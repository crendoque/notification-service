import { z } from "zod";

/** Message fields shared by all three trigger modes (single / batch / broadcast). */
export const pushMessageSchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(2000),
  /** URL opened (or focused) when the user clicks the notification. */
  url: z.string().url().optional(),
  /** Icon URL shown by the notification. */
  icon: z.string().optional(),
  /** Notification tag: replaces a previous notification with the same tag. Max 32 chars. */
  tag: z.string().max(32).optional(),
  /** Hint to the push service / OS about delivery priority. */
  urgency: z.enum(["very-low", "low", "normal", "high"]).default("normal"),
  /** Seconds the push service keeps the message if the device is offline. Default: 24h. */
  ttl: z.number().int().min(0).max(2_419_200).default(86_400),
  /** Arbitrary JSON passed through to the service worker's `push` event. */
  data: z.record(z.string(), z.unknown()).optional(),
});
export type PushMessage = z.infer<typeof pushMessageSchema>;

/**
 * The browser's PushSubscription JSON, exactly as produced by
 * `pushManager.subscribe()` + `subscription.toJSON()` on the PWA side.
 */
export const pushSubscriptionSchema = z.object({
  endpoint: z.string().url().min(1),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
});
export type PushSubscriptionInput = z.infer<typeof pushSubscriptionSchema>;

/** PUT /v1/subscriptions */
export const registerSubscriptionSchema = z.object({
  userId: z.string().min(1).max(256),
  subscription: pushSubscriptionSchema,
});
export type RegisterSubscriptionInput = z.infer<typeof registerSubscriptionSchema>;

/** Mode 1 — POST /v1/notifications/push (specific user). */
export const pushNotificationSchema = pushMessageSchema.extend({
  userId: z.string().min(1).max(256),
});
export type PushNotificationInput = z.infer<typeof pushNotificationSchema>;

/** Mode 2 — POST /v1/notifications/push/batch (list of users). */
export const pushBatchSchema = pushMessageSchema.extend({
  userIds: z.array(z.string().min(1).max(256)).min(1).max(500),
});
export type PushBatchInput = z.infer<typeof pushBatchSchema>;

/** Mode 3 — POST /v1/notifications/push/all (broadcast to everyone). */
export const pushBroadcastSchema = pushMessageSchema.extend({
  /** Count recipients and devices without enqueuing anything. */
  dryRun: z.boolean().optional().default(false),
});

/** Internal queue job envelopes (validated again on the consumer side). */
export const pushJobSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("broadcast-page"),
    afterId: z.string().min(1).nullable(),
    message: pushMessageSchema,
  }),
  z.object({
    kind: z.literal("batch-chunk"),
    userIds: z.array(z.string().min(1).max(256)).min(1).max(50),
    message: pushMessageSchema,
  }),
]);
export type PushJob = z.infer<typeof pushJobSchema>;
