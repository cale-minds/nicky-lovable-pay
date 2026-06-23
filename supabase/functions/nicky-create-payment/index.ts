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
// ⚠️ PRODUCTION GATE — Nicky validates the merchant account and asset; your app
// validates the order. This function trusts the caller for `amountExpectedNative`,
// `invoiceReference`, etc. The consuming app MUST validate these against its own
// orders BEFORE calling this function (via its own authenticated endpoint).
//
// What Nicky validates:
//   ✅ API key is valid and merchant exists
//   ✅ blockchainAssetId is accepted for this merchant
//
// What Nicky does NOT validate:
//   ❌ invoiceReference is a real order
//   ❌ amountExpectedNative is the correct price for that order
//   ❌ the payer is authorized to pay for that order
//
// See docs/IMPLEMENTATION_SECURITY_GUIDELINES.md section 2 for the correct pattern.

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
  mergeMetadata,
  PERSIST_FAILURE_MESSAGE,
  buildPersistFailureBody,
  type ClaimOutcome,
} from "../_shared/create-payment-helpers.ts";

// deno-lint-ignore no-explicit-any
type AnySupabase = any;

/**
 * Best-effort: merge an operational `patch` into nicky_orders.metadata WITHOUT
 * clobbering existing (app-specific) metadata. Reads the current metadata first,
 * then writes the merged object. Errors are logged, never thrown — callers use
 * this for operator-recovery flags and must not depend on it succeeding.
 */
