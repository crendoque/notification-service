import { beforeEach, beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { app } from "../src/index";
import { subscriptionIdFromEndpoint } from "../src/crypto";
import { applyPushSchema } from "./schema";

const authHeaders = (): Record<string, string> => ({
  Authorization: `Bearer ${env.BACKEND_AUTH_TOKEN}`,
});
const jsonHeaders = (): Record<string, string> => ({
  ...authHeaders(),
  "Content-Type": "application/json",
});

const subscriptionBody = {
  userId: "user-123",
  subscription: {
    endpoint: "https://push.example.com/s/sub-1",
    keys: { p256dh: "BPubKey", auth: "AuthSecret" },
  },
};

beforeAll(async () => {
  await applyPushSchema(env.DB);
});

describe("subscriptions", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM push_subscriptions").run();
  });

  it("registers a subscription and returns its deterministic id", async () => {
    const res = await app.request(
      "/v1/subscriptions",
      {
        method: "PUT",
        headers: jsonHeaders(),
        body: JSON.stringify(subscriptionBody),
      },
      env,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { id: string; endpoint: string };
    expect(json.id).toBe(await subscriptionIdFromEndpoint(subscriptionBody.subscription.endpoint));

    const row = await env.DB.prepare("SELECT * FROM push_subscriptions").first();
    expect(row).not.toBeNull();
    expect((row as { user_id: string }).user_id).toBe("user-123");
  });

  it("is idempotent for the same endpoint", async () => {
    const opts = {
      method: "PUT",
      headers: jsonHeaders(),
      body: JSON.stringify(subscriptionBody),
    };
    await app.request("/v1/subscriptions", opts, env);
    await app.request("/v1/subscriptions", opts, env);

    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM push_subscriptions").first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it("rejects an invalid payload", async () => {
    const res = await app.request(
      "/v1/subscriptions",
      {
        method: "PUT",
        headers: jsonHeaders(),
        body: JSON.stringify({ userId: "", subscription: { endpoint: "not-a-url" } }),
      },
      env,
    );
    expect(res.status).toBe(400);
  });

  it("deletes a subscription by id and 404s for unknown ids", async () => {
    const res = await app.request(
      "/v1/subscriptions",
      {
        method: "PUT",
        headers: jsonHeaders(),
        body: JSON.stringify(subscriptionBody),
      },
      env,
    );
    const { id } = (await res.json()) as { id: string };

    const gone = await app.request(`/v1/subscriptions/${id}`, { method: "DELETE", headers: authHeaders() }, env);
    expect(gone.status).toBe(204);

    const after = await env.DB.prepare("SELECT COUNT(*) AS n FROM push_subscriptions").first<{ n: number }>();
    expect(after?.n).toBe(0);

    const missing = await app.request("/v1/subscriptions/unknown-id", { method: "DELETE", headers: authHeaders() }, env);
    expect(missing.status).toBe(404);
  });
});
