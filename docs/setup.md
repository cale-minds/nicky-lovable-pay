# Setup Guide

This guide walks through installing the Nicky Payment Kit into an existing
Lovable (React + TypeScript + Supabase) app. It assumes you already have a
Supabase project and the Supabase CLI installed.

> Account/API-key setup is separate from the application runtime. The canonical
> order is: ask the exact YES/NO question; obtain or create and reuse the key;
> complete the new-account email/Terms gate; store and validate the key; install,
> migrate, and deploy the kit; register the webhook; then give the conditional
> wallet-configuration reminder. The deployed app must not contain account,
> API-key, webhook-management, or merchant-onboarding features.

---

## 1. Configure Or Create A Nicky Account

Start with this exact setup question:

```text
Do you already have a Nicky account and API key? Answer YES or NO.
```

If the answer is YES, ask for the actual API key and skip to the next section.
Prefer a secure secret input supplied by the setup platform. Do not echo the key
in an assistant response. Do not accept `agents/signup`, `/api/agents/signup`,
or a URL as an API key.

If the answer is NO, do not open or fill a `NICKY_API_KEY` secret field yet. The
Lovable setup prompt may guide signup through Nicky's public agent signup
endpoint:

```http
POST https://api-public.pay.nicky.me/api/agents/signup
```

Request body:

```json
{
  "email": "merchant@example.com",
  "password": "strong-password",
  "language": "en",
  "publicName": "My Lovable App"
}
```

The response includes `apiKey`. Capture and store that value directly as the
Supabase secret `NICKY_API_KEY`. Treat it like a password immediately: never
show it in browser UI, an assistant response, logs, or committed files. Do not
ask the user to retrieve or paste it after signup.

After signup, tell the user that the following two actions can be completed in
parallel:

1. Confirm the email address sent by Nicky.
2. Review and accept Nicky's [Privacy Policy](https://nicky.me/privacy-policy/)
   and [Terms of Service](https://nicky.me/terms-of-service/).

Wait for one explicit user declaration confirming both actions, for example:

```text
I CONFIRM that I verified my Nicky email and I AGREE to Nicky's Privacy Policy
and Terms of Service.
```

Only after that declaration, record the agreement by calling:

```http
POST https://api-public.pay.nicky.me/api/public/privacy-policy/agree
X-API-KEY: <NICKY_API_KEY>
```

If the agreement call reports that email confirmation is incomplete or has not
propagated, retain the account and API key, ask the user to finish confirmation,
and retry only the agreement step. Never run signup again for this condition.

## 2. Provide A Nicky API Key

Use either:

- an existing public API key from the Nicky dashboard; or
- the `apiKey` returned by the agent signup endpoint above.

This is the value sent to Nicky as the `x-api-key` header from server-side code
only. Treat it like a password: anyone with this key can create payment requests
on your account.

## 3. Store And Validate The API Key

**Do not** paste the key into frontend code, `.env` files that get bundled, or
git. Store it as a Supabase Edge Function secret:

```bash
supabase secrets set NICKY_API_KEY=your_key_here
```

After storage, validate the key from setup-time server code, never from React:

```http
GET https://api-public.pay.nicky.me/AcceptedAsset/get-for-user
X-API-KEY: <NICKY_API_KEY>
```

Interpret the result without conflating authentication and merchant setup:

- `2xx` containing a bare asset array or a supported array envelope, including
  an extracted `[]`: the key authenticated successfully.
- `2xx` with `[]`: validation succeeded, but accepted settlement assets,
  Merchant Configuration, Wallet Connections, and/or Payment Routes still need
  attention. Continue installation and webhook setup, but do not declare the
  merchant ready to accept payments.
- `401` or `403`: the key/account is not authorized. For a newly created account,
  re-check the combined email-confirmation and Terms declaration/agreement step.
  Do not register the webhook until this is resolved.
- `2xx` with no recognized asset array in either bare or supported-envelope form:
  treat it as an API-contract failure, not as proof that the key is invalid.
  Stop and investigate before webhook registration.

Optional overrides (defaults are sensible; only set if you need to change them):

```bash
supabase secrets set NICKY_API_BASE_URL=https://api-public.pay.nicky.me
supabase secrets set NICKY_PAY_BASE_URL=https://pay.nicky.me
supabase secrets set NICKY_WEBHOOK_ALLOWED_IP=20.76.240.81
```

The reconciliation secret is not optional when the scheduled function is used.
Set it to a long random value and do not reuse the Nicky key:

```bash
supabase secrets set NICKY_RECONCILIATION_SECRET=$(openssl rand -hex 32)
```

Accepted assets are read from the fixed endpoint
`GET /AcceptedAsset/get-for-user`; there is no configurable assets endpoint.

> **Do not change this path.** It is intentionally exactly
> `/AcceptedAsset/get-for-user` and does **not** include the `/api/public` prefix
> that the PaymentRequest endpoints use. Verify the exact path against the live
> Nicky API during E2E before production.

## 4. Copy The Kit Files Into Your Project

From this repository, copy:

- `supabase/migrations/001_nicky_payment_kit.sql` to your `supabase/migrations/`
- `supabase/functions/_shared/` and the five `nicky-*` function folders
  (`nicky-create-payment`, `nicky-list-assets`, `nicky-webhook`,
  `nicky-sync-payment-status`, `nicky-reconcile-open-orders`) to your
  `supabase/functions/`
- `src/nicky/` to your app's `src/nicky/` (or wherever your alias `@/nicky`
  points)
