# notification-worker

Cloudflare Worker microservice that sends **Web Push notifications** for a PWA and
**transactional email through Resend** (always asynchronous call, template-aware, with
delivery status tracked from Resend webhooks).
SMS is planned as a future phase under the same service.

```
PWA (browser)                Backend                    This Worker
     │                           │                           │
     │ pushManager.subscribe()   │                           │
     │──── sends subscription ───>│  PUT /v1/subscriptions   │
     │                           │──────────────────────────>│  (stored in D1)
     │  user action              │                           │
     │──────────────────────────>│  POST /v1/notifications/ │
     │                           │       push                │
     │  🔔 encrypted Web Push (sent directly to the browser)  │
     │<──────────────────────────────────────────────────────│
```

```
Calling app                  This Worker                     Resend
     │                            │                             │
     │ POST /v1/notifications/email│                            │
     │───────────────────────────>│ 202 { id, status:"queued" } │
     │                            │ (row in D1, job in the queue)
     │                            │──── POST /emails ──────────>│
     │                            │<─── 200 { id } ─────────────│  status: sent
     │                            │<─── email.sent/delivered ───│  (signed webhook)
     │ GET /v1/notifications/email/:id                           │
     │───────────────────────────>│ { status: "delivered" }     │
```

- **Stack**: Wrangler v4 · TypeScript · Hono · Cloudflare D1 · Cloudflare Queues · Cloudflare R2 · `web-push-neo` (Web Push Protocol + VAPID) · Resend (`fetch`)
- **Storage**: `push_subscriptions` (one user → many devices), `email_requests` (one row per email trigger, incl. the payload so retries are replayable), `resend_webhook_events` (webhook dedupe + audit), and the private R2 bucket `notification-attachments` (email attachment bytes; D1 holds only references)
- **Auth**: every `/v1/*` route requires `Authorization: Bearer <BACKEND_AUTH_TOKEN>`, **except** `POST /v1/webhooks/resend`, which Resend authenticates with a Svix signature

---

## Local development

```bash
npm install
npm run setup:dev        # generates VAPID keypair + dev token into .dev.vars
npm run db:migrate:local # applies D1 migrations locally
npm run dev              # http://localhost:8787
```

`setup:dev` does not create Resend credentials — add them to `.dev.vars`
(see `.dev.vars.example`):

```
RESEND_API_KEY=re_...              # https://resend.com/api-keys
RESEND_WEBHOOK_SECRET=whsec_...    # signing secret of the webhook you create
```

