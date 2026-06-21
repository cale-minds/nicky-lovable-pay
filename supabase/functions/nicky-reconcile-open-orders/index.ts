// Edge Function: nicky-reconcile-open-orders
//
// Operational fallback that periodically reconciles open/stuck orders with
// Nicky — independent of webhooks and the browser success-page polling. Use it
// to catch missed/delayed webhooks and abandoned redirects.
//
// SECURITY: this function is NOT meant to be publicly callable. It is protected
// by a shared secret (`NICKY_RECONCILIATION_SECRET`) sent in the
// `x-nicky-reconciliation-secret` header. In supabase/config.toml it is
// deployed with verify_jwt = false so a scheduler/cron can call it with that
// header instead of a Supabase JWT. If the secret is not configured, the
// function refuses to run (fails closed).
//
// It NEVER marks anything paid except via the shared reconcileOrder(), which
// only sets `paid` when a server-side Nicky lookup returns `Finished`, and never
// unlocks anything on `PaymentValidationRequired`.

import { json, errorResponse } from "../_shared/cors.ts";
import { getNickyEnv, getReconciliationSecret } from "../_shared/env.ts";
import { getServiceClient } from "../_shared/db.ts";
import { reconcileOrder } from "../_shared/reconcile.ts";
import { NickyApiError } from "../_shared/nicky.ts";
import {
  OPEN_STATUSES,
  parseReconcileParams,
  cutoffIso,
  hasNickyIdentifier,
} from "../_shared/reconcile-open-orders-helpers.ts";

interface OpenOrderRow {
  id: string;
  status: string;
  nicky_payment_request_id: string | null;
  nicky_short_id: string | null;
}

Deno.serve(async (req) => {
  if (req.method !== "POST" && req.method !== "GET") {
    return errorResponse("Method not allowed. Use POST or GET.", 405);
  }

  // --- Auth: shared secret (fails closed if not configured) --------------
  const secret = getReconciliationSecret();
  if (!secret) {
    console.error("NICKY_RECONCILIATION_SECRET is not set; refusing to run.");
    return errorResponse("Reconciliation is not configured on this deployment.", 503);
  }
  if (req.headers.get("x-nicky-reconciliation-secret") !== secret) {
    return errorResponse("Forbidden: invalid or missing reconciliation secret.", 401);
  }

  try {
    const env = getNickyEnv();
    const supabase = getServiceClient();

    // Params from JSON body (POST) or query string (GET).
    let rawParams: Record<string, unknown> = {};
    if (req.method === "POST") {
      try {
        rawParams = (await req.json()) ?? {};
      } catch {
        rawParams = {};
      }
    } else {
      const url = new URL(req.url);
      rawParams = Object.fromEntries(url.searchParams.entries());
    }
    const { limit, olderThanMinutes, dryRun } = parseReconcileParams(rawParams);

    // Select eligible open orders that also have a Nicky identifier. We filter
    // on the identifier in SQL (request id OR short id present) and re-check in
    // code for safety.
    const { data, error } = await supabase
      .from("nicky_orders")
      .select("id, status, nicky_payment_request_id, nicky_short_id")
      .in("status", OPEN_STATUSES as string[])
      .or("nicky_payment_request_id.not.is.null,nicky_short_id.not.is.null")
      .lt("updated_at", cutoffIso(olderThanMinutes))
      .order("updated_at", { ascending: true })
      .limit(limit);

    if (error) {
      console.error("failed to query open orders", error.message);
      return errorResponse("Failed to query open orders.", 500);
    }

    const orders = ((data as OpenOrderRow[]) ?? []).filter(hasNickyIdentifier);

    const results: Array<{
      orderId: string;
      ok: boolean;
      status?: string;
      remoteStatus?: string;
      paid?: boolean;
      error?: string;
      wouldReconcile?: boolean;
    }> = [];

    let reconciled = 0;
    let failed = 0;

    for (const order of orders) {
      if (dryRun) {
        results.push({ orderId: order.id, ok: true, wouldReconcile: true });
        continue;
      }
      try {
        const r = await reconcileOrder(supabase, env, { orderId: order.id }, "scheduled");
        reconciled += 1;
        results.push({
          orderId: order.id,
          ok: true,
          status: r.localStatus,
          remoteStatus: r.remoteStatus,
          paid: r.paid,
        });
      } catch (err) {
        failed += 1;
        const message =
          err instanceof NickyApiError ? `Nicky lookup failed (${err.status})` : (err as Error).message;
        console.error(`reconcile failed for order ${order.id}: ${message}`);
        results.push({ orderId: order.id, ok: false, error: message });
      }
    }

    return json({
      ok: true,
      dryRun,
      params: { limit, olderThanMinutes },
      scanned: orders.length,
      reconciled,
      failed,
      results,
    });
  } catch (err) {
    console.error("nicky-reconcile-open-orders error", (err as Error).message);
    return errorResponse("Unexpected error during reconciliation.", 500);
  }
});
