import type { Bindings } from "./env";
import type { EmailRequestRow } from "./db";
import { getAttachmentBytes, toBase64 } from "./attachments";
import type { EmailContentBase, StoredAttachment } from "./validation";

/** Resend's single-email endpoint (the only one this worker needs). */
export const RESEND_EMAILS_URL = "https://api.resend.com/emails";

/** Tag key used to correlate a webhook back to our request even if `resend_id` is lost. */
export const EMAIL_REQUEST_TAG = "request_id";

/**
 * Total send attempts allowed per request (queue retries and webhook-driven
 * retries share this budget). Mirrors `max_retries` in wrangler.jsonc.
 */
export const EMAIL_MAX_ATTEMPTS = 3;

/** One Resend attachment. The worker always sends `content` (base64), never a URL. */
export interface ResendAttachment {
  filename: string;
  /** Base64-encoded bytes of the file. */
  content?: string;
  content_type?: string;
  /** Set to embed the file inline, e.g. `<img src="cid:logo">`. */
  content_id?: string;
}

/** The Resend request body we build (To-only; the worker never sets cc/bcc). */
export interface ResendEmailPayload {
  from: string;
  to: string[];
  subject?: string;
  html?: string;
  text?: string;
  reply_to?: string | string[];
  scheduled_at?: string;
  attachments?: ResendAttachment[];
  tags: { name: string; value: string }[];
  template?: { id: string; variables?: Record<string, string | number> };
}

/** HTTP statuses Resend (or the network) can report that are worth retrying. */
function isRetryableStatus(statusCode: number): boolean {
  return statusCode === 0 || statusCode === 429 || statusCode >= 500;
}

/**
 * A failed Resend call, normalised so the queue can decide between
 * `retry()` and a permanent failure.
 */
export class ResendError extends Error {
  readonly statusCode: number;
  readonly errorName: string;
  readonly retryable: boolean;

  constructor(input: {
    statusCode: number;
    errorName: string;
    message: string;
    retryable: boolean;
  }) {
    super(input.message);
    this.name = "ResendError";
    this.statusCode = input.statusCode;
    this.errorName = input.errorName;
    this.retryable = input.retryable;
  }
}

/** Normalises any thrown value into a ResendError. */
export function toResendError(error: unknown): ResendError {
  if (error instanceof ResendError) return error;
  return new ResendError({
    statusCode: 0,
    errorName: "network_error",
    message: error instanceof Error ? error.message : String(error),
    retryable: true,
  });
}

/**
 * A staged attachment is no longer in R2 (already cleaned up, or lost).
 *
 * Extending ResendError plugs this straight into the existing permanent-failure
 * path: the email must never go out with a silently dropped file, and no retry
 * can bring the object back.
 */
export class AttachmentMissingError extends ResendError {
  readonly key: string;

  constructor(key: string) {
    super({
      statusCode: 0,
      errorName: "attachment_missing",
      message: `Attachment is no longer available in R2: ${key}`,
      retryable: false,
    });
    this.name = "AttachmentMissingError";
    this.key = key;
  }
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null) return parsed as Record<string, unknown>;
    return null;
  } catch {
    return null;
  }
}

/**
 * Minimal Resend client built on `fetch` (no SDK dependency). The fetch
 * implementation is injectable so tests stay offline and deterministic.
 */
export interface EmailTransport {
  send(
    payload: ResendEmailPayload,
    options?: { idempotencyKey?: string },
  ): Promise<{ id: string }>;
}

export function createResendTransport(
  env: Bindings,
  fetchImpl: typeof fetch = fetch,
): EmailTransport {
  return {
    async send(payload, options) {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      };
      if (options?.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;

      let response: Response;
      try {
        response = await fetchImpl(RESEND_EMAILS_URL, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
        });
      } catch (error) {
        throw new ResendError({
          statusCode: 0,
          errorName: "network_error",
          message: error instanceof Error ? error.message : String(error),
          retryable: true,
        });
      }

      const raw = await response.text();

      if (!response.ok) {
        const body = parseJsonObject(raw);
        const errorName =
          typeof body?.name === "string" && body.name.length > 0 ? body.name : "resend_error";
        const message =
          typeof body?.message === "string" && body.message.length > 0
            ? body.message
            : raw.slice(0, 500);
        throw new ResendError({
          statusCode: response.status,
          errorName,
          message,
          retryable: isRetryableStatus(response.status),
        });
      }

      const body = parseJsonObject(raw);
      const id = typeof body?.id === "string" ? body.id : "";
      if (!id) {
        // A 2xx without an email id cannot be correlated with webhooks, so it
        // is treated as a retryable failure rather than silently accepted.
        throw new ResendError({
          statusCode: response.status,
          errorName: "invalid_response",
          message: raw.slice(0, 500),
          retryable: true,
        });
      }
      return { id };
    },
  };
}

