import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import {
  buildResendPayload,
  createResendTransport,
  resolveSender,
  RESEND_EMAILS_URL,
} from "../src/email";
import type { EmailContentInput } from "../src/validation";

const request = { id: "req-1", app: "crm", recipient: "user@example.com" };
const sender = "Notification Worker <notifications@example.com>";

const inlineContent: EmailContentInput = {
  useTemplate: false,
  subject: "Hello",
  html: "<p>Hi</p>",
  text: "Hi",
};

/** Stubbed fetch that records the calls it receives. */
function fakeFetch(response: { status?: number; body: string }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(response.body, { status: response.status ?? 200 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("buildResendPayload", () => {
  it("builds a To-only inline payload with correlation tags", () => {
    const payload = buildResendPayload(request, inlineContent, sender);

    expect(payload).toEqual({
      from: sender,
      to: ["user@example.com"],
      subject: "Hello",
      html: "<p>Hi</p>",
      text: "Hi",
      tags: [
        { name: "request_id", value: "req-1" },
        { name: "app", value: "crm" },
      ],
    });
    expect(payload).not.toHaveProperty("cc");
    expect(payload).not.toHaveProperty("bcc");
  });

  it("builds a template payload without inline content", () => {
    const payload = buildResendPayload(
      request,
      { useTemplate: true, templateId: "order-ready", variables: { name: "Ali", count: 2 } },
      sender,
    );

    expect(payload.template).toEqual({
      id: "order-ready",
      variables: { name: "Ali", count: 2 },
    });
    expect(payload).not.toHaveProperty("html");
    expect(payload).not.toHaveProperty("text");
    expect(payload).not.toHaveProperty("subject");
  });

  it("passes replyTo and scheduledAt through", () => {
    const payload = buildResendPayload(
      request,
      { ...inlineContent, replyTo: "support@example.com", scheduledAt: "in 1 min" },
      sender,
    );

    expect(payload.reply_to).toBe("support@example.com");
    expect(payload.scheduled_at).toBe("in 1 min");
  });
});

describe("createResendTransport", () => {
  const payload = buildResendPayload(request, inlineContent, sender);

  it("posts to the Resend endpoint with auth and idempotency headers", async () => {
    const { fetchImpl, calls } = fakeFetch({
      status: 200,
      body: JSON.stringify({ id: "email-1" }),
    });
    const transport = createResendTransport(env, fetchImpl);

    const result = await transport.send(payload, { idempotencyKey: "idem-1" });

    expect(result).toEqual({ id: "email-1" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(RESEND_EMAILS_URL);
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${env.RESEND_API_KEY}`);
    expect(headers["Idempotency-Key"]).toBe("idem-1");
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({
      to: ["user@example.com"],
      subject: "Hello",
    });
  });

  it("maps a 422 validation error to a permanent failure", async () => {
    const { fetchImpl } = fakeFetch({
      status: 422,
      body: JSON.stringify({
        statusCode: 422,
        name: "missing_required_field",
        message: "The request body is missing fields",
      }),
    });
    const transport = createResendTransport(env, fetchImpl);

    await expect(transport.send(payload)).rejects.toMatchObject({
      errorName: "missing_required_field",
      statusCode: 422,
      retryable: false,
    });
  });

  it("marks 429 and 5xx responses as retryable", async () => {
    for (const status of [429, 500, 503]) {
      const { fetchImpl } = fakeFetch({
        status,
        body: JSON.stringify({ statusCode: status, name: "rate_limit_exceeded", message: "slow down" }),
      });
      const transport = createResendTransport(env, fetchImpl);

      await expect(transport.send(payload)).rejects.toMatchObject({
        statusCode: status,
        retryable: true,
      });
    }
  });

  it("treats network errors as retryable", async () => {
    const fetchImpl = (async () => {
      throw new Error("connection reset");
    }) as unknown as typeof fetch;
    const transport = createResendTransport(env, fetchImpl);

    await expect(transport.send(payload)).rejects.toMatchObject({
      errorName: "network_error",
      retryable: true,
    });
  });

  it("treats a 2xx response without an email id as retryable", async () => {
    const { fetchImpl } = fakeFetch({ status: 200, body: JSON.stringify({ ok: true }) });
    const transport = createResendTransport(env, fetchImpl);

    await expect(transport.send(payload)).rejects.toMatchObject({
      errorName: "invalid_response",
      retryable: true,
    });
  });
});

describe("resolveSender", () => {
  it("uses EMAIL_FROM when the caller does not override the sender", () => {
    expect(resolveSender(env, undefined)).toEqual({ ok: true, from: env.EMAIL_FROM });
    expect(resolveSender(env, env.EMAIL_FROM)).toEqual({ ok: true, from: env.EMAIL_FROM });
  });

  it("rejects a sender that is not allowlisted", () => {
    expect(resolveSender(env, "Someone Else <else@example.com>")).toEqual({ ok: false });
  });
});
