import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { app } from "../src/index";
import { attachmentKey } from "../src/attachments";
import { EMAIL_MAX_ATTACHMENT_BYTES } from "../src/validation";
import { applyEmailSchema, applyPushSchema, fakeQueueSendResponse } from "./schema";

const ATTACHMENT_PREFIX = "attachments/";

const authHeaders = (): Record<string, string> => ({
  Authorization: `Bearer ${env.BACKEND_AUTH_TOKEN}`,
});

/** Every staged object key, so staging and cleanup can be asserted. */
async function listAttachmentKeys(): Promise<string[]> {
  const { objects } = await env.ATTACHMENTS.list({ prefix: ATTACHMENT_PREFIX });
  return objects.map((object) => object.key);
}

async function clearAttachments(): Promise<void> {
  for (const key of await listAttachmentKeys()) await env.ATTACHMENTS.delete(key);
}

interface UploadFile {
  name: string;
  type: string;
  body: string;
}

/**
 * Builds the multipart body the endpoint accepts: a `payload` part holding the
 * JSON, plus one file part per attachment, named after `attachments[].field`.
 */
function multipart(body: unknown, files: Record<string, UploadFile> = {}): FormData {
  const form = new FormData();
  form.append("payload", JSON.stringify(body));
  for (const [field, file] of Object.entries(files)) {
    form.append(field, new File([file.body], file.name, { type: file.type }));
  }
  return form;
}

/** Content-Type is omitted on purpose: the runtime adds the boundary itself. */
async function postEmail(form: FormData, bindings: Cloudflare.Env = env): Promise<Response> {
  return app.request(
    "/v1/notifications/email",
    { method: "POST", headers: authHeaders(), body: form },
    bindings,
  );
}

function inlinePayload(extra: Record<string, unknown> = {}) {
  return {
    app: "crm",
    userId: "user-1",
    email: "user@example.com",
    payload: { useTemplate: false, subject: "Invoice", html: "<p>Attached</p>", ...extra },
  };
}

const invoice: UploadFile = {
  name: "invoice-1042.pdf",
  type: "application/pdf",
  body: "%PDF-1.4 fake invoice bytes",
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  await applyPushSchema(env.DB);
  await applyEmailSchema(env.DB);
});

