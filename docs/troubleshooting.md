# Troubleshooting

## Assets do not load / `nicky-list-assets` returns 502

Assets are read from the fixed Nicky endpoint `GET /AcceptedAsset/get-for-user`
(there is no configurable endpoint).

- **`NICKY_API_KEY` missing or wrong.** The function fails loudly if the secret
  is not set. Run `supabase secrets list` and re-set it.
- **Empty asset list.** A `2xx` empty array means the API key authenticated, but
  the function returns a clear `502` because checkout has no usable assets. Do
  not label the key invalid. Confirm Merchant Configuration, Wallet Connections,
  and Payment Routes in Nicky, then retry. See [`wallets.md`](wallets.md).
- **Invalid response shape.** If the response cannot be parsed into the expected
  shape, the function returns a `502` with a clear message. Normalization lives
  in `_shared/assets.ts` (`normalizeAcceptedAssets`).

## New agent account cannot pass protected setup calls

After `POST /api/agents/signup`, email confirmation and review/acceptance of
Nicky's Privacy Policy and Terms can happen in parallel. The installer must wait
for one explicit user declaration confirming both, then call
`POST /api/public/privacy-policy/agree` with the returned/stored key.

If agreement or accepted-assets validation still returns `401`/`403`, retain the
account and key, confirm that the email action has propagated, and retry the
agreement/validation steps. Do not repeat signup and do not ask the user to paste
the key returned by signup.

## `nicky-create-payment` returns 400

It is an input-validation error; the `error` field says which field. Common
causes:

- `amountExpectedNative` is not a positive decimal string.
- `payerEmail` is not a valid email.
- `blockchainAssetId` is missing.

## `nicky-create-payment` returns 502

Nicky rejected the create call. Check:

- The asset id is one Nicky actually accepts and came from `nicky-list-assets`.
- Your API key has permission to create payment requests.
- Function logs with `supabase functions logs nicky-create-payment`.

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

The browser may send a simple internal payload to **your** Edge Function, but
the Edge Function must transform it to the nested Nicky DTO before calling Nicky.
Do **not** send `acceptedAssetId` to the public create endpoint; use the selected
accepted asset's `id` as `blockchainAssetId`.

## `nicky-create-payment` returns 502 with missing `id` / `bill.shortId`

The Nicky create response must contain `response.id` (Payment Request UUID) and
`response.bill.shortId` (used to build the payment link). The kit does **not**
probe alternate field names. A missing identifier is treated as an API-contract
violation.

Inspect `nicky_orders.nicky_create_response` to see exactly what Nicky returned.
If the real API changed its contract, update
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

The source IP did not match `NICKY_WEBHOOK_ALLOWED_IP`. Unauthorized requests
are rejected **before** the body is read or stored, so they are **not** in
`nicky_webhook_events`. Debug from function logs instead:

- The default allowed IP is `20.76.240.81`. Confirm Nicky still uses it.
- `supabase functions logs nicky-webhook` should show
  `Rejected webhook from unauthorized IP <ip> ua: <user-agent>`.
- If you are behind an extra proxy that changes the first `x-forwarded-for`
  entry, adjust `checkWebhookIp()` in `_shared/webhook-ip.ts` or the allowed IP.
- Only authorized deliveries are persisted; inspect those with
  `select source_ip, ip_allowed, processing_status from nicky_webhook_events
  order by received_at desc limit 20;`.

## Webhook is not being received / not configured

There is **no** runtime function that registers webhooks. Configuration is a
one-time setup step in Nicky, either via Lovable setup automation/private MCP or
manual fallback. Checklist:

- Confirm the webhook is configured in Nicky for **both** events
  (`PaymentRequest_ReportAdded`, `PaymentRequest_StatusChanged`).
- Confirm the callback URL is exactly
  `https://<project-ref>.functions.supabase.co/nicky-webhook`.
- If setup automation was used, confirm it listed existing webhooks first and
  created only missing event+URL pairs.
- Confirm `nicky-webhook` is deployed with `verify_jwt = false`.
- Inspect `nicky_webhook_events` for incoming deliveries and their
  `processing_status`.

## Legitimate webhook seems skipped as a duplicate

The dedupe logic only acks as a duplicate when the prior event for that dedupe
key is `processed` (success) or `failed_non_retryable`. A prior unauthorized
event does **not** block a later authorized delivery because unauthorized
requests are rejected before insert.

## Order never becomes `paid`

- Confirm the payment actually reached `Finished` in Nicky.
- `PaymentValidationRequired` maps to `validation_required` and intentionally
  stays locked until Nicky finishes validation.
- Check `nicky_payment_status_checks` for what Nicky returned on each lookup.
- Make sure the webhook was configured once in Nicky for both required events
  and that your success page polls `nicky-sync-payment-status`.

## Duplicate orders

You are sending a different `idempotencyKey` or invoice reference on retries.
Reuse the same `invoiceReference`, or pass an explicit `idempotencyKey`, so the
create endpoint returns the existing order instead of making a new one.

## CORS errors in the browser

The public functions return permissive CORS headers and handle `OPTIONS`
preflight. If you still see CORS errors, you are likely hitting the wrong URL or
the function failed to deploy.

## Local order stuck in `creating_payment`

The create call failed after the order row was created but before it was linked
to Nicky. The row is intentionally retained for audit, and
`creation_claimed_at` gates retries. Retry creation with the same idempotency key
after the stale window. It re-claims and re-attempts.

## `nicky-create-payment` returns 409 "creation already in progress"

Two requests with the same idempotency key raced. One is creating the Nicky
Payment Request and the others are told to retry shortly. Retry the same call
after a moment; it will return the existing payment URL once creation completes.

## `nicky-create-payment` succeeds with a `warning` field

The payment is usable, but the normalized `nicky_payment_requests` row failed to
persist. The order is flagged with `metadata.payment_request_row_missing`.
Re-call `nicky-create-payment` with the same idempotency key to repair the row,
or see [`operations.md`](operations.md).

## Reconciliation function returns 401 / 503

- **503 "not configured"** means `NICKY_RECONCILIATION_SECRET` is not set.
- **401** means the `x-nicky-reconciliation-secret` header is missing or wrong.

## `npm run typecheck:edge` cannot run

This requires the Deno CLI and network access to fetch the Edge Functions'
remote imports. If Deno is not installed, install it (https://deno.land) or rely
on CI, where the `edge` job runs it. The pure business logic is also covered by
`npm test`, so a missing Deno locally does not block the Node checks.
