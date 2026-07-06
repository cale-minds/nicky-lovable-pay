# Nicky Payment Kit Instructions For Lovable Agents

This repository is a reusable Nicky payment integration kit for Lovable-style
apps that use React, TypeScript, Supabase Edge Functions, and PostgreSQL. Treat
this file as the highest-level implementation contract when installing or
adapting the kit.

## Hard Rules

- Do not enable Lovable built-in Payments for this integration. Nicky is a
  custom payment provider here, not Stripe or Paddle.
- Do not add a Nicky account creator, Nicky API key generator, or merchant
  onboarding UI to the consuming application runtime. During setup only, an
  agent/Lovable installer may either ask for an existing Nicky API key or guide
  the user through Nicky's agent signup flow (`POST /api/agents/signup`), email
  confirmation, and Terms/Privacy agreement.
- Never expose `NICKY_API_KEY` to the browser, Vite env vars, committed files,
  logs, responses, or generated UI. It belongs only in Supabase Edge Function
  secrets and is read server-side with `Deno.env`.
- Do not call the Nicky API directly from React. Browser code calls Supabase Edge
  Functions; Edge Functions call Nicky.
- Do not add a demo store, fake product catalog, or hardcoded product pricing to
  this kit. The consuming app owns products, orders, authorization, and pricing.
- Before a production app creates a Nicky Payment Request, the consuming app
  must authenticate the user and validate order ownership, order status, product,
  amount, invoice reference, and payer details server-side.
- Do not mark anything paid from a success redirect, client state, localStorage,
  or webhook body. Payment is confirmed only after a server-side Nicky lookup
  returns `Finished`.
- Do not unlock paid features on `PaymentValidationRequired` or local
  `validation_required`.
- Gate entitlement on current local `status === "paid"`, not on `paid_at`.
  `paid` is not terminal; only Nicky `Canceled` is terminal.
- Do not register, list, update, or delete Nicky webhooks from browser code or
  deployed application runtime code. There is no `nicky-register-webhooks` Edge
  Function and no runtime webhook setup script.
- During setup only, after Edge Functions are deployed and the callback URL is
  known, the installer may list existing Nicky webhooks and create any missing
  required webhooks. This setup action must be idempotent: do not create a
  duplicate when the same event type already points at the fixed callback URL.
- Configure the Nicky webhook once, by assisted setup or manual fallback, with callback
  `https://<project-ref>.functions.supabase.co/nicky-webhook` and events
  `PaymentRequest_ReportAdded` and `PaymentRequest_StatusChanged`.
- Do not let users choose arbitrary webhook callback URLs.
- Do not change the accepted-assets endpoint path. It is exactly
  `GET /AcceptedAsset/get-for-user` and intentionally has no `/api/public`
  prefix.
- Treat the browser request body and the Nicky API request body as two different
  contracts. A consuming app may send a simple internal payload such as
  `{ selectedAssetId, name, email }` to its own Edge Function, but the Edge
  Function MUST transform that into Nicky's public create DTO before calling
  Nicky.
- The public Nicky create endpoint requires a nested payload with
  `blockchainAssetId`, `amountExpectedNative`, `billDetails`, and `requester`.
  Do not send a flat payload containing `description`, `invoiceReference`,
  `payerName`, or `payerEmail` at the top level.
- Do not send `acceptedAssetId` to `POST /api/public/PaymentRequestPublicApi/create`.
  Use the chosen accepted asset's `id` as `blockchainAssetId`.
- Do not probe alternate create-payment response fields. Creation requires
  `response.id` and `response.bill.shortId`; missing values are API-contract
  failures.

## Files To Install

- Copy `src/nicky/` into the consuming app frontend.
- Copy `supabase/migrations/001_nicky_payment_kit.sql`.
- Copy `supabase/functions/_shared/`.
- Copy these Supabase Edge Functions:
  - `nicky-create-payment`
  - `nicky-list-assets`
  - `nicky-sync-payment-status`
  - `nicky-webhook`
  - `nicky-reconcile-open-orders`
- Merge the Nicky `[functions.*]` blocks from `supabase/config.toml`.

## Supabase Function Auth

- `nicky-create-payment`: `verify_jwt = true`
- `nicky-list-assets`: `verify_jwt = true`
- `nicky-sync-payment-status`: `verify_jwt = true`
- `nicky-webhook`: `verify_jwt = false`
- `nicky-reconcile-open-orders`: `verify_jwt = false`, but protected by the
  `x-nicky-reconciliation-secret` header and must fail closed if
  `NICKY_RECONCILIATION_SECRET` is unset.

## Database And RLS

- Apply `supabase/migrations/001_nicky_payment_kit.sql`.
- Keep RLS enabled on all Nicky tables with no broad permissive policies.
- Keep the `nicky_create_or_claim_order` RPC. It is the race-safe guard that
  prevents duplicate Nicky Payment Requests for the same idempotency key.

## Status Model

Use this local status model exactly:

`idle`, `creating_payment`, `redirecting_to_nicky`, `waiting_payment`,
`webhook_received`, `syncing_status`, `paid`, `validation_required`, `canceled`,
`expired_or_abandoned`, `failed`.

Map Nicky statuses conservatively:

- `PaymentPending` -> `waiting_payment`
- `PaymentValidationRequired` -> `validation_required`
- `Finished` -> `paid`
- `Canceled` -> `canceled`

## Public Boundary

- For browser success-page polling, prefer high-entropy local `orderId` only.
- Treat `nickyShortId` and `nickyPaymentRequestId` lookups as server/admin flows
  unless the consuming app adds authorization and rate limiting.
- Add app authentication, rate limiting, and abuse controls before production.

## Validation Before Launch

Before production, run:

```bash
npm ci
npm run typecheck
npm test
npm run typecheck:edge
```

Also complete `docs/production-checklist.md` and perform an end-to-end test:
asset loading, payment creation, Nicky redirect, success-page sync, cancel flow,
webhook processing, and scheduled reconciliation.
