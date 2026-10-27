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

import { env } from "cloudflare:test";

/**
 * Shallow copy of the test env with overrides — lets a single test simulate a
 * missing secret or an allowlist without touching .dev.vars.
 */
export function envWith(
  overrides: Partial<Record<keyof Cloudflare.Env, string>>,
): Cloudflare.Env {
  return { ...env, ...overrides } as Cloudflare.Env;
}

/**
 * Mirror of migrations/0002_create_email_requests.sql (IF NOT EXISTS so tests
 * can apply it on top of any pre-applied migrations).
 */
export function applyEmailSchema(db: D1Database): Promise<unknown> {
  return db.batch([
    db.prepare(`
      CREATE TABLE IF NOT EXISTS email_requests (
        seq             INTEGER PRIMARY KEY AUTOINCREMENT,
        id              TEXT NOT NULL UNIQUE,
        app             TEXT NOT NULL,
        user_id         TEXT NOT NULL,
        recipient       TEXT NOT NULL,
        mode            TEXT NOT NULL,
        subject         TEXT,
        template_id     TEXT,
        payload         TEXT NOT NULL,
        status          TEXT NOT NULL,
        resend_id       TEXT UNIQUE,
        attempts        INTEGER NOT NULL DEFAULT 0,
        error_name      TEXT,
        error_message   TEXT,
        last_event      TEXT,
        last_event_at   TEXT,
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
        sent_at         TEXT,
        delivered_at    TEXT,
        bounce_type     TEXT,
        bounce_sub_type TEXT,
        bounce_message  TEXT
      )
    `),
    db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_email_requests_app
        ON email_requests (app, seq)
    `),
    db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_email_requests_user
        ON email_requests (user_id, seq)
    `),
    db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_email_requests_status
        ON email_requests (status)
    `),
    db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_email_requests_resend
        ON email_requests (resend_id)
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS resend_webhook_events (
        svix_id         TEXT PRIMARY KEY,
        event_type      TEXT NOT NULL,
        resend_email_id TEXT,
        received_at     TEXT NOT NULL DEFAULT (datetime('now')),
        payload         TEXT NOT NULL
      )
    `),
    db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_resend_events_email
        ON resend_webhook_events (resend_email_id)
    `),
  ]);
}

/** Valid QueueSendResponse for stubbed producer sends in tests. */
export function fakeQueueSendResponse(): QueueSendResponse {
  return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
}

export interface SeedEmailRequest {
  id: string;
  recipient: string;
  app?: string;
  userId?: string;
  mode?: "template" | "inline";
  subject?: string | null;
  templateId?: string | null;
  payload?: string;
  status?: string;
  resendId?: string | null;
  attempts?: number;
}

/** Inserts email request rows for tests that only exercise the webhook/jobs. */
export async function seedEmailRequests(
  db: D1Database,
  rows: SeedEmailRequest[],
): Promise<void> {
  for (const row of rows) {
    await db
      .prepare(
        `INSERT INTO email_requests
           (id, app, user_id, recipient, mode, subject, template_id, payload, status, resend_id, attempts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        row.id,
        row.app ?? "test-app",
        row.userId ?? "user-1",
        row.recipient,
        row.mode ?? "inline",
        row.subject ?? "Hello",
        row.templateId ?? null,
        row.payload ?? JSON.stringify({ useTemplate: false, subject: "Hello", text: "Hi" }),
        row.status ?? "queued",
        row.resendId ?? null,
        row.attempts ?? 0,
      )
      .run();
  }
}

/** base64 (not url-safe) encoding of raw bytes — mirrors what Svix produces. */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** base64 decoding, tolerant of the padding Svix strips from `whsec_` secrets. */
export function fromBase64(value: string): Uint8Array {
  const padded = value + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Independent implementation of the Svix signature scheme (see
 * https://docs.svix.com/receiving/verifying-payloads/how-manual) so webhook
 * tests do not reuse the production code they are validating.
 * Returns the value of the `svix-signature` header, e.g. `v1,<base64>`.
 */
export async function signSvixPayload(
  secret: string,
  svixId: string,
  svixTimestamp: string,
  payload: string,
): Promise<string> {
  const key = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    fromBase64(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    new TextEncoder().encode(`${svixId}.${svixTimestamp}.${payload}`),
  );
  return `v1,${toBase64(new Uint8Array(signature))}`;
}

export interface SignedWebhookRequest {
  body: string;
  headers: Record<string, string>;
}

/** Builds a fully signed Resend webhook request body + headers. */
export async function signedWebhookRequest(
  secret: string,
  event: unknown,
  options: { svixId?: string; timestamp?: number } = {},
): Promise<SignedWebhookRequest> {
  const body = JSON.stringify(event);
  const svixId = options.svixId ?? `msg_${crypto.randomUUID()}`;
  const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
  const signature = await signSvixPayload(secret, svixId, timestamp, body);
  return {
    body,
    headers: {
      "svix-id": svixId,
      "svix-timestamp": timestamp,
      "svix-signature": signature,
    },
  };
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
