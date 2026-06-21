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

/**
 * Merges an operational `patch` into existing order metadata WITHOUT clobbering
 * previously-stored keys (e.g. app-specific user id / sku / cart id). Patch keys
 * override only the same keys. Safe when `existing` is null/undefined.
 */
export function mergeMetadata(
  existing: Record<string, unknown> | null | undefined,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  return { ...(existing ?? {}), ...patch };
}

/**
 * Message + body for the "Nicky created the Payment Request but local persistence
 * failed" path. The body deliberately omits any usable payment identifiers
 * (paymentUrl / nickyShortId / nickyPaymentRequestId) so the browser can never
 * redirect a payer to an orphaned request the local system can't reconcile.
 */
export const PERSIST_FAILURE_MESSAGE =
  "Payment was created at Nicky but failed to persist locally. Manual review is required.";

export function buildPersistFailureBody(
  orderId: string,
): { orderId: string; retryable: false; needsReview: true } {
  return { orderId, retryable: false, needsReview: true };
}

/** Result shape of the create-or-claim RPC, normalized for the function. */
export interface ClaimOutcome {
  orderId: string;
  status: string;
  paymentUrl: string | null;
  nickyPaymentRequestId: string | null;
  nickyShortId: string | null;
  claimed: boolean;
  /** True when a stale claim cannot be auto-re-granted because a Nicky create
   * was already attempted without local linkage (possible orphaned request). */
  needsReview: boolean;
}

export type ClaimAction = "return_existing" | "owns_creation" | "in_progress" | "needs_review";

/**
 * Interprets the create-or-claim RPC result into a control-flow decision.
 *
 *  - "return_existing": the order already has a payment_url; return it
 *    idempotently (this MUST win even if a rate limit would otherwise apply).
 *  - "needs_review": a prior attempt called Nicky but never linked a result;
 *    auto-creating again could duplicate the Nicky Payment Request, so an
 *    operator must review first.
 *  - "owns_creation": this invocation won the claim and must create at Nicky.
 *  - "in_progress": another invocation holds an active claim; ask the caller to
 *    retry shortly. We must NOT create a parallel Nicky Payment Request.
 */
export function decideClaimAction(outcome: ClaimOutcome): ClaimAction {
  if (outcome.paymentUrl) return "return_existing";
  if (outcome.needsReview) return "needs_review";
  if (outcome.claimed) return "owns_creation";
  return "in_progress";
}