- Merge the `[functions.*]` blocks from `supabase/config.toml` into your own
  `supabase/config.toml` (especially `verify_jwt = false` for `nicky-webhook`
  and `nicky-reconcile-open-orders`).

## 5. Run The SQL Migration

```bash
supabase db push
```

Or paste `supabase/migrations/001_nicky_payment_kit.sql` into the Supabase SQL
editor and run it. This creates:

- `nicky_orders`
- `nicky_payment_requests`
- `nicky_webhook_events`
- `nicky_payment_status_checks`
- `nicky_assets_cache`

All tables have **Row Level Security enabled with no policies**; only the
service-role key used by the Edge Functions can access them. See
`docs/security.md`.

## 6. Deploy The Edge Functions

Four runtime functions plus the scheduled-reconciliation function:

```bash
supabase functions deploy nicky-create-payment
supabase functions deploy nicky-list-assets
supabase functions deploy nicky-sync-payment-status
supabase functions deploy nicky-webhook
supabase functions deploy nicky-reconcile-open-orders
```

Verify `nicky-webhook` and `nicky-reconcile-open-orders` deployed with
`verify_jwt = false` (Nicky and your scheduler carry no Supabase JWT). The
reconciliation function is protected by the `NICKY_RECONCILIATION_SECRET`
configured in step 3 instead.

> The plugin does **not** register, update, or delete webhooks at runtime, so
> there is no `nicky-register-webhooks` Edge Function and no
> `WEBHOOK_CALLBACK_URL` secret.

## 7. Configure The Webhook Once

The callback URL is only known **after** deployment and is fixed:

```text
https://<project-ref>.functions.supabase.co/nicky-webhook
```

After API-key validation and deployment, configure the webhook **once** in
Nicky. The default assisted path is a setup-time Nicky Public API/private MCP
call; manual dashboard setup is the fallback. First list existing webhooks:

```http
GET https://api-public.pay.nicky.me/api/public/WebHookApi/list
X-API-KEY: <NICKY_API_KEY>
```

Then create only the missing event+URL pairs with
`POST /api/public/WebHookApi/create`. Point both required events at the fixed
URL:

- `PaymentRequest_ReportAdded`
- `PaymentRequest_StatusChanged`

Webhook setup must be idempotent: list existing Nicky webhooks first and create
only the missing event+URL pairs. There is **no** repository runtime script and
**no** Edge Function that registers webhooks. Do not use any callback URL other
than the fixed one above. See
[`webhook-registration.md`](webhook-registration.md) for setup details and
[`lovable-install-prompt.md`](lovable-install-prompt.md) for the guided flow.
The deployed plugin itself never registers/lists/updates/deletes webhooks; it
only processes them.

