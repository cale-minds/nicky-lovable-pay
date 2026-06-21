# Security Model

Read this before going to production. The kit is designed so that **no single
client-controlled signal can cause a false "paid".**

---

## 1. The Nicky API key never reaches the browser

- `NICKY_API_KEY` is stored as a **Supabase secret** and read only inside Edge
  Functions via `Deno.env`.
- It is sent to Nicky exclusively as the `x-api-key` header, server-side.
- It is **never** returned in any function response, logged, or embedded in
  frontend code.
- The frontend only ever holds **public** values: your Supabase Functions URL
  and the Supabase **anon** key.

> ⚠️ If you ever see the Nicky API key in a network response, a bundled JS file,
> or a git commit — rotate it immediately in the Nicky dashboard.

## 2. Payment confirmation is server-side only

**The success redirect is UX, not proof.** A user can navigate directly to your
success URL without paying.

The only thing that flips an order to `paid` is `reconcileOrder()` in
`supabase/functions/_shared/reconcile.ts`, which:

1. Calls the Nicky API (`get-by-id` / `get-by-short-id`) server-side.
2. Maps the returned status.
3. Sets `paid` **only** when Nicky returns `Finished`.

This logic is shared by both the webhook and the sync endpoint, so the rule is
enforced consistently no matter what triggers a check.

## 3. Webhooks are validated, then re-verified

Even a webhook is not trusted as the source of truth:

- **Source IP check.** The receiver compares the request's client IP against
  `NICKY_WEBHOOK_ALLOWED_IP` (default `20.76.240.81`). Non-matching requests are
  rejected with `403` (but still recorded for audit).
- **Proxy headers, handled carefully.** Supabase fronts functions with a proxy,
  so we read `x-forwarded-for` and use **only the first (left-most) entry** (the
  original client recorded by the trusted edge). We do **not** scan arbitrary
  positions, and we do **not** consult freely-settable headers such as
  `x-real-ip` or `cf-connecting-ip` — that prevents the trivial spoof of slipping
  the allowed IP into a loosely-scanned header. Crucially, even a spoofed IP
  cannot cause a false `paid`, because of the next point.
- **Mandatory re-query.** The webhook body's `newStatus` is **never** trusted.
  We use `itemId` to ask Nicky directly, and only then update the order.

So the webhook does not need to be cryptographically trusted to be safe: the
re-query is the real gate. The IP check simply reduces noise and abuse.

## 4. Idempotency

- **Webhook events** are inserted with a unique `dedupe_key` derived from the
  payload (`webHookId | webHookType | itemId | previousStatus | newStatus`). A
  redelivery hits the unique constraint and is acknowledged as a duplicate with
  `200` — Nicky stops retrying and we never double-process.
- **Order creation** uses an `idempotency_key` (client-supplied or derived from
  the invoice reference). Re-creating returns the existing order and payment URL
  instead of creating a duplicate Nicky request.

## 5. Auditability

Every security-relevant event is persisted:

- `nicky_webhook_events` — the **raw** webhook body and selected headers, the
  source IP, whether the IP was allowed, and the processing outcome. Stored
  **before** processing so even rejected events are retained.
- `nicky_payment_status_checks` — every server-side Nicky lookup, what triggered
  it, the remote status, and the resulting local status. This is your "why did
  this order change?" trail.
- `nicky_orders.nicky_create_response` and `nicky_payment_requests.raw_response`
  — the raw Nicky responses.

## 6. Database access control

All kit tables have **Row Level Security enabled with no permissive policies**.
The Edge Functions use the **service-role** key, which bypasses RLS. The browser
(anon/authenticated roles) therefore cannot read or write these tables directly.

If you want end users to read *their own* orders from the client, add a narrow
`SELECT` policy yourself — scoped to their user id — rather than opening the
tables broadly.

## 7. `validation_required` must stay locked

When Nicky returns `PaymentValidationRequired`, the order becomes
`validation_required`. **Do not unlock paid features in this state.** Treat it
as "pending"; only `paid` (i.e. Nicky `Finished`) unlocks anything.

## 8. `verify_jwt` settings

- `nicky-webhook`: `verify_jwt = false` (Nicky cannot send a Supabase JWT).
  Protected instead by IP validation + re-query.
- `nicky-reconcile-open-orders`: `verify_jwt = false` so a scheduler can call it,
  but it is **not** public — it requires the `x-nicky-reconciliation-secret`
  header (`NICKY_RECONCILIATION_SECRET`) and **fails closed** if that secret is
  unset.
- `nicky-create-payment`, `nicky-list-assets`, `nicky-sync-payment-status`:
  `verify_jwt = true` — they require the Supabase anon key.

