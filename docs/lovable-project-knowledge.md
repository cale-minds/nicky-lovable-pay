# Lovable Project Knowledge - Nicky Payment Kit

Use this text in Lovable Project Knowledge before asking Lovable to implement the
Nicky payment integration.

```text
Project payment strategy
- This project must use Nicky as a custom non-custodial payment integration.
- Do not enable Lovable built-in Payments for this integration. Nicky is not Stripe or Paddle.
- Nicky is a custom payment provider implemented through Supabase Edge Functions, PostgreSQL tables, and React components.
- The public Nicky kit repository is: <PASTE_PUBLIC_REPOSITORY_URL_HERE>.
- Before changing payment code, read the repository root AGENTS.md first, then README.md, docs/security.md, docs/lovable-install-prompt.md, docs/wallets.md, and docs/production-checklist.md.

Setup-time account strategy
- At installation time, the first Nicky account question must be explicit and binary: "Do you already have a Nicky account and API key? Answer YES or NO."
- Do not ask for NICKY_API_KEY, show a Supabase secret input, or ask the user to paste a secret until the user answers YES.
- If the user answers YES, collect the actual API key through a secure setup secret input when available, store it only as Supabase secret NICKY_API_KEY, never echo it in an assistant response, and validate it server-side.
- If the user answers NO, do not ask for an API key. Follow the agent signup flow instead.
- If the user does not have an account, setup may call POST https://api-public.pay.nicky.me/api/agents/signup with email, password, optional language, and optional publicName.
- The signup response contains apiKey. Capture and store it directly as NICKY_API_KEY; never ask the user to retrieve or paste it. Never show it in browser UI, assistant responses, frontend code, committed files, logs, or function responses.
- After signup, tell the user to complete email confirmation and review/acceptance of Nicky's Privacy Policy (https://nicky.me/privacy-policy/) and Terms of Service (https://nicky.me/terms-of-service/) in parallel.
- Wait for one explicit user declaration confirming both actions. Only after that combined declaration, call POST https://api-public.pay.nicky.me/api/public/privacy-policy/agree with the X-API-KEY header.
- If the agreement call reports that email confirmation is incomplete, retain the account and key and retry only the agreement step after confirmation propagates. Do not repeat signup.
- Converge both branches and validate NICKY_API_KEY with GET /AcceptedAsset/get-for-user from setup-time server code. A 2xx response containing a bare asset array or supported array envelope authenticates the key, including when the extracted array is empty. An empty array means merchant assets, Wallet Connections, and/or Payment Routes are incomplete; it does not mean the key is invalid. A 401/403 means authorization/account activation failed. A 2xx shape with no recognized asset array is an API-contract failure, not proof of an invalid key.
- Never treat "agents/signup", "/api/agents/signup", or the full signup URL as an API key or Supabase secret value. These strings are setup instructions only. If the user enters one of them into a secret field, clear it and restart with the YES/NO account question.
- Account creation and API-key setup are setup-only orchestration. Do not add account creation, API-key generation, or merchant onboarding UI to the deployed application runtime.
- Do not claim signup, agreement, validation, deployment, webhook registration, or wallet configuration succeeded without the relevant API/tool result or explicit user declaration.

Nicky integration summary
- The frontend uses the React kit from src/nicky/: NickyAssetSelector, NickyPayButton, NickyPaymentStatus, useNickyAssets, and useNickyPayment.
- The backend uses Supabase Edge Functions:
  - nicky-create-payment
  - nicky-list-assets
  - nicky-sync-payment-status
  - nicky-webhook
  - nicky-reconcile-open-orders
- Do not add nicky-register-webhooks, account-signup, or merchant-onboarding Edge Functions.
- The database migration is supabase/migrations/001_nicky_payment_kit.sql.
- The migration creates nicky_orders, nicky_payment_requests, nicky_webhook_events, nicky_payment_status_checks, nicky_assets_cache, and the nicky_create_or_claim_order RPC.
- Keep RLS enabled on all Nicky tables. Do not add broad permissive policies.

Security rules
- Never expose NICKY_API_KEY in frontend code, Vite env vars, committed files, logs, UI, network responses, or browser code.
- NICKY_API_KEY must live only as a Supabase Edge Function secret and be read server-side with Deno.env.
- Browser code must not call the Nicky API directly.
- Do not add a runtime Nicky account creator, API-key generator, merchant onboarding flow, demo store, fake products, or hardcoded pricing.
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
- The plugin runtime only processes webhooks. It must not register, list, update, or delete webhooks from browser code or deployed runtime code.
- Do not create a nicky-register-webhooks Edge Function.
- Do not add local runtime scripts that call Nicky webhook setup endpoints.
- Do not let users choose arbitrary callback URLs.
- The fixed callback URL is https://<project-ref>.functions.supabase.co/nicky-webhook.
- Configure the webhook once after NICKY_API_KEY is validated and the Edge Functions are deployed. Nicky's Public API/private MCP is the assisted default; manual dashboard configuration is the fallback.
- Required Nicky events: PaymentRequest_ReportAdded and PaymentRequest_StatusChanged.
- Webhook setup must be idempotent: call GET /api/public/WebHookApi/list first, then create only missing event+URL pairs with POST /api/public/WebHookApi/create.
- If webhook setup fails, retry only the webhook step or offer the manual fallback. Do not repeat signup, request the key again, reset secrets, or recreate database objects.
- nicky-webhook must deploy with verify_jwt = false and validate source IP before reading/storing the body.

Wallet handoff
- After successful webhook setup, always tell the user that, if accepted settlement assets, Wallet Connections, and Payment Routes are not already configured in Nicky, they must sign in to Nicky and complete them before accepting payments. See docs/wallets.md.
- An empty accepted-assets array is an incomplete merchant-configuration signal, not an invalid-key signal. A non-empty array does not prove every desired payment route is ready.
- Never ask for wallet private keys, seed phrases, exchange API secrets, or custody material. The user performs and confirms wallet configuration inside Nicky.

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
- Nicky account/API key has been provided or created during setup and NICKY_API_KEY is stored as a Supabase secret.
- For agent signup, the user explicitly declared both email confirmation and Terms/Privacy acceptance, and the agreement API call succeeded.
- NICKY_API_KEY validation authenticated the key; empty accepted assets were handled as incomplete merchant configuration rather than an invalid key.
- NICKY_RECONCILIATION_SECRET is set.
- Apply the SQL migration.
- Deploy the five Edge Functions.
- Configure the Nicky webhook once with both required events, using setup automation or manual fallback.
- The user has confirmed the required Nicky Merchant Configuration, Wallet Connections, and Payment Routes for the assets the app will accept.
- Schedule nicky-reconcile-open-orders with x-nicky-reconciliation-secret.
- Run npm ci, npm run typecheck, npm test, and npm run typecheck:edge.
- Test asset loading, payment creation, redirect to Nicky, success-page sync, cancel flow, webhook processing, and scheduled reconciliation.
```
