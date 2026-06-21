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
# Only if your account's assets endpoint differs from the default:
# supabase secrets set NICKY_ASSETS_ENDPOINT=/api/public/PaymentRequestPublicApi/get-supported-assets
```

## 4. Copy the kit files into your project

From this repository, copy:

- `supabase/migrations/001_nicky_payment_kit.sql` → your `supabase/migrations/`
- `supabase/functions/_shared/` and the five `nicky-*` function folders →
  your `supabase/functions/`
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

```bash
supabase functions deploy nicky-create-payment
supabase functions deploy nicky-list-assets
supabase functions deploy nicky-sync-payment-status
supabase functions deploy nicky-webhook
supabase functions deploy nicky-register-webhooks
```

Verify `nicky-webhook` deployed with `verify_jwt = false` (otherwise Nicky's
calls will be rejected with 401, because they carry no Supabase JWT).

## 7. Register the webhooks

The callback URL is only known **after** deployment:

```
https://<project-ref>.functions.supabase.co/nicky-webhook
```

Set it and run the registration function (idempotent — it lists existing
webhooks first):

```bash
supabase secrets set WEBHOOK_CALLBACK_URL=https://<project-ref>.functions.supabase.co/nicky-webhook
supabase functions deploy nicky-register-webhooks

curl -X POST https://<project-ref>.functions.supabase.co/nicky-register-webhooks
```

This registers both `PaymentRequest_ReportAdded` and
`PaymentRequest_StatusChanged`. See `docs/webhooks.md` for details.

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

## 9. Test end-to-end

1. Load your checkout — the asset selector should populate from Nicky.
2. Create a payment and confirm you're redirected to `pay.nicky.me`.
3. Complete (or cancel) a test payment.
4. On return, your success page should poll `nicky-sync-payment-status` and only
   show "paid" once Nicky reports `Finished`.
5. Check `nicky_webhook_events` and `nicky_payment_status_checks` in your DB for
   the audit trail.

See `docs/troubleshooting.md` if anything misbehaves.
