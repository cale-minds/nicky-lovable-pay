// Edge Function: nicky-webhook
//
// Fixed, kit-owned webhook receiver for Nicky events:
//   * PaymentRequest_ReportAdded
//   * PaymentRequest_StatusChanged
//
// Security posture (see docs/security.md and docs/webhooks.md):
//   1. POST only.
//   2. Validate the source IP is Nicky's (`NICKY_WEBHOOK_ALLOWED_IP`,
//      default 20.76.240.81), using only the first x-forwarded-for entry —
//      BEFORE reading/parsing/storing the body. Unauthorized requests get a 403
//      with no DB write (storage-amplification hardening), so they never reach
//      `nicky_webhook_events` (they appear only in function logs).
//   2b. Enforce a small body-size cap (defense-in-depth) for authorized requests.
//   3. Store the raw (authorized) event BEFORE processing (audit trail), with a
//      `processing_status` lifecycle. Only 'processed' means success.
//   4. Do NOT trust the webhook body's status. Use `itemId` to re-query Nicky
//      server-side and only then update the local order. An order only becomes
//      `paid` if Nicky returns `Finished`.
//   5. Safe dedupe: a redelivery acks as a duplicate only if the prior event
//      truly succeeded ('processed') or is structurally unusable
//      ('failed_non_retryable'); other prior states reprocess and refresh audit
//      fields. Because unauthorized requests are now rejected before any insert,
//      dedupe poisoning is structurally impossible. See _shared/webhook-dedupe-helpers.ts.
//
// ⚠️ LLM CRITICAL: Step 4 is non-negotiable. Never modify this function to trust
// the webhook body's status field alone. The only reason this webhook is safe is
// because we re-query Nicky. If you remove or weaken the re-query, you enable
// attackers to mark arbitrary orders as paid by spoofing webhooks.
// See docs/IMPLEMENTATION_SECURITY_GUIDELINES.md section 3.
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
import { decideDuplicateAction } from "../_shared/webhook-dedupe-helpers.ts";
import { MAX_WEBHOOK_BODY_BYTES, contentLengthExceeds } from "../_shared/webhook-body.ts";

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

/**
 * Reads the request body while enforcing a hard byte cap. Streaming the body and
 * counting bytes means a chunked request WITHOUT a Content-Length header still
 * can't exceed the limit. Returns the text, or `{ tooLarge: true }`.
 */
async function readBodyWithLimit(
  req: Request,
  maxBytes: number,
): Promise<string | { tooLarge: true }> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // ignore
        }
        return { tooLarge: true };
      }
      chunks.push(value);
    }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(merged);
}

