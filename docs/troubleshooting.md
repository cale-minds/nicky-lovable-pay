# Troubleshooting

## Assets don't load / `nicky-list-assets` returns 502

- **`NICKY_API_KEY` missing or wrong.** The function fails loudly if the secret
  isn't set. Run `supabase secrets list` and re-set it.
- **Wrong assets endpoint.** The spec did not pin an assets-list path, so the
  kit uses a configurable default
  (`/api/public/PaymentRequestPublicApi/get-supported-assets`). If your account
  exposes a different path, set `NICKY_ASSETS_ENDPOINT`. The 502 response
  includes a `rawSample` to help you spot the right shape.
- **Unexpected response shape.** `normalizeAsset()` probes common field names
  (`blockchainAssetId`/`assetId`/`id`, `symbol`/`ticker`, etc.). If Nicky uses
  different names, adjust that function.

## `nicky-create-payment` returns 400

It's an input-validation error; the `error` field says which field. Common
causes:

- `amountExpectedNative` not a positive decimal string (send `"25.00"`, not
  `25` as a JS number with float issues, though numbers are accepted).
- `payerEmail` not a valid email.
- Missing `blockchainAssetId` (the asset selector value wasn't set).

## `nicky-create-payment` returns 502

Nicky rejected the create call. Check:

- The asset id is one Nicky actually accepts (came from `nicky-list-assets`).
- Your API key has permission to create payment requests.
- The function logs (`supabase functions logs nicky-create-payment`) for the
  Nicky status code.

## Redirect goes to a broken Nicky page

The redirect URL is `https://pay.nicky.me/home?paymentId=<shortId>`. If the
short id is missing/blank, the create response didn't contain a recognizable
short id. The kit probes `shortId` / `billShortId` / `billId`. Inspect
`nicky_orders.nicky_create_response` to see the actual response and adjust
`extractShortId()` in `_shared/nicky.ts` if needed.

## Webhook returns 401

`nicky-webhook` was deployed with `verify_jwt = true`. Nicky cannot send a
Supabase JWT. Redeploy with `verify_jwt = false` (see `supabase/config.toml`).

## Webhook returns 403

The source IP didn't match `NICKY_WEBHOOK_ALLOWED_IP`. Check:

- The default is `20.76.240.81`. Confirm Nicky still uses it.
- Look at the stored event in `nicky_webhook_events` — `source_ip` and
  `raw_headers` show what arrived. If you're behind an extra proxy, adjust
  `extractClientIps()` or the allowed IP.

The event is still recorded even when rejected, so you can debug after the fact.

## Order never becomes `paid`

- Confirm the payment actually reached `Finished` in Nicky (check the Nicky
  dashboard or call `nicky-sync-payment-status`).
- `PaymentValidationRequired` maps to `validation_required` and is **intended**
  to stay locked until Nicky finishes validation. Poll/sync again later.
- Check `nicky_payment_status_checks` for what Nicky returned on each lookup.
- Make sure webhooks are registered (`GET /api/public/WebHookApi/list`) **and**
  your success page polls `nicky-sync-payment-status`. Don't rely on webhooks
  alone.

## Duplicate orders

You're sending a different `idempotencyKey` (or invoice reference) on retries.
Reuse the same `invoiceReference` (or pass an explicit `idempotencyKey`) so the
create endpoint returns the existing order instead of making a new one.

## CORS errors in the browser

The public functions return permissive CORS headers and handle `OPTIONS`
preflight. If you still see CORS errors, you're likely hitting the wrong URL
(check `VITE_SUPABASE_FUNCTIONS_URL`) or the function failed to deploy.

## Local order stuck in `creating_payment`

The create call failed after inserting the local order but before linking it to
Nicky. The row is intentionally retained for audit. Retry creation with the same
idempotency key; once Nicky returns a short id, the order advances to
`waiting_payment`.
