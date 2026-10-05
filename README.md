# notification-worker

Cloudflare Worker microservice that sends **Web Push notifications** for a PWA.
Email and SMS channels are planned as future phases under the same service.

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

- **Stack**: Wrangler v4 · TypeScript · Hono · Cloudflare D1 · `web-push-neo` (Web Push Protocol + VAPID, Web Crypto based)
- **Storage**: `push_subscriptions` table in D1 (one user → many devices)
- **Auth**: every `/v1/*` route requires `Authorization: Bearer <BACKEND_AUTH_TOKEN>`

---

## Local development

```bash
npm install
npm run setup:dev        # generates VAPID keypair + dev token into .dev.vars
npm run db:migrate:local # applies D1 migrations locally
npm run dev              # http://localhost:8787
```

Checks: `npm run typecheck` and `npm test` (runs inside workerd via `@cloudflare/vitest-plugin`).

## Production setup (once)

1. `npx wrangler d1 create notification-worker` → paste the `database_id` into `wrangler.jsonc`.
2. `npx wrangler queues create notification-push` → the queue the worker uses for large fan-outs (bound as `PUSH_QUEUE` in `wrangler.jsonc`).
3. Generate keys once (reuse your local pair so already-subscribed browsers keep working):
   ```bash
   npx wrangler secret put VAPID_PRIVATE_KEY    # from .dev.vars
   npx wrangler secret put BACKEND_AUTH_TOKEN   # a strong random string
   ```
4. Put `VAPID_PUBLIC_KEY` and `VAPID_SUBJECT` (e.g. `mailto:ops@yourdomain.com`) into `wrangler.jsonc` `vars`.
5. `npm run db:migrate:remote && npm run deploy`.

> ⚠️ VAPID keys are generate-once, use-forever. Rotating the keypair breaks
> delivery to every browser subscribed with the old public key.

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


### Error responses

| Status | Body | Meaning |
|---|---|---|
| `400` | `{"error":"invalid_request","details":{...}}` | Validation failed — check `details` |
| `400` | `{"error":"invalid_json"}` | Body is not valid JSON |
| `401` | `{"error":"unauthorized"}` | Missing/wrong bearer token |
| `404` | `{"error":"not_found"}` | Unknown route / subscription id |
| `500` | `{"error":"server_misconfigured"}` | `BACKEND_AUTH_TOKEN` secret not set |

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

- **Email** — `POST /v1/notifications/email` (Resend/SendGrid via `fetch`), same auth
- **SMS** — `POST /v1/notifications/sms` (Twilio via `fetch`), same auth
- **Dead-letter queue** — for broadcast jobs that exhaust retries (currently dropped after 3 retries)

