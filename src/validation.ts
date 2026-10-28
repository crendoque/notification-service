import { z } from "zod";

/** Message fields shared by all three trigger modes (single / batch / broadcast). */
export const pushMessageSchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(2000),
  /** URL opened (or focused) when the user clicks the notification. */
  url: z.string().url().optional(),
  /** Icon URL shown by the notification. */
  icon: z.string().optional(),
  /** Notification tag: replaces a previous notification with the same tag. Max 32 chars. */
  tag: z.string().max(32).optional(),
  /** Hint to the push service / OS about delivery priority. */
  urgency: z.enum(["very-low", "low", "normal", "high"]).default("normal"),
  /** Seconds the push service keeps the message if the device is offline. Default: 24h. */
  ttl: z.number().int().min(0).max(2_419_200).default(86_400),
  /** Arbitrary JSON passed through to the service worker's `push` event. */
  data: z.record(z.string(), z.unknown()).optional(),
});
export type PushMessage = z.infer<typeof pushMessageSchema>;

/**
 * The browser's PushSubscription JSON, exactly as produced by
 * `pushManager.subscribe()` + `subscription.toJSON()` on the PWA side.
 */
export const pushSubscriptionSchema = z.object({
  endpoint: z.string().url().min(1),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
});
export type PushSubscriptionInput = z.infer<typeof pushSubscriptionSchema>;

/** PUT /v1/subscriptions */
export const registerSubscriptionSchema = z.object({
  userId: z.string().min(1).max(256),
  subscription: pushSubscriptionSchema,
});
export type RegisterSubscriptionInput = z.infer<typeof registerSubscriptionSchema>;

/** Mode 1 — POST /v1/notifications/push (specific user). */
export const pushNotificationSchema = pushMessageSchema.extend({
  userId: z.string().min(1).max(256),
});
export type PushNotificationInput = z.infer<typeof pushNotificationSchema>;

/** Mode 2 — POST /v1/notifications/push/batch (list of users). */
export const pushBatchSchema = pushMessageSchema.extend({
  userIds: z.array(z.string().min(1).max(256)).min(1).max(500),
});
export type PushBatchInput = z.infer<typeof pushBatchSchema>;

/** Mode 3 — POST /v1/notifications/push/all (broadcast to everyone). */
export const pushBroadcastSchema = pushMessageSchema.extend({
  /** Count recipients and devices without enqueuing anything. */
  dryRun: z.boolean().optional().default(false),
});

/* ------------------------------------------------------------------ *
 * Email attachments
 * ------------------------------------------------------------------ */

/**
 * Attachment limits.
 *
 * Only R2 references are stored in the request payload — never the bytes — so
 * the D1 row (2 MB hard limit) stays small. At send time the peak memory is
 * roughly 3.7x the decoded size (bytes + base64 + the JSON copy), so 15 MB
 * (~56 MB peak) leaves comfortable headroom inside a 128 MB isolate.
 */
export const EMAIL_MAX_ATTACHMENTS = 10;
/** Largest single attachment, in decoded bytes. */
export const EMAIL_MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
/** Largest total across all attachments of one request, in decoded bytes. */
export const EMAIL_MAX_TOTAL_ATTACHMENT_BYTES = 15 * 1024 * 1024;

/**
 * Extensions Resend refuses to send, so an upload is rejected with `415`
 * immediately instead of failing later inside the queue.
 * https://resend.com/docs/knowledge-base/what-attachment-types-are-not-supported
 */
export const UNSUPPORTED_ATTACHMENT_EXTENSIONS: ReadonlySet<string> = new Set([
  ".adp", ".app", ".asp", ".bas", ".bat", ".cer", ".chm", ".cmd", ".com", ".cpl",
  ".crt", ".csh", ".der", ".exe", ".fxp", ".gadget", ".hlp", ".hta", ".inf", ".ins",
  ".isp", ".its", ".js", ".jse", ".ksh", ".lib", ".lnk", ".mad", ".maf", ".mag",
  ".mam", ".maq", ".mar", ".mas", ".mat", ".mau", ".mav", ".maw", ".mda", ".mdb",
  ".mde", ".mdt", ".mdw", ".mdz", ".msc", ".msh", ".msh1", ".msh2", ".mshxml",
  ".msh1xml", ".msh2xml", ".msi", ".msp", ".mst", ".ops", ".pcd", ".pif", ".plg",
  ".prf", ".prg", ".reg", ".scf", ".scr", ".sct", ".shb", ".shs", ".sys", ".ps1",
  ".ps1xml", ".ps2", ".ps2xml", ".psc1", ".psc2", ".tmp", ".url", ".vb", ".vbe",
  ".vbs", ".vps", ".vsmacros", ".vss", ".vst", ".vsw", ".vxd", ".ws", ".wsc",
  ".wsf", ".wsh", ".xnk",
]);

