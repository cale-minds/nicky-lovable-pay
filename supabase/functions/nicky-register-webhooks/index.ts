// Edge Function: nicky-register-webhooks
//
// Registers the kit's fixed webhook callback URL with Nicky for both supported
// event types:
//   * PaymentRequest_ReportAdded
//   * PaymentRequest_StatusChanged
//
// The callback URL points at the kit-owned `nicky-webhook` function. The end
// user does not get to choose arbitrary callback routes.
//
// Idempotency: we first list existing webhooks and skip any that already point
// at our callback URL for a given type.
//
// IMPORTANT: the deployed `nicky-webhook` URL is only known AFTER you deploy the
// functions. Provide it via the `WEBHOOK_CALLBACK_URL` env var, or pass
// `{ "callbackUrl": "https://<ref>.functions.supabase.co/nicky-webhook" }` in
// the request body. We do not guess it.

import { handlePreflight, json, errorResponse } from "../_shared/cors.ts";
import { getNickyEnv } from "../_shared/env.ts";
import {
  createWebhook,
  listWebhooks,
  NickyApiError,
  type NickyWebhook,
  type NickyWebhookType,
} from "../_shared/nicky.ts";

const REQUIRED_TYPES: NickyWebhookType[] = [
  "PaymentRequest_ReportAdded",
  "PaymentRequest_StatusChanged",
];

function webhookUrl(w: NickyWebhook): string | undefined {
  return (w.url as string) || (w.callbackUrl as string) || undefined;
}

Deno.serve(async (req) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;

  if (req.method !== "POST") {
    return errorResponse("Method not allowed. Use POST.", 405);
  }

  try {
    const env = getNickyEnv();

    // Resolve the callback URL: body override first, then env var.
    let callbackUrl = Deno.env.get("WEBHOOK_CALLBACK_URL") ?? "";
    try {
      const body = await req.json();
      if (typeof body?.callbackUrl === "string" && body.callbackUrl.trim()) {
        callbackUrl = body.callbackUrl.trim();
      }
    } catch {
      // No body is fine if WEBHOOK_CALLBACK_URL is set.
    }

    if (!callbackUrl) {
      return errorResponse(
        "No callback URL available. Set the WEBHOOK_CALLBACK_URL secret or pass " +
          '{ "callbackUrl": "https://<project-ref>.functions.supabase.co/nicky-webhook" }.',
        400,
      );
    }
    if (!/^https:\/\//.test(callbackUrl)) {
      return errorResponse("callbackUrl must be an https URL.", 400);
    }

    // List existing webhooks to stay idempotent.
    const existing = await listWebhooks(env);

    const results: Array<{ type: NickyWebhookType; action: "created" | "exists"; id?: string }> = [];

    for (const type of REQUIRED_TYPES) {
      const already = existing.find(
        (w) => w.webHookType === type && webhookUrl(w) === callbackUrl,
      );
      if (already) {
        results.push({ type, action: "exists", id: already.id as string | undefined });
        continue;
      }
      const created = await createWebhook(env, type, callbackUrl);
      results.push({ type, action: "created", id: created.id as string | undefined });
    }

    return json({ ok: true, callbackUrl, webhooks: results });
  } catch (err) {
    if (err instanceof NickyApiError) {
      console.error("Nicky webhook registration error", err.status);
      return errorResponse("Failed to register webhooks with Nicky.", 502, {
        nickyStatus: err.status,
      });
    }
    console.error("nicky-register-webhooks error", (err as Error).message);
    return errorResponse("Unexpected error registering webhooks.", 500);
  }
});
