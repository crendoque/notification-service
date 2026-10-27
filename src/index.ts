import { Hono } from "hono";
import type { Bindings } from "./env";
import { authMiddleware } from "./auth";
import { subscriptionIdFromEndpoint } from "./crypto";
import {
  chunkBy,
  countAllSubscriptions,
  countSubscriptionsForUsers,
  countUsers,
  getEmailRequestById,
  insertEmailRequest,
  listEmailRequests,
  removeSubscriptionById,
  upsertSubscription,
  type EmailRequestRow,
} from "./db";
import { BATCH_CHUNK_SIZE, processBatchChunk, processBroadcastPage } from "./jobs";
import { processEmailSend } from "./email-jobs";
import { resolveSender } from "./email";
import {
  handleResendWebhookEvent,
  parseSvixHeaders,
  resendWebhookEventSchema,
  verifySvixSignature,
} from "./resend-webhook";
import { sendPushToUser, sendPushToUsers, SYNC_DEVICE_LIMIT } from "./push";
import {
  emailListQuerySchema,
  emailRequestSchema,
  findUnsupportedEmailPayloadFields,
  registerSubscriptionSchema,
  pushNotificationSchema,
  pushBatchSchema,
  pushBroadcastSchema,
  notificationJobSchema,
  type NotificationJob,
} from "./validation";

const app = new Hono<{ Bindings: Bindings }>();

/** Safely parse the JSON body; null when the body is not valid JSON. */
async function readJsonBody(c: { req: { json(): Promise<unknown> } }): Promise<unknown | null> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

/** API representation of a stored email request. */
function serializeEmailRequest(row: EmailRequestRow) {
  return {
    id: row.id,
    app: row.app,
    userId: row.user_id,
    recipient: row.recipient,
    mode: row.mode,
    subject: row.subject,
    templateId: row.template_id,
    status: row.status,
    resendId: row.resend_id,
    attempts: row.attempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sentAt: row.sent_at,
    deliveredAt: row.delivered_at,
    lastEvent: row.last_event,
    lastEventAt: row.last_event_at,
    error: row.error_name
      ? { name: row.error_name, message: row.error_message ?? null }
      : null,
    bounce:
      row.bounce_type || row.bounce_sub_type || row.bounce_message
        ? {
            type: row.bounce_type,
            subType: row.bounce_sub_type,
            message: row.bounce_message,
          }
        : null,
  };
}

/** Comma-separated allowlist helper (empty list = allow everything). */
function allowList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

app.get("/health", (c) => c.json({ status: "ok", service: "notification-worker" }));

const v1 = new Hono<{ Bindings: Bindings }>();
v1.use("*", authMiddleware);

/**
 * Public VAPID key the PWA needs for `pushManager.subscribe({
 *   applicationServerKey, ... })`. The backend can proxy this to the frontend.
 */
v1.get("/config/vapid-public-key", (c) => c.json({ publicKey: c.env.VAPID_PUBLIC_KEY }));

/** Register (or refresh) a browser subscription for a user. Idempotent. */
v1.put("/subscriptions", async (c) => {
  const body = await readJsonBody(c);
  if (body === null) return c.json({ error: "invalid_json" }, 400);

  const parsed = registerSubscriptionSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid_request", details: parsed.error.flatten() }, 400);
  }

  const { userId, subscription } = parsed.data;
  const id = await subscriptionIdFromEndpoint(subscription.endpoint);
  await upsertSubscription(c.env, { id, userId, subscription });

  console.log(JSON.stringify({ msg: "subscription_registered", userId, id }));
  return c.json({ id, endpoint: subscription.endpoint });
});

/** Remove a subscription. `:id` is the value returned by PUT /v1/subscriptions. */
v1.delete("/subscriptions/:id", async (c) => {
  const deleted = await removeSubscriptionById(c.env, c.req.param("id"));
  if (!deleted) return c.json({ error: "not_found" }, 404);
  return c.body(null, 204);
});

/** Mode 1 — notify one specific user (all their devices). Synchronous. */
v1.post("/notifications/push", async (c) => {
  const body = await readJsonBody(c);
  if (body === null) return c.json({ error: "invalid_json" }, 400);

  const parsed = pushNotificationSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid_request", details: parsed.error.flatten() }, 400);
  }

  const result = await sendPushToUser(c.env, parsed.data);
  console.log(JSON.stringify({ msg: "push_triggered", ...result }));
  return c.json(result);
});


