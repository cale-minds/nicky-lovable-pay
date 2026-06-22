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

- **Source IP check, before any DB write.** The receiver compares the request's
  client IP against `NICKY_WEBHOOK_ALLOWED_IP` (default `20.76.240.81`) **before
  reading/parsing/storing the body**. Non-matching requests get `403` and are
  **not** persisted in `nicky_webhook_events` — they appear only in
  platform/function logs. This prevents storage-amplification abuse (POSTing junk
  to force DB writes). Only authorized requests are stored for audit.
- **Body size cap.** Authorized requests are capped at 64 KB
  (`MAX_WEBHOOK_BODY_BYTES`), enforced via `Content-Length` and while streaming.
- **Proxy headers, handled carefully.** Supabase fronts functions with a proxy,
  so we read `x-forwarded-for` and use **only the first (left-most) entry** (the
  original client recorded by the trusted edge). We do **not** scan arbitrary
  positions, and we do **not** consult freely-settable headers such as
  `x-real-ip` or `cf-connecting-ip` — that prevents the trivial spoof of slipping
  the allowed IP into a loosely-scanned header. Crucially, even a spoofed IP
  cannot cause a false `paid`, because of the next point.
- **Mandatory re-query.** The webhook body's `newStatus` is **never** trusted.
  We use `itemId` to ask Nicky directly, and only then update the order.
- **Recommended edge allowlisting.** In production, additionally allowlist the
  webhook endpoint to Nicky's source IP at the infrastructure layer
  (Cloudflare/WAF/gateway) so junk never reaches the function. The code-side check
  is the backstop; the edge allowlist is the front door. See `docs/webhooks.md`.

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

> **Hard production gate:** do not go live until the consuming app validates
> amount / product / order server-side before invoking `nicky-create-payment`.
> `nicky-create-payment` is **not** a dry-run or quote endpoint — it creates a
> real Nicky Payment Request, returns the real payment URL, and writes local
> order/payment linkage.

### Public-boundary risk: `nicky-sync-payment-status`

`nicky-sync-payment-status` re-queries Nicky server-side, updates the local
status, and is used by the success page / manual sync / reconciliation-style
flows. It **never** trusts the browser as proof of payment (it always asks
Nicky). However, it currently accepts `orderId`, `nickyPaymentRequestId`, **or
`nickyShortId`** with no ownership check, and it is reachable with the public
Supabase anon key.

- Short ids are short and guessable → exposing this endpoint to untrusted users
  lets them probe arbitrary payment statuses and trigger Nicky lookups + audit
  writes (information disclosure + amplification).
- **Safer for browser flows:** use only the high-entropy local `orderId` (a
  UUID). Treat `nickyShortId` / `nickyPaymentRequestId` lookups as server/admin
  flows behind stronger authorization or a secret.
- This kit does not change the behavior by default; the deployment decision is a
  production gate in `docs/production-checklist.md` (restrict to `orderId`, or
  accept the exposure and add rate limiting / auth in the consuming app).

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
  `processing_status`; only `processed` counts as success. Unauthorized requests
  are rejected before any insert (so they cannot pre-create a dedupe key at all —
  poisoning is structurally impossible). A prior `failed_retryable` / `received`
  event is reprocessed (with refreshed audit fields) when a later authorized
  request arrives.

### Status terminality: `paid` is NOT terminal — only `Canceled` is

This is a deliberate business rule from Nicky, not an oversight:

- `Canceled` is the **only** terminal Payment Request state.
- `Finished` / local `paid` is **not** terminal. Under specific real Nicky
  circumstances a Payment Request that was `Finished` can move back to
  `PaymentPending`, and a webhook for that transition may legitimately arrive.
- Therefore local `status` **follows the latest trusted server-side Nicky
  lookup**: `PaymentPending` → `waiting_payment` **even if the order was
  previously `paid`**. The kit does **not** make `paid` sticky.
- `paid_at` records the **first** time the order was confirmed paid; it is **not**
  a guarantee that the order is *currently* paid.
- **Entitlement/fulfillment must gate on the current local `status === "paid"`**,
  not merely on the existence of `paid_at`. If you grant access purely because
  `paid_at` is set, a payment that later returns to `waiting_payment` would keep
  access it should no longer have.

Known follow-up: local `canceled` terminality is **not** currently enforced in
code (reconciliation always writes the latest mapped status). Since `Canceled` is
terminal in Nicky, a re-query of a canceled order returns `Canceled` again, so in
practice the status stays `canceled`; but the kit does not hard-guard against a
(non-contractual) transition away from `canceled`. See the audit follow-up note.

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

**No payment URL is returned on local-persistence failure.** If Nicky
successfully creates the Payment Request but the local `nicky_orders` write then
fails, the function returns `500` with **no** `paymentUrl` / `nickyShortId` /
`nickyPaymentRequestId` — only `{ orderId, retryable: false, needsReview: true }`.
This prevents the browser (or an integration client) from redirecting a payer to
an **orphaned** request that the local app cannot reconcile automatically. The
Nicky identifiers are logged server-side and best-effort written to
`metadata` (`review_reason = "nicky_created_local_persist_failed"` plus
`possible_orphaned_*` fields) for operator recovery — never returned to the
client. Recovery is a manual operator process documented in `docs/operations.md`.

**Known limitation / TODO:** this is intentionally conservative — a transient
network error that occurred *before* Nicky created anything will still require
manual review (we cannot distinguish "failed before the call reached Nicky" from
"succeeded but local write failed"). If Nicky later exposes an idempotent-create
header or lookup-by-invoice-reference, prefer that to remove the manual step.

## 13. Things to do yourself

- Implement server-side product/amount validation (section 9).
- Configure rate limiting / abuse control (section 10).
- **Rotate** the Nicky API key periodically and on any suspected exposure.
- Set a strong, random `NICKY_RECONCILIATION_SECRET`.