Deno.serve(async (req, connInfo) => {
  // 1. POST only. No CORS preflight handling — this is server-to-server.
  if (req.method !== "POST") {
    return errorResponse("Method not allowed. Use POST.", 405);
  }

  const env = getNickyEnv();

  // 2. Validate source IP BEFORE reading or storing the body. Only the FIRST
  //    x-forwarded-for entry is trusted (set by the Supabase edge proxy); we fall
  //    back to the direct connection IP when the header is absent. We do not scan
  //    arbitrary headers/positions.
  //
  //    STORAGE-AMPLIFICATION HARDENING: unauthorized requests are rejected here,
  //    before we read/parse/persist the body. An attacker therefore cannot force
  //    a DB write by POSTing arbitrary payloads. (Infrastructure-level IP
  //    allowlisting to Nicky's source IP is still recommended in production so
  //    junk never reaches the function at all — see docs/security.md.)
  const directIp = (connInfo as { remoteAddr?: { hostname?: string } } | undefined)?.remoteAddr
    ?.hostname;
  const { allowed: ipAllowed, clientIp } = checkWebhookIp({
    allowedIp: env.webhookAllowedIp,
    forwardedFor: req.headers.get("x-forwarded-for"),
    directIp,
  });

  if (!ipAllowed) {
    // Concise log only — never log the (unread) body. Rejected unauthorized
    // attempts are visible in platform/function logs, NOT in nicky_webhook_events.
    console.warn(
      "Rejected webhook from unauthorized IP",
      clientIp ?? "(unknown)",
      "ua:",
      (req.headers.get("user-agent") ?? "").slice(0, 120),
    );
    return errorResponse("Forbidden: source IP not allowed.", 403);
  }

  const supabase = getServiceClient();

  // 2b. Defense-in-depth body size cap (Nicky webhook payloads are tiny).
  if (contentLengthExceeds(req.headers.get("content-length"), MAX_WEBHOOK_BODY_BYTES)) {
    return errorResponse("Payload too large.", 413);
  }

  // Read the (authorized) body up front so we can persist it for audit, enforcing
  // the cap while streaming so a chunked body can't bypass it.
  const readResult = await readBodyWithLimit(req, MAX_WEBHOOK_BODY_BYTES);
  if (typeof readResult !== "string") {
    return errorResponse("Payload too large.", 413);
  }
  const rawText = readResult;

  let payload: Record<string, unknown>;
  try {
    payload = rawText ? JSON.parse(rawText) : {};
  } catch {
    return errorResponse("Webhook body must be valid JSON.", 400);
  }

  const data = (payload.data as Record<string, unknown> | undefined) ?? {};
  const dedupeKey = buildDedupeKey(payload);

  const selectedHeaders = {
    "x-forwarded-for": req.headers.get("x-forwarded-for"),
    "user-agent": req.headers.get("user-agent"),
  };

  // 3. Store the raw event BEFORE processing (full audit trail), with an
  //    initial processing_status of 'received'. We do NOT mark anything
  //    'processed' here.
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
      processing_status: "received",
      processed: false,
    })
    .select("id")
    .maybeSingle();

  let eventId = inserted?.id as string | undefined;

  if (insertErr) {
    // Unique violation => this dedupe key was recorded before (a redelivery,
    // OR a poisoning attempt that pre-inserted the key). Decide what to do based
    // on the PRIOR event's processing_status and whether THIS request is
    // authorized — a previously 'rejected' (unauthorized) event must never block
    // a later authorized Nicky delivery. See _shared/webhook-dedupe-helpers.ts.
    if ((insertErr as { code?: string }).code === "23505") {
      const { data: prior } = await supabase
        .from("nicky_webhook_events")
        .select("id, processing_status")
        .eq("dedupe_key", dedupeKey)
        .maybeSingle();

      const action = decideDuplicateAction(prior, ipAllowed);

      if (action === "duplicate_ack") {
        return json({
          ok: true,
          duplicate: true,
          alreadyProcessed: prior?.processing_status === "processed",
        });
      }
      if (action === "reject") {
        // Current request is unauthorized; do not let it touch the prior record.
        console.warn("Rejected duplicate webhook from unauthorized IP", clientIp ?? "(unknown)");
        return errorResponse("Forbidden: source IP not allowed.", 403);
      }
      // action === "reprocess": a legitimate, authorized delivery. Reuse the
      // existing audit row but OVERWRITE it with THIS attempt's audit data, so a
      // row that ends up 'processed' never carries the stale (possibly
      // unauthorized) source_ip / ip_allowed / raw payload from the prior attempt.
      if (!prior?.id) {
        return json({ ok: true, duplicate: true });
      }
      eventId = prior.id as string;
      await supabase
        .from("nicky_webhook_events")
        .update({
          processing_status: "received",
          processed: false,
          processing_error: null,
          processed_at: null,
          // Refresh audit fields to reflect the current (authorized) request.
          source_ip: clientIp ?? null,
          ip_allowed: ipAllowed,
          raw_payload: payload,
          raw_headers: selectedHeaders,
        })
        .eq("id", eventId);
    } else {
      console.error("failed to store webhook event", insertErr.message);
      return errorResponse("Failed to record webhook event.", 500);
    }
  }

  // (Source IP was already validated above, before the body was read/stored, so
  //  every event that reaches here is from the allowed IP. The dedupe/reprocess
  //  logic still refreshes audit fields for authorized redeliveries.)

  const itemId = typeof payload.itemId === "string" ? payload.itemId : undefined;
  if (!itemId) {
    if (eventId) {
      await supabase
        .from("nicky_webhook_events")
        .update({
          processing_status: "failed_non_retryable",
          processing_error: "missing itemId",
          processed_at: new Date().toISOString(),
        })
        .eq("id", eventId);
    }
    // 200 so Nicky doesn't retry a structurally-unusable event.
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
          processing_status: "processed", // the ONLY success state
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
      // Retryable: a later redelivery (or a manual retry) can reprocess.
      await supabase
        .from("nicky_webhook_events")
        .update({ processing_status: "failed_retryable", processing_error: message })
        .eq("id", eventId);
    }
    // Return 500 so Nicky retries; the raw event is already stored.
    return errorResponse("Failed to process webhook.", 500);
  }
});
