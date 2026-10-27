import { beforeEach, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { app } from "../src/index";
import { applyEmailSchema, applyPushSchema, envWith, fakeQueueSendResponse } from "./schema";

const authHeaders = (): Record<string, string> => ({
  Authorization: `Bearer ${env.BACKEND_AUTH_TOKEN}`,
});

async function postJson(path: string, body: unknown, bindings: Cloudflare.Env = env) {
  return app.request(
    path,
    {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    bindings,
  );
}

const inlineBody = {
  app: "crm",
  userId: "user-1",
  email: "user@example.com",
  payload: { useTemplate: false, subject: "Hello", html: "<p>Hi</p>" },
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  await applyPushSchema(env.DB);
  await applyEmailSchema(env.DB);
});

beforeEach(async () => {
  // The test pool delivers queued messages in the background, so `fetch` is
  // always stubbed: the trigger handler must never call it, and a background
  // delivery must never reach the real Resend API.
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "resend-test" }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  await env.DB.prepare("DELETE FROM email_requests").run();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("POST /v1/notifications/email", () => {
  it("persists a queued request and enqueues one job without sending inline", async () => {
    const sendSpy = vi
      .spyOn(env.PUSH_QUEUE, "send")
      .mockResolvedValue(fakeQueueSendResponse());

    const res = await postJson("/v1/notifications/email", inlineBody);

    expect(res.status).toBe(202);
    const json = (await res.json()) as { id: string; status: string };
    expect(json).toMatchObject({
      app: "crm",
      userId: "user-1",
      recipient: "user@example.com",
      mode: "inline",
      status: "queued",
    });
    expect(typeof json.id).toBe("string");

    const row = await env.DB.prepare("SELECT * FROM email_requests WHERE id = ?")
      .bind(json.id)
      .first<{ status: string; attempts: number; payload: string; app: string }>();
    expect(row?.status).toBe("queued");
    expect(row?.attempts).toBe(0);
    expect(row?.app).toBe("crm");
    expect(row?.payload).toContain("Hello");

    // Async contract: exactly one job, and Resend is never called from the handler.
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy.mock.calls[0][0]).toEqual({ kind: "email-send", requestId: json.id });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stores template requests with mode=template and the template id", async () => {
    const res = await postJson("/v1/notifications/email", {
      app: "crm",
      userId: "user-1",
      email: "user@example.com",
      payload: {
        useTemplate: true,
        templateId: "order-ready",
        variables: { name: "Ali" },
        subject: "Your order",
      },
    });

    expect(res.status).toBe(202);
    const json = (await res.json()) as { id: string; mode: string; templateId: string };
    expect(json.mode).toBe("template");
    expect(json.templateId).toBe("order-ready");

    const row = await env.DB.prepare("SELECT * FROM email_requests WHERE id = ?")
      .bind(json.id)
      .first<{ mode: string; template_id: string; subject: string }>();
    expect(row?.mode).toBe("template");
    expect(row?.template_id).toBe("order-ready");
    expect(row?.subject).toBe("Your order");
  });

  it("rejects to/cc/bcc/headers/tags inside the payload", async () => {
    for (const field of ["to", "cc", "bcc", "headers", "tags"]) {
      const res = await postJson("/v1/notifications/email", {
        ...inlineBody,
        payload: { ...inlineBody.payload, [field]: "user@example.com" },
      });
      expect(res.status).toBe(400);
      const json = (await res.json()) as { error: string; fields: string[] };
      expect(json.error).toBe("unsupported_field");
      expect(json.fields).toContain(field);
    }
  });

  it("requires templateId and forbids inline content when useTemplate is true", async () => {
    const missingTemplate = await postJson("/v1/notifications/email", {
      ...inlineBody,
      payload: { useTemplate: true, subject: "Hi" },
    });
    expect(missingTemplate.status).toBe(400);

    const conflicting = await postJson("/v1/notifications/email", {
      ...inlineBody,
      payload: { useTemplate: true, templateId: "t-1", html: "<p>Hi</p>" },
    });
    expect(conflicting.status).toBe(400);
  });

  it("requires a subject and a body when useTemplate is false", async () => {
    const noSubject = await postJson("/v1/notifications/email", {
      ...inlineBody,
      payload: { useTemplate: false, html: "<p>Hi</p>" },
    });
    expect(noSubject.status).toBe(400);

    const noBody = await postJson("/v1/notifications/email", {
      ...inlineBody,
      payload: { useTemplate: false, subject: "Hi" },
    });
    expect(noBody.status).toBe(400);
  });

  it("validates app and email", async () => {
    const badApp = await postJson("/v1/notifications/email", { ...inlineBody, app: "CRM App!" });
    expect(badApp.status).toBe(400);

    const missingApp = await postJson("/v1/notifications/email", {
      userId: "user-1",
      email: "user@example.com",
      payload: inlineBody.payload,
    });
    expect(missingApp.status).toBe(400);

    const badEmail = await postJson("/v1/notifications/email", {
      ...inlineBody,
      email: "not-an-email",
    });
    expect(badEmail.status).toBe(400);
  });

  it("returns 500 when Resend is not configured", async () => {
    const res = await postJson(
      "/v1/notifications/email",
      inlineBody,
      envWith({ RESEND_API_KEY: "" }),
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "server_misconfigured" });
  });

  it("rejects apps that are not allowlisted", async () => {
    const bindings = envWith({ EMAIL_ALLOWED_APPS: "billing,portal" });

    const blocked = await postJson("/v1/notifications/email", inlineBody, bindings);
    expect(blocked.status).toBe(400);
    expect(await blocked.json()).toMatchObject({ error: "unknown_app" });

    const listed = await postJson(
      "/v1/notifications/email",
      { ...inlineBody, app: "billing" },
      bindings,
    );
    expect(listed.status).toBe(202);
  });

  it("rejects a sender that is not allowlisted", async () => {
    const res = await postJson("/v1/notifications/email", {
      ...inlineBody,
      payload: { ...inlineBody.payload, from: "Someone Else <else@example.com>" },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "from_not_allowed" });
  });

  it("requires the backend bearer token", async () => {
    const res = await app.request(
      "/v1/notifications/email",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(inlineBody),
      },
      env,
    );
    expect(res.status).toBe(401);
  });
});