/** Mode 2 — notify an explicit list of users. Sync, or queued when large. */
v1.post("/notifications/push/batch", async (c) => {
  const body = await readJsonBody(c);
  if (body === null) return c.json({ error: "invalid_json" }, 400);

  const parsed = pushBatchSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid_request", details: parsed.error.flatten() }, 400);
  }

  const { userIds, ...message } = parsed.data;
  const uniqueUserIds = Array.from(new Set(userIds));
  const deviceCount = await countSubscriptionsForUsers(c.env, uniqueUserIds);

  // Too many devices for one synchronous invocation -> fan out via the queue.
  if (deviceCount > SYNC_DEVICE_LIMIT) {
    for (const chunk of chunkBy(uniqueUserIds, BATCH_CHUNK_SIZE)) {
      await c.env.PUSH_QUEUE.send({ kind: "batch-chunk", userIds: chunk, message });
    }
    console.log(
      JSON.stringify({ msg: "batch_queued", users: uniqueUserIds.length, devices: deviceCount }),
    );
    return c.json({ queued: true, queuedUsers: uniqueUserIds.length });
  }

  const result = await sendPushToUsers(c.env, { userIds: uniqueUserIds, message });
  console.log(
    JSON.stringify({
      msg: "batch_triggered",
      users: uniqueUserIds.length,
      notified: result.notifiedUsers,
      skipped: result.skippedUsers,
    }),
  );
  return c.json(result);
});

/** Mode 3 — broadcast to every user with a subscription. Always queued. */
v1.post("/notifications/push/all", async (c) => {
  const body = await readJsonBody(c);
  if (body === null) return c.json({ error: "invalid_json" }, 400);

  const parsed = pushBroadcastSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid_request", details: parsed.error.flatten() }, 400);
  }

  const { dryRun, ...message } = parsed.data;
  const [estimatedUsers, estimatedDevices] = await Promise.all([
    countUsers(c.env),
    countAllSubscriptions(c.env),
  ]);

  if (dryRun) {
    return c.json({ dryRun: true, estimatedUsers, estimatedDevices });
  }

  await c.env.PUSH_QUEUE.send({ kind: "broadcast-page", afterId: null, message });
  console.log(JSON.stringify({ msg: "broadcast_queued", estimatedUsers, estimatedDevices }));
  return c.json({ queued: true, estimatedUsers, estimatedDevices });
});

/**
 * Email trigger — always asynchronous.
 *
 * The request is validated, persisted (so the queued job and any retry can be
 * replayed from D1) and enqueued; Resend is never called from this handler.
 * Poll `GET /v1/notifications/email/:id` for the delivery status.
 */
v1.post("/notifications/email", async (c) => {
  const body = await readJsonBody(c);
  if (body === null) return c.json({ error: "invalid_json" }, 400);

  if (!c.env.RESEND_API_KEY || !c.env.EMAIL_FROM) {
    console.error(
      JSON.stringify({
        msg: "email_misconfigured",
        hint: "RESEND_API_KEY secret and EMAIL_FROM var must both be set",
      }),
    );
    return c.json({ error: "server_misconfigured" }, 500);
  }

  // `to`/`cc`/`bcc`/`headers`/`tags` are not accepted: the recipient is always
  // the request's `email` field (To only), and silently ignoring them would
  // hide a caller mistake.
  const unsupported = findUnsupportedEmailPayloadFields(body);
  if (unsupported.length > 0) {
    return c.json(
      {
        error: "unsupported_field",
        fields: unsupported,
        details: "The recipient is always the request's `email` field (To only).",
      },
      400,
    );
  }

  const parsed = emailRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid_request", details: parsed.error.flatten() }, 400);
  }

  const { app, userId, email, payload } = parsed.data;

  const allowedApps = allowList(c.env.EMAIL_ALLOWED_APPS);
  if (allowedApps.length > 0 && !allowedApps.includes(app.toLowerCase())) {
    return c.json({ error: "unknown_app", app }, 400);
  }
  if (!resolveSender(c.env, payload.from).ok) {
    return c.json({ error: "from_not_allowed", from: payload.from }, 400);
  }

  const id = crypto.randomUUID();
  const mode = payload.useTemplate ? "template" : "inline";
  await insertEmailRequest(c.env, {
    id,
    app,
    userId,
    recipient: email,
    mode,
    subject: payload.subject ?? null,
    templateId: payload.templateId ?? null,
    payload: JSON.stringify(payload),
  });
  await c.env.PUSH_QUEUE.send({ kind: "email-send", requestId: id });

  console.log(
    JSON.stringify({ msg: "email_queued", requestId: id, app, userId, mode, templateId: payload.templateId ?? null }),
  );
  return c.json(
    {
      id,
      app,
      userId,
      recipient: email,
      mode,
      subject: payload.subject ?? null,
      templateId: payload.templateId ?? null,
      status: "queued",
      createdAt: new Date().toISOString(),
    },
    202,
  );
});

