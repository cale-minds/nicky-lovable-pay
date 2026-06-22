// Pure helpers for webhook request-body size limiting. No Deno imports so they
// can be unit-tested with vitest. The streaming enforcement (reading the body
// with a running byte cap) lives in the Edge Function; this module holds the
// constant and the Content-Length pre-check.
//
// Nicky webhook payloads are tiny (an id + status fields), so a small cap is a
// safe defense-in-depth limit against oversized/abusive bodies.

export const MAX_WEBHOOK_BODY_BYTES = 64 * 1024; // 64 KB

/**
 * Returns true when a present, parseable `Content-Length` exceeds `maxBytes`.
 * A missing or non-numeric header returns false (we then enforce the cap while
 * streaming the body, so a chunked request without Content-Length can't bypass
 * the limit).
 */
export function contentLengthExceeds(
  header: string | null | undefined,
  maxBytes: number = MAX_WEBHOOK_BODY_BYTES,
): boolean {
  if (header == null || header === "") return false;
  const n = Number(header);
  if (!Number.isFinite(n)) return false;
  return n > maxBytes;
}
