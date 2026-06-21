// Edge Function: nicky-create-payment
//
// Creates a Nicky payment request for a local order and returns the payer
// redirect URL plus the local order id. The Nicky API key is read from the
// environment and NEVER returned to the caller.
//
// Flow:
//   1. Validate input.
//   2. (Optional) soft per-payer rate limit.
//   3. Atomic create-or-claim of the local order (race-safe idempotency).
//   4. Branch: return existing URL / refuse if another claim is active / proceed.
//   5. Call Nicky create + strictly extract identifiers.
//   6. Persist order + normalized payment-request row (handle partial failures).
//   7. Return { orderId, paymentUrl, nickyShortId, ... }.
//
// PRODUCTION NOTE — amount/product validation: this function trusts the caller
// for `amountExpectedNative`, `invoiceReference`, etc. A public app MUST validate
// these server-side against its own catalog/orders before calling this function
// (e.g. via its own authenticated Edge Function or RLS-protected table). See
// docs/security.md ("Server-side product/amount validation").

import { handlePreflight, json, errorResponse } from "../_shared/cors.ts";
import { getNickyEnv } from "../_shared/env.ts";
import { getServiceClient } from "../_shared/db.ts";
import {
  asAmount,
  asEmail,
  asString,
  asBoolean,
  asOptionalString,
  parseJsonBody,
  ValidationError,
} from "../_shared/validate.ts";
import {
  buildPaymentUrl,
  createPaymentRequest,
  NickyApiError,
  type CreatePaymentRequestBody,
} from "../_shared/nicky.ts";
import {
  getRequiredPaymentRequestIdentifiers,
  PaymentRequestContractError,
} from "../_shared/payment-identifiers.ts";
import {
  isOverRateLimit,
  decideClaimAction,
  type ClaimOutcome,
} from "../_shared/create-payment-helpers.ts";

// deno-lint-ignore no-explicit-any
type AnySupabase = any;

/**
 * Upserts the normalized nicky_payment_requests row.
 *
 * `repairOnly` uses INSERT ... ON CONFLICT DO NOTHING so an idempotent retry can
 * re-create a missing row without clobbering an existing one. Returns the
 * Supabase error (or null).
 */
async function ensurePaymentRequestRow(
  supabase: AnySupabase,
  row: Record<string, unknown>,
  repairOnly: boolean,
): Promise<{ message: string } | null> {
  const { error } = await supabase
    .from("nicky_payment_requests")
    .upsert(row, { onConflict: "nicky_payment_request_id", ignoreDuplicates: repairOnly });
  return error ? { message: error.message } : null;
}