Without `RESEND_API_KEY` the email endpoint answers `500 server_misconfigured`.
See **[Testing the email channel in dev](#testing-the-email-channel-in-dev)** for
a step-by-step walkthrough (trigger → poll status → simulated webhook events).

Attachments need no local setup: `wrangler dev` provisions a local R2 bucket for the
`ATTACHMENTS` binding on its own.

Checks: `npm run typecheck` and `npm test` (runs inside workerd via `@cloudflare/vitest-plugin`).

---

## Testing the email channel in dev

Everything below runs against `npm run dev` (local D1 + local queue). Because the
worker never calls Resend from the request path, most of the flow is testable with
a placeholder API key. The examples use bash; adapt the quoting on PowerShell.

### 0. One-time setup

```bash
npm install
npm run setup:dev          # VAPID keys + BACKEND_AUTH_TOKEN into .dev.vars
npm run db:migrate:local   # applies 0001 (push) and 0002 (email)
```

Add the Resend values to `.dev.vars` (gitignored):

```
RESEND_API_KEY=re_dev_placeholder     # a real key only for live sends
RESEND_WEBHOOK_SECRET=whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw
```

- With `re_dev_placeholder` the send job fails fast with
  `error.name: "validation_error"` / `"API key is invalid"`. That is the expected
  local behaviour — it still exercises the whole async pipeline.
- `RESEND_WEBHOOK_SECRET` must be valid base64 after the `whsec_` prefix. The
  simulator reads it from `.dev.vars`, so the value just has to be consistent.

### 1. Start the worker

```bash
npm run dev      # http://localhost:8787
```

Keep this terminal visible: `email_queued`, `email_sent`, `email_send_retry`,
`email_send_failed`, `webhook_applied` and `webhook_unmatched` all log there.

### 2. Grab the token

```bash
TOKEN=$(grep '^BACKEND_AUTH_TOKEN=' .dev.vars | cut -d= -f2)
BASE=http://localhost:8787
```

### 3. Trigger an email (template mode)

```bash
curl -s -X POST "$BASE/v1/notifications/email" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{
        "app": "crm",
        "userId": "user-123",
        "email": "delivered@resend.dev",
        "payload": {
          "useTemplate": true,
          "templateId": "order-ready",
          "variables": { "name": "Ali", "orderId": "42" },
          "subject": "Your order is ready"
        }
      }'
```

Expect `202` with `"status":"queued"`. No Resend call happens in this request —
the job is on the queue.

### 4. Poll the status

```bash
curl -s "$BASE/v1/notifications/email/<id-from-step-3>" -H "Authorization: Bearer $TOKEN"
```

With the placeholder key the consumer runs and records a permanent failure:

```json
{ "status": "failed", "attempts": 1,
  "error": { "name": "validation_error", "message": "API key is invalid" } }
```

With a **real** `RESEND_API_KEY` you get `"status": "sent"` plus a `resendId`
(`56761188-7520-42d8-8898-ff6fc54ce618`) — note it down for the next step.


### 5. Simulate the Resend webhook

Resend cannot reach `localhost`, so sign and post the event yourself with the
bundled simulator (it uses the same Svix scheme Resend uses):

```bash
# with a real key: the resendId from step 4
npm run simulate:webhook -- --email-id 56761188-7520-42d8-8898-ff6fc54ce618 --type email.delivered
```

Without a real key there is no `resendId`, so seed one request that already has
one. Create `.wrangler/local-webhook-test.sql` (`.wrangler/` is gitignored):

```sql
INSERT INTO email_requests (id, app, user_id, recipient, mode, payload, status, resend_id)
VALUES ('local-webhook-test', 'crm', 'user-123', 'delivered@resend.dev', 'inline',
        '{"useTemplate":false,"subject":"Seed","text":"Seed"}', 'sent', 'resend-local-1');
```

```bash
npx wrangler d1 execute notification-db --local --file=.wrangler/local-webhook-test.sql
npm run simulate:webhook -- --email-id resend-local-1 --type email.delivered
```

Both print the API response:

```
POST http://localhost:8787/v1/webhooks/resend -> 200
{"received":true,"outcome":"applied","requestId":"local-webhook-test"}
```

Confirm the webhook upgraded the status:

```bash
curl -s "$BASE/v1/notifications/email/local-webhook-test" -H "Authorization: Bearer $TOKEN"
# { "status": "delivered", "deliveredAt": "...", "lastEvent": "email.delivered", ... }
```

### 6. Cases worth exercising

```bash
# Bounce — records bounce.type / subType / message, flips the status and is
# NEVER retried (a bounce is permanent)
npm run simulate:webhook -- --email-id resend-local-1 --type email.bounced

# Failed send — {"outcome":"requeued"}: the request goes back to "queued",
# attempts is incremented and the consumer retries it. After 3 attempts the
# request stays "failed" with error.name "retries_exhausted" and no job is queued.
npm run simulate:webhook -- --email-id resend-local-1 --type email.failed

# Any other event type is ignored (recorded in resend_webhook_events, status untouched)
npm run simulate:webhook -- --email-id resend-local-1 --type email.opened

# Duplicate delivery — replay the *same* svix-id (Svix reuses it when it retries):
# the second call answers {"outcome":"duplicate"} and is not reprocessed
npm run simulate:webhook -- --email-id resend-local-1 --type email.delivered --svix-id msg-fixed-1
npm run simulate:webhook -- --email-id resend-local-1 --type email.delivered --svix-id msg-fixed-1

# Out-of-order — after a delivered, send email.sent: the status stays "delivered"
# (the event is still recorded in lastEvent)
npm run simulate:webhook -- --email-id resend-local-1 --type email.delivered
npm run simulate:webhook -- --email-id resend-local-1 --type email.sent

# Unknown email id -> HTTP 200 {"outcome":"unmatched"} (so Svix stops retrying)
npm run simulate:webhook -- --email-id not-ours

# Bad signature -> HTTP 400 invalid_signature
npm run simulate:webhook -- --email-id resend-local-1 --type email.sent \
  --secret whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw
```

The webhook route takes **no bearer token** (it is Svix-signature authenticated),
which you can prove with plain curl:

```bash
curl -i -X POST "$BASE/v1/webhooks/resend" -H 'Content-Type: application/json' -d '{}'
# HTTP 400 {"error":"missing_signature_headers"}   <- not 401
```

Simulator flags:

| Flag | Default | Purpose |
|---|---|---|
| `--email-id` | — (required) | Resend email id to correlate on |
| `--type` | `email.delivered` | Any Resend event type (`email.sent`, `email.bounced`, …) |
| `--requestId` | — | Adds the `request_id` tag, which lets the webhook recover a request whose `resend_id` was never stored |
| `--svix-id` | random | Reuse a fixed id to replay the same delivery (tests duplicate suppression) |
| `--to` | `delivered@resend.dev` | Recipient echoed in the event |
| `--url` | `http://localhost:8787/v1/webhooks/resend` | Override the target |
| `--secret` | `RESEND_WEBHOOK_SECRET` from `.dev.vars` | Sign with another secret (to test rejection) |

### 7. Validate requests without sending

```bash
# To-only enforcement (cc/bcc/to/headers/tags are rejected)
curl -s -X POST "$BASE/v1/notifications/email" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"app":"crm","userId":"u1","email":"a@b.com","payload":{"useTemplate":false,"subject":"s","text":"t","cc":"x@y.com"}}'
# 400 {"error":"unsupported_field","fields":["cc"],...}

# Attachments (multipart). Local dev uses a local R2 bucket automatically, so
# this stages the file, queues the job and deletes it again on delivery.
printf '%s' '{"app":"crm","userId":"u1","email":"a@b.com","payload":{"useTemplate":false,"subject":"Invoice","text":"Attached","attachments":[{"field":"invoice","filename":"invoice.pdf"}]}}' > /tmp/body.json
curl -s -X POST "$BASE/v1/notifications/email" \
  -H "Authorization: Bearer $TOKEN" \
  -F 'payload=@/tmp/body.json;type=application/json' \
  -F 'invoice=@/tmp/invoice.pdf;type=application/pdf'
# 202 { ..., "attachments":[{"filename":"invoice.pdf","contentType":"application/pdf","size":...}] }

# A file part with no matching `field` (and vice versa) is rejected up front:
# 400 {"error":"attachment_part_missing","fields":["invoice"],...}
# 400 {"error":"attachment_part_undeclared","fields":["invoice"],...}
```

Also worth trying: `useTemplate: true` without `templateId`, `useTemplate: true`
together with `html`, `useTemplate: false` without `subject`/body, a missing or
badly-cased `app`, `payload.from` that is not allowlisted, and the same call
without the `Authorization` header (`401`). For attachments: an empty file, a
file over 15 MB (`413`), and a blocklisted extension such as `setup.exe` (`415`).

### 8. Inspect the local database

```bash
npx wrangler d1 execute notification-db --local --command \
  "SELECT id, app, status, resend_id, attempts, error_name FROM email_requests ORDER BY seq DESC LIMIT 10"

npx wrangler d1 execute notification-db --local --command \
  "SELECT svix_id, event_type, resend_email_id, received_at FROM resend_webhook_events ORDER BY received_at DESC LIMIT 10"
```

The local D1 file lives in `.wrangler/state/v3/d1`.

### 9. Automated tests

```bash
npm run typecheck
npm test                                     # full suite: workerd, offline, no Resend calls
npx vitest run test/resend-webhook.test.ts   # just signature + status handling
npx vitest run test/email-jobs.test.ts       # just the queue/retry behaviour
```

Tests stub the outbound `fetch` and generate real Svix signatures in-process, so
they never hit the network and never need a Resend key.

### 10. Optional: let real Resend call your dev server

`wrangler dev` has no public URL. To receive genuine webhooks locally, expose it
(`cloudflared tunnel --url http://localhost:8787` or `ngrok http 8787`), point a
Resend webhook at `https://<tunnel>/v1/webhooks/resend`, copy that webhook's
signing secret into `RESEND_WEBHOOK_SECRET` and restart `npm run dev`. Otherwise
the simulator is enough — it takes the identical verification path.

## Production setup (once)

1. `npx wrangler d1 create notification-db` → paste the `database_id` into `wrangler.jsonc`.
2. `npx wrangler queues create notification-push` → the queue the worker uses for push fan-outs **and** email delivery (bound as `PUSH_QUEUE` in `wrangler.jsonc`).
3. Generate keys once (reuse your local pair so already-subscribed browsers keep working):
   ```bash
   npx wrangler secret put VAPID_PRIVATE_KEY    # from .dev.vars
   npx wrangler secret put BACKEND_AUTH_TOKEN   # a strong random string
   ```
4. Put `VAPID_PUBLIC_KEY` and `VAPID_SUBJECT` (e.g. `mailto:ops@yourdomain.com`) into `wrangler.jsonc` `vars`.
5. **Email (Resend)**:
   ```bash
   npx wrangler secret put RESEND_API_KEY         # https://resend.com/api-keys
   npx wrangler secret put RESEND_WEBHOOK_SECRET  # from the webhook you create below
   ```
   - Set `EMAIL_FROM` in `wrangler.jsonc` `vars` to an address on a **domain verified in Resend**.
   - Optionally set `EMAIL_ALLOWED_SENDERS` (comma-separated `from` allowlist) and
     `EMAIL_ALLOWED_APPS` (comma-separated app ids allowed to trigger email).
   - Create a webhook in the Resend dashboard pointing at
     `https://notification-worker.<your-subdomain>.workers.dev/v1/webhooks/resend`
     subscribed to: `email.sent`, `email.delivered`, `email.delivery_delayed`,
     `email.bounced`, `email.complained`, `email.failed`, `email.suppressed`.
     Copy its signing secret into `RESEND_WEBHOOK_SECRET`.
6. **Attachments (R2)**: create the private bucket the email trigger stages files in.
   ```bash
   npx wrangler r2 bucket create notification-attachments
   ```
   Leave it **private** — no `r2.dev` domain, no custom domain, no signed URLs. The
   worker is the only reader, and objects are deleted as soon as the email reaches a
   terminal delivery state, so no lifecycle rule is needed. If you also want a
   backstop against objects orphaned by a webhook that never arrives, add one:
   ```bash
   npx wrangler r2 bucket lifecycle add notification-attachments expire-orphans attachments/ --expire-days 30
   ```
7. `npm run db:migrate:remote && npm run deploy`.

> ⚠️ VAPID keys are generate-once, use-forever. Rotating the keypair breaks
> delivery to every browser subscribed with the old public key.

> ⚠️ Until a domain is verified in Resend, the API only accepts your own address
> as a recipient and answers `403 validation_error` for anything else. The
> request then shows up as `status: "failed"` with `error.name: "validation_error"`.

---

## Endpoint contract

**Base URL** (dev): `http://localhost:8787` — (prod): `https://notification-worker.<your-subdomain>.workers.dev`

**All `/v1/*` routes require the header:**

```
Authorization: Bearer <BACKEND_AUTH_TOKEN>
```

`GET /health` is public.

### 1. `PUT /v1/subscriptions` — register a browser subscription

Called when the PWA subscribes (or re-subscribes) to push. **Idempotent** —
safe to call repeatedly with the same endpoint.

Request:

```json
{
  "userId": "user-123",
  "subscription": {
    "endpoint": "https://fcm.googleapis.com/fcm/send/...",
    "keys": { "p256dh": "BNb...", "auth": "a-b..." }
  }
}
```

- `userId` — your app's user id (string, 1–256 chars)
- `subscription` — the browser's `PushSubscription` exactly as
  `subscription.toJSON()` produces it. Forward it unchanged.

Response `200`:

```json
{ "id": "dowjDeZqlS8QctDL1-5eBf6...", "endpoint": "https://fcm.googleapis.com/..." }
```

`id` is deterministic (`base64url(sha256(endpoint))`) — keep it if you want to
DELETE later, or recompute it from the endpoint.

### 2. `DELETE /v1/subscriptions/:id` — remove a subscription

Called when the user unsubscribes in the PWA. Unknown id → `404`.

Response: `204 No Content`.

### 3. `GET /v1/config/vapid-public-key` — public key for subscribing

Response `200`: `{ "publicKey": "BG6ad..." }`

The PWA needs this value as `applicationServerKey` in
`pushManager.subscribe()`. Expose it to the frontend through your backend
(or proxy this route).

### 4. `POST /v1/notifications/push` — trigger a push (the main endpoint)

Called by the backend **after an action completes**. Sends to every device
the user has registered and returns a summary.

Request:

```json
{
  "userId": "user-123",
  "title": "Export ready",
  "body": "Your report finished generating.",
  "url": "https://app.example.com/reports/42",
  "icon": "/icons/badge-192.png",
  "tag": "export-done",
  "urgency": "normal",
  "ttl": 86400,
  "data": { "reportId": 42 }
}
```
| Field | Type | Required | Notes |
|---|---|---|---|
| `userId` | string | ✅ | Target user; all their devices are notified |
| `title` | string | ✅ | Notification title (≤200) |
| `body` | string | ✅ | Notification body (≤2000) |
| `url` | string | — | Opened/focused when the notification is clicked |
| `icon` | string | — | Icon URL |
| `tag` | string | — | Coalesces notifications; replaces the same-tag one (≤32) |
| `urgency` | `very-low`\|`low`\|`normal`\|`high` | — | Default `normal` |
| `ttl` | int | — | Seconds the push service retries offline devices. Default `86400` |
| `data` | object | — | Arbitrary JSON delivered to the service worker |

Response `200`:

```json
{ "userId": "user-123", "delivered": 2, "failed": 0, "removed": 1 }
```

- `delivered` — accepted by a push service (the device may be offline; it shows when it comes online if within `ttl`)
- `failed` — rejected with a non-expiry error (e.g. push service 5xx); the subscription is kept
- `removed` — subscriptions the push service reported `404`/`410` (user cleared browser data), automatically deleted

**A user with no registered subscriptions is not an error** — you get `delivered: 0`.

### 5. `POST /v1/notifications/push/batch` — notify a list of users

Same message fields as mode 1, but with `userIds` (1–500 unique users, duplicates are ignored).

```json
{
  "userIds": ["user-1", "user-47", "user-102"],
  "title": "Budget sheet updated",
  "body": "Q3 figures were just revised.",
  "url": "https://app.example.com/sheets/q3"
}
```

**Adaptive delivery:** if the total device count is ≤500, sending happens
synchronously and you get a full per-user summary:

```json
{
  "results": [
    { "userId": "user-1",  "delivered": 2, "failed": 0, "removed": 0 },
    { "userId": "user-47", "delivered": 1, "failed": 0, "removed": 1 },
    { "userId": "user-102", "delivered": 0, "failed": 0, "removed": 0 }
  ],
  "notifiedUsers": 2,
  "skippedUsers": 1
}
```

If the fan-out would exceed 500 devices, the worker instead enqueues 50-user
chunks onto its internal queue and returns immediately:

```json
{ "queued": true, "queuedUsers": 251 }
```

Chunk larger lists client-side (≤500 users per call, deduplicated).

### 6. `POST /v1/notifications/push/all` — broadcast to everyone

Sends to **every user with at least one subscription**. Always asynchronous:
the worker enqueues a self-chaining job that walks the subscription table in
100-device pages, so it scales to any number of devices.

```json
{
  "title": "Scheduled maintenance tonight",
  "body": "The app will be down 02:00–03:00 UTC.",
  "url": "https://app.example.com/status",
  "tag": "maintenance",
  "dryRun": false
}
```

- `dryRun: true` — returns recipient counts **without enqueuing anything**.
  Strongly recommended before any production broadcast.

Response `200`:

```json
{ "queued": true, "estimatedUsers": 420, "estimatedDevices": 512 }
```

Delivery then proceeds via the queue consumer over the following seconds/minutes
(check Workers Logs / Traces for `broadcast_page_processed` lines). Note: if a
consumer invocation fails mid-page, Cloudflare retries the message
(`max_retries: 3`) — devices already notified in that page may get a duplicate
notification. This is the accepted trade-off vs. exactly-once complexity.


### 7. `POST /v1/notifications/email` — trigger an email (always asynchronous)

Called by any app when it wants to email a user. **Nothing is sent inline**: the
worker validates the request, stores it in D1 and enqueues a job, then answers
immediately. Resend is called by the queue consumer.

Request (template mode — the usual path):

```json
{
  "app": "crm",
  "userId": "user-123",
  "email": "user@example.com",
  "payload": {
    "useTemplate": true,
    "templateId": "order-ready",
    "variables": { "name": "Ali", "orderId": "42" },
    "subject": "Your order is ready"
  }
}
```

Request (inline mode):

```json
{
  "app": "crm",
  "userId": "user-123",
  "email": "user@example.com",
  "payload": {
    "useTemplate": false,
    "subject": "Export finished",
    "html": "<p>Your report is ready.</p>",
    "text": "Your report is ready."
  }
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `app` | string | ✅ | Which app triggered the email (`^[a-z0-9][a-z0-9_-]*$`, ≤64) |
| `userId` | string | ✅ | The app's own user id |
| `email` | string | ✅ | The recipient — always sent as **To** |
| `payload.useTemplate` | boolean | ✅ | `true` → Resend template, `false` → inline content |
| `payload.templateId` | string | ✅ when template | Resend template **id or alias** |
| `payload.variables` | object | — | Template variables (string/number values) |
| `payload.subject` | string | ✅ inline, — template | Overrides the template default subject |
| `payload.html` / `payload.text` | string | ✅ inline | At least one; `useTemplate` must be `false` |
| `payload.from` | string | — | Only accepted if listed in `EMAIL_ALLOWED_SENDERS` |
| `payload.replyTo` | string \| string[] | — | Reply-to address(es) |
| `payload.scheduledAt` | string | — | ISO 8601 or natural language, e.g. `in 1 min` |
| `payload.idempotencyKey` | string | — | Passed to Resend's `Idempotency-Key` header |
| `payload.attachments[]` | object[] | — | Files to attach (≤10). **Omit entirely** to send without attachments |
| `payload.attachments[].field` | string | ✅ per entry | Name of the multipart part carrying the file |
| `payload.attachments[].filename` | string | — | Overrides the part's filename (no path separators) |
| `payload.attachments[].content_type` | string | — | Overrides the part's MIME type |
| `payload.attachments[].content_id` | string | — | Embeds the file inline, e.g. `<img src="cid:logo">` |

`payload.to`, `cc`, `bcc`, `headers` and `tags` are **rejected** with
`400 unsupported_field` — the recipient always comes from `email`, and the
worker manages its own tags.

A send with `scheduledAt` is reported as `sent` (Resend accepted it) and is
confirmed later by the `email.sent` / `email.delivered` webhooks.

#### Attachments (`multipart/form-data`)

Attachments are **optional**. Send the same JSON as a `payload` part, plus one file
part per attachment; each entry of `payload.attachments` names the part carrying its
bytes through `field`.

```http
POST /v1/notifications/email
Content-Type: multipart/form-data

part "payload"  (application/json)
{
  "app": "crm",
  "userId": "user-123",
  "email": "user@example.com",
  "payload": {
    "useTemplate": false,
    "subject": "Your invoice",
    "html": "<p>Invoice attached.</p>",
    "attachments": [
      { "field": "invoice",   "filename": "invoice-1042.pdf", "content_type": "application/pdf" },
      { "field": "statement", "content_id": "statement" }
    ]
  }
}

part "invoice"    (application/pdf) — 48,211 bytes
part "statement"  (image/png)       —  8,123 bytes
```

```bash
curl -X POST "$BASE/v1/notifications/email" \
  -H "Authorization: Bearer $TOKEN" \
  -F 'payload=@email-body.json;type=application/json' \
  -F 'invoice=@./invoice-1042.pdf' \
  -F 'statement=@./statement.png'
```

A plain `application/json` body — or a multipart body with no file parts — sends an
email with no files, exactly as before.

The bytes are staged in the **private** R2 bucket `notification-attachments`; D1
stores only a reference, so the stored payload stays tiny and every retry replays the
identical bytes. The recipient receives a **real attached file**: no link, no URL and
no shared-storage reference is ever created or exposed.

| Rule | Value |
|---|---|
| Files per request | ≤ 10 |
| Size per file | ≤ 15 MB |
| Total per request | ≤ 15 MB |
| Resend ceiling | 40 MB per email (measured after base64) |

The 15 MB cap comes from two platform limits: the stored payload must stay far inside
D1's 2 MB row limit, and send-time peak memory is roughly 3.7× the file size (raw
bytes + base64 + the JSON copy) — so 15 MB is about 56 MB inside a 128 MB isolate.
Both are the constants `EMAIL_MAX_ATTACHMENT_BYTES` and
`EMAIL_MAX_TOTAL_ATTACHMENT_BYTES` in `src/validation.ts`.

Resend refuses a fixed list of executable/script extensions; those are rejected up
front with `415` (see
[Resend's list](https://resend.com/docs/knowledge-base/what-attachment-types-are-not-supported)).
Filenames containing path separators or control characters are rejected with `400`.

**Lifecycle.** Staged bytes are deleted as soon as the email can no longer be retried:

| Event | Staged files |
|---|---|
| `email.delivered` | **deleted** |
| `email.bounced` | **deleted** — permanent, never retried |
| `email.failed` → re-queued | **kept** — the next attempt still needs them |
| `email.failed` → retries exhausted | **deleted** |
| Permanent send failure in the worker | **deleted** |
| Upload / enqueue failure | **deleted** (rolled back) |

A webhook that never arrives (Svix gives up, or a `suppressed` / `complained` event,
which this worker only observes) leaves its object behind. Add the optional lifecycle
rule from the production setup if you want a backstop for that.

Attachment-specific errors:

| Status | `error` | When |
|---|---|---|
| `400` | `attachment_part_missing` | A `payload.attachments[].field` has no matching file part |
| `400` | `attachment_part_undeclared` | A file part is not declared in `payload.attachments` |
| `400` | `invalid_request` | Empty file, unusable filename, or a duplicate `field` |
| `413` | `file_too_large` | One file exceeds 15 MB |
| `413` | `payload_too_large` | The files together exceed 15 MB |
| `415` | `unsupported_media_type` | Resend will not send that file extension |
| `502` | `attachment_upload_failed` | Staging the bytes in R2 failed |

Response `202`:

```json
{
  "id": "3f1c9b7e-2a41-4f0d-9c2e-1a5b8d6f0e21",
  "app": "crm",
  "userId": "user-123",
  "recipient": "user@example.com",
  "mode": "inline",
  "subject": "Your invoice",
  "templateId": null,
  "status": "queued",
  "attachments": [
    { "filename": "invoice-1042.pdf", "contentType": "application/pdf", "size": 48211 }
  ],
  "createdAt": "2026-10-27T10:00:00.000Z"
}
```

`attachments` is `null` when the request carries none, and it only ever holds
metadata — the bytes stay in R2.

### 8. `GET /v1/notifications/email/:id` — delivery status

```json
{
  "id": "3f1c9b7e-…",
  "app": "crm",
  "userId": "user-123",
  "recipient": "user@example.com",
  "mode": "template",
  "templateId": "order-ready",
  "status": "delivered",
  "attachments": [
    { "filename": "invoice-1042.pdf", "contentType": "application/pdf", "size": 48211 }
  ],
  "resendId": "56761188-7520-42d8-8898-ff6fc54ce618",
  "attempts": 1,
  "createdAt": "2026-10-27T10:00:00.000Z",
  "updatedAt": "2026-10-27T10:00:02.000Z",
  "sentAt": "2026-10-27T10:00:00.500Z",
  "deliveredAt": "2026-10-27T10:00:02.000Z",
  "lastEvent": "email.delivered",
  "lastEventAt": "2026-10-27T10:00:02.000Z",
  "error": null,
  "bounce": null
}
```

Unknown id → `404 {"error":"not_found"}`.

**Status values** — only five, and only four webhook events are maintained:

| Status | Set by | Meaning |
|---|---|---|
| `queued` | the worker | Stored / re-queued, waiting for the queue consumer |
| `sent` | Resend API `200`, or webhook `email.sent` | Resend accepted the message (`resendId` is stored) |
| `delivered` | webhook `email.delivered` | Delivered to the recipient's mail server |
| `bounced` | webhook `email.bounced` | Permanently rejected — **never retried** (`bounce` holds the details) |
| `failed` | worker, or webhook `email.failed` | Send failure — **retried** while attempts remain, otherwise terminal (`error.name`) |

**Webhook events acted on.** Everything else (`email.opened`, `email.clicked`,
`email.delivery_delayed`, `email.complained`, `email.suppressed`, `domain.*`, …) is
stored in `resend_webhook_events` for audit and answered with
`outcome: "ignored"` — no status change.

| Event | Effect |
|---|---|
| `email.sent` | status → `sent` |
| `email.delivered` | status → `delivered` |
| `email.bounced` | status → `bounced` (+ bounce details) — **terminal, never retried** |
| `email.failed` | status → `failed`, then **re-queued for another attempt** (up to 3 total attempts, the same budget the queue retries use). Once the budget is used up the request stays `failed` with `error.name: "retries_exhausted"` |

Statuses are ranked (`queued < sent < failed < delivered < bounced`), so a late or
out-of-order event never downgrades a request: an `email.failed` arriving after
`email.delivered` is recorded in `lastEvent` but never triggers a retry, and a
late `email.sent` cannot undo a `bounced`/`delivered` result.

### 9. `GET /v1/notifications/email` — email history

Newest first, keyset paginated.

```
GET /v1/notifications/email?userId=user-123&limit=50
GET /v1/notifications/email?app=crm&status=failed
GET /v1/notifications/email?afterSeq=1042
```

| Query | Default | Notes |
|---|---|---|
| `userId` | — | Filter by the app's user id |
| `app` | — | Filter by triggering app |
| `status` | — | Filter by status |
| `limit` | `50` | 1–100 |
| `afterSeq` | — | Cursor: pass `nextAfterSeq` from the previous page |

```json
{ "requests": [ { "id": "3f1c9b7e-…", "status": "delivered", "…": "…" } ], "nextAfterSeq": null }
```

### 10. `POST /v1/webhooks/resend` — inbound Resend events

Resend calls this route when the delivery status changes. It is **not**
protected by the bearer token — Resend authenticates with a Svix signature
(`svix-id`, `svix-timestamp`, `svix-signature`), which the worker verifies
against `RESEND_WEBHOOK_SECRET` over the raw body, with a ±5 min replay window.
Delivery is deduplicated on `svix-id`.

```json
{ "received": true, "outcome": "applied", "requestId": "3f1c9b7e-…" }
```

| `outcome` | Meaning |
|---|---|
| `applied` | Matched a request and updated its status |
| `requeued` | `email.failed` → the request was put back on the queue for another attempt |
| `duplicate` | This `svix-id` was already processed |
| `unmatched` | No request has that `email_id` (e.g. an email sent outside this worker) |
| `ignored` | Event type the worker does not maintain (anything but the four above) |

The route always answers `2xx` for verified events (even unmatched ones) so Svix
stops retrying; it answers `400` for a bad signature/timestamp and
`500 server_misconfigured` when `RESEND_WEBHOOK_SECRET` is missing.



### Error responses

| Status | Body | Meaning |
|---|---|---|
| `400` | `{"error":"invalid_request","details":{...}}` | Validation failed — check `details` |
| `400` | `{"error":"invalid_json"}` | Body is not valid JSON |
| `400` | `{"error":"unsupported_field","fields":[...]}` | Email payload used `to`/`cc`/`bcc`/`headers`/`tags` |
| `400` | `{"error":"unknown_app"}` | `app` is not in `EMAIL_ALLOWED_APPS` |
| `400` | `{"error":"from_not_allowed"}` | `payload.from` is not in `EMAIL_ALLOWED_SENDERS` |
| `400` | `{"error":"invalid_query","details":{...}}` | Bad listing query (e.g. `limit=0`) |
| `401` | `{"error":"unauthorized"}` | Missing/wrong bearer token |
| `404` | `{"error":"not_found"}` | Unknown route, subscription id or email id |
| `500` | `{"error":"server_misconfigured"}` | `BACKEND_AUTH_TOKEN`, `RESEND_API_KEY`/`EMAIL_FROM` or `RESEND_WEBHOOK_SECRET` missing |

### curl examples

```bash
TOKEN="your-backend-auth-token"
BASE="http://localhost:8787"

# Mode 1 — one user
curl -X POST "$BASE/v1/notifications/push" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"userId":"user-123","title":"Export ready","body":"Your report finished generating.","url":"https://app.example.com/reports/42"}'

