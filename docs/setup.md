# Setup Guide

This guide walks through installing the Nicky Payment Kit into an existing
Lovable (React + TypeScript + Supabase) app. It assumes you already have a
Supabase project and the Supabase CLI installed.

> This kit will **never** create a Nicky account or API key for you. You do
> steps 1 and 2 yourself, manually.

---

## 1. Create a Nicky account (manual)

1. Go to **https://nicky.me** and sign up.
2. Complete the onboarding / verification steps Nicky requires.
3. Confirm you can log into the Nicky dashboard.

## 2. Generate a Nicky API key (manual)

1. In the Nicky dashboard, open the API keys / developer section.
2. Create a **public API key**. This is the value you'll send as the
   `x-api-key` header.
3. Copy it once and store it somewhere safe. Treat it like a password — anyone
   with this key can create payment requests on your account.

## 3. Store the API key as a Supabase secret

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
`GET /AcceptedAsset/get-for-user` — there is no configurable assets endpoint.

## 4. Copy the kit files into your project

From this repository, copy:

- `supabase/migrations/001_nicky_payment_kit.sql` → your `supabase/migrations/`
- `supabase/functions/_shared/` and the four `nicky-*` function folders
  (`nicky-create-payment`, `nicky-list-assets`, `nicky-webhook`,
  `nicky-sync-payment-status`) → your `supabase/functions/`
- `src/nicky/` → your app's `src/nicky/` (or wherever your alias `@/nicky`
  points)
- Merge the `[functions.*]` blocks from `supabase/config.toml` into your own
  `supabase/config.toml` (especially `verify_jwt = false` for `nicky-webhook`).

## 5. Run the SQL migration

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

All tables have **Row Level Security enabled with no policies** — only the
service-role key (used by the Edge Functions) can access them. See
`docs/security.md`.

## 6. Deploy the Edge Functions

Four runtime functions plus the optional scheduled-reconciliation function:

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
instead (set it as a secret):

```bash
supabase secrets set NICKY_RECONCILIATION_SECRET=$(openssl rand -hex 32)
```

> The plugin does **not** register, update, or delete webhooks at runtime, so
> there is no `nicky-register-webhooks` function and no `WEBHOOK_CALLBACK_URL`
> secret.

## 7. Configure the webhook once (manual — no script)

The callback URL is only known **after** deployment and is fixed:

```
https://<project-ref>.functions.supabase.co/nicky-webhook
```

Configure the webhook **once** in Nicky (via the Lovable setup prompt or manually
in the Nicky dashboard), pointing both required events at that URL:

- `PaymentRequest_ReportAdded`
- `PaymentRequest_StatusChanged`

There is **no** repository script and **no** runtime function that registers
webhooks. Do not use any callback URL other than the fixed one above. See
[`webhook-registration.md`](webhook-registration.md) for the manual setup details
and [`lovable-install-prompt.md`](lovable-install-prompt.md) for the guided flow.
The plugin itself never registers/lists/updates/deletes webhooks — it only
processes them.

## 8. Wire up the frontend

Provide the public config to the React kit:

```ts
const config = {
  functionsBaseUrl: import.meta.env.VITE_SUPABASE_FUNCTIONS_URL,
  supabaseAnonKey: import.meta.env.VITE_SUPABASE_ANON_KEY,
};
```

Set these in your Lovable/Vite environment:

```
VITE_SUPABASE_FUNCTIONS_URL=https://<project-ref>.functions.supabase.co
VITE_SUPABASE_ANON_KEY=<your anon key>
```

Then use `useNickyAssets`, `NickyAssetSelector`, `NickyPayButton`,
`useNickyPayment`, and `NickyPaymentStatus` as shown in the README.

## 9. Schedule reconciliation (recommended)

Schedule `nicky-reconcile-open-orders` to run every few minutes so missed/delayed
webhooks and abandoned redirects are still reconciled. Call it with the
`x-nicky-reconciliation-secret` header (via Supabase cron / `pg_cron` + `pg_net`,
or an external scheduler). See [`operations.md`](operations.md) for the exact
invocation and scheduling patterns.

## 10. Run CI checks before deploying

```bash
npm ci
npm run typecheck       # pure modules + frontend kit
npm test                # vitest unit tests
npm run typecheck:edge  # Deno check of Edge Function entrypoints (needs Deno)
```

CI runs the same on every push/PR (`.github/workflows/ci.yml`). Then work through
[`production-checklist.md`](production-checklist.md).

## 11. Test end-to-end

1. Load your checkout — the asset selector should populate from Nicky.
2. Create a payment and confirm you're redirected to `pay.nicky.me`.
3. Complete (or cancel) a test payment.
4. On return, your success page should poll `nicky-sync-payment-status` and only
   show "paid" once Nicky reports `Finished`.
5. Check `nicky_webhook_events` and `nicky_payment_status_checks` in your DB for
   the audit trail.
6. Run the reconciliation job once with `{"dryRun": true}` to confirm it is wired
   and authenticated (see [`operations.md`](operations.md)).

See [`troubleshooting.md`](troubleshooting.md) if anything misbehaves,
[`operations.md`](operations.md) for the day-2 runbook, and
[`production-checklist.md`](production-checklist.md) before launch.