Deno.serve(async (req) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;

  if (req.method !== "POST") {
    return errorResponse("Method not allowed. Use POST.", 405);
  }

  try {
    const env = getNickyEnv();
    const supabase = getServiceClient();
    const body = await parseJsonBody(req);

    // --- 1. Validate input -------------------------------------------------
    const blockchainAssetId = asString(body.blockchainAssetId, "blockchainAssetId");
    const amountExpectedNative = asAmount(body.amountExpectedNative, "amountExpectedNative");
    const invoiceReference = asString(body.invoiceReference, "invoiceReference");
    const description = asString(body.description, "description");
    const payerEmail = asEmail(body.payerEmail, "payerEmail");
    const payerName = asString(body.payerName, "payerName");
    const sendNotification = asBoolean(body.sendNotification, true);
    const successUrl = asOptionalString(body.successUrl, "successUrl");
    const cancelUrl = asOptionalString(body.cancelUrl, "cancelUrl");

    // Idempotency key: client-supplied, else derived from the invoice reference.
    const idempotencyKey =
      asOptionalString(body.idempotencyKey, "idempotencyKey") ??
      `invref:${invoiceReference}`;

    const metadata =
      typeof body.metadata === "object" && body.metadata !== null
        ? (body.metadata as Record<string, unknown>)
        : {};

    // --- 2. Optional soft rate limit (defense-in-depth only) --------------
    // Disabled unless NICKY_CREATE_RATE_LIMIT_PER_HOUR > 0. This is a weak,
    // per-payer-email cap; real protection should be app auth + WAF/Cloudflare.
    if (env.createRateLimitPerHour > 0) {
      const sinceIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const { count, error: countErr } = await supabase
        .from("nicky_orders")
        .select("id", { count: "exact", head: true })
        .eq("payer_email", payerEmail)
        .gte("created_at", sinceIso);
      if (!countErr && isOverRateLimit(count ?? 0, env.createRateLimitPerHour)) {
        return errorResponse("Too many payment attempts. Please try again later.", 429);
      }
    }

    // --- 3. Atomic create-or-claim ----------------------------------------
    const { data: claimRows, error: claimErr } = await supabase.rpc(
      "nicky_create_or_claim_order",
      {
        p_idempotency_key: idempotencyKey,
        p_invoice_reference: invoiceReference,
        p_description: description,
        p_amount: amountExpectedNative,
        p_asset_id: blockchainAssetId,
        p_payer_email: payerEmail,
        p_payer_name: payerName,
        p_metadata: metadata,
      },
    );

    if (claimErr) {
      console.error("create-or-claim RPC failed", claimErr.message);
      return errorResponse("Failed to initialize order.", 500);
    }

    const claimRow = Array.isArray(claimRows) ? claimRows[0] : claimRows;
    if (!claimRow) {
      return errorResponse("Failed to initialize order (no claim result).", 500);
    }

    const outcome: ClaimOutcome = {
      orderId: claimRow.order_id,
      status: claimRow.status,
      paymentUrl: claimRow.payment_url ?? null,
      nickyPaymentRequestId: claimRow.nicky_payment_request_id ?? null,
      nickyShortId: claimRow.nicky_short_id ?? null,
      claimed: claimRow.claimed === true,
    };
    const orderId = outcome.orderId;
    const action = decideClaimAction(outcome);

    // --- 4. Branch on the claim outcome -----------------------------------
    if (action === "return_existing") {
      // Idempotent hit. Repair the normalized row if a prior run failed to
      // persist it (see docs/operations.md "missing payment_requests row").
      if (outcome.nickyPaymentRequestId) {
        await ensurePaymentRequestRow(
          supabase,
          {
            order_id: orderId,
            nicky_payment_request_id: outcome.nickyPaymentRequestId,
            nicky_short_id: outcome.nickyShortId,
            payment_url: outcome.paymentUrl,
            blockchain_asset_id: blockchainAssetId,
            amount_expected_native: amountExpectedNative,
          },
          /* repairOnly */ true,
        );
      }
      return json({
        orderId,
        nickyPaymentRequestId: outcome.nickyPaymentRequestId,
        nickyShortId: outcome.nickyShortId,
        paymentUrl: outcome.paymentUrl,
        status: outcome.status,
        idempotent: true,
      });
    }

    if (action === "in_progress") {
      // Another concurrent invocation owns creation for this idempotency key.
      // We must NOT create a parallel Nicky Payment Request.
      return errorResponse(
        "Payment creation already in progress for this order. Please retry shortly.",
        409,
        { orderId, retryable: true },
      );
    }

    // action === "owns_creation": this invocation won the claim.

    // --- 5. Call Nicky -----------------------------------------------------
    const nickyBody: CreatePaymentRequestBody = {
      blockchainAssetId,
      amountExpectedNative,
      billDetails: { invoiceReference, description },
      requester: { email: payerEmail, name: payerName },
      sendNotification,
      successUrl,
      cancelUrl,
    };

    const pr = await createPaymentRequest(env, nickyBody);

    // Strictly extract the required identifiers. A missing identifier is an
    // exceptional invalid-protocol case — fail the order, do not continue.
    let paymentRequestId: string;
    let shortId: string;
    try {
      ({ paymentRequestId, shortId } = getRequiredPaymentRequestIdentifiers(pr));
    } catch (contractErr) {
      const message =
        contractErr instanceof PaymentRequestContractError
          ? contractErr.message
          : "Nicky returned an unusable create response.";
      // Mark failed + persist raw response. We intentionally leave
      // creation_claimed_at set so retries are gated by the stale window until
      // an operator can inspect (a retry after the window can re-attempt).
      await supabase
        .from("nicky_orders")
        .update({ status: "failed", nicky_create_response: pr })
        .eq("id", orderId);
      return errorResponse(message, 502, { nickyResponse: pr });
    }

    const paymentUrl = buildPaymentUrl(env, shortId);

    // --- 6. Persist --------------------------------------------------------
    const { error: updErr } = await supabase
      .from("nicky_orders")
      .update({
        status: "waiting_payment",
        nicky_payment_request_id: paymentRequestId,
        nicky_short_id: shortId,
        payment_url: paymentUrl,
        last_remote_status: (pr.status as string) ?? "PaymentPending",
        nicky_create_response: pr,
        creation_claimed_at: null, // release the claim; payment_url now gates retries
      })
      .eq("id", orderId);

    if (updErr) {
      console.error("failed to update order after Nicky create", updErr.message);
      return errorResponse("Payment created at Nicky but failed to persist locally.", 500, {
        paymentUrl,
        nickyShortId: shortId,
      });
    }

    // Persist the normalized payment-request row.
    const prRowError = await ensurePaymentRequestRow(
      supabase,
      {
        order_id: orderId,
        nicky_payment_request_id: paymentRequestId,
        nicky_short_id: shortId,
        payment_url: paymentUrl,
        blockchain_asset_id: blockchainAssetId,
        amount_expected_native: amountExpectedNative,
        remote_status: (pr.status as string) ?? "PaymentPending",
        raw_response: pr,
      },
      /* repairOnly */ false,
    );

    if (prRowError) {
      // The order is fully usable (payment_url set), but the normalized audit
      // row failed to persist. Rather than show a generic failure for a usable
      // payment, we flag the inconsistency and succeed with a warning. An
      // idempotent retry (or operator) will repair the row via repairOnly upsert.
      console.error("failed to persist nicky_payment_requests row", prRowError.message);
      await supabase
        .from("nicky_orders")
        .update({ metadata: { ...metadata, payment_request_row_missing: true } })
        .eq("id", orderId);

      return json({
        orderId,
        nickyPaymentRequestId: paymentRequestId,
        nickyShortId: shortId,
        paymentUrl,
        status: "waiting_payment",
        warning:
          "Payment is ready, but the normalized payment-request record failed to save. " +
          "It will be repaired automatically on retry/reconciliation.",
      });
    }

    // --- 7. Respond --------------------------------------------------------
    return json({
      orderId,
      nickyPaymentRequestId: paymentRequestId,
      nickyShortId: shortId,
      paymentUrl,
      status: "waiting_payment",
    });
  } catch (err) {
    if (err instanceof ValidationError) {
      return errorResponse(err.message, 400);
    }
    if (err instanceof NickyApiError) {
      console.error("Nicky API error", err.status, JSON.stringify(err.body));
      return errorResponse(err.message, 502, { nickyStatus: err.status });
    }
    console.error("nicky-create-payment unexpected error", (err as Error).message);
    return errorResponse("Unexpected error creating payment.", 500);
  }
});
