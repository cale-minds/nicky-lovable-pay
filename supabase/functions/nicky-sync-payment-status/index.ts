// Edge Function: nicky-sync-payment-status
//
// Re-queries Nicky for the authoritative payment-request status and updates the
// local order accordingly. Safe to call:
//   * from a frontend success page (to reflect status after the payer returns),
//   * from a manual admin action, or
//   * from a scheduled reconciliation job.
//
// Accepts any one of: orderId, nickyPaymentRequestId, nickyShortId.
//
// This NEVER trusts a redirect or client claim — it always asks Nicky directly,
// and only reports `paid` when Nicky returns `Finished`.

import { handlePreflight, json, errorResponse } from "../_shared/cors.ts";
import { getNickyEnv } from "../_shared/env.ts";
import { getServiceClient } from "../_shared/db.ts";
import { asOptionalString, parseJsonBody } from "../_shared/validate.ts";
import { reconcileOrder } from "../_shared/reconcile.ts";
import { NickyApiError } from "../_shared/nicky.ts";

Deno.serve(async (req) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;

  if (req.method !== "POST" && req.method !== "GET") {
    return errorResponse("Method not allowed. Use POST or GET.", 405);
  }

  try {
    const env = getNickyEnv();
    const supabase = getServiceClient();

    let orderId: string | undefined;
    let nickyPaymentRequestId: string | undefined;
    let nickyShortId: string | undefined;

    if (req.method === "POST") {
      const body = await parseJsonBody(req);
      orderId = asOptionalString(body.orderId, "orderId");
      nickyPaymentRequestId = asOptionalString(body.nickyPaymentRequestId, "nickyPaymentRequestId");
      nickyShortId = asOptionalString(body.nickyShortId, "nickyShortId");
    } else {
      const url = new URL(req.url);
      orderId = url.searchParams.get("orderId") ?? undefined;
      nickyPaymentRequestId = url.searchParams.get("nickyPaymentRequestId") ?? undefined;
      nickyShortId = url.searchParams.get("nickyShortId") ?? undefined;
    }

    if (!orderId && !nickyPaymentRequestId && !nickyShortId) {
      return errorResponse(
        "Provide at least one of: orderId, nickyPaymentRequestId, nickyShortId.",
        400,
      );
    }

    const result = await reconcileOrder(
      supabase,
      env,
      { orderId, nickyPaymentRequestId, nickyShortId },
      "frontend_sync",
    );

    return json({
      orderId: result.orderId,
      nickyPaymentRequestId: result.nickyPaymentRequestId,
      nickyShortId: result.nickyShortId,
      status: result.localStatus,
      remoteStatus: result.remoteStatus,
      paid: result.paid,
    });
  } catch (err) {
    if (err instanceof NickyApiError) {
      console.error("Nicky API error during sync", err.status);
      return errorResponse("Failed to query Nicky for payment status.", 502, {
        nickyStatus: err.status,
      });
    }
    const message = (err as Error).message ?? "Unexpected error";
    console.error("nicky-sync-payment-status error", message);
    // Surface "no identifier"/"not found" style errors as 400, others as 500.
    const status = /No Nicky identifier|lookup failed|reconcile/.test(message) ? 400 : 500;
    return errorResponse(message, status);
  }
});