beforeEach(async () => {
  // The test pool delivers queued messages in the background, so `fetch` is
  // always stubbed: the trigger must never call Resend, and a background
  // delivery must never reach the real API.
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "resend-test" }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  await env.DB.prepare("DELETE FROM email_requests").run();
  await clearAttachments();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("POST /v1/notifications/email with attachments", () => {
  it("stages the file in R2 and stores only a reference in D1", async () => {
    const sendSpy = vi
      .spyOn(env.PUSH_QUEUE, "send")
      .mockResolvedValue(fakeQueueSendResponse());

    const res = await postEmail(
      multipart(inlinePayload({ attachments: [{ field: "invoice" }] }), { invoice }),
    );

    expect(res.status).toBe(202);
    const json = (await res.json()) as {
      id: string;
      attachments: { filename: string; contentType: string | null; size: number }[] | null;
    };
    expect(json.attachments).toEqual([
      { filename: "invoice-1042.pdf", contentType: "application/pdf", size: invoice.body.length },
    ]);

    // Exactly one object, keyed under the requesting app.
    const keys = await listAttachmentKeys();
    expect(keys).toHaveLength(1);
    expect(keys[0].startsWith(`${ATTACHMENT_PREFIX}crm/`)).toBe(true);

    const object = await env.ATTACHMENTS.get(keys[0]);
    expect(await object?.text()).toBe(invoice.body);
    expect(object?.customMetadata?.filename).toBe("invoice-1042.pdf");

    // The stored payload carries the reference, never the bytes.
    const row = await env.DB.prepare("SELECT payload FROM email_requests WHERE id = ?")
      .bind(json.id)
      .first<{ payload: string }>();
    expect(row?.payload).toContain(keys[0]);
    expect(row?.payload).not.toContain(invoice.body);
    expect(row?.payload).not.toContain('"field"');

    // Still asynchronous: one job, and Resend is not called from the handler.
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy.mock.calls[0][0]).toEqual({ kind: "email-send", requestId: json.id });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("supports several files, name overrides and an inline content id", async () => {
    vi.spyOn(env.PUSH_QUEUE, "send").mockResolvedValue(fakeQueueSendResponse());

    const res = await postEmail(
      multipart(
        inlinePayload({
          attachments: [
            { field: "invoice", filename: "Q3-invoice.pdf" },
            { field: "logo", content_type: "image/png", content_id: "brand" },
          ],
        }),
        {
          invoice,
          logo: { name: "logo.png", type: "image/png", body: "PNGDATA" },
        },
      ),
    );

    expect(res.status).toBe(202);
    const json = (await res.json()) as {
      id: string;
      attachments: { filename: string; contentType: string | null }[];
    };
    expect(json.attachments).toEqual([
      { filename: "Q3-invoice.pdf", contentType: "application/pdf", size: invoice.body.length },
      { filename: "logo.png", contentType: "image/png", size: 7 },
    ]);

    const row = await env.DB.prepare("SELECT payload FROM email_requests WHERE id = ?")
      .bind(json.id)
      .first<{ payload: string }>();
    expect(row?.payload).toContain('"content_id":"brand"');
  });

  it("accepts a multipart request with no attachments at all", async () => {
    const sendSpy = vi
      .spyOn(env.PUSH_QUEUE, "send")
      .mockResolvedValue(fakeQueueSendResponse());

    const res = await postEmail(multipart(inlinePayload()));

    expect(res.status).toBe(202);
    const json = (await res.json()) as { attachments: unknown };
    expect(json.attachments).toBeNull();
    expect(await listAttachmentKeys()).toHaveLength(0);
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it("keeps the plain JSON path working with no attachments", async () => {
    const sendSpy = vi
      .spyOn(env.PUSH_QUEUE, "send")
      .mockResolvedValue(fakeQueueSendResponse());

    const res = await app.request(
      "/v1/notifications/email",
      {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify(inlinePayload()),
      },
      env,
    );

    expect(res.status).toBe(202);
    const json = (await res.json()) as { attachments: unknown; mode: string };
    expect(json.attachments).toBeNull();
    expect(json.mode).toBe("inline");
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("attachment validation", () => {
  it("rejects a declared field with no matching part", async () => {
    const res = await postEmail(
      multipart(inlinePayload({ attachments: [{ field: "invoice" }] })),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: "attachment_part_missing",
      fields: ["invoice"],
    });
    expect(await listAttachmentKeys()).toHaveLength(0);
  });

  it("rejects a file part that nothing declares", async () => {
    const res = await postEmail(multipart(inlinePayload(), { invoice }));

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: "attachment_part_undeclared",
      fields: ["invoice"],
    });
    expect(await listAttachmentKeys()).toHaveLength(0);
  });

  it("rejects stray text fields — all metadata belongs in the payload", async () => {
    const form = multipart(inlinePayload());
    form.append("app", "crm");

    const res = await postEmail(form);

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "unsupported_field", fields: ["app"] });
  });

  it("rejects an empty file", async () => {
    const res = await postEmail(
      multipart(inlinePayload({ attachments: [{ field: "invoice" }] }), {
        invoice: { name: "invoice.pdf", type: "application/pdf", body: "" },
      }),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_request" });
    expect(await listAttachmentKeys()).toHaveLength(0);
  });

  it("rejects a file larger than the per-file cap", async () => {
    const form = new FormData();
    form.append(
      "payload",
      JSON.stringify(inlinePayload({ attachments: [{ field: "big" }] })),
    );
    form.append(
      "big",
      new File([new Uint8Array(EMAIL_MAX_ATTACHMENT_BYTES + 1)], "big.bin", {
        type: "application/octet-stream",
      }),
    );

    const res = await postEmail(form);

    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({
      error: "file_too_large",
      field: "big",
      maxBytes: EMAIL_MAX_ATTACHMENT_BYTES,
    });
    expect(await listAttachmentKeys()).toHaveLength(0);
  });

  it("rejects an extension Resend will not send", async () => {
    const res = await postEmail(
      multipart(inlinePayload({ attachments: [{ field: "setup" }] }), {
        setup: { name: "setup.exe", type: "application/octet-stream", body: "MZ" },
      }),
    );

    expect(res.status).toBe(415);
    expect(await res.json()).toMatchObject({
      error: "unsupported_media_type",
      filename: "setup.exe",
    });
    expect(await listAttachmentKeys()).toHaveLength(0);
  });

  it("rejects a filename that tries to smuggle a path", async () => {
    const res = await postEmail(
      multipart(inlinePayload({ attachments: [{ field: "invoice", filename: "../etc/passwd" }] }), {
        invoice,
      }),
    );

    expect(res.status).toBe(400);
    expect(await listAttachmentKeys()).toHaveLength(0);
  });

  it("rejects a duplicate field", async () => {
    const res = await postEmail(
      multipart(
        inlinePayload({
          attachments: [{ field: "invoice" }, { field: "invoice", filename: "copy.pdf" }],
        }),
        { invoice },
      ),
    );

    expect(res.status).toBe(400);
    expect(await listAttachmentKeys()).toHaveLength(0);
  });

  it("rejects an unknown content_id", async () => {
    const res = await postEmail(
      multipart(
        inlinePayload({
          attachments: [{ field: "invoice", content_id: "not a cid!" }],
        }),
        { invoice },
      ),
    );

    expect(res.status).toBe(400);
    expect(await listAttachmentKeys()).toHaveLength(0);
  });

  it("returns 500 when the ATTACHMENTS binding is missing", async () => {
    const bindings = { ...env, ATTACHMENTS: undefined } as unknown as Cloudflare.Env;

    const res = await postEmail(
      multipart(inlinePayload({ attachments: [{ field: "invoice" }] }), { invoice }),
      bindings,
    );

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "server_misconfigured" });
  });

  it("still accepts a JSON request when the ATTACHMENTS binding is missing", async () => {
    vi.spyOn(env.PUSH_QUEUE, "send").mockResolvedValue(fakeQueueSendResponse());
    const bindings = { ...env, ATTACHMENTS: undefined } as unknown as Cloudflare.Env;

    const res = await app.request(
      "/v1/notifications/email",
      {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify(inlinePayload()),
      },
      bindings,
    );

    expect(res.status).toBe(202);
  });

  it("rolls back the staged objects when enqueueing fails", async () => {
    vi.spyOn(env.PUSH_QUEUE, "send").mockRejectedValue(new Error("queue unavailable"));

    const res = await postEmail(
      multipart(inlinePayload({ attachments: [{ field: "invoice" }] }), { invoice }),
    );

    expect(res.status).toBe(500);
    // Nothing may leak: the request never became a job.
    expect(await listAttachmentKeys()).toHaveLength(0);
  });
});
