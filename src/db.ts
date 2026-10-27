import type { Bindings } from "./env";
import type { PushSubscriptionInput } from "./validation";

export interface PushSubscriptionRow {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** Splits an array into chunks (D1 caps SQL bind parameters per statement). */
export function chunkBy<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

const ROW_COLUMNS = "id, user_id, endpoint, p256dh, auth";

/** Insert or refresh a subscription, keyed uniquely by its endpoint. */
export async function upsertSubscription(
  env: Bindings,
  input: { id: string; userId: string; subscription: PushSubscriptionInput },
): Promise<void> {
  const { id, userId, subscription } = input;
  await env.DB.prepare(
    `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (endpoint) DO UPDATE SET
       id = excluded.id,
       user_id = excluded.user_id,
       p256dh = excluded.p256dh,
       auth = excluded.auth,
       updated_at = datetime('now')`,
  )
    .bind(id, userId, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth)
    .run();
}

export async function getSubscriptionsForUser(
  env: Bindings,
  userId: string,
): Promise<PushSubscriptionRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT ${ROW_COLUMNS} FROM push_subscriptions WHERE user_id = ?`,
  )
    .bind(userId)
    .all<PushSubscriptionRow>();
  return results;
}

/** All subscriptions of the given users, chunked to respect D1 bind limits. */
export async function getSubscriptionsForUsers(
  env: Bindings,
  userIds: string[],
): Promise<PushSubscriptionRow[]> {
  const rows: PushSubscriptionRow[] = [];
  for (const chunk of chunkBy(userIds, 50)) {
    const placeholders = chunk.map(() => "?").join(", ");
    const { results } = await env.DB.prepare(
      `SELECT ${ROW_COLUMNS} FROM push_subscriptions WHERE user_id IN (${placeholders})`,
    )
      .bind(...chunk)
      .all<PushSubscriptionRow>();
    rows.push(...results);
  }
  return rows;
}

/** Device count across the given users (used to route batch sends sync vs queued). */
export async function countSubscriptionsForUsers(
  env: Bindings,
  userIds: string[],
): Promise<number> {
  let total = 0;
  for (const chunk of chunkBy(userIds, 50)) {
    const placeholders = chunk.map(() => "?").join(", ");
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id IN (${placeholders})`,
    )
      .bind(...chunk)
      .first<{ n: number }>();
    total += row?.n ?? 0;
  }
  return total;
}

/** One keyset-paginated page of subscriptions, ordered by id. */
export async function getSubscriptionPage(
  env: Bindings,
  afterId: string | null,
  limit: number,
): Promise<PushSubscriptionRow[]> {
  const stmt =
    afterId === null
      ? env.DB.prepare(`SELECT ${ROW_COLUMNS} FROM push_subscriptions ORDER BY id LIMIT ?`).bind(limit)
      : env.DB
          .prepare(`SELECT ${ROW_COLUMNS} FROM push_subscriptions WHERE id > ? ORDER BY id LIMIT ?`)
          .bind(afterId, limit);
  const { results } = await stmt.all<PushSubscriptionRow>();
  return results;
}

export async function countUsers(env: Bindings): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(DISTINCT user_id) AS n FROM push_subscriptions",
  ).first<{ n: number }>();
  return row?.n ?? 0;
}

export async function countAllSubscriptions(env: Bindings): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM push_subscriptions").first<{ n: number }>();
  return row?.n ?? 0;
}