/** Email history for one user (or one app), newest first. */
v1.get("/notifications/email", async (c) => {
  const parsed = emailListQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json({ error: "invalid_query", details: parsed.error.flatten() }, 400);
  }

  const { app, userId, status, limit, afterSeq } = parsed.data;
  // Fetch one extra row to know whether another page exists.
  const rows = await listEmailRequests(c.env, { app, userId, status, afterSeq, limit: limit + 1 });
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const nextAfterSeq = hasMore ? page[page.length - 1].seq : null;
  return c.json({ requests: page.map(serializeEmailRequest), nextAfterSeq });
});

/** Status of a single email request. */
v1.get("/notifications/email/:id", async (c) => {
  const row = await getEmailRequestById(c.env, c.req.param("id"));
  if (!row) return c.json({ error: "not_found" }, 404);
  return c.json(serializeEmailRequest(row));
});

/**
 * Resend webhook receiver.
 *
 * Registered on the root app *before* `app.route("/v1", v1)` on purpose:
 * Resend authenticates with a Svix signature, not our backend bearer token,
 * so `authMiddleware` must not run for this path.
 */
app.post("/v1/webhooks/resend", async (c) => {
  const secret = c.env.RESEND_WEBHOOK_SECRET;
  if (!secret) {
    console.error(
      JSON.stringify({
        msg: "webhook_misconfigured",
        hint: "RESEND_WEBHOOK_SECRET secret is not set",
      }),
    );
    return c.json({ error: "server_misconfigured" }, 500);
  }

  // The raw body must be used as-is: re-serialising JSON breaks the signature.
  const rawBody = await c.req.text();
  const headers = parseSvixHeaders(c.req.raw.headers);
  if (!headers) return c.json({ error: "missing_signature_headers" }, 400);

  const verification = await verifySvixSignature(secret, headers, rawBody);
  if (!verification.ok) {
    console.warn(JSON.stringify({ msg: "webhook_rejected", reason: verification.reason }));
    return c.json({ error: "invalid_signature", reason: verification.reason }, 400);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const parsed = resendWebhookEventSchema.safeParse(payload);
  if (!parsed.success) {
    return c.json({ error: "invalid_event", details: parsed.error.flatten() }, 400);
  }

  const result = await handleResendWebhookEvent(c.env, {
    svixId: headers.id,
    rawBody,
    event: parsed.data,
  });
  return c.json({ received: true, ...result });
});

app.route("/v1", v1);

/** Queue consumer — processes one job per message (max_batch_size: 1). */
async function handleQueueJob(
  env: Bindings,
  job: NotificationJob,
  attempt: number,
): Promise<void> {
  if (job.kind === "email-send") {
    await processEmailSend(env, job, { attempt });
    return;
  }
  if (job.kind === "broadcast-page") {
    await processBroadcastPage(env, env.PUSH_QUEUE, job);
    return;
  }
  await processBatchChunk(env, job);
}

export default {
  fetch: app.fetch,
  queue: async (
    batch: MessageBatch<NotificationJob>,
    env: Bindings,
    _ctx: ExecutionContext,
  ): Promise<void> => {
    for (const message of batch.messages) {
      const parsed = notificationJobSchema.safeParse(message.body);
      if (!parsed.success) {
        // Poison message — ack so it is not redelivered forever.
        console.warn(JSON.stringify({ msg: "queue_job_invalid" }));
        message.ack();
        continue;
      }
      try {
        await handleQueueJob(env, parsed.data, message.attempts);
        message.ack();
      } catch (error) {
        console.error(
          JSON.stringify({ msg: "queue_job_failed", kind: parsed.data.kind, error: String(error) }),
        );
        message.retry();
      }
    }
  },
};

export { app };