/**
 * Resolves the sender: `EMAIL_FROM` unless the caller asked for another
 * address that is explicitly allowlisted via `EMAIL_ALLOWED_SENDERS`.
 */
export function resolveSender(
  env: Bindings,
  requested: string | undefined,
): { ok: true; from: string } | { ok: false } {
  if (!requested || requested === env.EMAIL_FROM) return { ok: true, from: env.EMAIL_FROM };
  const allowed = (env.EMAIL_ALLOWED_SENDERS ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (allowed.includes(requested.toLowerCase())) return { ok: true, from: requested };
  return { ok: false };
}

/**
 * Builds the Resend request body from the stored request + its payload.
 *
 * `attachments` are already-resolved base64 parts, so this stays pure and
 * synchronous; `resolveAttachments` does the R2 reads.
 */
export function buildResendPayload(
  request: Pick<EmailRequestRow, "id" | "app" | "recipient">,
  content: EmailContentBase,
  from: string,
  attachments: ResendAttachment[] = [],
): ResendEmailPayload {
  const payload: ResendEmailPayload = {
    from,
    to: [request.recipient],
    tags: [
      { name: EMAIL_REQUEST_TAG, value: request.id },
      { name: "app", value: request.app },
    ],
  };

  if (content.subject !== undefined) payload.subject = content.subject;
  if (content.replyTo !== undefined) payload.reply_to = content.replyTo;
  if (content.scheduledAt !== undefined) payload.scheduled_at = content.scheduledAt;

  if (content.useTemplate) {
    // `templateId` is guaranteed by the request schema when useTemplate is true.
    payload.template = { id: content.templateId as string };
    if (content.variables !== undefined) payload.template.variables = content.variables;
  } else {
    if (content.html !== undefined) payload.html = content.html;
    if (content.text !== undefined) payload.text = content.text;
  }

  if (attachments.length > 0) payload.attachments = attachments;

  return payload;
}

/**
 * Loads the staged bytes from R2 and encodes them for Resend.
 *
 * Resend accepts either base64 `content` or a remote `path`; we always send the
 * content, so the recipient gets a real attachment and no URL exists anywhere.
 * A missing object throws rather than sending a silently incomplete email.
 */
export async function resolveAttachments(
  env: Bindings,
  attachments: StoredAttachment[],
): Promise<ResendAttachment[]> {
  const resolved: ResendAttachment[] = [];
  for (const attachment of attachments) {
    const bytes = await getAttachmentBytes(env, attachment.key);
    if (bytes === null) throw new AttachmentMissingError(attachment.key);

    const entry: ResendAttachment = {
      filename: attachment.filename,
      content: toBase64(bytes),
    };
    if (attachment.content_type !== undefined) entry.content_type = attachment.content_type;
    if (attachment.content_id !== undefined) entry.content_id = attachment.content_id;
    resolved.push(entry);
  }
  return resolved;
}

/** Sends one stored email request through Resend, with its staged attachments. */
export async function sendEmailRequest(
  env: Bindings,
  request: Pick<EmailRequestRow, "id" | "app" | "recipient">,
  content: EmailContentBase,
  storedAttachments: StoredAttachment[] = [],
  transport: EmailTransport = createResendTransport(env),
): Promise<{ id: string }> {
  const sender = resolveSender(env, content.from);
  // resolveSender already ran during validation; falling back keeps a stored
  // request replayable even if the allowlist changed afterwards.
  const from = sender.ok ? sender.from : env.EMAIL_FROM;
  const attachments = await resolveAttachments(env, storedAttachments);
  const payload = buildResendPayload(request, content, from, attachments);
  return await transport.send(payload, { idempotencyKey: content.idempotencyKey });
}
