import { z } from "zod";
import { timingSafeEqual } from "./crypto";
import {
  applyEmailWebhookEvent,
  bindEmailRequestResendId,
  recordResendWebhookEvent,
  requeueEmailRequestForRetry,
  type EmailStatus,
} from "./db";
import { EMAIL_MAX_ATTEMPTS, EMAIL_REQUEST_TAG } from "./email";
import type { Bindings } from "./env";

/** Svix signs `id.timestamp.body`; payloads older than this are rejected. */
export const SVIX_TOLERANCE_SECONDS = 300;

/**
 * The only Resend events this worker acts on. Every other event type is
 * recorded in `resend_webhook_events` and answered with `outcome: "ignored"`.
 */
export const RESEND_EVENT_STATUS: Record<string, EmailStatus> = {
  "email.sent": "sent",
  "email.delivered": "delivered",
  "email.bounced": "bounced",
  "email.failed": "failed",
};

/**
 * Retryable event: Resend reported a send failure, so the request is put back
 * on the queue (bounded by `EMAIL_MAX_ATTEMPTS`). `email.bounced` is *not*
 * retryable — a bounce is permanent.
 */
export const RESEND_EVENT_RETRYABLE = "email.failed";

export interface SvixHeaders {
  id: string;
  timestamp: string;
  signature: string;
}

/** Reads the three Svix headers; null when any of them is missing. */
export function parseSvixHeaders(headers: {
  get(name: string): string | null;
}): SvixHeaders | null {
  const id = headers.get("svix-id");
  const timestamp = headers.get("svix-timestamp");
  const signature = headers.get("svix-signature");
  if (!id || !timestamp || !signature) return null;
  return { id, timestamp, signature };
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const padded = value + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export type SvixVerification =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "missing_headers"
        | "invalid_secret"
        | "timestamp_out_of_tolerance"
        | "invalid_signature";
    };

/**
 * Verifies a Svix (Resend) webhook signature.
 * https://docs.svix.com/receiving/verifying-payloads/how-manual
 */
export async function verifySvixSignature(
  secret: string,
  headers: SvixHeaders,
  rawBody: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<SvixVerification> {
  const key = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  let keyBytes: Uint8Array;
  try {
    keyBytes = fromBase64(key);
  } catch {
    return { ok: false, reason: "invalid_secret" };
  }
  if (keyBytes.length === 0) return { ok: false, reason: "invalid_secret" };

  const timestamp = Number(headers.timestamp);
  if (!Number.isFinite(timestamp) || Math.abs(nowSeconds - timestamp) > SVIX_TOLERANCE_SECONDS) {
    return { ok: false, reason: "timestamp_out_of_tolerance" };
  }

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    new TextEncoder().encode(`${headers.id}.${headers.timestamp}.${rawBody}`),
  );
  const expected = toBase64(new Uint8Array(signature));

  // The header is a space-delimited list of `v1,<base64>` entries.
  for (const candidate of headers.signature.split(" ")) {
    const value = candidate.trim();
    if (!value) continue;
    const comma = value.indexOf(",");
    const provided = comma === -1 ? value : value.slice(comma + 1);
    if (provided && (await timingSafeEqual(provided, expected))) return { ok: true };
  }

  return { ok: false, reason: "invalid_signature" };
}

/** Shape of the Resend webhook payloads we act on (extra fields are ignored). */
export const resendWebhookEventSchema = z.object({
  type: z.string().min(1).max(128),
  created_at: z.string().max(64).optional(),
  data: z
    .object({
      email_id: z.string().min(1).max(128).optional(),
      tags: z.record(z.string(), z.string()).optional(),
      bounce: z
        .object({
          type: z.string().max(64).optional(),
          subType: z.string().max(64).optional(),
          message: z.string().max(2000).optional(),
        })
        .optional(),
    })
    .optional(),
});
export type ResendWebhookEvent = z.infer<typeof resendWebhookEventSchema>;

