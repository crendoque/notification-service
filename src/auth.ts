import type { Context, Next } from "hono";
import { timingSafeEqual } from "./crypto";
import type { Bindings } from "./env";

/**
 * Bearer-token auth middleware protecting every /v1 route.
 * The token is a shared secret between the backend and this worker,
 * compared in constant time.
 */
export async function authMiddleware(
  c: Context<{ Bindings: Bindings }>,
  next: Next,
): Promise<Response | void> {
  const expected = c.env.BACKEND_AUTH_TOKEN;
  if (!expected) {
    console.error(
      JSON.stringify({ msg: "auth_misconfigured", hint: "BACKEND_AUTH_TOKEN secret is not set" }),
    );
    return c.json({ error: "server_misconfigured" }, 500);
  }

  const header = c.req.header("Authorization") ?? "";
  const match = /^Bearer (.+)$/.exec(header);
  if (!match) return c.json({ error: "unauthorized" }, 401);

  const ok = await timingSafeEqual(match[1], expected);
  if (!ok) {
    console.warn(JSON.stringify({ msg: "auth_rejected" }));
    return c.json({ error: "unauthorized" }, 401);
  }
  return next();
}
