/**
 * The `env` imported from "cloudflare:test" is typed as `Cloudflare.Env`,
 * which mirrors the generated global `Env`. Secrets declared with
 * `wrangler secret put` are not part of the generated types, so merge them
 * in here for type-safe tests.
 */
declare namespace Cloudflare {
  interface Env {
    /** Shared secret required by the backend in the Authorization header. */
    BACKEND_AUTH_TOKEN: string;
    /** VAPID private key (Wrangler secret). */
    VAPID_PRIVATE_KEY: string;
  }
}