# Mode 2 — a list of users
curl -X POST "$BASE/v1/notifications/push/batch" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"userIds":["user-1","user-47"],"title":"Budget sheet updated","body":"Q3 figures were just revised."}'

# Mode 3 — broadcast (dry-run first, then real)
curl -X POST "$BASE/v1/notifications/push/all" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"title":"Maintenance","body":"Down 02:00-03:00 UTC.","dryRun":true}'

curl -X POST "$BASE/v1/notifications/push/all" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"title":"Maintenance","body":"Down 02:00-03:00 UTC."}'

# Register a subscription
curl -X PUT "$BASE/v1/subscriptions" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"userId":"user-123","subscription":{"endpoint":"https://push.example.com/s/abc","keys":{"p256dh":"...","auth":"..."}}}'

# Email — template mode (async: returns 202 with an id to poll)
curl -X POST "$BASE/v1/notifications/email" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"app":"crm","userId":"user-123","email":"user@example.com","payload":{"useTemplate":true,"templateId":"order-ready","variables":{"name":"Ali","orderId":"42"},"subject":"Your order is ready"}}'

# Email — inline mode
curl -X POST "$BASE/v1/notifications/email" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"app":"crm","userId":"user-123","email":"user@example.com","payload":{"useTemplate":false,"subject":"Export finished","html":"<p>Your report is ready.</p>"}}'