/** Returns true if a row was deleted. */
export async function removeSubscriptionById(env: Bindings, id: string): Promise<boolean> {
  const result = await env.DB.prepare("DELETE FROM push_subscriptions WHERE id = ?")
    .bind(id)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/* ------------------------------------------------------------------ *
 * Email channel
 * ------------------------------------------------------------------ */

export type EmailMode = "template" | "inline";

/**
 * The only statuses an email request can have.
 * `queued` and `sent` are written by the worker; `delivered`, `bounced` and
 * `failed` come from Resend webhooks (see `RESEND_EVENT_STATUS`).
 */
export type EmailStatus = "queued" | "sent" | "delivered" | "bounced" | "failed";

export interface EmailRequestRow {
  seq: number;
  id: string;
  app: string;
  user_id: string;
  recipient: string;
  mode: EmailMode;
  subject: string | null;
  template_id: string | null;
  payload: string;
  status: EmailStatus;
  resend_id: string | null;
  attempts: number;
  error_name: string | null;
  error_message: string | null;
  last_event: string | null;
  last_event_at: string | null;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
  delivered_at: string | null;
  bounce_type: string | null;
  bounce_sub_type: string | null;
  bounce_message: string | null;
}

const EMAIL_COLUMNS =
  "seq, id, app, user_id, recipient, mode, subject, template_id, payload, status, resend_id, " +
  "attempts, error_name, error_message, last_event, last_event_at, created_at, updated_at, " +
  "sent_at, delivered_at, bounce_type, bounce_sub_type, bounce_message";

/**
 * Ordering used to keep a late or out-of-order webhook from regressing a
 * terminal status. Higher wins.
 *
 * `failed` sits above `sent` (a reported send failure supersedes "accepted"),
 * but below `delivered`/`bounced`, so a late `email.failed` can never
 * re-queue an email that was already delivered or permanently bounced.
 */
const EMAIL_STATUS_RANK: Record<EmailStatus, number> = {
  queued: 0,
  sent: 1,
  failed: 2,
  delivered: 3,
  bounced: 4,
};

export function emailStatusRank(status: string): number {
  return EMAIL_STATUS_RANK[status as EmailStatus] ?? -1;
}

/**
 * True once the row has been handed to Resend (or failed permanently).
 * The queue must never send such a row again, which is what makes
 * at-least-once queue delivery safe.
 */
export function isEmailSendComplete(status: string): boolean {
  return status !== "queued";
}

export interface InsertEmailRequestInput {
  id: string;
  app: string;
  userId: string;
  recipient: string;
  mode: EmailMode;
  subject: string | null;
  templateId: string | null;
  /** Validated payload JSON — the replay source for queued jobs and retries. */
  payload: string;
}

/** Creates a queued email request. The caller enqueues the matching job. */
export async function insertEmailRequest(
  env: Bindings,
  input: InsertEmailRequestInput,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO email_requests
       (id, app, user_id, recipient, mode, subject, template_id, payload, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued')`,
  )
    .bind(
      input.id,
      input.app,
      input.userId,
      input.recipient,
      input.mode,
      input.subject,
      input.templateId,
      input.payload,
    )
    .run();
}

export async function getEmailRequestById(
  env: Bindings,
  id: string,
): Promise<EmailRequestRow | null> {
  return await env.DB.prepare(`SELECT ${EMAIL_COLUMNS} FROM email_requests WHERE id = ?`)
    .bind(id)
    .first<EmailRequestRow>();
}

export interface ListEmailRequestsQuery {
  app?: string;
  userId?: string;
  status?: EmailStatus;
  /** Keyset cursor: the `seq` of the last row of the previous page. */
  afterSeq?: number;
  limit: number;
}

/** Newest-first page of email requests (keyset paginated on `seq`). */
export async function listEmailRequests(
  env: Bindings,
  query: ListEmailRequestsQuery,
): Promise<EmailRequestRow[]> {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (query.app) {
    conditions.push("app = ?");
    params.push(query.app);
  }
  if (query.userId) {
    conditions.push("user_id = ?");
    params.push(query.userId);
  }
  if (query.status) {
    conditions.push("status = ?");
    params.push(query.status);
  }
  if (query.afterSeq !== undefined) {
    conditions.push("seq < ?");
    params.push(query.afterSeq);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const { results } = await env.DB.prepare(
    `SELECT ${EMAIL_COLUMNS} FROM email_requests ${where} ORDER BY seq DESC LIMIT ?`,
  )
    .bind(...params, query.limit)
    .all<EmailRequestRow>();
  return results;
}

/** Records a successful hand-off to Resend. */
export async function markEmailRequestSent(
  env: Bindings,
  input: { id: string; resendId: string; attempts: number },
): Promise<void> {
  await env.DB.prepare(
    `UPDATE email_requests
        SET status = 'sent', resend_id = ?, attempts = ?, sent_at = COALESCE(sent_at, ?),
            error_name = NULL, error_message = NULL, updated_at = datetime('now')
      WHERE id = ?`,
  )
    .bind(input.resendId, input.attempts, new Date().toISOString(), input.id)
    .run();
}

/** Bumps the attempt counter without changing the status (retryable failure). */
export async function incrementEmailRequestAttempts(env: Bindings, id: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE email_requests SET attempts = attempts + 1, updated_at = datetime('now') WHERE id = ?",
  )
    .bind(id)
    .run();
}

/** Marks a permanent failure (invalid payload, bad key, retries exhausted). */
export async function markEmailRequestFailed(
  env: Bindings,
  input: { id: string; errorName: string; errorMessage: string; attempts: number },
): Promise<void> {
  await env.DB.prepare(
    `UPDATE email_requests
        SET status = 'failed', error_name = ?, error_message = ?, attempts = ?,
            updated_at = datetime('now')
      WHERE id = ?`,
  )
    .bind(input.errorName, input.errorMessage, input.attempts, input.id)
    .run();
}

export type EmailRetryOutcome = "requeued" | "exhausted";

/**
 * Resend reported `email.failed`, which is retryable: put the request back on
 * the queue while the attempt budget lasts, otherwise mark it failed.
 *
 * `email.bounced` never reaches this function — a bounce is permanent and is
 * recorded as a terminal status instead.
 */
export async function requeueEmailRequestForRetry(
  env: Bindings,
  input: { id: string; eventType: string; eventAt: string; maxAttempts: number },
): Promise<EmailRetryOutcome> {
  const requeued = await env.DB.prepare(
    `UPDATE email_requests
        SET status = 'queued',
            attempts = attempts + 1,
            last_event = ?,
            last_event_at = ?,
            error_name = NULL,
            error_message = NULL,
            updated_at = datetime('now')
      WHERE id = ? AND attempts < ?`,
  )
    .bind(input.eventType, input.eventAt, input.id, input.maxAttempts)
    .run();

  if ((requeued.meta.changes ?? 0) > 0) return "requeued";

  await env.DB.prepare(
    `UPDATE email_requests
        SET status = 'failed',
            error_name = 'retries_exhausted',
            error_message = ?,
            last_event = ?,
            last_event_at = ?,
            updated_at = datetime('now')
      WHERE id = ?`,
  )
    .bind(
      `Retries exhausted after ${input.maxAttempts} attempts (${input.eventType})`,
      input.eventType,
      input.eventAt,
      input.id,
    )
    .run();

  return "exhausted";
}

export interface EmailWebhookEventInput {
  /** Resend email id (`data.email_id`) — the correlation key. */
  resendId: string;
  /** Status to apply, or null for events that only update `last_event`. */
  status: EmailStatus | null;
  eventType: string;
  eventAt: string;
  bounce?: { type?: string; subType?: string; message?: string };
}

export type EmailWebhookOutcome = "ok" | "unmatched" | "out_of_order";

/**
 * Applies a Resend webhook event to the matching email request.
 * A lower-ranked status (e.g. a late `email.sent` after `email.delivered`)
 * is not applied, so terminal states can never regress.
 */
export async function applyEmailWebhookEvent(
  env: Bindings,
  input: EmailWebhookEventInput,
): Promise<{ outcome: EmailWebhookOutcome; requestId: string | null }> {
  const row = await env.DB.prepare(
    "SELECT id, status FROM email_requests WHERE resend_id = ?",
  )
    .bind(input.resendId)
    .first<{ id: string; status: EmailStatus }>();

  if (!row) return { outcome: "unmatched", requestId: null };

  const isRegression =
    input.status !== null && emailStatusRank(input.status) < emailStatusRank(row.status);

  if (isRegression) {
    // Keep the higher-ranked status but still record what arrived.
    await env.DB.prepare(
      `UPDATE email_requests
          SET last_event = ?, last_event_at = ?, updated_at = datetime('now')
        WHERE id = ?`,
    )
      .bind(input.eventType, input.eventAt, row.id)
      .run();
    return { outcome: "out_of_order", requestId: row.id };
  }

  const status = input.status ?? row.status;
  const accepted = status === "sent";
  await env.DB.prepare(
    `UPDATE email_requests
        SET status = ?,
            last_event = ?,
            last_event_at = ?,
            updated_at = datetime('now'),
            sent_at = COALESCE(sent_at, ?),
            delivered_at = COALESCE(delivered_at, ?),
            bounce_type = COALESCE(?, bounce_type),
            bounce_sub_type = COALESCE(?, bounce_sub_type),
            bounce_message = COALESCE(?, bounce_message)
      WHERE id = ?`,
  )
    .bind(
      status,
      input.eventType,
      input.eventAt,
      accepted ? input.eventAt : null,
      status === "delivered" ? input.eventAt : null,
      input.bounce?.type ?? null,
      input.bounce?.subType ?? null,
      input.bounce?.message ?? null,
      row.id,
    )
    .run();

  return { outcome: "ok", requestId: row.id };
}

/**
 * Binds a Resend email id to a request that never recorded one — crash
 * recovery for a send that reached Resend but whose `resend_id` write was lost.
 * Returns false when the row is unknown or already bound.
 */
export async function bindEmailRequestResendId(
  env: Bindings,
  input: { id: string; resendId: string },
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE email_requests
        SET resend_id = ?, updated_at = datetime('now')
      WHERE id = ? AND resend_id IS NULL`,
  )
    .bind(input.resendId, input.id)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/**
 * Stores an inbound webhook event. Returns false when the same `svix-id` was
 * already recorded (Svix retries reuse it), which makes handling idempotent.
 */
export async function recordResendWebhookEvent(
  env: Bindings,
  input: { svixId: string; eventType: string; resendEmailId: string | null; payload: string },
): Promise<boolean> {
  const result = await env.DB.prepare(
    `INSERT INTO resend_webhook_events (svix_id, event_type, resend_email_id, payload)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (svix_id) DO NOTHING`,
  )
    .bind(input.svixId, input.eventType, input.resendEmailId, input.payload)
    .run();
  return (result.meta.changes ?? 0) > 0;
}