async function mergeOrderMetadata(
  supabase: AnySupabase,
  orderId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const { data, error: readErr } = await supabase
    .from("nicky_orders")
    .select("metadata")
    .eq("id", orderId)
    .maybeSingle();
  if (readErr) {
    console.error("mergeOrderMetadata: failed to read existing metadata", readErr.message);
    return;
  }
  const merged = mergeMetadata(data?.metadata as Record<string, unknown> | null, patch);
  const { error: writeErr } = await supabase
    .from("nicky_orders")
    .update({ metadata: merged })
    .eq("id", orderId);
  if (writeErr) {
    console.error("mergeOrderMetadata: failed to write merged metadata", writeErr.message);
  }
}

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
    // ⚠️ LLM NOTE: metadata has no size limit. If users supply metadata, consider
    // adding a size cap (~5-10 KB) to prevent DB bloat. See
    // docs/IMPLEMENTATION_SECURITY_GUIDELINES.md section 4.

    // --- 2. Atomic create-or-claim ----------------------------------------
    // NOTE: idempotency is resolved BEFORE any rate limiting. A legitimate retry
    // that maps to an existing order with a payment_url must always get that URL
    // back, even if the soft creation rate limit would otherwise be exceeded.
    // The rate limit is applied later, only when this invocation is actually
    // about to create a NEW Nicky Payment Request (action === "owns_creation").
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
      needsReview: claimRow.needs_review === true,
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
      // We must NOT create a parallel Nicky Payment Request. Rate limiting is
      // intentionally NOT applied here (no new Nicky request is being created).
      return errorResponse(
        "Payment creation already in progress for this order. Please retry shortly.",
        409,
        { orderId, retryable: true },
      );
    }

    if (action === "needs_review") {
      // A previous attempt called Nicky but never persisted linkage, so we
      // cannot tell whether a Nicky Payment Request already exists. Auto-creating
      // again risks a duplicate. Require operator review (see docs/operations.md).
      await supabase.from("nicky_orders").update({ status: "failed" }).eq("id", orderId);
      // Merge flags into EXISTING metadata so app-specific keys aren't clobbered.
      await mergeOrderMetadata(supabase, orderId, {
        needs_operator_review: true,
        review_reason: "nicky_create_attempted_no_linkage",
      });
      return errorResponse(
        "This payment needs manual review before it can be retried. A previous " +
          "creation attempt may have reached Nicky without being linked locally.",
        409,
        { orderId, retryable: false, needsReview: true },
      );
    }

    // action === "owns_creation": this invocation won the claim.

    // --- 5. Optional soft rate limit (defense-in-depth only) --------------
    // Applied ONLY now that we are about to create a NEW Nicky Payment Request.
    // Idempotent retries (return_existing) and in_progress already returned above,
    // so a legitimate retry is never blocked by this cap. Disabled unless
    // NICKY_CREATE_RATE_LIMIT_PER_HOUR > 0. This is a weak per-payer-email cap;
    // real protection should be app auth + WAF/Cloudflare (see docs/security.md).
    if (env.createRateLimitPerHour > 0) {
      const sinceIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      // Exclude the current order (it was just created/claimed by the RPC above)
      // so it doesn't count against itself — otherwise a cap of N would block the
      // Nth creation instead of the (N+1)th. With `.neq("id", orderId)` the count
      // is the number of PREVIOUS orders in the window, and isOverRateLimit blocks
      // once that already equals the cap (i.e. allow up to N, block the next).
      const { count, error: countErr } = await supabase
        .from("nicky_orders")
        .select("id", { count: "exact", head: true })
        .eq("payer_email", payerEmail)
        .neq("id", orderId)
        .gte("created_at", sinceIso);
      if (!countErr && isOverRateLimit(count ?? 0, env.createRateLimitPerHour)) {
        // Release our claim so a legitimate later attempt isn't blocked by it.
        await supabase
          .from("nicky_orders")
          .update({ creation_claimed_at: null })
          .eq("id", orderId);
        return errorResponse("Too many payment attempts. Please try again later.", 429);
      }
    }

    // --- 6. Call Nicky -----------------------------------------------------
    const nickyBody: CreatePaymentRequestBody = {
      blockchainAssetId,
      amountExpectedNative,
      billDetails: { invoiceReference, description },
      requester: { email: payerEmail, name: payerName },
      sendNotification,
      successUrl,
      cancelUrl,
    };

    // EXTERNAL-CALL CONSISTENCY: mark that we are about to call Nicky BEFORE the
    // request. This marker is the protection against DUPLICATE external creates:
    // if the Nicky call succeeds but the local persistence below fails, it lets
    // the create-or-claim RPC refuse an automatic stale re-claim (returning
    // needs_review) instead of creating a second Nicky Payment Request. Nicky's
    // public API has no documented idempotent-create or lookup-by-invoice-
    // reference, so this marker is the safe mitigation.
    //
    // Therefore the marker write is MANDATORY: if it fails we must NOT call Nicky
    // (a later retry could not tell the call had happened). We abort, release the
    // claim, and persist nothing. See docs/operations.md and docs/security.md.
    const { error: attemptErr } = await supabase
      .from("nicky_orders")
      .update({ nicky_create_attempted_at: new Date().toISOString() })
      .eq("id", orderId);

    if (attemptErr) {
      console.error("failed to write nicky_create_attempted_at", attemptErr.message);
      // Release the claim so a legitimate later attempt isn't blocked by it.
      await supabase
        .from("nicky_orders")
        .update({ creation_claimed_at: null })
        .eq("id", orderId);
      return errorResponse("Failed to mark Nicky create attempt; payment was not created.", 500, {
        orderId,
        retryable: true,
      });
    }

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
      // Mark failed + persist raw response. Because nicky_create_attempted_at is
      // set, a later stale retry will resolve to `needs_review` (not an auto
      // re-create) — Nicky may or may not have created a request, so an operator
      // must check before reattempting. See docs/operations.md.
      await supabase
        .from("nicky_orders")
        .update({ status: "failed", nicky_create_response: pr })
        .eq("id", orderId);
      return errorResponse(message, 502, { nickyResponse: pr });
    }

    const paymentUrl = buildPaymentUrl(env, shortId);

    // --- 7. Persist --------------------------------------------------------
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
      // Nicky created the Payment Request, but we failed to persist the linkage
      // locally. We must NOT hand the browser a usable payment URL for a request
      // the local system cannot reconcile automatically — otherwise a payer could
      // pay an orphaned request. Log the identifiers server-side for operator
      // recovery and best-effort flag the order for review, then return a safe
      // 500 with NO payment identifiers.
      console.error(
        "failed to update order after Nicky create",
        updErr.message,
        "orphaned nicky identifiers (for recovery):",
        JSON.stringify({
          orderId,
          nicky_payment_request_id: paymentRequestId,
          nicky_short_id: shortId,
          payment_url: paymentUrl,
        }),
      );
      await mergeOrderMetadata(supabase, orderId, {
        needs_operator_review: true,
        review_reason: "nicky_created_local_persist_failed",
        possible_orphaned_nicky_payment_request_id: paymentRequestId,
        possible_orphaned_nicky_short_id: shortId,
        possible_orphaned_payment_url: paymentUrl,
      });
      return errorResponse(PERSIST_FAILURE_MESSAGE, 500, buildPersistFailureBody(orderId));
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
      // Merge into existing metadata (don't clobber app-specific keys).
      await mergeOrderMetadata(supabase, orderId, { payment_request_row_missing: true });

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