export type ResendWebhookOutcome =
  /** A status (or last_event) was written to a matching request. */
  | "applied"
  /** The svix-id was already handled (Svix retry). */
  | "duplicate"
  /** No email request matches `data.email_id` (e.g. an email sent elsewhere). */
  | "unmatched"
  /** Event we do not act on (anything other than the four mapped email events). */
  | "ignored"
  /** `email.failed`: the request was put back on the queue for another attempt. */
  | "requeued";

export interface ResendWebhookResult {
  outcome: ResendWebhookOutcome;
  requestId: string | null;
}

/**
 * Records and applies one verified Resend webhook delivery.
 *
 * Every delivery is stored first (deduped on `svix-id`), then mapped onto the
 * email request through `data.email_id` — so retries are idempotent and
 * unmatched events are still auditable.
 */
export async function handleResendWebhookEvent(
  env: Bindings,
  input: { svixId: string; rawBody: string; event: ResendWebhookEvent },
): Promise<ResendWebhookResult> {
  const eventType = input.event.type;
  const resendEmailId = input.event.data?.email_id ?? null;
  const eventAt = input.event.created_at ?? new Date().toISOString();

  const isFresh = await recordResendWebhookEvent(env, {
    svixId: input.svixId,
    eventType,
    resendEmailId,
    payload: input.rawBody,
  });
  if (!isFresh) return { outcome: "duplicate", requestId: null };

  const status = RESEND_EVENT_STATUS[eventType] ?? null;

  // Only the four mapped email events are acted on; everything else (including
  // email.opened / email.clicked / domain.*) is stored for audit and ignored.
  if (resendEmailId === null || status === null) {
    console.warn(JSON.stringify({ msg: "webhook_ignored", eventType }));
    return { outcome: "ignored", requestId: null };
  }

  let result = await applyEmailWebhookEvent(env, {
    resendId: resendEmailId,
    status,
    eventType,
    eventAt,
    bounce: input.event.data?.bounce,
  });

  if (result.outcome === "unmatched") {
    // Recovery path: the send may have reached Resend while the `resend_id`
    // write was lost, so correlate through the tag we attach to every send.
    const taggedRequestId = input.event.data?.tags?.[EMAIL_REQUEST_TAG];
    if (taggedRequestId) {
      const bound = await bindEmailRequestResendId(env, {
        id: taggedRequestId,
        resendId: resendEmailId,
      });
      if (bound) {
        result = await applyEmailWebhookEvent(env, {
          resendId: resendEmailId,
          status,
          eventType,
          eventAt,
          bounce: input.event.data?.bounce,
        });
        console.warn(
          JSON.stringify({
            msg: "webhook_recovered_by_tag",
            eventType,
            requestId: taggedRequestId,
            resendEmailId,
          }),
        );
      }
    }

    if (result.outcome === "unmatched") {
      console.warn(JSON.stringify({ msg: "webhook_unmatched", eventType, resendEmailId }));
      return { outcome: "unmatched", requestId: null };
    }
  }

  // `email.failed` is retryable: put the request back on the queue while the
  // attempt budget lasts. `email.bounced` is permanent and is never retried,
  // and an out-of-order event (result !== "ok") is only recorded.
  if (
    eventType === RESEND_EVENT_RETRYABLE &&
    result.outcome === "ok" &&
    result.requestId !== null
  ) {
    const requestId = result.requestId;
    const retry = await requeueEmailRequestForRetry(env, {
      id: requestId,
      eventType,
      eventAt,
      maxAttempts: EMAIL_MAX_ATTEMPTS,
    });

    if (retry === "requeued") {
      await env.PUSH_QUEUE.send({ kind: "email-send", requestId });
      console.log(
        JSON.stringify({ msg: "webhook_retry_queued", eventType, requestId, status }),
      );
      return { outcome: "requeued", requestId };
    }

    console.warn(
      JSON.stringify({ msg: "webhook_retry_exhausted", eventType, requestId, status }),
    );
    return { outcome: "applied", requestId };
  }

  console.log(
    JSON.stringify({
      msg: "webhook_applied",
      eventType,
      requestId: result.requestId,
      status,
      outOfOrder: result.outcome === "out_of_order",
    }),
  );
  return { outcome: "applied", requestId: result.requestId };
}
