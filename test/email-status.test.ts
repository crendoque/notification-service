import { beforeEach, beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { app } from "../src/index";
import { applyEmailSchema, applyPushSchema, seedEmailRequests } from "./schema";

const authHeaders = (): Record<string, string> => ({
  Authorization: `Bearer ${env.BACKEND_AUTH_TOKEN}`,
});

async function getJson(path: string) {
  return app.request(path, { headers: authHeaders() }, env);
}

beforeAll(async () => {
  await applyPushSchema(env.DB);
  await applyEmailSchema(env.DB);
});

describe("GET /v1/notifications/email/:id", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM email_requests").run();
  });

  it("returns the stored request status", async () => {
    await seedEmailRequests(env.DB, [
      {
        id: "req-1",
        recipient: "a@example.com",
        userId: "u1",
        app: "crm",
        status: "delivered",
        resendId: "resend-1",
      },
    ]);

    const res = await getJson("/v1/notifications/email/req-1");

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id: "req-1",
      app: "crm",
      userId: "u1",
      recipient: "a@example.com",
      status: "delivered",
      resendId: "resend-1",
      attempts: 0,
      error: null,
      bounce: null,
    });
  });

  it("exposes failure details", async () => {
    await seedEmailRequests(env.DB, [{ id: "req-2", recipient: "b@example.com" }]);
    await env.DB.prepare(
      `UPDATE email_requests
          SET status = 'failed', error_name = 'validation_error', error_message = 'domain not verified'
        WHERE id = 'req-2'`,
    ).run();

    const res = await getJson("/v1/notifications/email/req-2");

    expect(await res.json()).toMatchObject({
      status: "failed",
      error: { name: "validation_error", message: "domain not verified" },
    });
  });

  it("404s for an unknown id", async () => {
    const res = await getJson("/v1/notifications/email/does-not-exist");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });
});

describe("GET /v1/notifications/email", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM email_requests").run();
    await seedEmailRequests(env.DB, [
      { id: "req-1", recipient: "a@example.com", userId: "u1", app: "crm" },
      { id: "req-2", recipient: "b@example.com", userId: "u1", app: "crm", status: "sent" },
      { id: "req-3", recipient: "c@example.com", userId: "u2", app: "billing" },
    ]);
  });

  it("filters by userId and paginates newest first", async () => {
    const first = await getJson("/v1/notifications/email?userId=u1&limit=1");
    expect(first.status).toBe(200);
    const page = (await first.json()) as {
      requests: { id: string }[];
      nextAfterSeq: number | null;
    };
    expect(page.requests.map((row) => row.id)).toEqual(["req-2"]);
    // `seq` is AUTOINCREMENT, so assert the cursor is usable rather than a fixed value.
    expect(typeof page.nextAfterSeq).toBe("number");
    expect(page.nextAfterSeq).toBeGreaterThan(0);

    const second = await getJson(
      `/v1/notifications/email?userId=u1&limit=1&afterSeq=${page.nextAfterSeq}`,
    );
    const nextPage = (await second.json()) as {
      requests: { id: string }[];
      nextAfterSeq: number | null;
    };
    expect(nextPage.requests.map((row) => row.id)).toEqual(["req-1"]);
    expect(nextPage.nextAfterSeq).toBeNull();
  });

  it("filters by app and status", async () => {
    const byApp = await getJson("/v1/notifications/email?app=billing");
    expect(((await byApp.json()) as { requests: { id: string }[] }).requests.map((r) => r.id)).toEqual(
      ["req-3"],
    );

    const byStatus = await getJson("/v1/notifications/email?status=sent");
    expect(
      ((await byStatus.json()) as { requests: { id: string }[] }).requests.map((r) => r.id),
    ).toEqual(["req-2"]);
  });

  it("rejects an invalid query", async () => {
    expect((await getJson("/v1/notifications/email?limit=0")).status).toBe(400);
    expect((await getJson("/v1/notifications/email?status=unknown")).status).toBe(400);
  });

  it("requires auth", async () => {
    const res = await app.request("/v1/notifications/email", undefined, env);
    expect(res.status).toBe(401);
  });
});
