// Pure, dependency-free helpers for nicky-create-payment. No Deno/Supabase
// imports so they can be unit-tested with vitest.

/**
 * Decides whether a create request should be rejected by the optional soft
 * per-payer-email hourly cap.
 *
 * @param recentCount how many orders the same payer created in the window
 * @param maxPerWindow the configured cap; 0 (or negative) disables the limit
 */
export function isOverRateLimit(recentCount: number, maxPerWindow: number): boolean {
  if (!Number.isFinite(maxPerWindow) || maxPerWindow <= 0) return false;
  return recentCount >= maxPerWindow;
}

/** Result shape of the create-or-claim RPC, normalized for the function. */
export interface ClaimOutcome {
  orderId: string;
  status: string;
  paymentUrl: string | null;
  nickyPaymentRequestId: string | null;
  nickyShortId: string | null;
  claimed: boolean;
}

/**
 * Interprets the create-or-claim RPC result into a control-flow decision.
 *
 *  - "return_existing": the order already has a payment_url; return it.
 *  - "owns_creation": this invocation won the claim and must create at Nicky.
 *  - "in_progress": another invocation holds an active claim; ask the caller to
 *    retry shortly. We must NOT create a parallel Nicky Payment Request.
 */
export function decideClaimAction(
  outcome: ClaimOutcome,
): "return_existing" | "owns_creation" | "in_progress" {
  if (outcome.paymentUrl) return "return_existing";
  if (outcome.claimed) return "owns_creation";
  return "in_progress";
}
