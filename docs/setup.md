# Setup Guide

This guide walks through installing the Nicky Payment Kit into an existing
Lovable (React + TypeScript + Supabase) app. It assumes you already have a
Supabase project and the Supabase CLI installed.

> Account/API-key setup is separate from the application runtime. During
> installation you can either provide an existing Nicky API key or use Nicky's
> agent signup API through the Lovable setup prompt. The deployed app must not
> include a Nicky account creator or API-key generator.

---

## 1. Configure Or Create A Nicky Account

If you already have a Nicky account and API key, use that key and skip to the
next section.

If you do not have an account, the Lovable setup prompt may guide signup through
Nicky's public agent signup endpoint:

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

The response includes `apiKey`. Treat that value like a password immediately:
store it as a Supabase secret, never show it in browser UI, and never commit or
log it.

After signup:

1. Confirm the email address sent by Nicky.
2. Explicitly agree to Nicky's Privacy Policy and Terms of Service.
3. Record the agreement by calling:

```http
POST https://api-public.pay.nicky.me/api/public/privacy-policy/agree
X-API-KEY: <NICKY_API_KEY>
```

## 2. Provide A Nicky API Key

Use either:

- an existing public API key from the Nicky dashboard; or
- the `apiKey` returned by the agent signup endpoint above.

This is the value sent to Nicky as the `x-api-key` header from server-side code
only. Treat it like a password: anyone with this key can create payment requests
on your account.

## 3. Store The API Key As A Supabase Secret

**Do not** paste the key into frontend code, `.env` files that get bundled, or
git. Store it as a Supabase Edge Function secret:

```bash
supabase secrets set NICKY_API_KEY=your_key_here
```

Optional overrides (defaults are sensible; only set if you need to change them):

```bash
supabase secrets set NICKY_API_BASE_URL=https://api-public.pay.nicky.me
supabase secrets set NICKY_PAY_BASE_URL=https://pay.nicky.me
supabase secrets set NICKY_WEBHOOK_ALLOWED_IP=20.76.240.81
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
reconciliation function is protected by the `NICKY_RECONCILIATION_SECRET` header
instead:

```bash
supabase secrets set NICKY_RECONCILIATION_SECRET=$(openssl rand -hex 32)
```

> The plugin does **not** register, update, or delete webhooks at runtime, so
> there is no `nicky-register-webhooks` Edge Function and no
> `WEBHOOK_CALLBACK_URL` secret.

## 7. Configure The Webhook Once

The callback URL is only known **after** deployment and is fixed:

```text
https://<project-ref>.functions.supabase.co/nicky-webhook
```

Configure the webhook **once** in Nicky, via the Lovable setup prompt, a
setup-time Nicky Public API/private MCP call, or manual dashboard fallback. Point
both required events at that URL:

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

## 8. Wire Up The Frontend

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

## 9. Schedule Reconciliation

Schedule `nicky-reconcile-open-orders` to run every few minutes so missed/delayed
webhooks and abandoned redirects are still reconciled. Call it with the
`x-nicky-reconciliation-secret` header via Supabase cron / `pg_cron` + `pg_net`,
or an external scheduler. See [`operations.md`](operations.md) for exact
invocation and scheduling patterns.

## 10. Run CI Checks Before Deploying

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

## 11. Test End-To-End

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
