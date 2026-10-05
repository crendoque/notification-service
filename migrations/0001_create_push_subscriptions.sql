-- Push subscription storage for the notification worker.
-- One user can have many subscriptions (multiple browsers/devices).
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id         TEXT PRIMARY KEY,              -- deterministic: base64url(sha256(endpoint))
  user_id    TEXT NOT NULL,
  endpoint   TEXT NOT NULL UNIQUE,          -- push service endpoint URL
  p256dh     TEXT NOT NULL,                 -- client public encryption key (base64url)
  auth       TEXT NOT NULL,                 -- client auth secret (base64url)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_id
  ON push_subscriptions (user_id);
