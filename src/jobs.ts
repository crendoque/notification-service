import type { Bindings } from "./env";
import { getSubscriptionPage, getSubscriptionsForUsers } from "./db";
import { sendToDevices } from "./push";
import type { PushJob } from "./validation";

/**
 * Devices processed per broadcast page. Keeps each consumer invocation well
 * within CPU/subrequest limits no matter how many devices exist in total.
 */
export const BROADCAST_PAGE_SIZE = 100;

/** Users per queued batch chunk (matches the D1 IN-clause chunk size). */
export const BATCH_CHUNK_SIZE = 50;

/** Minimal producer interface so tests can inject a fake queue. */
export interface PushQueueProducer {
  send(message: PushJob): Promise<unknown>;
}

export type BroadcastPageJob = Extract<PushJob, { kind: "broadcast-page" }>;
export type BatchChunkJob = Extract<PushJob, { kind: "batch-chunk" }>;

/**
 * Broadcast fan-out: sends one keyset-paginated page of devices, then
 * self-chains the next page onto the queue. Returns whether another page
 * was enqueued.
 */
export async function processBroadcastPage(
  env: Bindings,
  queue: PushQueueProducer,
  job: BroadcastPageJob,
  pageSize: number = BROADCAST_PAGE_SIZE,
): Promise<{ processed: number; chained: boolean }> {
  const rows = await getSubscriptionPage(env, job.afterId, pageSize);
  const summary = await sendToDevices(env, rows, job.message);
  console.log(
    JSON.stringify({
      msg: "broadcast_page_processed",
      afterId: job.afterId,
      devices: rows.length,
      ...summary,
    }),
  );

  if (rows.length < pageSize) {
    console.log(JSON.stringify({ msg: "broadcast_complete" }));
    return { processed: rows.length, chained: false };
  }

  const afterId = rows[rows.length - 1].id;
  await queue.send({ kind: "broadcast-page", afterId, message: job.message });
  return { processed: rows.length, chained: true };
}

/** Queued batch chunk: deliver to every registered device of the given users. */
export async function processBatchChunk(
  env: Bindings,
  job: BatchChunkJob,
): Promise<void> {
  const rows = await getSubscriptionsForUsers(env, job.userIds);
  const summary = await sendToDevices(env, rows, job.message);
  console.log(
    JSON.stringify({
      msg: "batch_chunk_processed",
      users: job.userIds.length,
      devices: rows.length,
      ...summary,
    }),
  );
}
