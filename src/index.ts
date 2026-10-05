import { Hono } from "hono";
import type { Bindings } from "./env";
import { authMiddleware } from "./auth";
import { subscriptionIdFromEndpoint } from "./crypto";
import {
  chunkBy,
  countAllSubscriptions,
  countSubscriptionsForUsers,
  countUsers,
  removeSubscriptionById,
  upsertSubscription,
} from "./db";
import { BATCH_CHUNK_SIZE, processBatchChunk, processBroadcastPage } from "./jobs";
import { sendPushToUser, sendPushToUsers, SYNC_DEVICE_LIMIT } from "./push";
import {
  registerSubscriptionSchema,
  pushNotificationSchema,
  pushBatchSchema,
  pushBroadcastSchema,
  pushJobSchema,
  type PushJob,
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

app.route("/v1", v1);

/** Queue consumer — processes one job per message (max_batch_size: 1). */
async function handleQueueJob(env: Bindings, job: PushJob): Promise<void> {
  if (job.kind === "broadcast-page") {
    await processBroadcastPage(env, env.PUSH_QUEUE, job);
  } else {
    await processBatchChunk(env, job);
  }
}

export default {
  fetch: app.fetch,
  queue: async (batch: MessageBatch<PushJob>, env: Bindings, _ctx: ExecutionContext): Promise<void> => {
    for (const message of batch.messages) {
      const parsed = pushJobSchema.safeParse(message.body);
      if (!parsed.success) {
        // Poison message — ack so it is not redelivered forever.
        console.warn(JSON.stringify({ msg: "queue_job_invalid" }));
        message.ack();
        continue;
      }
      try {
        await handleQueueJob(env, parsed.data);
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
