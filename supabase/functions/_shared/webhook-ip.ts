// Pure helpers for webhook source-IP validation. No Deno imports — testable
// with vitest.
//
// SECURITY MODEL (see docs/webhooks.md and docs/security.md):
//   * Supabase fronts Edge Functions with a trusted proxy that appends the real
//     client IP as the FIRST entry of `x-forwarded-for`.
//   * We therefore trust ONLY the first entry of `x-forwarded-for`, never an
//     arbitrary position and never alternate, freely-settable headers such as
//     `x-real-ip` or `cf-connecting-ip`. That avoids the trivial spoof of
//     injecting the allowed IP somewhere in a header we scan loosely.
//   * IP validation is defense-in-depth only. The real guarantee is the
//     mandatory server-side re-query to Nicky, which the webhook always performs
//     before changing an order.

/**
 * Returns the first (left-most) IP from an `x-forwarded-for` header value, or
 * undefined if absent/empty.
 */
export function getClientIpFromForwardedFor(xff: string | null | undefined): string | undefined {
  if (!xff) return undefined;
  const first = xff.split(",")[0]?.trim();
  return first ? first : undefined;
}

export interface WebhookIpCheck {
  allowed: boolean;
  /** The IP we evaluated (first XFF entry, else direct remote address). */
  clientIp?: string;
}

/**
 * Decides whether a webhook request is from the allowed Nicky IP.
 *
 * Only the first `x-forwarded-for` entry is considered; if that header is
 * absent we fall back to the direct connection IP (useful for local testing).
 */
export function checkWebhookIp(opts: {
  allowedIp: string;
  forwardedFor?: string | null;
  directIp?: string | null;
}): WebhookIpCheck {
  const fromXff = getClientIpFromForwardedFor(opts.forwardedFor);
  const clientIp = fromXff ?? (opts.directIp ? opts.directIp.trim() : undefined);
  return { allowed: clientIp === opts.allowedIp, clientIp };
}