Report success only when the list/create API results prove that both pairs
exist. If registration fails, retry only this step or offer the manual fallback.
Do not repeat signup, request the key again, reset secrets, or recreate the DB.

## 8. Give The Conditional Wallet Reminder

After both webhook event+URL pairs are confirmed, always tell the user:

> The Nicky integration and webhook are configured. If your Nicky account does
> not already have its accepted settlement assets, Wallet Connections, and
> Payment Routes configured, sign in to Nicky and complete them before accepting
> payments. The Lovable installer does not configure wallets or request wallet
> private keys, seed phrases, exchange API secrets, or other custody material.

An empty `GET /AcceptedAsset/get-for-user` array is a strong signal that merchant
configuration remains incomplete, but a non-empty list is not proof that every
desired payment route is ready. The user owns this configuration and confirms
it before go-live. See [`wallets.md`](wallets.md).

## 9. Wire Up The Frontend

Provide the public config to the React kit:

```ts
const config = {
  functionsBaseUrl: import.meta.env.VITE_SUPABASE_URL,
  supabaseAnonKey: import.meta.env.VITE_SUPABASE_ANON_KEY,
};
```

Set these in your Lovable/Vite environment:

```text
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<your anon key>
```

`functionsBaseUrl` can also point directly at
`https://<project-ref>.functions.supabase.co`, but in a Lovable app the standard
`VITE_SUPABASE_URL` is usually already available and the client derives the
functions endpoint automatically.

Then use `useNickyAssets`, `NickyAssetSelector`, `NickyPayButton`,
`useNickyPayment`, and `NickyPaymentStatus` as shown in the README.

## 10. Schedule Reconciliation

Schedule `nicky-reconcile-open-orders` to run every few minutes so missed/delayed
webhooks and abandoned redirects are still reconciled. Call it with the
`x-nicky-reconciliation-secret` header via Supabase cron / `pg_cron` + `pg_net`,
or an external scheduler. See [`operations.md`](operations.md) for exact
invocation and scheduling patterns.

## 11. Run CI Checks Before Launch

```bash
npm ci
npm run typecheck       # pure modules + frontend kit
npm test                # vitest unit tests
npm run typecheck:edge  # Deno check of Edge Function entrypoints (needs Deno)
```

CI runs the same on every push/PR (`.github/workflows/ci.yml`), and the Deno
edge-check job is **blocking**. Then work through
[`production-checklist.md`](production-checklist.md).

### Installing Deno For `typecheck:edge`

The Edge Functions use `Deno.serve` and remote (`esm.sh`) imports, so they are
type-checked with Deno, not `tsc`. Install the Deno CLI (v2.x):

```bash
# macOS / Linux (official installer) - then add ~/.deno/bin to your PATH
curl -fsSL https://deno.land/install.sh | sh

# macOS (Homebrew)
brew install deno

# Windows (PowerShell)
irm https://deno.land/install.ps1 | iex
# or: scoop install deno   /   choco install deno
```

Verify with `deno --version` (expect `deno 2.x`). The first
`npm run typecheck:edge` needs network access to fetch and cache the remote
imports. You do **not** need to install Deno for CI; the workflow installs it via
`denoland/setup-deno@v2`.

> On a Windows/VirtualBox shared folder, run the checks from a local path (not
> the shared mount) to avoid unreliable file I/O while Deno populates its cache.

## 12. Test End-To-End

1. Load your checkout; the asset selector should populate from Nicky.
2. Create a payment and confirm you're redirected to `pay.nicky.me`.
3. Complete (or cancel) a test payment.
4. On return, your success page should poll `nicky-sync-payment-status` and only
   show `paid` once Nicky reports `Finished`.
5. Check `nicky_webhook_events` and `nicky_payment_status_checks` in your DB for
   the audit trail.
6. Run the reconciliation job once with `{"dryRun": true}` to confirm it is wired
   and authenticated.

See [`troubleshooting.md`](troubleshooting.md) if anything misbehaves,
[`operations.md`](operations.md) for the day-2 runbook, and
[`production-checklist.md`](production-checklist.md) before launch.
