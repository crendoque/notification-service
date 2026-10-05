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
