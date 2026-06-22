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

## Webhook (configured once, manually — no script)

- [ ] Webhook configured **once** in Nicky (via the Lovable setup prompt or
      manually in the Nicky dashboard). The plugin does **not** register webhooks
      at runtime and ships **no** local registration script.
- [ ] Callback URL is exactly `https://<project-ref>.functions.supabase.co/nicky-webhook`
      (no arbitrary URL).
- [ ] Configured for both events:
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
- [ ] `npm run typecheck:edge` (Deno) passes. This CI job is **blocking** (not
      advisory). It needs the Deno CLI and network access to fetch the Edge
      Functions' remote (`esm.sh`) imports; on a transient registry outage, re-run
      the job rather than disabling it. To run it locally, install Deno v2.x
      (`curl -fsSL https://deno.land/install.sh | sh`, `brew install deno`, or on
      Windows `irm https://deno.land/install.ps1 | iex`) — see
      [`setup.md`](setup.md#installing-deno-for-typecheckedge). CI installs Deno
      automatically via `denoland/setup-deno`.

### GitHub branch protection (hard gate — CI alone is not enough)

A failing CI job does **not** block a merge unless branch protection requires it.
On `main`:

- [ ] Branch protection enabled on `main`.
- [ ] Require a pull request before merging.
- [ ] Require status checks to pass before merging, including **both**:
  - [ ] the Node job — `Typecheck & unit tests (Node)` (typecheck + unit tests);
  - [ ] the Deno Edge Function job — `Deno check (Edge Functions)`.
      (If the job names drift, the required checks must still cover both the Node
      typecheck/tests and the Deno Edge Function typecheck.)
- [ ] Do not allow normal contributors to bypass required checks.
- [ ] Block force-pushes and branch deletion on `main`.

## End-to-end verification

- [ ] Test payment completed end-to-end against Nicky.
- [ ] Success redirect tested (UX only — not treated as proof of payment).
- [ ] Cancel redirect tested.
- [ ] A webhook test event (from the allowed IP) was received and stored in
      `nicky_webhook_events`. (Unauthorized-IP requests are rejected before any
      write and appear only in function logs — that is expected.)
- [ ] Manual `nicky-sync-payment-status` tested.
- [ ] Scheduled reconciliation job tested (e.g. with `dryRun: true` first).
- [ ] `PaymentValidationRequired` path tested, **or** the operational procedure is
      documented — note that paid features must stay **locked** in this state.
- [ ] Confirmed an order only becomes `paid` after a server-side `Finished` lookup.
- [ ] Accepted-assets endpoint path `GET /AcceptedAsset/get-for-user` verified
      against the live Nicky API (it intentionally has **no** `/api/public`
      prefix — do not change it).

## Status terminality (business rule)

- [ ] Confirmed your fulfillment/entitlement gates on **current local
      `status === "paid"`**, NOT merely on `paid_at` being set. `paid` is **not**
      terminal — only `Canceled` is — so an order can return from `paid` to
      `waiting_payment` if Nicky reports `PaymentPending`. `paid_at` is the
      first-confirmed-paid time, not a current-state guarantee. See
      [`security.md`](security.md) and [`operations.md`](operations.md).

## Webhook edge hardening

- [ ] Webhook endpoint additionally restricted at the edge (Cloudflare/WAF/API
      gateway / Supabase network controls) to Nicky's source IP `20.76.240.81`
      where possible, so junk traffic never reaches the function. The code-side IP
      check + body-size cap remain the backstop. See [`webhooks.md`](webhooks.md).

## Public-boundary decisions (hard gates)

- [ ] **`nicky-create-payment`**: do NOT go live until the consuming app
      authenticates/authorizes users and validates amount / product / invoice
      reference / payer server-side before invoking it. It creates a real Nicky
      Payment Request — it is not a quote/dry-run.
- [ ] **`nicky-sync-payment-status`**: decide and document one of —
      (a) restrict browser usage to the high-entropy `orderId` (UUID) only; or
      (b) accept the short-id/request-id exposure and add rate limiting /
      authentication in the consuming app. See [`security.md`](security.md).

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
