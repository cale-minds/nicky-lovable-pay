// Pure, dependency-free helpers for reconciliation. No Deno/Supabase imports so
// they can be unit-tested directly with vitest.

import type { NickyLocalStatus } from "./status.ts";

/** The subset of an order row reconciliation needs to compute its update. */
export interface ExistingOrderState {
  nicky_payment_request_id: string | null;
  nicky_short_id: string | null;
  /** First-confirmed-paid timestamp, or null if never confirmed paid yet. */
  paid_at: string | null;
}

/**
 * Decides whether `paid_at` should be set on this reconciliation.
 *
 * `paid_at` must represent the FIRST time the order was confirmed paid, so we
 * only set it when the order is transitioning to `paid` AND `paid_at` is still
 * null. Re-running reconciliation on an already-paid order must NOT overwrite
 * the original timestamp.
 */
export function shouldSetPaidAt(
  localStatus: NickyLocalStatus,
  currentPaidAt: string | null | undefined,
): boolean {
  return localStatus === "paid" && (currentPaidAt === null || currentPaidAt === undefined);
}

/**
 * Builds the `nicky_orders` update object for a reconciliation result.
 *
 * - Always updates `status` and `last_remote_status`.
 * - Backfills `nicky_payment_request_id` / `nicky_short_id` only when missing.
 * - Sets `paid_at` only on the first transition to `paid` (see shouldSetPaidAt).
 */
export function buildReconcileUpdate(opts: {
  localStatus: NickyLocalStatus;
  remoteStatus?: string;
  order: ExistingOrderState;
  resolvedRequestId?: string;
  resolvedShortId?: string;
  now?: string;
}): Record<string, unknown> {
  const { localStatus, remoteStatus, order, resolvedRequestId, resolvedShortId } = opts;
  const now = opts.now ?? new Date().toISOString();

  const update: Record<string, unknown> = {
    status: localStatus,
    last_remote_status: remoteStatus ?? null,
  };

  if (!order.nicky_payment_request_id && resolvedRequestId) {
    update.nicky_payment_request_id = resolvedRequestId;
  }
  if (!order.nicky_short_id && resolvedShortId) {
    update.nicky_short_id = resolvedShortId;
  }
  if (shouldSetPaidAt(localStatus, order.paid_at)) {
    update.paid_at = now;
  }

  return update;
}
