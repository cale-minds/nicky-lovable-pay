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

## `nicky-create-payment` returns 502 and Nicky says `billDetails` / `requester` are missing

The Edge Function likely sent the wrong JSON shape to
`POST /api/public/PaymentRequestPublicApi/create`.

The public Nicky create endpoint requires a **nested** payload:

```json
{
  "blockchainAssetId": "BRL.BRL",
  "amountExpectedNative": "25.00",
  "billDetails": {
    "invoiceReference": "order-1234",
    "description": "Pro plan - 1 month"
  },
  "requester": {
    "email": "buyer@example.com",
    "name": "Ada Lovelace"
  },
  "sendNotification": true
}
```

Common mistake:

```json
{
  "blockchainAssetId": "BRL.BRL",
  "amountExpectedNative": "25.00",
  "invoiceReference": "order-1234",
  "description": "Pro plan - 1 month",
  "payerEmail": "buyer@example.com",
  "payerName": "Ada Lovelace"
}
```

That flat payload is invalid for the public Nicky create endpoint. The browser
may send a simple internal payload to **your** Edge Function, but the Edge
Function must transform it to the nested Nicky DTO before calling Nicky.

Also do **not** send `acceptedAssetId` to the public create endpoint; use the
selected accepted asset's `id` as `blockchainAssetId`.

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

The source IP didn't match `NICKY_WEBHOOK_ALLOWED_IP`. Unauthorized requests are
rejected **before** the body is read or stored, so they are **not** in
`nicky_webhook_events` — debug from the function logs instead:

- The default allowed IP is `20.76.240.81`. Confirm Nicky still uses it.
- `supabase functions logs nicky-webhook` → look for
  `Rejected webhook from unauthorized IP <ip> ua: <user-agent>`.
- If you're behind an extra proxy that changes the first `x-forwarded-for` entry,
  adjust `checkWebhookIp()` in `_shared/webhook-ip.ts` or the allowed IP.
- Only authorized deliveries are persisted; inspect those with
  `select source_ip, ip_allowed, processing_status from nicky_webhook_events
  order by received_at desc limit 20;`.

## Webhook isn't being received / not configured

There is **no** repository script and **no** runtime function that registers
webhooks — configuration is a one-time manual step in Nicky (or via the Lovable
setup prompt). Checklist:

- Confirm the webhook is configured in Nicky for **both** events
  (`PaymentRequest_ReportAdded`, `PaymentRequest_StatusChanged`).
- Confirm the callback URL is exactly
  `https://<project-ref>.functions.supabase.co/nicky-webhook` (no other URL).
- Confirm `nicky-webhook` is deployed with `verify_jwt = false`.
- Inspect `nicky_webhook_events` for incoming deliveries and their
  `processing_status` (`received` / `processed` / `rejected` /
  `failed_retryable` / `failed_non_retryable`).

## Legitimate webhook seems "skipped" as a duplicate

The dedupe logic only acks as a duplicate when the prior event for that dedupe
key is `processed` (success) or `failed_non_retryable`. A prior `rejected`
(unauthorized IP) event does **not** block a later authorized delivery — it is
reprocessed. If a real event still looks skipped, check the prior row's
`processing_status` and `ip_allowed` in `nicky_webhook_events`.

## Order never becomes `paid`

- Confirm the payment actually reached `Finished` in Nicky (check the Nicky
  dashboard or call `nicky-sync-payment-status`).
- `PaymentValidationRequired` maps to `validation_required` and is **intended**
  to stay locked until Nicky finishes validation. Poll/sync again later.
- Check `nicky_payment_status_checks` for what Nicky returned on each lookup.
- Make sure the webhook was configured once in Nicky for both required events and
  that your success page polls `nicky-sync-payment-status`. Don't rely on
  webhooks alone.

## Duplicate orders

You're sending a different `idempotencyKey` (or invoice reference) on retries.
Reuse the same `invoiceReference` (or pass an explicit `idempotencyKey`) so the
create endpoint returns the existing order instead of making a new one.

## CORS errors in the browser

The public functions return permissive CORS headers and handle `OPTIONS`
preflight. If you still see CORS errors, you're likely hitting the wrong URL
(check `VITE_SUPABASE_URL` or your direct functions-domain override) or the
function failed to deploy.

## Local order stuck in `creating_payment`

The create call failed after the order row was created but before it was linked
to Nicky. The row is intentionally retained for audit, and `creation_claimed_at`
gates retries. Retry creation with the same idempotency key after the stale
window (~2 minutes); it re-claims and re-attempts. Once Nicky returns identifiers
the order advances to `waiting_payment`.

## `nicky-create-payment` returns 409 "creation already in progress"

Two requests with the same idempotency key raced; one is creating the Nicky
Payment Request and the others are told to **retry shortly**. This is the
race-safety guard (`nicky_create_or_claim_order`) preventing duplicate Nicky
requests. Simply retry the same call after a moment — it will return the existing
payment URL once creation completes.

## `nicky-create-payment` succeeds with a `warning` field

The payment is usable (a `paymentUrl` is returned), but the normalized
`nicky_payment_requests` row failed to persist. The order is flagged with
`metadata.payment_request_row_missing`. Re-call `nicky-create-payment` with the
same idempotency key to repair the row (idempotent path), or see
[`operations.md`](operations.md).

## Reconciliation function returns 401 / 503

- **503 "not configured"** — `NICKY_RECONCILIATION_SECRET` is not set. Set it as
  a Supabase secret and redeploy.
- **401** — the `x-nicky-reconciliation-secret` header is missing or wrong. Send
  the exact secret value.

## `npm run typecheck:edge` can't run

This requires the Deno CLI (and network access to fetch the Edge Functions'
remote imports). If Deno isn't installed, install it (https://deno.land) or rely
on CI, where the `edge` job runs it. The pure business logic is also covered by
`npm test`, so a missing Deno locally does not block the Node checks.
