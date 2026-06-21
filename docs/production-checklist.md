# Production Checklist

Work through this before taking the Nicky payment kit live. It complements
[`setup.md`](setup.md), [`security.md`](security.md), and [`operations.md`](operations.md).

## Accounts & secrets

- [ ] Nicky account created **manually** by the merchant (the kit never creates one).
- [ ] Nicky API key generated **manually** in the Nicky dashboard.
- [ ] `NICKY_API_KEY` stored as a **Supabase secret** (`supabase secrets set NICKY_API_KEY=...`).
- [ ] API key is **never** present in frontend code, bundles, or git history.
- [ ] `NICKY_WEBHOOK_ALLOWED_IP` configured (default `20.76.240.81`).
- [ ] `NICKY_RECONCILIATION_SECRET` set to a long random value (for the scheduled job).
- [ ] (Optional) `NICKY_CREATE_RATE_LIMIT_PER_HOUR` set if you want the soft per-payer cap.

## Database

- [ ] SQL migration `supabase/migrations/001_nicky_payment_kit.sql` applied.
- [ ] Tables exist: `nicky_orders`, `nicky_payment_requests`, `nicky_webhook_events`,
      `nicky_payment_status_checks`, `nicky_assets_cache`.
- [ ] RPC `nicky_create_or_claim_order` exists (race-safe order creation).
- [ ] RLS is enabled on all tables (no permissive policies unless you added scoped ones).

## Edge Functions deployed

- [ ] `nicky-create-payment` (verify_jwt = true)
- [ ] `nicky-list-assets` (verify_jwt = true)
- [ ] `nicky-sync-payment-status` (verify_jwt = true)
- [ ] `nicky-webhook` (verify_jwt = **false**)
- [ ] `nicky-reconcile-open-orders` (verify_jwt = **false**, protected by the secret header)

## Webhook (configured once, outside the runtime)

- [ ] Webhook registered **once** in Nicky (via `npm run nicky:register-webhooks`
      or the Lovable setup flow). The plugin does **not** register webhooks at runtime.
- [ ] Callback URL: `https://<project-ref>.functions.supabase.co/nicky-webhook`
- [ ] Registered for both events:
  - [ ] `PaymentRequest_ReportAdded`
  - [ ] `PaymentRequest_StatusChanged`

## Scheduled reconciliation

- [ ] `nicky-reconcile-open-orders` deployed.
- [ ] Scheduler/cron configured to call it periodically with the
      `x-nicky-reconciliation-secret` header (see [`operations.md`](operations.md)
      and [`setup.md`](setup.md)).
- [ ] Verified it returns a summary and does not mark anything paid except on `Finished`.

## CI & validation

- [ ] CI enabled (`.github/workflows/ci.yml`).
- [ ] `npm ci` succeeds.
- [ ] `npm run typecheck` passes.
- [ ] `npm test` passes.
- [ ] `npm run typecheck:edge` (Deno) passes, **or** the limitation is documented
      (Deno may need network to fetch remote imports).

## End-to-end verification

- [ ] Test payment completed end-to-end against Nicky.
- [ ] Success redirect tested (UX only — not treated as proof of payment).
- [ ] Cancel redirect tested.
- [ ] A webhook test event was received and stored in `nicky_webhook_events`.
- [ ] Manual `nicky-sync-payment-status` tested.
- [ ] Scheduled reconciliation job tested (e.g. with `dryRun: true` first).
- [ ] `PaymentValidationRequired` path tested, **or** the operational procedure is
      documented — note that paid features must stay **locked** in this state.
- [ ] Confirmed an order only becomes `paid` after a server-side `Finished` lookup.

## Abuse / correctness controls (consuming-app responsibility)

- [ ] **Server-side product/amount validation** implemented by the consuming app
      (do not trust client-supplied `amountExpectedNative` / `invoiceReference`).
      See [`security.md`](security.md).
- [ ] Rate limiting / abuse control in place (WAF/Cloudflare, app auth, and/or the
      optional `NICKY_CREATE_RATE_LIMIT_PER_HOUR`).
- [ ] Logs / audit tables reviewed (`nicky_webhook_events`,
      `nicky_payment_status_checks`).

---

See [`operations.md`](operations.md) for the day-2 runbook.