/**
 * Filename as it appears on the attachment. Path separators and control
 * characters are rejected so a caller cannot smuggle a path or a MIME header
 * fragment into the message.
 */
export const attachmentFilenameSchema = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (value) =>
      !value.includes("/") && !value.includes("\\") && !/[\u0000-\u001f\u007f]/.test(value),
    "filename must not contain path separators or control characters",
  )
  .refine((value) => value !== "." && value !== "..", "filename is not a valid file name");

/** MIME type, e.g. `application/pdf`. */
export const attachmentContentTypeSchema = z
  .string()
  .min(3)
  .max(255)
  .regex(/^[\w.+-]+\/[\w.+-]+$/, "content_type must be a MIME type such as application/pdf");

/** CID referenced from the HTML as `<img src="cid:<content_id>">`. */
export const attachmentContentIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._@-]+$/, "content_id must contain only letters, digits, . _ @ or -");

/** Returns the lower-cased extension of a filename ("" when it has none). */
export function attachmentExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot <= 0 ? "" : filename.slice(dot).toLowerCase();
}

/** True when Resend would refuse to send a file with this name. */
export function isUnsupportedAttachmentFilename(filename: string): boolean {
  return UNSUPPORTED_ATTACHMENT_EXTENSIONS.has(attachmentExtension(filename));
}

/**
 * One entry of `payload.attachments` in the *request*.
 *
 * Attachments travel as `multipart/form-data` parts: `field` names the part
 * carrying the bytes, and the worker mints the R2 reference itself. The whole
 * field is optional — an email with no attachments needs neither.
 */
export const emailAttachmentInputSchema = z.object({
  /** Name of the multipart part holding the file (`field: "invoice"` -> part `invoice`). */
  field: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/, "field must be letters, digits, - or _"),
  /** Filename shown to the recipient. Defaults to the uploaded part's filename. */
  filename: attachmentFilenameSchema.optional(),
  /** MIME type. Defaults to the uploaded part's Content-Type. */
  content_type: attachmentContentTypeSchema.optional(),
  /** Set to embed the file inline, e.g. `<img src="cid:logo">`. */
  content_id: attachmentContentIdSchema.optional(),
});
export type EmailAttachmentInput = z.infer<typeof emailAttachmentInputSchema>;

/**
 * What is persisted in `email_requests.payload` for each attachment — the R2
 * key plus the metadata needed to rebuild the Resend part on every attempt.
 */
export const storedAttachmentSchema = z.object({
  /** R2 object key; the cleanup path deletes exactly this key. */
  key: z.string().min(1).max(512),
  id: z.string().min(1).max(64),
  filename: attachmentFilenameSchema,
  content_type: attachmentContentTypeSchema.optional(),
  content_id: attachmentContentIdSchema.optional(),
  /** Decoded size in bytes. */
  size: z.number().int().min(0),
});
export type StoredAttachment = z.infer<typeof storedAttachmentSchema>;

/** Email payload fields shared by the template and inline modes. */
const emailContentBaseSchema = z.object({
  /** true -> send with a published Resend template; false -> send inline html/text. */
  useTemplate: z.boolean(),
  /** Resend template id or alias. Required when `useTemplate` is true. */
  templateId: z.string().min(1).max(256).optional(),
  /** Template variables (the same values are used for the whole request). */
  variables: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  /** Subject line. Optional with a template (it overrides the template default). */
  subject: z.string().min(1).max(998).optional(),
  /** HTML body (inline mode). */
  html: z.string().min(1).max(100_000).optional(),
  /** Plain-text body (inline mode). */
  text: z.string().min(1).max(100_000).optional(),
  /** Optional sender override — must match the EMAIL_ALLOWED_SENDERS allowlist. */
  from: z.string().min(1).max(320).optional(),
  replyTo: z.union([z.email(), z.array(z.email()).min(1).max(50)]).optional(),
  /** ISO 8601 or natural language, e.g. "in 1 min". */
  scheduledAt: z.string().min(1).max(64).optional(),
  idempotencyKey: z.string().min(1).max(256).optional(),
});
export type EmailContentBase = z.infer<typeof emailContentBaseSchema>;

/**
 * Request-facing payload. `attachments` describes the `multipart/form-data`
 * parts to read; omit it (or send an empty array) to send an email with no
 * files — attachments are always optional.
 */
