import { beforeEach, beforeAll, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { app } from "../src/index";
import { applyPushSchema } from "./schema";

const { sendNotificationMock } = vi.hoisted(() => ({
  sendNotificationMock: vi.fn(),
}));

// The worker's only outbound network dependency is web-push-neo's
// sendNotification; mocking it keeps tests fully offline and deterministic.
vi.mock("web-push-neo", () => ({
  sendNotification: sendNotificationMock,
}));

/** The dev token lives in .dev.vars; read it from the environment at test time. */
const authHeaders = (): Record<string, string> => ({
  Authorization: `Bearer ${env.BACKEND_AUTH_TOKEN}`,
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

async function putJson(path: string, body: unknown) {
  return app.request(
    path,
    {
      method: "PUT",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    env,
  );
}

async function postJson(path: string, body: unknown) {
  return app.request(
    path,
    {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    env,
  );
}

describe("push trigger", () => {
  beforeEach(async () => {
    sendNotificationMock.mockReset();
    await env.DB.prepare("DELETE FROM push_subscriptions").run();
  });

  it("returns delivered: 0 for a user without subscriptions", async () => {
    const res = await postJson("/v1/notifications/push", {
      userId: "user-123",
      title: "Done!",
      body: "Your export finished.",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      userId: "user-123",
      delivered: 0,
      failed: 0,
      removed: 0,
    });
    expect(sendNotificationMock).not.toHaveBeenCalled();
  });

  it("rejects an invalid payload", async () => {
    const res = await postJson("/v1/notifications/push", { userId: "user-123" });
    expect(res.status).toBe(400);
  });

  it("delivers to every subscription of the user with the JSON payload", async () => {
    sendNotificationMock.mockResolvedValue({ statusCode: 201 });
    await putJson("/v1/subscriptions", subscriptionBody);
    await putJson("/v1/subscriptions", {
      userId: "user-123",
      subscription: {
        endpoint: "https://push.example.com/s/sub-2",
        keys: { p256dh: "BPubKey2", auth: "AuthSecret2" },
      },
    });

    const res = await postJson("/v1/notifications/push", {
      userId: "user-123",
      title: "Done!",
      body: "Your export finished.",
      url: "https://app.example.com/results",
      tag: "export-done",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      userId: "user-123",
      delivered: 2,
      failed: 0,
      removed: 0,
    });
    expect(sendNotificationMock).toHaveBeenCalledTimes(2);

    const [, payload, options] = sendNotificationMock.mock.calls[0];
    const parsed = JSON.parse(payload);
    expect(parsed).toMatchObject({
      title: "Done!",
      body: "Your export finished.",
      url: "https://app.example.com/results",
      tag: "export-done",
    });
    expect(options.vapidDetails.publicKey).toBeTruthy();
    expect(options.TTL).toBe(86_400);
    expect(options.urgency).toBe("normal");
  });

  it("prunes subscriptions the push service reports as 404/410", async () => {
    const error = new Error("Subscription no longer exists");
    Object.assign(error, { statusCode: 404 });
    sendNotificationMock.mockRejectedValue(error);

    await putJson("/v1/subscriptions", subscriptionBody);

    const res = await postJson("/v1/notifications/push", {
      userId: "user-123",
      title: "Done!",
      body: "Your export finished.",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      userId: "user-123",
      delivered: 0,
      failed: 1,
      removed: 1,
    });

    const after = await env.DB.prepare("SELECT COUNT(*) AS n FROM push_subscriptions").first<{ n: number }>();
    expect(after?.n).toBe(0);
  });

  it("keeps subscriptions that fail with other errors", async () => {
    const error = new Error("Push service temporary failure");
    Object.assign(error, { statusCode: 503 });
    sendNotificationMock.mockRejectedValue(error);

    await putJson("/v1/subscriptions", subscriptionBody);

    const res = await postJson("/v1/notifications/push", {
      userId: "user-123",
      title: "Done!",
      body: "Your export finished.",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      userId: "user-123",
      delivered: 0,
      failed: 1,
      removed: 0,
    });

    const after = await env.DB.prepare("SELECT COUNT(*) AS n FROM push_subscriptions").first<{ n: number }>();
    expect(after?.n).toBe(1);
  });
});
