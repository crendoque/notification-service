import type { Bindings } from "./env";
import type { StoredAttachment } from "./validation";

/**
 * R2-backed staging for email attachments.
 *
 * The bucket is private and is never exposed: no `r2.dev` domain, no custom
 * domain, no signed URLs. The worker is the only reader and Resend never sees
 * R2 — the bytes are re-encoded as base64 `content` when the email is sent.
 * That keeps the recipient's attachment a real file rather than a link, while
 * leaving the D1 payload (2 MB row limit) holding references only.
 */

/** Key prefix; also the prefix an optional lifecycle rule can target. */
export const ATTACHMENT_KEY_PREFIX = "attachments/";

/**
 * Deterministic R2 key. Namespaced by app so one app can never read or delete
 * another app's object, even with a guessed id.
 */
export function attachmentKey(app: string, id: string): string {
  return `${ATTACHMENT_KEY_PREFIX}${app}/${id}`;
}

export interface PutAttachmentInput {
  app: string;
  /** Random id for this object; the key is derived from it. */
  id: string;
  filename: string;
  /** Resolved MIME type, when known. */
  contentType?: string;
  /** The uploaded part. A Blob lets R2 read it without an extra copy. */
  file: Blob;
}

/** Stores one uploaded part and returns the reference persisted in D1. */
export async function putAttachment(
  env: Bindings,
  input: PutAttachmentInput,
): Promise<StoredAttachment> {
  const key = attachmentKey(input.app, input.id);
  const { contentType } = input;
  await env.ATTACHMENTS.put(key, input.file, {
    httpMetadata: contentType ? { contentType } : undefined,
    customMetadata: {
      app: input.app,
      filename: input.filename,
      ...(contentType ? { contentType } : {}),
    },
  });

  const stored: StoredAttachment = {
    key,
    id: input.id,
    filename: input.filename,
    size: input.file.size,
  };
  if (contentType) stored.content_type = contentType;
  return stored;
}

/**
 * Reads one attachment's bytes. Returns null when the object is gone, which
 * happens when a retry outlives the cleanup of an earlier terminal state.
 */
export async function getAttachmentBytes(
  env: Bindings,
  key: string,
): Promise<Uint8Array | null> {
  const object = await env.ATTACHMENTS.get(key);
  if (!object) return null;
  return new Uint8Array(await object.arrayBuffer());
}

/**
 * Deletes the given keys. Best-effort by design: cleanup must never fail a
 * webhook or a send job, and R2 deletes are idempotent (deleting a missing key
 * is not an error), so this is always safe to repeat.
 */
export async function deleteAttachments(
  env: Bindings,
  keys: string[],
  context: Record<string, unknown> = {},
): Promise<number> {
  let deleted = 0;
  for (const key of keys) {
    try {
      await env.ATTACHMENTS.delete(key);
      deleted += 1;
    } catch (error) {
      console.error(
        JSON.stringify({ msg: "attachment_delete_failed", key, error: String(error), ...context }),
      );
    }
  }
  return deleted;
}

interface RawStoredAttachment {
  key?: unknown;
  filename?: unknown;
  content_type?: unknown;
  size?: unknown;
}

/**
 * Loose read of `attachments[]` from a stored payload.
 *
 * Deliberately not schema-validated: cleanup must still work for a payload
 * written by an older (or newer) version of the schema, and a row that fails to
 * parse must never be able to block a webhook.
 */
function readStoredAttachments(payloadJson: string): RawStoredAttachment[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  const attachments = (parsed as { attachments?: unknown }).attachments;
  if (!Array.isArray(attachments)) return [];
  return attachments.filter(
    (entry): entry is RawStoredAttachment => typeof entry === "object" && entry !== null,
  );
}

/**
 * R2 keys held by a stored payload. Anything outside our own key prefix is
 * ignored, so a corrupted row can never make the worker delete an unrelated
 * object.
 */
export function attachmentKeysFromPayload(payloadJson: string): string[] {
  const keys: string[] = [];
  for (const entry of readStoredAttachments(payloadJson)) {
    if (typeof entry.key === "string" && entry.key.startsWith(ATTACHMENT_KEY_PREFIX)) {
      keys.push(entry.key);
    }
  }
  return keys;
}

/** API representation of an attachment — metadata only, never the bytes. */
export interface AttachmentSummary {
  filename: string;
  contentType: string | null;
  size: number;
}

/** Summarises references we already hold (used by the trigger response). */
export function summarizeAttachments(attachments: StoredAttachment[]): AttachmentSummary[] {
  return attachments.map((attachment) => ({
    filename: attachment.filename,
    contentType: attachment.content_type ?? null,
    size: attachment.size,
  }));
}

/** Summarises a stored payload; null when the request has no attachments. */
export function payloadAttachmentSummary(payloadJson: string): AttachmentSummary[] | null {
  const summaries = readStoredAttachments(payloadJson).map((entry) => ({
    filename: typeof entry.filename === "string" ? entry.filename : "attachment",
    contentType: typeof entry.content_type === "string" ? entry.content_type : null,
    size: typeof entry.size === "number" ? entry.size : 0,
  }));
  return summaries.length > 0 ? summaries : null;
}

/** 48 KB — a multiple of 3, which `btoa` requires (see `toBase64`). */
const BASE64_CHUNK_BYTES = 49_152;

function toBinaryString(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return binary;
}

/**
 * Base64 for Resend's `content` field.
 *
 * `btoa` pads whatever it is handed, so every chunk except the last must be a
 * multiple of 3 bytes — otherwise `=` padding is injected mid-string and the
 * file is silently corrupted. The binary string is built with a loop rather
 * than `String.fromCharCode(...chunk)` so a large chunk cannot blow the call
 * stack.
 */
export function toBase64(bytes: Uint8Array): string {
  if (bytes.length <= BASE64_CHUNK_BYTES) return btoa(toBinaryString(bytes));
  let out = "";
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_BYTES) {
    const end = Math.min(offset + BASE64_CHUNK_BYTES, bytes.length);
    out += btoa(toBinaryString(bytes.subarray(offset, end)));
  }
  return out;
}
