import { beforeEach, beforeAll, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { app } from "../src/index";
import { applyPushSchema, fakeQueueSendResponse, seedSubscriptions } from "./schema";

const { sendNotificationMock } = vi.hoisted(() => ({
  sendNotificationMock: vi.fn(),
}));

// The worker's only outbound network dependency is web-push-neo's
// sendNotification; mocking it keeps tests fully offline and deterministic.
vi.mock("web-push-neo", () => ({
  sendNotification: sendNotificationMock,
}));

const authHeaders = (): Record<string, string> => ({
  Authorization: `Bearer ${env.BACKEND_AUTH_TOKEN}`,
});

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

beforeAll(async () => {
  await applyPushSchema(env.DB);
});

describe("batch push", () => {
  beforeEach(async () => {
    sendNotificationMock.mockReset();
    sendNotificationMock.mockResolvedValue({ statusCode: 201 });
    await env.DB.prepare("DELETE FROM push_subscriptions").run();
  });

  it("delivers per user and reports skipped users", async () => {
    await seedSubscriptions(env.DB, [
      { userId: "user-1", endpoint: "https://push.example.com/s/a1" },
      { userId: "user-1", endpoint: "https://push.example.com/s/a2" },
      { userId: "user-2", endpoint: "https://push.example.com/s/b1" },
    ]);

    const res = await postJson("/v1/notifications/push/batch", {
      userIds: ["user-1", "user-2", "user-3"],
      title: "Update",
      body: "Something changed.",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      results: [
        { userId: "user-1", delivered: 2, failed: 0, removed: 0 },
        { userId: "user-2", delivered: 1, failed: 0, removed: 0 },
        { userId: "user-3", delivered: 0, failed: 0, removed: 0 },
      ],
      notifiedUsers: 2,
      skippedUsers: 1,
    });
    expect(sendNotificationMock).toHaveBeenCalledTimes(3);
  });

  it("deduplicates userIds", async () => {
    await seedSubscriptions(env.DB, [
      { userId: "user-1", endpoint: "https://push.example.com/s/a1" },
    ]);

    const res = await postJson("/v1/notifications/push/batch", {
      userIds: ["user-1", "user-1", "user-1"],
      title: "Update",
      body: "Something changed.",
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { results: unknown[] };
    expect(json.results).toHaveLength(1);
    expect(sendNotificationMock).toHaveBeenCalledTimes(1);
  });

  it("rejects an empty or oversized userIds list", async () => {
    const empty = await postJson("/v1/notifications/push/batch", {
      userIds: [],
      title: "t",
      body: "b",
    });
    expect(empty.status).toBe(400);

    const oversized = await postJson("/v1/notifications/push/batch", {
      userIds: Array.from({ length: 501 }, (_, i) => `user-${i}`),
      title: "t",
      body: "b",
    });
    expect(oversized.status).toBe(400);
  });

  it("routes oversized fan-outs to the queue", async () => {
    // ≤500 users (schema cap) but >500 devices (2 per user) -> must be queued.
    const rows = Array.from({ length: 251 }, (_, i) => [
      { userId: `user-${i}`, endpoint: `https://push.example.com/s/dev-${i}-a` },
      { userId: `user-${i}`, endpoint: `https://push.example.com/s/dev-${i}-b` },
    ]).flat();
    await seedSubscriptions(env.DB, rows);

    // Stub the queue producer: this test verifies *routing*, not delivery.
    // (Delivery via the consumer is covered in jobs.test.ts.)
    const sendSpy = vi
      .spyOn(env.PUSH_QUEUE, "send")
      .mockResolvedValue(fakeQueueSendResponse());

    const res = await postJson("/v1/notifications/push/batch", {
      userIds: Array.from({ length: 251 }, (_, i) => `user-${i}`),
      title: "Big update",
      body: "Something changed.",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ queued: true, queuedUsers: 251 });

    // 251 users / 50 per chunk = 6 queued jobs, none sent synchronously.
    expect(sendSpy).toHaveBeenCalledTimes(6);
    for (const [job] of sendSpy.mock.calls as unknown[][]) {
      expect(job).toMatchObject({ kind: "batch-chunk" });
    }
    expect(sendNotificationMock).not.toHaveBeenCalled();
    sendSpy.mockRestore();
  });
});
