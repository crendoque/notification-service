/**
 * Sends a correctly signed Resend (Svix) webhook event to a locally running
 * worker. Resend cannot reach localhost, so this is how the webhook path is
 * exercised end to end during development.
 *
 * Usage:
 *   npm run dev                                     # in another terminal
 *   npm run simulate:webhook -- --email-id <resend-email-id>
 *   npm run simulate:webhook -- --type email.bounced --email-id <id> --userId user-1
 *
 * The `--email-id` value is the `resendId` reported by
 * `GET /v1/notifications/email/:id` (or logged as `email_sent`).
 */
import { createHmac, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

const DEV_VARS_PATH = new URL("../.dev.vars", import.meta.url);

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const [key, inlineValue] = token.slice(2).split("=");
    args[key] = inlineValue ?? argv[i + 1] ?? "";
    if (inlineValue === undefined) i += 1;
  }
  return args;
}

function readDevVars() {
  if (!existsSync(DEV_VARS_PATH)) return {};
  const values = {};
  for (const line of readFileSync(DEV_VARS_PATH, "utf8").split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (!match) continue;
    values[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
  return values;
}

const args = parseArgs(process.argv.slice(2));
const devVars = readDevVars();
const secret = args.secret ?? devVars.RESEND_WEBHOOK_SECRET;
if (!secret) {
  console.error(
    "RESEND_WEBHOOK_SECRET is not set. Add it to .dev.vars or pass --secret whsec_...",
  );
  process.exit(1);
}

const emailId = args["email-id"];
if (!emailId) {
  console.error(
    "Missing --email-id. Use the `resendId` from GET /v1/notifications/email/:id.",
  );
  process.exit(1);
}

const type = args.type ?? "email.delivered";
const url = args.url ?? "http://localhost:8787/v1/webhooks/resend";
const to = args.to ?? "delivered@resend.dev";

const event = {
  type,
  created_at: new Date().toISOString(),
  data: {
    email_id: emailId,
    message_id: `<${randomUUID()}@email.example.com>`,
    from: devVars.EMAIL_FROM ?? "Notification Worker <notifications@example.com>",
    to: [to],
    subject: "Simulated Resend event",
    ...(args.requestId ? { tags: { request_id: args.requestId } } : {}),
    ...(type === "email.bounced"
      ? {
          bounce: {
            type: "Permanent",
            subType: "Suppressed",
            message: "Simulated bounce from the local webhook simulator.",
          },
        }
      : {}),
  },
};

const body = JSON.stringify(event);
// Reuse --svix-id to replay the *same* delivery (Svix keeps the id when it
// retries), which is how the duplicate-suppression path is exercised.
const svixId = args["svix-id"] ?? `msg_${randomUUID()}`;
const timestamp = String(Math.floor(Date.now() / 1000));
const key = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
const signature = createHmac("sha256", Buffer.from(key, "base64"))
  .update(`${svixId}.${timestamp}.${body}`)
  .digest("base64");

const response = await fetch(url, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "svix-id": svixId,
    "svix-timestamp": timestamp,
    "svix-signature": `v1,${signature}`,
  },
  body,
});

console.log(`POST ${url} -> ${response.status}`);
console.log(await response.text());
console.log(`\nSimulated ${type} for email_id=${emailId}`);
