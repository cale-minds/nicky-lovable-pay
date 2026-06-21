// Edge Function: nicky-create-payment
//
// Creates a Nicky payment request for a local order and returns the payer
// redirect URL plus the local order id. The Nicky API key is read from the
// environment and NEVER returned to the caller.
//
// Flow:
//   1. Validate input.
//   2. Idempotency: if an order already exists for the idempotency key, return it.
//   3. Call Nicky create endpoint.
//   4. Persist order + payment-request records and the raw response.
//   5. Return { orderId, paymentUrl, nickyShortId, ... }.

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
  extractShortId,
  NickyApiError,
  type CreatePaymentRequestBody,
} from "../_shared/nicky.ts";

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

    // --- 2. Idempotency check ---------------------------------------------
    const { data: existing, error: existingErr } = await supabase
      .from("nicky_orders")
      .select("id, nicky_payment_request_id, nicky_short_id, payment_url, status")
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle();

    if (existingErr) {
      console.error("idempotency lookup failed", existingErr.message);
      return errorResponse("Failed to check for existing order.", 500);
    }

    if (existing && existing.payment_url) {
      // Already created — return the existing record rather than duplicating.
      return json({
        orderId: existing.id,
        nickyPaymentRequestId: existing.nicky_payment_request_id,
        nickyShortId: existing.nicky_short_id,
        paymentUrl: existing.payment_url,
        status: existing.status,
        idempotent: true,
      });
    }

    // Insert (or reuse) the local order in `creating_payment` state first, so a
    // failure mid-flight still leaves an auditable record.
    const orderId =
      existing?.id ??
      (await (async () => {
        const { data, error } = await supabase
          .from("nicky_orders")
          .insert({
            idempotency_key: idempotencyKey,
            invoice_reference: invoiceReference,
            description,
            amount_expected_native: amountExpectedNative,
            blockchain_asset_id: blockchainAssetId,
            payer_email: payerEmail,
            payer_name: payerName,
            status: "creating_payment",
            metadata,
          })
          .select("id")
          .single();
        if (error) throw new Error(`Failed to create local order: ${error.message}`);
        return data.id as string;
      })());

    // --- 3. Call Nicky -----------------------------------------------------
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
    const nickyPaymentRequestId = (pr.id as string) ?? undefined;
    const shortId = extractShortId(pr);

    if (!shortId) {
      await supabase.from("nicky_orders").update({ status: "failed", nicky_create_response: pr }).eq("id", orderId);
      return errorResponse(
        "Nicky did not return a usable short id for the payment request.",
        502,
        { nickyResponse: pr },
      );
    }

    const paymentUrl = buildPaymentUrl(env, shortId);

    // --- 4. Persist --------------------------------------------------------
    const { error: updErr } = await supabase
      .from("nicky_orders")
      .update({
        status: "waiting_payment",
        nicky_payment_request_id: nickyPaymentRequestId,
        nicky_short_id: shortId,
        payment_url: paymentUrl,
        last_remote_status: (pr.status as string) ?? "PaymentPending",
        nicky_create_response: pr,
      })
      .eq("id", orderId);

    if (updErr) {
      console.error("failed to update order after Nicky create", updErr.message);
      return errorResponse("Payment created at Nicky but failed to persist locally.", 500, {
        paymentUrl,
        nickyShortId: shortId,
      });
    }

    await supabase.from("nicky_payment_requests").upsert(
      {
        order_id: orderId,
        nicky_payment_request_id: nickyPaymentRequestId,
        nicky_short_id: shortId,
        payment_url: paymentUrl,
        blockchain_asset_id: blockchainAssetId,
        amount_expected_native: amountExpectedNative,
        remote_status: (pr.status as string) ?? "PaymentPending",
        raw_response: pr,
      },
      { onConflict: "nicky_payment_request_id" },
    );

    // --- 5. Respond --------------------------------------------------------
    return json({
      orderId,
      nickyPaymentRequestId,
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
