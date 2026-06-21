# Troubleshooting

## Assets don't load / `nicky-list-assets` returns 502

Assets are read from the fixed Nicky endpoint `GET /AcceptedAsset/get-for-user`
(there is no configurable endpoint).

- **`NICKY_API_KEY` missing or wrong.** The function fails loudly if the secret
  isn't set. Run `supabase secrets list` and re-set it.
- **Empty asset list.** If Nicky returns no accepted assets for the account, the
  function returns a clear `502` ("Nicky returned no accepted assets…"). Confirm
  your Nicky account actually has accepted assets configured.
- **Invalid response shape.** If the response can't be parsed into the expected
  shape (fields `id`, `assetName`, `isFiat`, `decimalPrecisionUI`, `assetChain`,
  `assetTicker`), the function returns a `502` with a clear message. Normalization
  lives in `_shared/assets.ts` (`normalizeAcceptedAssets`).

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

## `nicky-create-payment` returns 502 with "missing required `id` / `bill.shortId`"

The Nicky create response must contain `response.id` (Payment Request UUID) and
`response.bill.shortId` (used to build the payment link). The kit does **not**
probe alternate field names — a missing identifier is treated as an exceptional
API-contract violation. When this happens:

- the local order is marked `failed`,
- the raw response is saved in `nicky_orders.nicky_create_response`,
- no `nicky_payment_requests` row is created,
- no `paymentUrl` is returned.

Inspect `nicky_orders.nicky_create_response` to see exactly what Nicky returned.
If the real API has genuinely changed its contract, update
`getRequiredPaymentRequestIdentifiers()` in `_shared/payment-identifiers.ts`.

## Redirect goes to a broken Nicky page

The redirect URL is `https://pay.nicky.me/home?paymentId=<bill.shortId>`, built
from the validated `response.bill.shortId`. If the page is broken, confirm the
short id stored in `nicky_orders.nicky_short_id` matches what you see in the
Nicky dashboard.

## Webhook returns 401

`nicky-webhook` was deployed with `verify_jwt = true`. Nicky cannot send a
Supabase JWT. Redeploy with `verify_jwt = false` (see `supabase/config.toml`).

## Webhook returns 403

The source IP didn't match `NICKY_WEBHOOK_ALLOWED_IP`. Check:

- The default is `20.76.240.81`. Confirm Nicky still uses it.
- Look at the stored event in `nicky_webhook_events` — `source_ip` and
  `raw_headers` show what arrived. If you're behind an extra proxy, adjust
  `checkWebhookIp()` in `_shared/webhook-ip.ts` or the allowed IP.

The event is still recorded even when rejected, so you can debug after the fact.

## Webhook registration script fails or seems to do nothing

The one-time setup script is `scripts/register-nicky-webhooks.mjs`
(`npm run nicky:register-webhooks`). Common issues:

- **"NICKY_API_KEY is required" / "NICKY_WEBHOOK_URL is required".** Provide both
  env vars (see `scripts/.env.webhook.example`).
- **"NICKY_WEBHOOK_URL must use HTTPS" / "must end with `/nicky-webhook`".** The
  URL is fixed: `https://<project-ref>.functions.supabase.co/nicky-webhook`.
- **"already registered for this URL (no change)".** This is expected and correct
  — the script is idempotent, so re-running it does not create duplicates.
- **HTTP error listing/creating.** Verify the API key is valid and
  `NICKY_API_BASE_URL` is correct. Use `--dry-run` to validate inputs without
  calling Nicky.
- Remember this is a **setup-only** script. It is not deployed and does not run
  in production. The plugin runtime only *processes* webhooks.

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
