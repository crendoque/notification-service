import { beforeEach, beforeAll, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { app } from "../src/index";
import { applyPushSchema, fakeQueueSendResponse, seedSubscriptions } from "./schema";

const { sendNotificationMock } = vi.hoisted(() => ({
  sendNotificationMock: vi.fn(),
}));

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

describe("broadcast push", () => {
  beforeEach(async () => {
    sendNotificationMock.mockReset();
    await env.DB.prepare("DELETE FROM push_subscriptions").run();
  });

  it("dryRun returns recipient counts without enqueuing or sending", async () => {
    await seedSubscriptions(env.DB, [
      { userId: "u1", endpoint: "https://push.example.com/s/1" },
      { userId: "u1", endpoint: "https://push.example.com/s/2" },
      { userId: "u2", endpoint: "https://push.example.com/s/3" },
    ]);

    const res = await postJson("/v1/notifications/push/all", {
      title: "Maintenance",
      body: "Tonight at 02:00 UTC.",
      dryRun: true,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      dryRun: true,
      estimatedUsers: 2,
      estimatedDevices: 3,
    });
    expect(sendNotificationMock).not.toHaveBeenCalled();
  });

  it("enqueues a real broadcast and returns estimates", async () => {
    await seedSubscriptions(env.DB, [
      { userId: "u1", endpoint: "https://push.example.com/s/1" },
      { userId: "u2", endpoint: "https://push.example.com/s/2" },
    ]);

    // Stub the queue producer: this test verifies *routing*, not delivery.
    // (Self-chained delivery is covered in jobs.test.ts.)
    const sendSpy = vi
      .spyOn(env.PUSH_QUEUE, "send")
      .mockResolvedValue(fakeQueueSendResponse());

    const res = await postJson("/v1/notifications/push/all", {
      title: "Maintenance",
      body: "Tonight at 02:00 UTC.",
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      queued: boolean;
      estimatedUsers: number;
      estimatedDevices: number;
    };
    expect(json.queued).toBe(true);
    expect(json.estimatedUsers).toBe(2);
    expect(json.estimatedDevices).toBe(2);

    expect(sendSpy).toHaveBeenCalledTimes(1);
    const [job] = sendSpy.mock.calls[0] as unknown[];
    expect(job).toMatchObject({ kind: "broadcast-page", afterId: null });
    expect(sendNotificationMock).not.toHaveBeenCalled();
    sendSpy.mockRestore();
  });

  it("rejects an invalid message", async () => {
    const res = await postJson("/v1/notifications/push/all", { body: "no title" });
    expect(res.status).toBe(400);
  });
});
