/**
 * Mirror of migrations/0001_create_push_subscriptions.sql (IF NOT EXISTS so
 * tests can apply it on top of any pre-applied migrations), plus seeding
 * helpers for tests.
 */
export function applyPushSchema(db: D1Database): Promise<unknown> {
  return db.batch([
    db.prepare(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id         TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL,
        endpoint   TEXT NOT NULL UNIQUE,
        p256dh     TEXT NOT NULL,
        auth       TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `),
    db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_id
        ON push_subscriptions (user_id)
    `),
  ]);
}

/** Valid QueueSendResponse for stubbed producer sends in tests. */
export function fakeQueueSendResponse(): QueueSendResponse {
  return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
}

export interface SeedSubscription {
  userId: string;
  endpoint: string;
  p256dh?: string;
  auth?: string;
}

/**
 * Inserts many subscriptions in a few multi-row INSERT statements.
 * Row ids are ordered (`seed-00000`, `seed-00001`, ...), which makes
 * keyset-pagination assertions deterministic.
 */
export async function seedSubscriptions(db: D1Database, rows: SeedSubscription[]): Promise<void> {
  // D1 caps bound parameters per statement; 16 rows x 5 columns = 80 (safely under).
  for (let start = 0; start < rows.length; start += 16) {
    const chunk = rows.slice(start, start + 16);
    const values = chunk.map(() => "(?, ?, ?, ?, ?)").join(", ");
    const params = chunk.flatMap((row, i) => [
      `seed-${String(start + i).padStart(5, "0")}`,
      row.userId,
      row.endpoint,
      row.p256dh ?? "BPub",
      row.auth ?? "Auth",
    ]);
    await db
      .prepare(
        `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth) VALUES ${values}`,
      )
      .bind(...params)
      .run();
  }
}
