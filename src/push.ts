import { sendNotification } from "web-push-neo";
import type { Bindings } from "./env";
import {
  getSubscriptionsForUser,
  getSubscriptionsForUsers,
  removeSubscriptionById,
  type PushSubscriptionRow,
} from "./db";
import type { PushMessage, PushNotificationInput } from "./validation";

/**
 * Above this many target devices, the batch endpoint routes the fan-out
 * through the queue instead of running it inline (Workers cap outbound
 * subrequests per invocation).
 */
export const SYNC_DEVICE_LIMIT = 500;

export interface DeviceSendSummary {
  /** Accepted by the push service (not necessarily displayed yet). */
  delivered: number;
  /** Rejected by the push service for other reasons (e.g. 4xx/5xx). */
  failed: number;
  /** Expired subscriptions (404/410) pruned from the database. */
  removed: number;
}

/** Payload contract consumed by the PWA's service worker (`push` event):
 *  { title, body, url, icon, tag, data } */
function buildPayload(message: PushMessage): string {
  return JSON.stringify({
    title: message.title,
    body: message.body,
    url: message.url ?? null,
    icon: message.icon ?? null,
    tag: message.tag ?? null,
    data: message.data ?? null,
  });
}

/**
 * Sends to a set of devices in parallel; expired subscriptions
 * (push service answered 404 Not Found or 410 Gone) are pruned automatically.
 */
export async function sendToDevices(
  env: Bindings,
  rows: PushSubscriptionRow[],
  message: PushMessage,
): Promise<DeviceSendSummary> {
  if (rows.length === 0) return { delivered: 0, failed: 0, removed: 0 };

  const payload = buildPayload(message);
  const vapidDetails = {
    subject: env.VAPID_SUBJECT,
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
  };

  const settled = await Promise.allSettled(
    rows.map((row) =>
      sendNotification(
        { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
        payload,
        { vapidDetails, TTL: message.ttl, urgency: message.urgency },
      ),
    ),
  );

  let delivered = 0;
  let failed = 0;
  const expiredIds: string[] = [];
  settled.forEach((outcome, index) => {
    if (outcome.status === "fulfilled") {
      delivered++;
      return;
    }
    failed++;
    const reason = outcome.reason as { statusCode?: number } | null;
    const statusCode = reason?.statusCode ?? 0;
    if (statusCode === 404 || statusCode === 410) {
      // Subscription no longer exists on the push service -> prune it.
      expiredIds.push(rows[index].id);
    } else {
      console.warn(
        JSON.stringify({
          msg: "push_send_failed",
          endpoint: rows[index].endpoint,
          statusCode,
        }),
      );
    }
  });

  if (expiredIds.length > 0) {
    await Promise.allSettled(expiredIds.map((id) => removeSubscriptionById(env, id)));
    console.log(
      JSON.stringify({ msg: "pruned_expired_subscriptions", count: expiredIds.length }),
    );
  }

  return { delivered, failed, removed: expiredIds.length };
}

export interface PushSendResult extends DeviceSendSummary {
  userId: string;
}

/** Mode 1 — deliver to every registered device of one user. */
export async function sendPushToUser(
  env: Bindings,
  request: PushNotificationInput,
): Promise<PushSendResult> {
  const rows = await getSubscriptionsForUser(env, request.userId);
  const summary = await sendToDevices(env, rows, request);
  return { userId: request.userId, ...summary };
}

export interface PushBatchRequest {
  userIds: string[];
  message: PushMessage;
}

export interface PushBatchResult {
  results: ({ userId: string } & DeviceSendSummary)[];
  /** Users with at least one registered subscription. */
  notifiedUsers: number;
  /** Users with no registered subscriptions (no devices). */
  skippedUsers: number;
}

/** Mode 2 — deliver to every registered device of a list of users (inline/sync path). */
export async function sendPushToUsers(
  env: Bindings,
  request: PushBatchRequest,
): Promise<PushBatchResult> {
  const rows = await getSubscriptionsForUsers(env, request.userIds);
  const rowsByUser = new Map<string, PushSubscriptionRow[]>();
  for (const row of rows) {
    const list = rowsByUser.get(row.user_id);
    if (list) list.push(row);
    else rowsByUser.set(row.user_id, [row]);
  }

  const results = await Promise.all(
    request.userIds.map(async (userId) => ({
      userId,
      ...(await sendToDevices(env, rowsByUser.get(userId) ?? [], request.message)),
    })),
  );

  const skippedUsers = results.filter(
    (r) => (rowsByUser.get(r.userId)?.length ?? 0) === 0,
  ).length;
  return { results, notifiedUsers: results.length - skippedUsers, skippedUsers };
}