# Email — with an attachment (multipart; the JSON goes in the `payload` part)
# body.json = {"app":"crm","userId":"user-123","email":"user@example.com",
#              "payload":{"useTemplate":false,"subject":"Your invoice",
#                         "html":"<p>Attached.</p>",
#                         "attachments":[{"field":"invoice","filename":"invoice-1042.pdf"}]}}
curl -X POST "$BASE/v1/notifications/email" \
  -H "Authorization: Bearer $TOKEN" \
  -F 'payload=@body.json;type=application/json' \
  -F 'invoice=@./invoice-1042.pdf;type=application/pdf'

# Email — delivery status / history
curl "$BASE/v1/notifications/email/3f1c9b7e-2a41-4f0d-9c2e-1a5b8d6f0e21" -H "Authorization: Bearer $TOKEN"
curl "$BASE/v1/notifications/email?userId=user-123&limit=10" -H "Authorization: Bearer $TOKEN"

# Email — simulate a Resend webhook locally (signed, no bearer token)
npm run simulate:webhook -- --email-id 56761188-7520-42d8-8898-ff6fc54ce618 --type email.delivered
```

---

## What the backend must prepare

1. **Store the worker's shared secret** (`BACKEND_AUTH_TOKEN`) in your backend's
   secrets config and always send it as `Authorization: Bearer <token>`.
2. **Endpoint #1 — subscription intake.** Add an endpoint your PWA can call
   with the browser's `PushSubscription` JSON. Forward it with the authenticated
   user's id to `PUT /v1/subscriptions`. Call it:
   - after the browser subscribes for the first time
   - on the service worker's `pushsubscriptionchange` event (browser rotated
     the subscription) — PUT is idempotent, so just re-send
   - when the user re-enables notifications
3. **Endpoint #2 — unsubscribe.** When the user opts out, call
   `DELETE /v1/subscriptions/:id` with the id returned from registration
   (or `base64url(sha256(endpoint))`; you may also PUT first and use its id).
4. **Expose the VAPID public key to the PWA** — proxy
   `GET /v1/config/vapid-public-key` or embed its value at build time.
5. **Trigger notifications** — pick the mode for the action, based on your
   membership rules (which live entirely in *your* backend):
   - action concerns **one user** ("your export is ready")
     → `POST /v1/notifications/push` with `userId`. Fire-and-forget: the
     `delivered/failed/removed` summary is informational; don't retry on
     `failed` unless the notification is critical.
   - action concerns **a resolved group** ("notify all pro members") — query
     your membership data for the eligible `userIds`, then
     `POST /v1/notifications/push/batch` (≤500 users per call, chunk larger lists).
     You get a synchronous per-user summary when the fan-out is small, or
     `{ "queued": true }` when it is large.
   - action concerns **everyone** ("scheduled maintenance") —
     `POST /v1/notifications/push/all`. Send a `dryRun: true` call first to
     preview the recipient count, then the real call. Delivery is asynchronous.
6. **Send email** — `POST /v1/notifications/email` with the triggering `app`
   label, the user's `userId` + `email`, and a `payload` that is either a Resend
   template (`useTemplate: true` + `templateId` + `variables`) or inline
   `subject`/`html`/`text` (`useTemplate: false`). It answers `202` with an `id`;
   nothing is sent in the request path.
7. **Track email status** — poll `GET /v1/notifications/email/:id` (or list with
   `?userId=`) until `status` leaves `queued`. `sent` means Resend accepted the
   message; `delivered`, `bounced` and `failed` come from Resend webhooks. A
   `bounced` request is final (never retried), while an `email.failed` webhook
   makes the worker retry the send on its own (bounded to 3 attempts) — so treat
   `failed` with `error.name: "retries_exhausted"` as terminal. Store the returned
   `id` next to your own record if you want to surface it in your UI.

> Email is **always asynchronous**: the worker never calls Resend inline. A
> transient Resend failure (429/5xx/network) is retried by Cloudflare Queues
> (`max_retries: 3`) and the request row is replayed from D1, so what you sent is
> exactly what gets delivered on retry.

## PWA payload contract (for reference)

The push payload delivered to the service worker's `push` event is:

```json
{ "title": "...", "body": "...", "url": "...", "icon": "...", "tag": "...", "data": null }
```

`public/sw.js`:

```js
self.addEventListener("push", (event) => {
  const p = event.data.json();
  event.waitUntil(self.registration.showNotification(p.title, {
    body: p.body,
    icon: p.icon ?? undefined,
    tag: p.tag ?? undefined,
    data: p.data,
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const p = { url: "/" };
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true })
      .then((list) => {
        for (const client of list) {
          if ("focus" in client) return client.focus();
        }
        return self.clients.openWindow(p.url);
      })
  );
});
```

## Roadmap

### Shipped

**Push** — `PUT/DELETE /v1/subscriptions`, `POST /v1/notifications/push`
(single / batch / broadcast), VAPID public-key config, expired-subscription
pruning, queue-backed fan-out.

**Email (Resend)** — `POST /v1/notifications/email`, always asynchronous
(`202 { id, status: "queued" }` + poll), template **or** inline payloads,
`app` attribution, optional **file attachments** staged in a private R2 bucket
(multipart, ≤10 files / 15 MB, released once the email can no longer be retried),
per-request status persisted in D1, queue retries, and delivery
status refined by signed Resend webhooks (`POST /v1/webhooks/resend`).

| Concern | Where it lives |
|---|---|
| Trigger, validation, `202` response, multipart parsing | `src/index.ts`, `src/validation.ts` |
| Resend client, payload build, error classification | `src/email.ts` |
| R2 staging, base64 encoding, attachment cleanup keys | `src/attachments.ts` |
| Queue job + retry/permanent-failure handling | `src/email-jobs.ts` |
| Svix signature verification, event → status mapping, attachment release | `src/resend-webhook.ts` |
| Request rows, status ranking, webhook dedupe | `src/db.ts`, `migrations/0002_create_email_requests.sql` |
| Private attachment bucket | R2 `notification-attachments` (the `ATTACHMENTS` binding in `wrangler.jsonc`) |
| Local webhook simulator | `scripts/simulate-resend-webhook.mjs` |

### Next

1. **Email batch / announcement** — one shared `payload` fanned out to a list of
   `{ userId, email }` recipients, mirroring `push/batch`. The hooks are already in
   place: store the payload once in a parent row (plus a `batch_id` on
   `email_requests`), enqueue `ceil(n / 100)` `email-send` jobs and send each chunk
   through Resend's `/emails/batch` endpoint. Status then aggregates per batch
   (`SELECT status, COUNT(*) … WHERE batch_id = ? GROUP BY status`), and every
   recipient keeps its own `resend_id`, so webhooks correlate exactly as today.
   Recipient addresses stay private because each recipient gets its own email.
2. **SMS** — `POST /v1/notifications/sms` (Twilio via `fetch`), same auth and the
   same async shape (`queued → sent → delivered/failed`, provider webhook for
   status), reusing the `email_requests` pattern with a `channel` column.
3. **Dead-letter queue** — Cloudflare Queues drops a message after
   `max_retries: 3`. Add a DLQ as the consumer's `dead_letter_queue` and alert on
   its backlog; the request is already marked
   `failed` with `error.name: "retries_exhausted"`.
4. **Retention / pruning** — a `scheduled` handler (cron trigger) deleting
   `email_requests` and `resend_webhook_events` older than N days; the
   `app, seq` and `user_id, seq` indexes already support it. The same handler is the
   natural home for sweeping attachment objects orphaned by a webhook that never
   arrived — today the only backstop for those is the optional R2 lifecycle rule.
5. **Engagement + opt-out** — track `email.opened` / `email.clicked` (currently
   ignored) and add an unsubscribe/opt-out flag that the email trigger checks
   before enqueueing.
6. **Housekeeping** — rename the `PUSH_QUEUE` binding to `NOTIFICATION_QUEUE` now
   that it carries both channels, and add a per-app rate limit for email triggers.