export const emailContentSchema = emailContentBaseSchema.extend({
  attachments: z.array(emailAttachmentInputSchema).max(EMAIL_MAX_ATTACHMENTS).optional(),
});
export type EmailContentInput = z.infer<typeof emailContentSchema>;

/**
 * Stored payload — the replay source for the queue consumer and every retry.
 * `attachments` holds the resolved R2 references instead of part descriptors.
 */
export const storedEmailContentSchema = emailContentBaseSchema.extend({
  attachments: z.array(storedAttachmentSchema).max(EMAIL_MAX_ATTACHMENTS).optional(),
});
export type StoredEmailContent = z.infer<typeof storedEmailContentSchema>;

/** Statuses an email request can be in (kept in sync with db.ts). */
export const emailStatusSchema = z.enum([
  "queued",
  "sent",
  "delivered",
  "bounced",
  "failed",
]);

/** POST /v1/notifications/email — one recipient, always sent to `To` only. */
export const emailRequestSchema = z
  .object({
    /** Machine identifier of the calling app, e.g. "crm". */
    app: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9][a-z0-9_-]*$/, "app must be lowercase letters, digits, - or _"),
    userId: z.string().min(1).max(256),
    email: z.email().max(320),
    payload: emailContentSchema,
  })
  .superRefine((value, ctx) => {
    const payload = value.payload;

    // Each multipart part may be referenced once: a duplicate `field` would
    // attach the same file twice and hide a caller mistake.
    const fields = (payload.attachments ?? []).map((attachment) => attachment.field);
    if (new Set(fields).size !== fields.length) {
      ctx.addIssue({
        code: "custom",
        path: ["payload", "attachments"],
        message: "attachment `field` values must be unique",
      });
    }

    if (payload.useTemplate) {
      if (!payload.templateId) {
        ctx.addIssue({
          code: "custom",
          path: ["payload", "templateId"],
          message: "templateId is required when useTemplate is true",
        });
      }
      if (payload.html !== undefined || payload.text !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["payload", "html"],
          message: "html/text cannot be combined with a template",
        });
      }
      return;
    }
    if (!payload.subject) {
      ctx.addIssue({
        code: "custom",
        path: ["payload", "subject"],
        message: "subject is required when useTemplate is false",
      });
    }
    if (payload.html === undefined && payload.text === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["payload", "html"],
        message: "html or text is required when useTemplate is false",
      });
    }
  });
export type EmailRequestInput = z.infer<typeof emailRequestSchema>;

/**
 * Fields the worker deliberately does not accept: the recipient always comes
 * from the request's `email` field (To only), so silently dropping `to`/`cc`/
 * `bcc` would hide a caller mistake.
 */
export const UNSUPPORTED_EMAIL_PAYLOAD_FIELDS = ["to", "cc", "bcc", "headers", "tags"] as const;

/** Returns which unsupported fields the caller sent (empty when none were). */
export function findUnsupportedEmailPayloadFields(body: unknown): string[] {
  if (typeof body !== "object" || body === null) return [];
  const { payload } = body as { payload?: unknown };
  if (typeof payload !== "object" || payload === null) return [];
  const candidate = payload as Record<string, unknown>;
  return UNSUPPORTED_EMAIL_PAYLOAD_FIELDS.filter((field) => field in candidate);
}

/** GET /v1/notifications/email — history listing filters. */
export const emailListQuerySchema = z.object({
  app: z.string().min(1).max(64).optional(),
  userId: z.string().min(1).max(256).optional(),
  status: emailStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  /** Keyset cursor: the `seq` of the last row of the previous page. */
  afterSeq: z.coerce.number().int().min(0).optional(),
});

/** Internal queue job envelopes (validated again on the consumer side). */
export const notificationJobSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("broadcast-page"),
    afterId: z.string().min(1).nullable(),
    message: pushMessageSchema,
  }),
  z.object({
    kind: z.literal("batch-chunk"),
    userIds: z.array(z.string().min(1).max(256)).min(1).max(50),
    message: pushMessageSchema,
  }),
  z.object({
    kind: z.literal("email-send"),
    /** The payload lives in D1, so the job body stays tiny. */
    requestId: z.string().min(1).max(64),
  }),
]);
export type NotificationJob = z.infer<typeof notificationJobSchema>;
export type PushJob = Extract<NotificationJob, { kind: "broadcast-page" | "batch-chunk" }>;
export type EmailSendJob = Extract<NotificationJob, { kind: "email-send" }>;
