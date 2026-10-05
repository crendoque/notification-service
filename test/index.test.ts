import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { app } from "../src/index";

/** The dev token lives in .dev.vars; read it from the environment at test time. */
const authHeaders = (): Record<string, string> => ({
  Authorization: `Bearer ${env.BACKEND_AUTH_TOKEN}`,
});

describe("health", () => {
  it("is public", async () => {
    const res = await app.request("/health", undefined, env);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { status: string };
    expect(json.status).toBe("ok");
  });
});

describe("auth", () => {
  it("rejects missing token", async () => {
    const res = await app.request("/v1/config/vapid-public-key", undefined, env);
    expect(res.status).toBe(401);
  });

  it("rejects wrong token", async () => {
    const res = await app.request(
      "/v1/config/vapid-public-key",
      { headers: { Authorization: "Bearer wrong-token" } },
      env,
    );
    expect(res.status).toBe(401);
  });

  it("accepts the correct token", async () => {
    const res = await app.request("/v1/config/vapid-public-key", { headers: authHeaders() }, env);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { publicKey: string };
    expect(typeof json.publicKey).toBe("string");
  });
});
