-- Email channel storage for the notification worker.
-- One row per caller trigger: the row holds the validated payload so queued
-- jobs and retries can always be replayed from D1 (queue messages stay tiny).
CREATE TABLE IF NOT EXISTS email_requests (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,  -- monotonic; drives keyset pagination
  id              TEXT NOT NULL UNIQUE,               -- uuid, returned to the caller in the 202
  app             TEXT NOT NULL,                      -- which app triggered this email
  user_id         TEXT NOT NULL,                      -- the app's own user id
  recipient       TEXT NOT NULL,                      -- the "To" address (To only)
  mode            TEXT NOT NULL,                      -- 'template' | 'inline'
  subject         TEXT,                               -- resolved subject
  template_id     TEXT,                               -- set when mode = 'template'
  payload         TEXT NOT NULL,                      -- validated request JSON (replay source)
  status          TEXT NOT NULL,                      -- queued|sent|delivered|delayed|bounced|complained|failed|suppressed|scheduled|canceled
  resend_id       TEXT UNIQUE,                        -- Resend email id (webhook correlation key)
  attempts        INTEGER NOT NULL DEFAULT 0,         -- queue delivery attempts
  error_name      TEXT,
  error_message   TEXT,
  last_event      TEXT,                               -- last Resend webhook event applied
  last_event_at   TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at         TEXT,
  delivered_at    TEXT,
  bounce_type     TEXT,
  bounce_sub_type TEXT,
  bounce_message  TEXT
);

CREATE INDEX IF NOT EXISTS idx_email_requests_app
  ON email_requests (app, seq);

CREATE INDEX IF NOT EXISTS idx_email_requests_user
  ON email_requests (user_id, seq);

CREATE INDEX IF NOT EXISTS idx_email_requests_status
  ON email_requests (status);

CREATE INDEX IF NOT EXISTS idx_email_requests_resend
  ON email_requests (resend_id);

-- Svix (Resend) retries reuse the same svix-id: this table dedupes deliveries
-- and doubles as an audit trail of everything the webhook received.
CREATE TABLE IF NOT EXISTS resend_webhook_events (
  svix_id         TEXT PRIMARY KEY,
  event_type      TEXT NOT NULL,
  resend_email_id TEXT,
  received_at     TEXT NOT NULL DEFAULT (datetime('now')),
  payload         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_resend_events_email
  ON resend_webhook_events (resend_email_id);
