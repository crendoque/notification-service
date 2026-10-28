import type { Bindings } from "./env";
import { attachmentKeysFromPayload, deleteAttachments } from "./attachments";
import {
  getEmailRequestById,
  incrementEmailRequestAttempts,
  isEmailSendComplete,
  markEmailRequestFailed,
  markEmailRequestSent,
} from "./db";
import {
  createResendTransport,
  EMAIL_MAX_ATTEMPTS,
  sendEmailRequest,
  toResendError,
  type EmailTransport,
} from "./email";
import { storedEmailContentSchema, type EmailSendJob } from "./validation";

export type EmailSendOutcome = "sent" | "failed" | "skipped";

/**
 * Records a permanent failure and releases the staged attachments.
 *
 * The bytes are only needed while another attempt is still possible, so every
 * terminal path deletes them — that is what keeps the bucket from growing.
 * The key list is read loosely so cleanup still works for a payload that failed
 * to validate.
 */
async function failPermanently(
  env: Bindings,
  request: { id: string; payload: string },
  input: { errorName: string; errorMessage: string; attempts: number },
): Promise<void> {
  await markEmailRequestFailed(env, { id: request.id, ...input });

  const keys = attachmentKeysFromPayload(request.payload);
  if (keys.length === 0) return;

  const deleted = await deleteAttachments(env, keys, { requestId: request.id });
  console.log(
    JSON.stringify({
      msg: "attachments_deleted",
      requestId: request.id,
      reason: input.errorName,
      deleted,
    }),
  );
}

export interface EmailSendOptions {
  /** Injected in tests; defaults to the real Resend client. */
  transport?: EmailTransport;
  /** Queue delivery attempt number (`message.attempts`). */
  attempt?: number;
  maxAttempts?: number;
}

/**
 * Delivers one queued email request.
 *
 * The payload is re-read from D1 so a retry always sends exactly what the
 * caller originally asked for, and rows that already reached Resend are
 * skipped — which is what makes at-least-once queue delivery safe.
 *
 * Retryable failures are thrown so the consumer calls `message.retry()`;
 * permanent failures are recorded and acked.
 */
export async function processEmailSend(
  env: Bindings,
  job: EmailSendJob,
  options: EmailSendOptions = {},
): Promise<EmailSendOutcome> {
  const request = await getEmailRequestById(env, job.requestId);
  if (!request) {
    console.warn(JSON.stringify({ msg: "email_request_missing", requestId: job.requestId }));
    return "skipped";
  }

  if (isEmailSendComplete(request.status)) {
    console.log(
      JSON.stringify({
        msg: "email_send_skipped",
        requestId: request.id,
        status: request.status,
      }),
    );
    return "skipped";
  }

  let content: ReturnType<typeof storedEmailContentSchema.parse>;
  try {
    content = storedEmailContentSchema.parse(JSON.parse(request.payload));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await failPermanently(env, request, {
      errorName: "invalid_stored_payload",
      errorMessage: message.slice(0, 500),
      attempts: request.attempts + 1,
    });
    console.error(
      JSON.stringify({ msg: "email_send_failed", requestId: request.id, error: "invalid_stored_payload" }),
    );
    return "failed";
  }

  const maxAttempts = options.maxAttempts ?? EMAIL_MAX_ATTEMPTS;
  const attempt = Math.max(options.attempt ?? 1, request.attempts + 1);

  try {
    const { id } = await sendEmailRequest(
      env,
      request,
      content,
      content.attachments ?? [],
      options.transport ?? createResendTransport(env),
    );
    await markEmailRequestSent(env, {
      id: request.id,
      resendId: id,
      attempts: attempt,
    });
    console.log(
      JSON.stringify({
        msg: "email_sent",
        requestId: request.id,
        app: request.app,
        mode: request.mode,
        resendId: id,
        attempt,
      }),
    );
    return "sent";
  } catch (error) {
    const resendError = toResendError(error);

    if (resendError.retryable && attempt < maxAttempts) {
      await incrementEmailRequestAttempts(env, request.id);
      console.warn(
        JSON.stringify({
          msg: "email_send_retry",
          requestId: request.id,
          attempt,
          maxAttempts,
          statusCode: resendError.statusCode,
          error: resendError.errorName,
        }),
      );
      // Let the queue consumer retry the message.
      throw error;
    }

    const errorName = resendError.retryable ? "retries_exhausted" : resendError.errorName;
    await failPermanently(env, request, {
      errorName,
      errorMessage: resendError.message.slice(0, 500),
      attempts: attempt,
    });
    console.error(
      JSON.stringify({
        msg: "email_send_failed",
        requestId: request.id,
        app: request.app,
        attempt,
        statusCode: resendError.statusCode,
        error: errorName,
      }),
    );
    return "failed";
  }
}
