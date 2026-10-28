import { beforeEach, beforeAll, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import worker from "../src/index";
import { processEmailSend } from "../src/email-jobs";
import { attachmentKey } from "../src/attachments";
import { ResendError, type EmailTransport, type ResendEmailPayload } from "../src/email";
import type { NotificationJob } from "../src/validation";
import { applyEmailSchema, applyPushSchema, seedEmailRequests } from "./schema";

const job = { kind: "email-send", requestId: "req-1" } as const;

/** Removes every staged object so R2 assertions start from a clean bucket. */
async function clearAttachments(): Promise<void> {
  const { objects } = await env.ATTACHMENTS.list({ prefix: "attachments/" });
  for (const object of objects) await env.ATTACHMENTS.delete(object.key);
}

/** Seeds a request whose stored payload references one staged attachment. */
async function seedWithAttachment(id: string, key: string, size: number): Promise<void> {
  await seedEmailRequests(env.DB, [
    {
      id,
      recipient: "a@example.com",
      payload: JSON.stringify({
        useTemplate: false,
        subject: "Hi",
        text: "hello",
        attachments: [
          { key, id: "att-1", filename: "invoice.pdf", content_type: "application/pdf", size },
        ],
      }),
    },
  ]);
}

/** Injected transport: records payloads, then returns `result` or throws it. */
function stubTransport(result: { id: string } | Error) {
  const calls: ResendEmailPayload[] = [];
  const transport: EmailTransport = {
    async send(payload) {
      calls.push(payload);
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return { calls, transport };
}

async function readRequest(id: string) {
  return await env.DB.prepare(
    "SELECT status, resend_id, attempts, sent_at, error_name, error_message FROM email_requests WHERE id = ?",
  )
    .bind(id)
    .first<{
      status: string;
      resend_id: string | null;
      attempts: number;
      sent_at: string | null;
      error_name: string | null;
      error_message: string | null;
    }>();
}

beforeAll(async () => {
  await applyPushSchema(env.DB);
  await applyEmailSchema(env.DB);
});

describe("processEmailSend", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM email_requests").run();
    await clearAttachments();
  });

  it("sends the stored payload and marks the request as sent", async () => {
    await seedEmailRequests(env.DB, [
      {
        id: "req-1",
        recipient: "a@example.com",
        payload: JSON.stringify({ useTemplate: false, subject: "Hi", text: "hello" }),
      },
    ]);
    const { calls, transport } = stubTransport({ id: "resend-1" });

    const outcome = await processEmailSend(env, job, { transport });

    expect(outcome).toBe("sent");
    expect(calls[0]).toMatchObject({
      from: env.EMAIL_FROM,
      to: ["a@example.com"],
      subject: "Hi",
      text: "hello",
      tags: [
        { name: "request_id", value: "req-1" },
        { name: "app", value: "test-app" },
      ],
    });

    const row = await readRequest("req-1");
    expect(row?.status).toBe("sent");
    expect(row?.resend_id).toBe("resend-1");
    expect(row?.attempts).toBe(1);
    expect(row?.sent_at).toBeTruthy();
  });

  it("passes scheduledAt through and records the request as sent", async () => {
    await seedEmailRequests(env.DB, [
      {
        id: "req-1",
        recipient: "a@example.com",
        payload: JSON.stringify({
          useTemplate: true,
          templateId: "announcement",
          subject: "Later",
          scheduledAt: "in 1 min",
        }),
      },
    ]);
    const { calls, transport } = stubTransport({ id: "resend-2" });

    expect(await processEmailSend(env, job, { transport })).toBe("sent");
    expect(calls[0].scheduled_at).toBe("in 1 min");
    expect(calls[0].template).toEqual({ id: "announcement" });
    // `sent` means Resend accepted the request; a scheduled send is still
    // confirmed later by the email.sent / email.delivered webhooks.
    expect((await readRequest("req-1"))?.status).toBe("sent");
  });

  it("skips a request that already reached Resend", async () => {
    await seedEmailRequests(env.DB, [
      { id: "req-1", recipient: "a@example.com", status: "sent", resendId: "resend-0" },
    ]);
    const { calls, transport } = stubTransport({ id: "resend-2" });

    expect(await processEmailSend(env, job, { transport })).toBe("skipped");
    expect(calls).toHaveLength(0);
  });

  it("skips a request that does not exist", async () => {
    const { transport } = stubTransport({ id: "resend-3" });
    expect(await processEmailSend(env, job, { transport })).toBe("skipped");
  });

  it("throws on a retryable failure so the queue redelivers it", async () => {
    await seedEmailRequests(env.DB, [{ id: "req-1", recipient: "a@example.com" }]);
    const { transport } = stubTransport(
      new ResendError({
        statusCode: 429,
        errorName: "rate_limit_exceeded",
        message: "Too many requests",
        retryable: true,
      }),
    );

    await expect(
      processEmailSend(env, job, { transport, attempt: 1, maxAttempts: 3 }),
    ).rejects.toThrow("Too many requests");

    const row = await readRequest("req-1");
    expect(row?.status).toBe("queued");
    expect(row?.attempts).toBe(1);
  });

  it("fails the request once the retries are exhausted", async () => {
    await seedEmailRequests(env.DB, [{ id: "req-1", recipient: "a@example.com" }]);
    const { transport } = stubTransport(
      new ResendError({
        statusCode: 503,
        errorName: "service_unavailable",
        message: "API is temporarily unavailable",
        retryable: true,
      }),
    );

    const outcome = await processEmailSend(env, job, { transport, attempt: 3, maxAttempts: 3 });

    expect(outcome).toBe("failed");
    const row = await readRequest("req-1");
    expect(row?.status).toBe("failed");
    expect(row?.error_name).toBe("retries_exhausted");
    expect(row?.attempts).toBe(3);
  });

  it("fails permanently on a non-retryable error without throwing", async () => {
    await seedEmailRequests(env.DB, [{ id: "req-1", recipient: "a@example.com" }]);
    const { transport } = stubTransport(
      new ResendError({
        statusCode: 403,
        errorName: "validation_error",
        message: "The domain is not verified",
        retryable: false,
      }),
    );

    expect(await processEmailSend(env, job, { transport, attempt: 1, maxAttempts: 3 })).toBe(
      "failed",
    );
    const row = await readRequest("req-1");
    expect(row?.status).toBe("failed");
    expect(row?.error_name).toBe("validation_error");
    expect(row?.error_message).toBe("The domain is not verified");
  });

  it("fails a request whose stored payload is unusable", async () => {
    await seedEmailRequests(env.DB, [
      { id: "req-1", recipient: "a@example.com", payload: "{not json" },
    ]);
    const { transport } = stubTransport({ id: "resend-4" });

    expect(await processEmailSend(env, job, { transport })).toBe("failed");
    expect((await readRequest("req-1"))?.error_name).toBe("invalid_stored_payload");
  });

  it("loads the staged attachment from R2 and base64-encodes it for Resend", async () => {
    const bytes = new TextEncoder().encode("invoice bytes");
    const key = attachmentKey("test-app", "att-1");
    await env.ATTACHMENTS.put(key, bytes);
    await seedWithAttachment("req-1", key, bytes.length);
    const { calls, transport } = stubTransport({ id: "resend-1" });

    expect(await processEmailSend(env, job, { transport })).toBe("sent");

    expect(calls[0].attachments).toEqual([
      {
        filename: "invoice.pdf",
        content: btoa("invoice bytes"),
        content_type: "application/pdf",
      },
    ]);
    // The base64 must decode back to the exact original bytes.
    expect(atob(calls[0].attachments?.[0].content ?? "")).toBe("invoice bytes");
    // Sending is not a cleanup point: the object survives until delivery.
    expect(await env.ATTACHMENTS.get(key)).not.toBeNull();
  });

  it("fails permanently when a staged attachment is no longer in R2", async () => {
    await seedWithAttachment("req-1", attachmentKey("test-app", "gone"), 5);
    const { calls, transport } = stubTransport({ id: "resend-1" });

    expect(await processEmailSend(env, job, { transport })).toBe("failed");

    // The email must never go out with a silently dropped file.
    expect(calls).toHaveLength(0);
    const row = await readRequest("req-1");
    expect(row?.status).toBe("failed");
    expect(row?.error_name).toBe("attachment_missing");
  });

  it("releases the staged attachment on a permanent failure", async () => {
    const key = attachmentKey("test-app", "att-1");
    await env.ATTACHMENTS.put(key, "bytes");
    await seedWithAttachment("req-1", key, 5);
    const { transport } = stubTransport(
      new ResendError({
        statusCode: 403,
        errorName: "validation_error",
        message: "The domain is not verified",
        retryable: false,
      }),
    );

    expect(await processEmailSend(env, job, { transport, attempt: 1, maxAttempts: 3 })).toBe(
      "failed",
    );
    expect(await env.ATTACHMENTS.get(key)).toBeNull();
  });

  it("keeps the staged attachment while a retry is still possible", async () => {
    const key = attachmentKey("test-app", "att-1");
    await env.ATTACHMENTS.put(key, "bytes");
    await seedWithAttachment("req-1", key, 5);
    const { transport } = stubTransport(
      new ResendError({
        statusCode: 429,
        errorName: "rate_limit_exceeded",
        message: "slow down",
        retryable: true,
      }),
    );

    await expect(
      processEmailSend(env, job, { transport, attempt: 1, maxAttempts: 3 }),
    ).rejects.toThrow();

    // The next attempt needs the bytes, so they must survive the retry.
    expect(await env.ATTACHMENTS.get(key)).not.toBeNull();
  });
});

describe("queue consumer", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM email_requests").run();
  });

  function fakeBatch(body: unknown) {
    const ack = vi.fn();
    const retry = vi.fn();
    const batch = {
      messages: [{ id: "m1", timestamp: new Date(), body, attempts: 1, ack, retry }],
      queue: "notification-push",
      metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
      ackAll: vi.fn(),
      retryAll: vi.fn(),
    } as unknown as MessageBatch<NotificationJob>;
    return { batch, ack, retry };
  }

  const context = {
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;

  it("acks an email-send job after a successful send", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ id: "resend-9" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await seedEmailRequests(env.DB, [{ id: "req-9", recipient: "a@example.com" }]);
    const { batch, ack, retry } = fakeBatch({ kind: "email-send", requestId: "req-9" });

    await worker.queue(batch, env, context);

    expect(ack).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
    expect((await readRequest("req-9"))?.status).toBe("sent");
    vi.unstubAllGlobals();
  });

  it("acks a poison job instead of redelivering it forever", async () => {
    const { batch, ack, retry } = fakeBatch({ kind: "not-a-job" });

    await worker.queue(batch, env, context);

    expect(ack).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
  });
});
