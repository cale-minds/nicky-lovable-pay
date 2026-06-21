// Shared reconciliation logic.
//
// This is the single place where a local order's status is updated based on a
// SERVER-SIDE Nicky lookup. Both `nicky-sync-payment-status` and `nicky-webhook`
// call into this so the "re-query Nicky before trusting anything" rule is
// enforced consistently.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import type { NickyEnv } from "./env.ts";
import {
  getPaymentRequestById,
  getPaymentRequestByShortId,
  extractShortId,
  mapRemoteStatus,
  type NickyLocalStatus,
  type NickyPaymentRequest,
} from "./nicky.ts";

export interface OrderLocator {
  orderId?: string;
  nickyPaymentRequestId?: string;
  nickyShortId?: string;
}

export interface ReconcileResult {
  orderId?: string;
  nickyPaymentRequestId?: string;
  nickyShortId?: string;
  remoteStatus?: string;
  localStatus: NickyLocalStatus;
  paid: boolean;
}

interface OrderRow {
  id: string;
  nicky_payment_request_id: string | null;
  nicky_short_id: string | null;
  status: string;
}

async function findOrder(
  supabase: SupabaseClient,
  locator: OrderLocator,
): Promise<OrderRow | null> {
  let query = supabase
    .from("nicky_orders")
    .select("id, nicky_payment_request_id, nicky_short_id, status");

  if (locator.orderId) {
    query = query.eq("id", locator.orderId);
  } else if (locator.nickyPaymentRequestId) {
    query = query.eq("nicky_payment_request_id", locator.nickyPaymentRequestId);
  } else if (locator.nickyShortId) {
    query = query.eq("nicky_short_id", locator.nickyShortId);
  } else {
    return null;
  }

  const { data, error } = await query.maybeSingle();
  if (error) throw new Error(`Order lookup failed: ${error.message}`);
  return (data as OrderRow | null) ?? null;
}

/**
 * Re-queries Nicky for the authoritative status and updates the local order.
 *
 * `source` records what triggered the check ('webhook' | 'frontend_sync' |
 * 'manual' | 'scheduled') for the audit trail.
 *
 * SECURITY: an order is only ever set to `paid` when Nicky returns `Finished`
 * here, server-side. Webhook payloads are not trusted for this decision.
 */
export async function reconcileOrder(
  supabase: SupabaseClient,
  env: NickyEnv,
  locator: OrderLocator,
  source: string,
): Promise<ReconcileResult> {
  const order = await findOrder(supabase, locator);

  // Determine which Nicky identifier to query with.
  const requestId = locator.nickyPaymentRequestId ?? order?.nicky_payment_request_id ?? undefined;
  const shortId = locator.nickyShortId ?? order?.nicky_short_id ?? undefined;

  if (!requestId && !shortId) {
    throw new Error(
      "No Nicky identifier available to reconcile (need order with linkage, " +
        "or a Nicky id / short id).",
    );
  }

  // Prefer the uuid lookup; fall back to short id.
  let pr: NickyPaymentRequest;
  if (requestId) {
    pr = await getPaymentRequestById(env, requestId);
  } else {
    pr = await getPaymentRequestByShortId(env, shortId as string);
  }

  const remoteStatus = pr.status as string | undefined;
  const localStatus = mapRemoteStatus(remoteStatus);
  const resolvedShortId = shortId ?? extractShortId(pr);
  const resolvedRequestId = requestId ?? (pr.id as string | undefined);

  // --- Persist audit trail of this check --------------------------------
  await supabase.from("nicky_payment_status_checks").insert({
    order_id: order?.id ?? null,
    nicky_payment_request_id: resolvedRequestId ?? null,
    nicky_short_id: resolvedShortId ?? null,
    source,
    remote_status: remoteStatus ?? null,
    resulting_local_status: localStatus,
    raw_response: pr,
  });

  // --- Update the order (if we have one) --------------------------------
  if (order) {
    const update: Record<string, unknown> = {
      status: localStatus,
      last_remote_status: remoteStatus ?? null,
    };
    // Backfill linkage if it was missing.
    if (!order.nicky_payment_request_id && resolvedRequestId) {
      update.nicky_payment_request_id = resolvedRequestId;
    }
    if (!order.nicky_short_id && resolvedShortId) {
      update.nicky_short_id = resolvedShortId;
    }
    if (localStatus === "paid") {
      update.paid_at = new Date().toISOString();
    }

    const { error } = await supabase.from("nicky_orders").update(update).eq("id", order.id);
    if (error) throw new Error(`Failed to update order: ${error.message}`);

    // Keep the normalized payment-request row in sync too.
    if (resolvedRequestId) {
      await supabase
        .from("nicky_payment_requests")
        .update({ remote_status: remoteStatus ?? null, raw_response: pr })
        .eq("nicky_payment_request_id", resolvedRequestId);
    }
  }

  return {
    orderId: order?.id,
    nickyPaymentRequestId: resolvedRequestId,
    nickyShortId: resolvedShortId,
    remoteStatus,
    localStatus,
    paid: localStatus === "paid",
  };
}
