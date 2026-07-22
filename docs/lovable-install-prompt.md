# Lovable Install Prompt

Copy the prompt below into Lovable to add the Nicky payment kit to an
**existing** Lovable app. It tells Lovable exactly what to install and, just as
importantly, what **not** to do: no runtime account creation, no demo store, and
no exposed keys.

> Before running it: have your Supabase project connected. If you already have a
> Nicky account and API key, keep the key available. If you do not, the setup
> prompt below can guide signup through Nicky's public agent signup API.
> If installing from a public repository, tell Lovable to read the root
> `AGENTS.md` first, then `README.md`, `docs/security.md`, and
> `docs/production-checklist.md`, including `docs/wallets.md` for the merchant
> configuration handoff.
> Before the implementation prompt, paste `docs/lovable-project-knowledge.md`
> into Lovable Project Knowledge so these payment rules persist across turns.

---

## Copy-paste prompt

```text
Add the "Nicky Payment Kit" to this existing app to accept non-custodial crypto
payments via Nicky. This is an integration, NOT a new product or demo store.

If this kit is being referenced from a public repository, first read AGENTS.md,
README.md, docs/security.md, docs/lovable-install-prompt.md, and
docs/production-checklist.md. Treat AGENTS.md as the hard implementation
contract.

STRICT RULES - follow all of these:
- Do NOT add Nicky account creation, API-key generation, or merchant onboarding
  UI to the application runtime. Account/API-key setup may happen ONLY during
  this installation conversation.
- Start with an explicit binary question before opening any secret field:
  "Do you already have a Nicky account and API key? Answer YES or NO."
  Do not ask for `NICKY_API_KEY`, do not show a Supabase secret input, and do not
  ask the user to paste anything into `NICKY_API_KEY` until the user answers YES.
  If YES, ask for the actual API key through a secure setup secret input when
  available, store it only as Supabase secret NICKY_API_KEY, and never echo it
  in an assistant response. If NO, do not ask for an API key; guide signup using
  Nicky's agent signup endpoint:
  POST https://api-public.pay.nicky.me/api/agents/signup.
- Never treat the string "agents/signup", "/api/agents/signup", or the full
  signup URL as a Nicky API key or Supabase secret value. These are endpoint
  instructions for setup orchestration only.
- Do NOT put the Nicky API key anywhere in frontend code or in committed files.
  It must live ONLY as a Supabase secret named NICKY_API_KEY and be used ONLY
  inside Supabase Edge Functions or setup-time server/API calls.
- When agent signup returns apiKey, capture and store it directly. Do NOT ask
  the user to retrieve or paste it. After storage, never show the full key; only
  confirm that the secret exists.
- Do NOT build a demo storefront, sample products, or a cart.
- Do NOT hardcode a single currency (no USD-only logic). Available settlement
  assets must be loaded from Nicky at runtime via GET /AcceptedAsset/get-for-user.
- The webhook callback route is fixed and owned by the kit. Do not let the user
  choose arbitrary callback URLs.
- Do NOT register, list, update, or delete webhooks from browser code or deployed
  runtime code, and do NOT create a nicky-register-webhooks Edge Function. The
  plugin runtime only PROCESSES webhooks. Webhook setup is a one-time setup
  action done after deployment. During this installation conversation you may
  list/create required Nicky webhooks, but the operation must be idempotent:
  list existing webhooks first and create only missing event+URL pairs.
- Do NOT simulate setup operations. Report signup, agreement, validation,
  deployment, or webhook success only when the API/tool result or the user's
  explicit declaration proves it.
- After successful webhook setup, always give the conditional Wallet
  Connections / Payment Routes reminder from docs/wallets.md. Never ask for
  wallet private keys, seed phrases, exchange API secrets, or custody material.

NICKY ACCOUNT / API KEY SETUP:
1. Ask this exact first question and wait for the answer before requesting any
   secret: "Do you already have a Nicky account and API key? Answer YES or NO."
2. If the user answers yes:
   - Ask for the API key through a secure setup secret input when available.
   - Store it as Supabase secret NICKY_API_KEY.
   - Never print, log, echo, or repeat the key in an assistant response.
3. If the user answers no:
   - Do NOT open or fill a NICKY_API_KEY secret field yet.
   - Ask for email, password, optional language, and optional publicName.
   - Call POST https://api-public.pay.nicky.me/api/agents/signup with:
     {
       email,
       password,
       language?,
       publicName?
     }
   - The response contains apiKey. Capture it and store it directly as Supabase
     secret NICKY_API_KEY. Treat it like a password and never show it in UI,
     assistant responses, frontend code, committed files, logs, or function
     responses. Do NOT ask the user to paste it.
   - Tell the user that email confirmation and reviewing/accepting Nicky's
     Privacy Policy (https://nicky.me/privacy-policy/) and Terms of Service
     (https://nicky.me/terms-of-service/) can be completed in parallel.
   - Wait for one explicit declaration confirming both, for example:
     "I CONFIRM that I verified my Nicky email and I AGREE to Nicky's Privacy
     Policy and Terms of Service."
   - Only after that combined declaration, call
     POST https://api-public.pay.nicky.me/api/public/privacy-policy/agree with
     the X-API-KEY header.
   - If that call reports incomplete email confirmation, keep the account and
     key and retry only the agreement step after confirmation propagates. Never
     repeat signup for this condition.
4. If the user types "agents/signup", "/api/agents/signup", "signup", or any URL
   into an API-key field, stop and correct course: explain that this is not an
   API key, clear that value, ask the YES/NO account question again, and follow
   the branch above.
5. Converge both branches and validate NICKY_API_KEY server-side with
   GET https://api-public.pay.nicky.me/AcceptedAsset/get-for-user.
   - 2xx containing a bare asset array or supported array envelope, including an
     extracted empty array: authentication succeeded.
   - 2xx with an empty array: do not call the key invalid. Continue installation
     and webhook setup, but record that accepted assets, Merchant Configuration,
     Wallet Connections, and/or Payment Routes require attention before go-live.
   - 401/403: authentication/account activation failed. Stop before webhook
     registration and report the status without exposing the key.
   - 2xx with no recognized asset array in bare or supported-envelope form:
     API-contract failure. Do not call the key invalid; stop and investigate
     before registering the webhook.

WHAT TO INSTALL:
1. Supabase migration: create tables nicky_orders, nicky_payment_requests,
   nicky_webhook_events, nicky_payment_status_checks, nicky_assets_cache, with
   RLS enabled and no permissive policies. Use the provided
   001_nicky_payment_kit.sql.
2. Supabase Edge Functions (Deno) - create EXACTLY these (four runtime + one
   scheduled), no webhook-registration function and no account-signup function:
   - nicky-create-payment: validates input, reads NICKY_API_KEY from env. Use the
     race-safe DB path (nicky_create_or_claim_order RPC) so concurrent calls with
     the same idempotency key do NOT create duplicate Nicky requests: return the
     existing payment URL if present; if another caller owns creation, return 409
     "retry shortly"; otherwise create. Calls
     POST /api/public/PaymentRequestPublicApi/create on
     https://api-public.pay.nicky.me. Read EXACTLY response.id (Payment Request
     UUID) and response.bill.shortId; do NOT probe alternate field names. Build
     the payment URL as https://pay.nicky.me/home?paymentId=<response.bill.shortId>.
     If response.id or response.bill.shortId is missing, mark the order failed,
     store the raw response, and return 502. Never return the API key.
     IMPORTANT: the Nicky API create request body MUST be nested as:
     {
       blockchainAssetId,
       amountExpectedNative,
       billDetails: { invoiceReference, description },
       requester: { email, name },
       sendNotification,
       successUrl?,
       cancelUrl?
     }
     Do NOT send a flat payload with top-level description, invoiceReference,
     payerName, or payerEmail. Do NOT send acceptedAssetId to the public create
     endpoint; use the selected accepted asset id as blockchainAssetId.
   - nicky-list-assets: reads accepted assets from GET /AcceptedAsset/get-for-user,
     normalizes them (id, assetName, isFiat, decimalPrecisionUI, assetChain,
     assetTicker), and caches them. Return a clear error on empty/invalid
     responses. Never hardcode USD.
   - nicky-webhook: POST only; validate source IP 20.76.240.81 using ONLY the
     first x-forwarded-for entry; store the raw event idempotently; then RE-QUERY
     Nicky by itemId and only mark the order paid if Nicky returns Finished.
     Ack already-processed duplicates with 200; reprocess a duplicate whose prior
     attempt failed. Deploy with verify_jwt = false.
   - nicky-sync-payment-status: accepts orderId / nickyPaymentRequestId /
     nickyShortId, re-queries Nicky, updates local status. Safe for the success
     page and for scheduled reconciliation. paid_at is set once and never
     overwritten.
   - nicky-reconcile-open-orders: scheduled fallback that reconciles open orders
     (creating_payment / waiting_payment / webhook_received / syncing_status /
     validation_required) that have a Nicky id. Protect it with the
     x-nicky-reconciliation-secret header (NICKY_RECONCILIATION_SECRET) and
     verify_jwt = false; fail closed if the secret is unset. Never mark paid
     except via a server-side Finished lookup. Do NOT register/delete webhooks
     from this runtime function.
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
https://pay.nicky.me), NICKY_WEBHOOK_ALLOWED_IP (default 20.76.240.81),
NICKY_RECONCILIATION_SECRET (required for the scheduled reconciliation function),
NICKY_CREATE_RATE_LIMIT_PER_HOUR (optional, default 0 = disabled).
There is NO WEBHOOK_CALLBACK_URL and NO NICKY_ASSETS_ENDPOINT variable.
Frontend gets only the public Supabase functions URL and anon key.

PRODUCTION RULES (hard gates - do not go live until satisfied):
- nicky-create-payment creates a REAL Nicky Payment Request (not a quote/dry-run),
  returns the real payment URL, and writes local linkage. The consuming app MUST
  authenticate/authorize users and validate amount/product/invoiceReference/payer
  server-side BEFORE calling it. If exposed to anonymous users directly, anyone
  can create real Payment Requests on the merchant's Nicky account. Do NOT add a
  demo product catalog to the kit (the kit doesn't know your product/order model).
- nicky-sync-payment-status re-queries Nicky and updates local status; for browser
  flows prefer the high-entropy orderId (UUID). Treat lookups by nickyShortId /
  nickyPaymentRequestId as server/admin flows; short ids are guessable. Restrict
  to orderId for untrusted clients, or add rate limiting/auth.
- Accepted assets load from GET /AcceptedAsset/get-for-user - intentionally NO
  /api/public prefix. Do NOT change this path.
- Add rate limiting / abuse control (app auth + WAF/Cloudflare; optionally the
  built-in soft cap). Additionally allowlist the nicky-webhook endpoint to Nicky's
  source IP (20.76.240.81) at the edge where possible.
- `paid` is NOT terminal (only `Canceled` is): a paid order can return to
  waiting_payment if Nicky reports PaymentPending. Gate entitlement on the current
  local status === "paid", not on paid_at.

WEBHOOK SETUP RULES (setup-only, no runtime function):
- Do NOT create a nicky-register-webhooks Edge Function.
- Do NOT deploy webhook-registration code as an Edge Function.
- Do NOT add any runtime/local script to the app that calls Nicky's webhook setup
  endpoints.
- Do NOT create, list, update, or delete webhooks from browser code or deployed
  application runtime.
- Do NOT let users choose arbitrary callback URLs anywhere.
- Webhook setup is a ONE-TIME SETUP step after NICKY_API_KEY validation and Edge
  Function deployment. Nicky's Public API/private MCP is the assisted default;
  manual dashboard configuration is the fallback. Use the fixed callback URL:
  https://<project-ref>.functions.supabase.co/nicky-webhook
- Before creating webhooks, call
  GET https://api-public.pay.nicky.me/api/public/WebHookApi/list with the
  X-API-KEY header. For each required event,
  create the webhook only if no existing webhook has the same webHookType and
  callback URL.
- Required events:
  - PaymentRequest_ReportAdded
  - PaymentRequest_StatusChanged
- REST shape for creation:
  POST https://api-public.pay.nicky.me/api/public/WebHookApi/create
  X-API-KEY: <NICKY_API_KEY>
  {
    "webHookType": "PaymentRequest_ReportAdded",
    "url": "https://<project-ref>.functions.supabase.co/nicky-webhook"
  }
  Repeat for PaymentRequest_StatusChanged if missing.
- Report webhook success only if the list/create results prove that both pairs
  exist. If the API call fails, retry only the webhook step or offer the manual
  fallback. Do not repeat signup, ask for the key again, reset secrets, or
  recreate database objects.

WALLET REMINDER (mandatory after webhook success):
- Always tell the user that, if accepted settlement assets, Wallet Connections,
  and Payment Routes are not already configured in Nicky, they must sign in to
  Nicky and complete that configuration before accepting payments. Link to
  docs/wallets.md.
- An empty accepted-assets array means the key authenticated but merchant setup
  is incomplete. A non-empty array does not prove every desired route is ready.
- Never ask for or handle wallet private keys, seed phrases, exchange API
  secrets, or custody material. Never claim wallets are configured; the user
  performs and confirms this in Nicky.

AFTER INSTALLING, report to me (the user):
1) whether NICKY_API_KEY came from an existing account or agent signup, without
   displaying any part of the value,
2) for agent signup, that you waited for my combined declaration of email
   confirmation plus Terms/Privacy acceptance and successfully recorded it,
3) whether validation authenticated the key and whether accepted assets were
   empty or non-empty,
4) that the migration and five Edge Function deployments completed,
5) the exact fixed webhook callback and which required pairs were already
   present or created; confirm no duplicates were created,
6) the conditional Nicky Wallet Connections / Payment Routes reminder,
7) the remaining reconciliation, CI, frontend, and E2E tasks, without claiming
   any task you did not actually execute.

Confirm payment ONLY via a server-side Nicky lookup. Treat the success redirect
and the webhook as signals, never as proof of payment.
```

---

## After Lovable finishes

Follow the post-install steps in [`setup.md`](setup.md), then work through
[`production-checklist.md`](production-checklist.md). In short: configure or
create the Nicky account during setup; for signup, finish the parallel
email-confirmation and Terms/Privacy declaration gate; store and validate the
key; run the migration; deploy the functions; configure the webhook once by
assisted setup or manual fallback (no runtime function — see
[`webhook-registration.md`](webhook-registration.md)); give the conditional
wallet reminder from [`wallets.md`](wallets.md); schedule reconciliation (see
[`operations.md`](operations.md)); and wire the checkout UI.
