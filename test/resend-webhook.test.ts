import { afterEach, beforeEach, beforeAll, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { app } from "../src/index";
import { attachmentKey } from "../src/attachments";
import {
  applyEmailSchema,
  applyPushSchema,
  envWith,
  fakeQueueSendResponse,
  seedEmailRequests,
  signSvixPayload,
  signedWebhookRequest,
} from "./schema";

const SECRET = env.RESEND_WEBHOOK_SECRET;
const OTHER_SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";

async function postWebhook(
  body: string,
  headers: Record<string, string>,
  bindings: Cloudflare.Env = env,
) {
  return app.request(
    "/v1/webhooks/resend",
    { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body },
    bindings,
  );
}

function event(type: string, emailId: string, extra: Record<string, unknown> = {}) {
  return {
    type,
    created_at: "2026-10-27T10:00:00.000Z",
    data: {
      email_id: emailId,
      message_id: "<111-222-333@email.example.com>",
      from: "Acme <onboarding@example.com>",
      to: ["a@example.com"],
      subject: "Hi",
      tags: { request_id: "req-1", app: "crm" },
      ...extra,
    },
  };
}

/** Removes every staged object so R2 assertions start from a clean bucket. */
async function clearAttachments(): Promise<void> {
  const { objects } = await env.ATTACHMENTS.list({ prefix: "attachments/" });
  for (const object of objects) await env.ATTACHMENTS.delete(object.key);
}

/**
 * Seeds a request whose stored payload references one staged object, and
 * returns that object's key so the test can assert on its lifecycle.
 */
async function seedStaged(
  id: string,
  resendId: string,
  status: string,
  attempts = 0,
): Promise<string> {
  const key = attachmentKey("test-app", `${id}-att`);
  await env.ATTACHMENTS.put(key, "invoice bytes");
  await seedEmailRequests(env.DB, [
    {
      id,
      recipient: "a@example.com",
      status,
      resendId,
      attempts,
      payload: JSON.stringify({
        useTemplate: false,
        subject: "Hi",
        text: "hello",
        attachments: [
          { key, id: "att-1", filename: "invoice.pdf", content_type: "application/pdf", size: 13 },
        ],
      }),
    },
  ]);
  return key;
}

async function readRequest(id: string) {
  return await env.DB.prepare(
    `SELECT status, resend_id, attempts, last_event, last_event_at, sent_at, delivered_at,
            error_name, bounce_type, bounce_sub_type, bounce_message
       FROM email_requests WHERE id = ?`,
  )
    .bind(id)
    .first<{
      status: string;
      resend_id: string | null;
      attempts: number;
      last_event: string | null;
      last_event_at: string | null;
      sent_at: string | null;
      delivered_at: string | null;
      error_name: string | null;
      bounce_type: string | null;
      bounce_sub_type: string | null;
      bounce_message: string | null;
    }>();
}

beforeAll(async () => {
  await applyPushSchema(env.DB);
  await applyEmailSchema(env.DB);
});

describe("POST /v1/webhooks/resend", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM email_requests").run();
    await env.DB.prepare("DELETE FROM resend_webhook_events").run();
    await clearAttachments();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("applies a signed event without the backend bearer token", async () => {
    await seedEmailRequests(env.DB, [
      { id: "req-1", recipient: "a@example.com", status: "sent", resendId: "resend-1" },
    ]);
    const signed = await signedWebhookRequest(SECRET, event("email.delivered", "resend-1"));

    const res = await postWebhook(signed.body, signed.headers);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      received: true,
      outcome: "applied",
      requestId: "req-1",
    });

    const row = await readRequest("req-1");
    expect(row?.status).toBe("delivered");
    expect(row?.delivered_at).toBe("2026-10-27T10:00:00.000Z");
    expect(row?.last_event).toBe("email.delivered");
  });

  it("rejects a payload signed with another secret", async () => {
    const signed = await signedWebhookRequest(OTHER_SECRET, event("email.sent", "resend-1"));

    const res = await postWebhook(signed.body, signed.headers);

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_signature" });
  });

  it("rejects a tampered body", async () => {
    const signed = await signedWebhookRequest(SECRET, event("email.delivered", "resend-1"));
    const tampered = signed.body.replace("email.delivered", "email.bounced");

    const res = await postWebhook(tampered, signed.headers);

    expect(res.status).toBe(400);
  });

  it("rejects a stale timestamp", async () => {
    const signed = await signedWebhookRequest(SECRET, event("email.sent", "resend-1"), {
      timestamp: Math.floor(Date.now() / 1000) - 3600,
    });

    const res = await postWebhook(signed.body, signed.headers);

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ reason: "timestamp_out_of_tolerance" });
  });

  it("rejects a request without signature headers", async () => {
    const res = await postWebhook(JSON.stringify(event("email.sent", "resend-1")), {
      "svix-id": "msg-1",
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "missing_signature_headers" });
  });

  it("ignores a duplicate svix-id", async () => {
    await seedEmailRequests(env.DB, [
      { id: "req-1", recipient: "a@example.com", status: "sent", resendId: "resend-1" },
    ]);
    const signed = await signedWebhookRequest(SECRET, event("email.delivered", "resend-1"), {
      svixId: "msg-fixed",
    });

    const first = await postWebhook(signed.body, signed.headers);
    const second = await postWebhook(signed.body, signed.headers);

    expect(first.status).toBe(200);
    expect(await second.json()).toMatchObject({ outcome: "duplicate" });

    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM resend_webhook_events",
    ).first<{ n: number }>();
    expect(count?.n).toBe(1);
    expect((await readRequest("req-1"))?.status).toBe("delivered");
  });

  it("keeps a terminal status when events arrive out of order", async () => {
    await seedEmailRequests(env.DB, [
      { id: "req-1", recipient: "a@example.com", status: "delivered", resendId: "resend-1" },
    ]);
    const signed = await signedWebhookRequest(SECRET, event("email.sent", "resend-1"));

    const res = await postWebhook(signed.body, signed.headers);

    expect(res.status).toBe(200);
    const row = await readRequest("req-1");
    expect(row?.status).toBe("delivered");
    // The event is still recorded for observability.
    expect(row?.last_event).toBe("email.sent");
  });

  it("records bounce details", async () => {
    await seedEmailRequests(env.DB, [
      { id: "req-1", recipient: "a@example.com", status: "sent", resendId: "resend-1" },
    ]);
    const signed = await signedWebhookRequest(
      SECRET,
      event("email.bounced", "resend-1", {
        bounce: {
          type: "Permanent",
          subType: "Suppressed",
          message: "The recipient's email address is on the suppression list.",
        },
      }),
    );

    expect((await postWebhook(signed.body, signed.headers)).status).toBe(200);

    const row = await readRequest("req-1");
    expect(row?.status).toBe("bounced");
    expect(row?.bounce_type).toBe("Permanent");
    expect(row?.bounce_sub_type).toBe("Suppressed");
    expect(row?.bounce_message).toContain("suppression list");
  });

  it("re-queues the request when Resend reports email.failed", async () => {
    await seedEmailRequests(env.DB, [
      { id: "req-retry", recipient: "a@example.com", status: "sent", resendId: "resend-retry" },
    ]);
    const sendSpy = vi
      .spyOn(env.PUSH_QUEUE, "send")
      .mockResolvedValue(fakeQueueSendResponse());
    const signed = await signedWebhookRequest(SECRET, event("email.failed", "resend-retry"));

    const res = await postWebhook(signed.body, signed.headers);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ outcome: "requeued", requestId: "req-retry" });

    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy.mock.calls[0][0]).toEqual({ kind: "email-send", requestId: "req-retry" });

    const row = await readRequest("req-retry");
    expect(row?.status).toBe("queued");
    expect(row?.attempts).toBe(1);
    expect(row?.last_event).toBe("email.failed");
  });

  it("stops retrying email.failed once the attempt budget is used up", async () => {
    await seedEmailRequests(env.DB, [
      {
        id: "req-exhausted",
        recipient: "a@example.com",
        status: "sent",
        resendId: "resend-exhausted",
        attempts: 3,
      },
    ]);
    const sendSpy = vi
      .spyOn(env.PUSH_QUEUE, "send")
      .mockResolvedValue(fakeQueueSendResponse());
    const signed = await signedWebhookRequest(SECRET, event("email.failed", "resend-exhausted"));

    const res = await postWebhook(signed.body, signed.headers);

    expect(await res.json()).toMatchObject({ outcome: "applied", requestId: "req-exhausted" });
    expect(sendSpy).not.toHaveBeenCalled();

    const row = await readRequest("req-exhausted");
    expect(row?.status).toBe("failed");
    expect(row?.error_name).toBe("retries_exhausted");
    expect(row?.attempts).toBe(3);
  });

  it("never re-queues a bounced email", async () => {
    await seedEmailRequests(env.DB, [
      { id: "req-bounce", recipient: "a@example.com", status: "sent", resendId: "resend-bounce" },
    ]);
    const sendSpy = vi
      .spyOn(env.PUSH_QUEUE, "send")
      .mockResolvedValue(fakeQueueSendResponse());
    const signed = await signedWebhookRequest(SECRET, event("email.bounced", "resend-bounce"));

    const res = await postWebhook(signed.body, signed.headers);

    expect(await res.json()).toMatchObject({ outcome: "applied", requestId: "req-bounce" });
    expect(sendSpy).not.toHaveBeenCalled();
    expect((await readRequest("req-bounce"))?.status).toBe("bounced");
  });

  it("does not re-queue email.failed for an email that was already delivered", async () => {
    await seedEmailRequests(env.DB, [
      {
        id: "req-delivered",
        recipient: "a@example.com",
        status: "delivered",
        resendId: "resend-delivered",
      },
    ]);
    const sendSpy = vi
      .spyOn(env.PUSH_QUEUE, "send")
      .mockResolvedValue(fakeQueueSendResponse());
    const signed = await signedWebhookRequest(SECRET, event("email.failed", "resend-delivered"));

    const res = await postWebhook(signed.body, signed.headers);

    expect(res.status).toBe(200);
    expect(sendSpy).not.toHaveBeenCalled();

    const row = await readRequest("req-delivered");
    expect(row?.status).toBe("delivered");
    expect(row?.last_event).toBe("email.failed");
  });

  it("ignores event types outside the four it maintains", async () => {
    await seedEmailRequests(env.DB, [
      { id: "req-1", recipient: "a@example.com", status: "delivered", resendId: "resend-1" },
    ]);

    for (const type of [
      "email.delivery_delayed",
      "email.complained",
      "email.suppressed",
      "email.opened",
      "email.clicked",
      "contact.created",
    ]) {
      const signed = await signedWebhookRequest(SECRET, event(type, "resend-1"));
      const res = await postWebhook(signed.body, signed.headers);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ outcome: "ignored" });
    }

    const row = await readRequest("req-1");
    expect(row?.status).toBe("delivered");
    expect(row?.last_event).toBeNull();
  });

  it("returns 200 unmatched for an email it did not send", async () => {
    const signed = await signedWebhookRequest(SECRET, event("email.sent", "unknown-email-id"));

    const res = await postWebhook(signed.body, signed.headers);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ outcome: "unmatched" });
  });

  it("recovers a request whose resend_id was never stored, via its request_id tag", async () => {
    await seedEmailRequests(env.DB, [
      { id: "req-recover", recipient: "a@example.com", status: "queued" },
    ]);
    const signed = await signedWebhookRequest(SECRET, {
      type: "email.delivered",
      created_at: "2026-10-27T10:00:00.000Z",
      data: {
        email_id: "resend-recovered",
        to: ["a@example.com"],
        tags: { request_id: "req-recover", app: "crm" },
      },
    });

    const res = await postWebhook(signed.body, signed.headers);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ outcome: "applied", requestId: "req-recover" });

    const row = await readRequest("req-recover");
    expect(row?.resend_id).toBe("resend-recovered");
    expect(row?.status).toBe("delivered");
  });

  it("ignores non-email events", async () => {
    const signed = await signedWebhookRequest(SECRET, {
      type: "domain.created",
      created_at: "2026-10-27T10:00:00.000Z",
      data: { id: "domain-1" },
    });

    const res = await postWebhook(signed.body, signed.headers);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ outcome: "ignored" });
  });

  it("rejects a signed body that is not JSON", async () => {
    const rawBody = "not json";
    const svixId = "msg-raw";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = await signSvixPayload(SECRET, svixId, timestamp, rawBody);

    const res = await postWebhook(rawBody, {
      "svix-id": svixId,
      "svix-timestamp": timestamp,
      "svix-signature": signature,
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_json" });
  });

  it("returns 500 when the webhook secret is not configured", async () => {
    const signed = await signedWebhookRequest(SECRET, event("email.sent", "resend-1"));

    const res = await postWebhook(
      signed.body,
      signed.headers,
      envWith({ RESEND_WEBHOOK_SECRET: "" }),
    );

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "server_misconfigured" });
  });

  describe("attachment cleanup", () => {
    it("releases the staged bytes once the email is delivered", async () => {
      const key = await seedStaged("req-delivered", "resend-delivered", "sent");
      const signed = await signedWebhookRequest(
        SECRET,
        event("email.delivered", "resend-delivered"),
      );

      const res = await postWebhook(signed.body, signed.headers);

      expect(res.status).toBe(200);
      expect((await readRequest("req-delivered"))?.status).toBe("delivered");
      expect(await env.ATTACHMENTS.get(key)).toBeNull();
    });

    it("releases the staged bytes when the email bounces", async () => {
      const key = await seedStaged("req-bounce", "resend-bounce", "sent");
      const signed = await signedWebhookRequest(SECRET, event("email.bounced", "resend-bounce"));

      await postWebhook(signed.body, signed.headers);

      expect(await env.ATTACHMENTS.get(key)).toBeNull();
    });

    it("releases the staged bytes once email.failed exhausts the retry budget", async () => {
      const key = await seedStaged("req-exhausted", "resend-exhausted", "sent", 3);
      const signed = await signedWebhookRequest(
        SECRET,
        event("email.failed", "resend-exhausted"),
      );

      await postWebhook(signed.body, signed.headers);

      expect(await env.ATTACHMENTS.get(key)).toBeNull();
    });

    it("keeps the staged bytes while email.failed re-queues the request", async () => {
      const key = await seedStaged("req-retry", "resend-retry", "sent");
      vi.spyOn(env.PUSH_QUEUE, "send").mockResolvedValue(fakeQueueSendResponse());
      const signed = await signedWebhookRequest(SECRET, event("email.failed", "resend-retry"));

      const res = await postWebhook(signed.body, signed.headers);

      expect(await res.json()).toMatchObject({ outcome: "requeued" });
      // The next attempt still needs the file, so deleting here would break it.
      expect(await env.ATTACHMENTS.get(key)).not.toBeNull();
    });

    it("keeps the staged bytes for events that are only observed", async () => {
      const key = await seedStaged("req-opened", "resend-opened", "sent");
      const signed = await signedWebhookRequest(SECRET, event("email.opened", "resend-opened"));

      await postWebhook(signed.body, signed.headers);

      expect(await env.ATTACHMENTS.get(key)).not.toBeNull();
    });

    it("does not pay the R2 cost for a request without attachments", async () => {
      await seedEmailRequests(env.DB, [
        { id: "req-plain", recipient: "a@example.com", status: "sent", resendId: "resend-plain" },
      ]);
      const signed = await signedWebhookRequest(SECRET, event("email.delivered", "resend-plain"));

      const res = await postWebhook(signed.body, signed.headers);

      expect(res.status).toBe(200);
      expect((await readRequest("req-plain"))?.status).toBe("delivered");
      expect(await env.ATTACHMENTS.list({ prefix: "attachments/" })).toMatchObject({
        objects: [],
      });
    });
  });
});
