import { beforeEach, beforeAll, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { processBatchChunk, processBroadcastPage } from "../src/jobs";
import { applyPushSchema, seedSubscriptions } from "./schema";
import type { BroadcastPageJob, BatchChunkJob } from "../src/jobs";

const { sendNotificationMock } = vi.hoisted(() => ({
  sendNotificationMock: vi.fn(),
}));

vi.mock("web-push-neo", () => ({
  sendNotification: sendNotificationMock,
}));

const message = {
  title: "Maintenance",
  body: "Tonight at 02:00 UTC.",
  urgency: "normal",
  ttl: 86_400,
} as const;

beforeAll(async () => {
  await applyPushSchema(env.DB);
});

describe("processBroadcastPage", () => {
  beforeEach(async () => {
    sendNotificationMock.mockReset();
    sendNotificationMock.mockResolvedValue({ statusCode: 201 });
    await env.DB.prepare("DELETE FROM push_subscriptions").run();
  });

  it("sends a full page and self-chains the next page", async () => {
    await seedSubscriptions(env.DB, [
      { userId: "u1", endpoint: "https://push.example.com/s/1" },
      { userId: "u2", endpoint: "https://push.example.com/s/2" },
      { userId: "u3", endpoint: "https://push.example.com/s/3" },
    ]);

    const queue = { send: vi.fn(async (_job: unknown) => undefined) };

    // pageSize smaller than the table exercises the self-chaining path.
    const first = await processBroadcastPage(
      env,
      queue,
      { kind: "broadcast-page", afterId: null, message },
      2,
    );
    expect(first).toEqual({ processed: 2, chained: true });
    expect(queue.send).toHaveBeenCalledTimes(1);

    const chainedJob = queue.send.mock.calls[0][0] as BroadcastPageJob;
    expect(chainedJob.kind).toBe("broadcast-page");
    expect(chainedJob.afterId).toBe("seed-00001");

    const second = await processBroadcastPage(env, queue, chainedJob, 2);
    expect(second).toEqual({ processed: 1, chained: false });
    expect(queue.send).toHaveBeenCalledTimes(1);

    expect(sendNotificationMock).toHaveBeenCalledTimes(3);
  });

  it("completes without chaining when the table fits in one page", async () => {
    await seedSubscriptions(env.DB, [
      { userId: "u1", endpoint: "https://push.example.com/s/1" },
    ]);

    const queue = { send: vi.fn(async () => undefined) };
    const result = await processBroadcastPage(
      env,
      queue,
      { kind: "broadcast-page", afterId: null, message },
      2,
    );
    expect(result).toEqual({ processed: 1, chained: false });
    expect(queue.send).not.toHaveBeenCalled();
    expect(sendNotificationMock).toHaveBeenCalledTimes(1);
  });

  it("handles an empty table", async () => {
    const queue = { send: vi.fn(async () => undefined) };
    const result = await processBroadcastPage(
      env,
      queue,
      { kind: "broadcast-page", afterId: null, message },
      2,
    );
    expect(result).toEqual({ processed: 0, chained: false });
    expect(sendNotificationMock).not.toHaveBeenCalled();
  });
});

describe("processBatchChunk", () => {
  beforeEach(async () => {
    sendNotificationMock.mockReset();
    sendNotificationMock.mockResolvedValue({ statusCode: 201 });
    await env.DB.prepare("DELETE FROM push_subscriptions").run();
  });

  it("delivers to all devices of the chunk's users", async () => {
    await seedSubscriptions(env.DB, [
      { userId: "u1", endpoint: "https://push.example.com/s/1" },
      { userId: "u2", endpoint: "https://push.example.com/s/2" },
      { userId: "u2", endpoint: "https://push.example.com/s/3" },
      { userId: "u3", endpoint: "https://push.example.com/s/4" },
    ]);

    await processBatchChunk(env, {
      kind: "batch-chunk",
      userIds: ["u1", "u2"],
      message,
    } satisfies BatchChunkJob);

    expect(sendNotificationMock).toHaveBeenCalledTimes(3);
  });
});
