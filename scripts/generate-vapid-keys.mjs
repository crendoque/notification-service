/**
 * Generates a VAPID keypair and writes local dev secrets to `.dev.vars`
 * (gitignored). Prints production instructions.
 *
 * VAPID keys must be generated ONCE and reused forever — the public key is
 * baked into every browser subscription, so regenerating it breaks delivery
 * to previously-subscribed devices.
 *
 * Usage: npm run setup:dev
 */
import { generateVAPIDKeys } from "web-push-neo";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

const DEV_VARS_PATH = new URL("../.dev.vars", import.meta.url);

const keys = await generateVAPIDKeys();
const values = {
  VAPID_PUBLIC_KEY: keys.publicKey,
  VAPID_PRIVATE_KEY: keys.privateKey,
  BACKEND_AUTH_TOKEN: randomBytes(32).toString("base64url"),
};

const existing = existsSync(DEV_VARS_PATH)
  ? readFileSync(DEV_VARS_PATH, "utf8")
  : "# Local development secrets (gitignored). Do not commit.\n";

let out = existing;
for (const [key, value] of Object.entries(values)) {
  const re = new RegExp(`^${key}=.*$`, "m");
  out = re.test(out) ? out.replace(re, `${key}=${value}`) : out + `${key}=${value}\n`;
}
writeFileSync(DEV_VARS_PATH, out);

console.log("Wrote .dev.vars for local development:\n");
console.log(`  VAPID_PUBLIC_KEY=${keys.publicKey}`);
console.log(`  VAPID_PRIVATE_KEY=${keys.privateKey.slice(0, 12)}...`);
console.log(`  BACKEND_AUTH_TOKEN=${values.BACKEND_AUTH_TOKEN.slice(0, 8)}...\n`);
console.log("For production, set the same keys + a strong token as secrets:");
console.log("  npx wrangler secret put VAPID_PRIVATE_KEY");
console.log("  npx wrangler secret put BACKEND_AUTH_TOKEN");
console.log("and put VAPID_PUBLIC_KEY in wrangler.jsonc vars (it is not a secret).");
