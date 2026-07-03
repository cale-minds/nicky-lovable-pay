# Lovable Project Knowledge - Nicky Payment Kit

Use this text in Lovable Project Knowledge before asking Lovable to implement the
Nicky payment integration.

```text
Project payment strategy
- This project must use Nicky as a custom non-custodial payment integration.
- Do not enable Lovable built-in Payments for this integration. Nicky is not Stripe or Paddle.
- Nicky is a custom payment provider implemented through Supabase Edge Functions, PostgreSQL tables, and React components.
- The public Nicky kit repository is: <PASTE_PUBLIC_REPOSITORY_URL_HERE>.
- Before changing payment code, read the repository root AGENTS.md first, then README.md, docs/security.md, docs/lovable-install-prompt.md, and docs/production-checklist.md.

Nicky integration summary
- The frontend uses the React kit from src/nicky/: NickyAssetSelector, NickyPayButton, NickyPaymentStatus, useNickyAssets, and useNickyPayment.
- The backend uses Supabase Edge Functions:
  - nicky-create-payment
  - nicky-list-assets
  - nicky-sync-payment-status
  - nicky-webhook
  - nicky-reconcile-open-orders
- The database migration is supabase/migrations/001_nicky_payment_kit.sql.
- The migration creates nicky_orders, nicky_payment_requests, nicky_webhook_events, nicky_payment_status_checks, nicky_assets_cache, and the nicky_create_or_claim_order RPC.
- Keep RLS enabled on all Nicky tables. Do not add broad permissive policies.

Security rules
- Never expose NICKY_API_KEY in frontend code, Vite env vars, committed files, logs, UI, network responses, or browser code.
- NICKY_API_KEY must live only as a Supabase Edge Function secret and be read server-side with Deno.env.
- Browser code must not call the Nicky API directly.
- Do not create a Nicky account, Nicky API key, merchant onboarding flow, demo store, fake products, or hardcoded pricing.
- The consuming app owns products, orders, authorization, entitlement, and price validation.
- Before creating a real Nicky Payment Request in production, authenticate the user and validate order ownership, order status, amount, product, invoice reference, and payer details server-side.
- The client must not be trusted for amountExpectedNative, invoiceReference, description, payer identity, or fulfillment decisions.
- Add app authentication, rate limiting, and abuse controls before production.

Payment confirmation rules
- The success redirect is UX only and is never proof of payment.
- A webhook body is a signal only and is never proof of payment.
- An order becomes paid only after a server-side Nicky lookup returns Finished.
- Use nicky-sync-payment-status on the success page and rely on the server-side lookup result.
- Webhook processing must re-query Nicky by itemId before updating local status.
- Never unlock paid features on PaymentValidationRequired or local validation_required.
- Gate entitlement on current local status === "paid", not on paid_at.
- paid is not terminal; only Nicky Canceled is terminal.

Nicky status model
- Use exactly these local statuses:
  idle, creating_payment, redirecting_to_nicky, waiting_payment, webhook_received, syncing_status, paid, validation_required, canceled, expired_or_abandoned, failed.
- Map Nicky statuses:
  PaymentPending -> waiting_payment
  PaymentValidationRequired -> validation_required
  Finished -> paid
  Canceled -> canceled

Webhook rules
- The plugin only processes webhooks. It must not register, list, update, or delete webhooks.
- Do not create a nicky-register-webhooks Edge Function.
- Do not add local scripts that call Nicky webhook setup endpoints.
- Do not let users choose arbitrary callback URLs.
- The fixed callback URL is https://<project-ref>.functions.supabase.co/nicky-webhook.
- Configure the webhook once manually in Nicky after the Edge Functions are deployed.
- Required Nicky events: PaymentRequest_ReportAdded and PaymentRequest_StatusChanged.
- nicky-webhook must deploy with verify_jwt = false and validate source IP before reading/storing the body.

Nicky API contract
- Accepted assets load from GET /AcceptedAsset/get-for-user. This path intentionally has no /api/public prefix.
- Do not introduce NICKY_ASSETS_ENDPOINT.
- Payment creation calls POST /api/public/PaymentRequestPublicApi/create.
- The browser payload and the Nicky API payload are different contracts. A simple internal request like { selectedAssetId, name, email } is acceptable only between the app and its own Edge Function.
- Before calling Nicky, the Edge Function must transform that internal request into:
  {
    blockchainAssetId,
    amountExpectedNative,
    billDetails: { invoiceReference, description },
    requester: { email, name },
    sendNotification,
    successUrl?,
    cancelUrl?
  }
- Do not send a flat create payload with top-level description, invoiceReference, payerName, or payerEmail.
- Do not send acceptedAssetId to the public create endpoint. Use the selected accepted asset id as blockchainAssetId.
- The create response must include response.id and response.bill.shortId.
- The payment URL is https://pay.nicky.me/home?paymentId=<response.bill.shortId>.
- Do not probe alternate or legacy response fields. Missing identifiers are API-contract failures.

Supabase function auth
- nicky-create-payment: verify_jwt = true.
- nicky-list-assets: verify_jwt = true.
- nicky-sync-payment-status: verify_jwt = true.
- nicky-webhook: verify_jwt = false.
- nicky-reconcile-open-orders: verify_jwt = false, protected by x-nicky-reconciliation-secret, and must fail closed if NICKY_RECONCILIATION_SECRET is unset.

Before go-live
- Set Supabase secrets NICKY_API_KEY and NICKY_RECONCILIATION_SECRET.
- Apply the SQL migration.
- Deploy the five Edge Functions.
- Configure the Nicky webhook manually with both required events.
- Schedule nicky-reconcile-open-orders with x-nicky-reconciliation-secret.
- Run npm ci, npm run typecheck, npm test, and npm run typecheck:edge.
- Test asset loading, payment creation, redirect to Nicky, success-page sync, cancel flow, webhook processing, and scheduled reconciliation.
```
