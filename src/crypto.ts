/**
 * Constant-time comparison of two strings.
 *
 * Uses SHA-256 digests so both sides always have the same length while
 * comparing, which avoids leaking the position of the first differing byte.
 */
export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [digestA, digestB] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  const bytesA = new Uint8Array(digestA);
  const bytesB = new Uint8Array(digestB);
  if (bytesA.length !== bytesB.length) return false;
  let diff = 0;
  for (let i = 0; i < bytesA.length; i++) {
    diff |= bytesA[i] ^ bytesB[i];
  }
  return diff === 0;
}

/** base64url (URL-safe, unpadded) encoding of raw bytes. */
export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Deterministic subscription id derived from the endpoint URL.
 * Lets clients compute the id themselves (for DELETE) and makes the
 * PUT /v1/subscriptions upsert naturally idempotent.
 */
export async function subscriptionIdFromEndpoint(endpoint: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(endpoint),
  );
  return toBase64Url(new Uint8Array(digest));
}