The plugin does **not** register, list, or delete webhooks at runtime, so there
is no setup function to lock down. Webhooks are configured once, outside the
plugin runtime (see `docs/webhooks.md`).

## 9. Server-side product/amount validation (consuming-app responsibility)

`nicky-create-payment` can create Payment Requests on the merchant's Nicky
account, and it **trusts its caller** for `amountExpectedNative`,
`invoiceReference`, `description`, and payer details. A public app must not let
arbitrary users create arbitrary payments. Recommended patterns:

- **Front it with your own logic.** Have the browser call *your* authenticated
  endpoint (or an RLS-protected table/RPC) that computes the trusted amount from
  your catalog, then calls `nicky-create-payment` with values you control.
- **Validate `invoiceReference`** against an existing local order/product row;
  refuse references that don't map to a known, unpaid order.
- **Refuse client-supplied amounts** for fixed-price products — derive the amount
  server-side; never accept it from the browser.
- **Require authenticated user context** where possible, and put the user id in
  `metadata` for traceability (never trust it for fulfillment by itself).

The kit does not ship a product catalog (by design). These checks live in the
consuming app.

## 10. Rate limiting / abuse control

Attackers can spam `nicky-create-payment`. In order of effectiveness:

1. **App authentication** — require a logged-in user to create payments.
2. **WAF / Cloudflare / Supabase platform rate limiting** in front of the
   function — the most robust option.
3. **Optional built-in soft cap** — set `NICKY_CREATE_RATE_LIMIT_PER_HOUR` > 0 to
   cap orders per payer email per hour. This is **defense-in-depth only**: it is
   keyed on payer email (which an attacker can vary) and is not a substitute for
   (1) and (2). It is disabled by default to avoid security theater.

## 11. Concurrency & data integrity

- **Race-safe idempotency.** Order creation goes through the
  `nicky_create_or_claim_order` SQL function, which does an atomic
  `INSERT ... ON CONFLICT (idempotency_key) DO NOTHING` and then a conditional
  claim. Only one concurrent caller "owns" creating the Nicky Payment Request;
  others get a `409 retry shortly`. This prevents duplicate Nicky requests for
  the same idempotency key. A stale claim (older than the window) can be
  re-claimed so a failed attempt can be retried — but only when the Nicky create
  call was never attempted (see the next point).
- **`paid_at` is write-once.** Reconciliation sets `paid_at` only on the first
  transition to `paid` and never overwrites it (see `_shared/reconcile-helpers.ts`).
- **Partial-write recovery.** If the order saves but the normalized
  `nicky_payment_requests` row fails to persist, the order is flagged
  (`metadata.payment_request_row_missing`) and the row is repaired on the next
  idempotent retry (non-clobbering upsert). See `docs/operations.md`.
- **Webhook reprocessing & dedupe poisoning.** Each webhook event carries a
  `processing_status`; only `processed` counts as success. An unauthorized
  delivery is stored as `rejected` (never `processed`), so it cannot block a
  later authorized delivery with the same dedupe key from being processed. A
  prior `rejected` / `failed_retryable` / `received` event is reprocessed when a
  later **authorized** request arrives.

## 12. External-call / DB-write consistency (known limitation)

`nicky-create-payment` performs an external call (create the Nicky Payment
Request) and then a local DB write (store `id` / `bill.shortId`). These two steps
are **not atomic across systems**: if the Nicky call succeeds but the local write
fails, the local DB does not learn the Nicky Payment Request id/short id.

Nicky's public API (as used by this kit) has **no documented idempotent-create
key and no lookup-by-invoice-reference**, so we cannot reliably ask Nicky "did
you already create a request for this order?". We therefore mitigate
conservatively rather than risk a **duplicate** Payment Request:

- The order is marked `nicky_create_attempted_at` **before** the Nicky call.
- If a later (stale-claim) retry finds `nicky_create_attempted_at` set but no
  linkage, `nicky_create_or_claim_order` returns `needs_review = true`; the
  function refuses to auto-create again, flags
  `metadata.needs_operator_review = true`, and returns `409` (non-retryable).
- An operator resolves it manually (see `docs/operations.md`): check the Nicky
  dashboard by invoice reference, then either link the existing request id or
  clear the flag to allow a fresh attempt.

**Known limitation / TODO:** this is intentionally conservative — a transient
network error that occurred *before* Nicky created anything will still require
manual review (we cannot distinguish "failed before the call reached Nicky" from
"succeeded but local write failed"). If Nicky later exposes an idempotent-create
header or lookup-by-invoice-reference, prefer that to remove the manual step.

## 12. Things to do yourself

- Implement server-side product/amount validation (section 9).
- Configure rate limiting / abuse control (section 10).
- **Rotate** the Nicky API key periodically and on any suspected exposure.
- Set a strong, random `NICKY_RECONCILIATION_SECRET`.
