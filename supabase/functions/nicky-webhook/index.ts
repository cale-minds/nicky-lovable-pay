// Edge Function: nicky-webhook
//
// Fixed, kit-owned webhook receiver for Nicky events:
//   * PaymentRequest_ReportAdded
//   * PaymentRequest_StatusChanged
//
// Security posture (see docs/security.md and docs/webhooks.md):
//   1. POST only.
//   2. Validate the source IP is Nicky's (`NICKY_WEBHOOK_ALLOWED_IP`,
//      default 20.76.240.81).
//   3. Store the raw event idempotently BEFORE processing (full audit trail).
//   4. Do NOT trust the webhook body's status. Use `itemId` to re-query Nicky
//      server-side and only then update the local order. An order only becomes
//      `paid` if Nicky returns `Finished`.
//   5. Acknowledge duplicates with 200 so Nicky stops retrying.
//
// NOTE ON PROXY HEADERS: Supabase fronts functions with a proxy, so the direct
// socket IP is not Nicky's. We therefore read `x-forwarded-for`. Because that
// header is client-settable in general, we take the LEFT-MOST entry (the
// original client as seen by the trusted Supabase edge, which appends rather
// than lets callers forge the front of the chain) and compare it to the allow
// list. This is the pragmatic check available on this platform; combined with
// the mandatory server-side re-query (step 4), a spoofed IP still cannot cause
// a false `paid`.

import { json, errorResponse } from "../_shared/cors.ts";
import { getNickyEnv } from "../_shared/env.ts";
import { getServiceClient } from "../_shared/db.ts";
import { reconcileOrder } from "../_shared/reconcile.ts";
import { NickyApiError } from "../_shared/nicky.ts";
import { checkWebhookIp } from "../_shared/webhook-ip.ts";

/** Stable dedupe key for an event, used to enforce idempotency. */
function buildDedupeKey(payload: Record<string, unknown>): string {
  const data = (payload.data as Record<string, unknown> | undefined) ?? {};
  return [
    payload.webHookId ?? "",
    payload.webHookType ?? "",
    payload.itemId ?? "",
    data.previousStatus ?? "",
    data.newStatus ?? "",
  ].join("|");
}

Deno.serve(async (req, connInfo) => {
  // 1. POST only. No CORS preflight handling — this is server-to-server.
  if (req.method !== "POST") {
    return errorResponse("Method not allowed. Use POST.", 405);
  }

  const env = getNickyEnv();
  const supabase = getServiceClient();

  // Read the raw body up front so we can persist it even if later steps fail.
  let payload: Record<string, unknown>;
  let rawText: string;
  try {
    rawText = await req.text();
    payload = rawText ? JSON.parse(rawText) : {};
  } catch {
    return errorResponse("Webhook body must be valid JSON.", 400);
  }

  // 2. Validate source IP. Only the FIRST x-forwarded-for entry is trusted
  //    (set by the Supabase edge proxy); we fall back to the direct connection
  //    IP when the header is absent. We do not scan arbitrary headers/positions.
  const directIp = (connInfo as { remoteAddr?: { hostname?: string } } | undefined)?.remoteAddr
    ?.hostname;
  const { allowed: ipAllowed, clientIp } = checkWebhookIp({
    allowedIp: env.webhookAllowedIp,
    forwardedFor: req.headers.get("x-forwarded-for"),
    directIp,
  });

  const data = (payload.data as Record<string, unknown> | undefined) ?? {};
  const dedupeKey = buildDedupeKey(payload);

  const selectedHeaders = {
    "x-forwarded-for": req.headers.get("x-forwarded-for"),
    "user-agent": req.headers.get("user-agent"),
  };

  // 3. Store raw event idempotently BEFORE processing.
  //    On conflict (redelivery), this is a no-op insert; we detect that and
  //    return success without reprocessing.
  const { data: inserted, error: insertErr } = await supabase
    .from("nicky_webhook_events")
    .insert({
      dedupe_key: dedupeKey,
      web_hook_id: payload.webHookId ?? null,
      web_hook_type: payload.webHookType ?? null,
      item_id: payload.itemId ?? null,
      previous_status: data.previousStatus ?? null,
      new_status: data.newStatus ?? null,
      source_ip: clientIp ?? null,
      ip_allowed: ipAllowed,
      raw_payload: payload,
      raw_headers: selectedHeaders,
      processed: false,
    })
    .select("id")
    .maybeSingle();

  let eventId = inserted?.id as string | undefined;

  if (insertErr) {
    // Unique violation => this exact event was recorded before (a redelivery).
    if ((insertErr as { code?: string }).code === "23505") {
      // Load the prior record. If it was already processed SUCCESSFULLY, ack the
      // duplicate without redoing work. If a previous attempt did NOT finish
      // successfully (processed = false), we REPROCESS it now: webhooks must not
      // be permanently lost just because the first attempt errored.
      const { data: prior } = await supabase
        .from("nicky_webhook_events")
        .select("id, processed")
        .eq("dedupe_key", dedupeKey)
        .maybeSingle();

      if (prior?.processed === true) {
        return json({ ok: true, duplicate: true, alreadyProcessed: true });
      }
      if (prior?.id) {
        // Fall through and reprocess against the prior event row.
        eventId = prior.id as string;
      } else {
        // Couldn't load the prior row; safest is to ack so Nicky stops retrying
        // (the original record exists for audit).
        return json({ ok: true, duplicate: true });
      }
    } else {
      console.error("failed to store webhook event", insertErr.message);
      return errorResponse("Failed to record webhook event.", 500);
    }
  }

  // Reject (but keep the audit record) if the IP is not Nicky's.
  if (!ipAllowed) {
    console.warn("Rejected webhook from unauthorized IP", clientIp ?? "(unknown)");
    if (eventId) {
      await supabase
        .from("nicky_webhook_events")
        .update({ processed: true, processing_error: "rejected: unauthorized source IP", processed_at: new Date().toISOString() })
        .eq("id", eventId);
    }
    return errorResponse("Forbidden: source IP not allowed.", 403);
  }

  const itemId = typeof payload.itemId === "string" ? payload.itemId : undefined;
  if (!itemId) {
    if (eventId) {
      await supabase
        .from("nicky_webhook_events")
        .update({ processed: true, processing_error: "missing itemId", processed_at: new Date().toISOString() })
        .eq("id", eventId);
    }
    // Still a 200 so Nicky doesn't retry a structurally-fine-but-unusable event.
    return json({ ok: true, note: "No itemId; nothing to reconcile." });
  }

  // 4. Re-query Nicky server-side and update the order. The webhook's claimed
  //    status is NOT trusted as truth.
  try {
    const result = await reconcileOrder(
      supabase,
      env,
      { nickyPaymentRequestId: itemId },
      "webhook",
    );

    if (eventId) {
      await supabase
        .from("nicky_webhook_events")
        .update({
          processed: true,
          processed_at: new Date().toISOString(),
          order_id: result.orderId ?? null,
        })
        .eq("id", eventId);
    }

    return json({
      ok: true,
      orderId: result.orderId,
      status: result.localStatus,
      remoteStatus: result.remoteStatus,
      paid: result.paid,
    });
  } catch (err) {
    const message = err instanceof NickyApiError ? `Nicky lookup failed (${err.status})` : (err as Error).message;
    console.error("webhook reconcile failed", message);
    if (eventId) {
      await supabase
        .from("nicky_webhook_events")
        .update({ processing_error: message })
        .eq("id", eventId);
    }
    // Return 500 so Nicky retries; the raw event is already stored.
    return errorResponse("Failed to process webhook.", 500);
  }
});
