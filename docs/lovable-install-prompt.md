# Lovable Install Prompt

Copy the prompt below into Lovable to add the Nicky payment kit to an **existing**
Lovable app. It tells Lovable exactly what to install and — just as importantly —
what **not** to do (no account creation, no demo store, no exposed keys).

> Before running it: create your Nicky account and API key yourself (Lovable
> cannot and should not do this), and have your Supabase project connected.

---

## Copy-paste prompt

```text
Add the "Nicky Payment Kit" to this existing app to accept non-custodial crypto
payments via Nicky. This is an integration, NOT a new product or demo store.

STRICT RULES — follow all of these:
- Do NOT create a Nicky account or a Nicky API key. The user creates those
  manually in the Nicky dashboard.
- Do NOT put the Nicky API key anywhere in frontend code or in committed files.
  It must live ONLY as a Supabase secret named NICKY_API_KEY and be used ONLY
  inside Supabase Edge Functions.
- Do NOT build a demo storefront, sample products, or a cart.
- Do NOT hardcode a single currency (no USD-only logic). Available settlement
  assets must be loaded from Nicky at runtime via GET /AcceptedAsset/get-for-user.
- The webhook callback route is fixed and owned by the kit. Do not let the user
  choose arbitrary callback URLs.
- Do NOT register, list, or delete webhooks at runtime, and do NOT create a
  nicky-register-webhooks function. The plugin only PROCESSES webhooks. Webhook
  setup in Nicky is a one-time step done outside the plugin runtime.

WHAT TO INSTALL:
1. Supabase migration: create tables nicky_orders, nicky_payment_requests,
   nicky_webhook_events, nicky_payment_status_checks, nicky_assets_cache, with
   RLS enabled and no permissive policies. Use the provided
   001_nicky_payment_kit.sql.
2. Supabase Edge Functions (Deno) — create EXACTLY these four, no more:
   - nicky-create-payment: validates input, reads NICKY_API_KEY from env, calls
     POST /api/public/PaymentRequestPublicApi/create on
     https://api-public.pay.nicky.me, stores the order, returns { orderId,
     paymentUrl, nickyShortId }. Read EXACTLY response.id (Payment Request UUID)
     and response.bill.shortId; do NOT probe alternate field names. Build the
     payment URL as https://pay.nicky.me/home?paymentId=<response.bill.shortId>.
     If response.id or response.bill.shortId is missing, mark the order failed,
     store the raw response, and return a 502 — do not continue with a partial
     state. Never return the API key.
   - nicky-list-assets: reads accepted assets from GET /AcceptedAsset/get-for-user,
     normalizes them (id, assetName, isFiat, decimalPrecisionUI, assetChain,
     assetTicker), and caches them. Return a clear error on empty/invalid
     responses. Never hardcode USD.
   - nicky-webhook: POST only; validate source IP 20.76.240.81 using ONLY the
     first x-forwarded-for entry; store the raw event idempotently; then RE-QUERY
     Nicky by itemId and only mark the order paid if Nicky returns Finished.
     Acknowledge duplicates with 200. Deploy with verify_jwt = false.
   - nicky-sync-payment-status: accepts orderId / nickyPaymentRequestId /
     nickyShortId, re-queries Nicky, updates local status. Safe for the success
     page and for scheduled reconciliation.
3. Frontend kit under src/nicky/: NickyPayButton, NickyAssetSelector,
   NickyPaymentStatus, useNickyPayment, useNickyAssets, types, and an index.
   The frontend loads assets via nicky-list-assets, lets the user pick the
   settlement asset, creates a payment via nicky-create-payment, redirects to
   the returned Nicky payment URL, and after return polls
   nicky-sync-payment-status. Only unlock paid features when the confirmed
   status is "paid" (Nicky "Finished").

LOCAL STATUS MODEL (use exactly these):
idle, creating_payment, redirecting_to_nicky, waiting_payment, webhook_received,
syncing_status, paid, validation_required, canceled, expired_or_abandoned,
failed.
Map Nicky -> local: PaymentPending->waiting_payment,
PaymentValidationRequired->validation_required, Finished->paid,
Canceled->canceled. Never unlock on validation_required.

ENV / SECRETS (Supabase secrets, not frontend):
NICKY_API_KEY (required), NICKY_API_BASE_URL (default
https://api-public.pay.nicky.me), NICKY_PAY_BASE_URL (default
https://pay.nicky.me), NICKY_WEBHOOK_ALLOWED_IP (default 20.76.240.81).
There is NO WEBHOOK_CALLBACK_URL and NO NICKY_ASSETS_ENDPOINT variable.
Frontend gets only the public Supabase functions URL and anon key.

AFTER INSTALLING, tell me to:
1) set the NICKY_API_KEY secret,
2) run the migration,
3) deploy the four functions,
4) configure the webhook ONCE in Nicky, pointing at
   https://<project-ref>.functions.supabase.co/nicky-webhook for the events
   PaymentRequest_ReportAdded and PaymentRequest_StatusChanged (no arbitrary
   URLs; the plugin does not create or delete webhooks),
5) add the checkout UI using the provided components.

Confirm payment ONLY via a server-side Nicky lookup. Treat the success redirect
and the webhook as signals, never as proof of payment.
```

---

## After Lovable finishes

Follow the post-install steps in [`setup.md`](setup.md): set the secret, run the
migration, deploy the four functions, configure the webhook once in Nicky, and
wire the checkout UI.
