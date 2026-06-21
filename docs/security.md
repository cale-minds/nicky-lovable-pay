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
  so we read `x-forwarded-for` and take the **left-most** entry (the original
  client recorded by the trusted edge). We do **not** blindly trust arbitrary
  forwarding headers — and crucially, even a spoofed IP cannot cause a false
  `paid`, because of the next point.
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
- `nicky-register-webhooks`: `verify_jwt = false` for setup convenience. It only
  registers your own callback URL using your own key, but consider locking it
  down or removing it after initial setup.
- `nicky-create-payment`, `nicky-list-assets`, `nicky-sync-payment-status`:
  `verify_jwt = true` — they require the Supabase anon key.

## 9. Things to do yourself

- **Rate-limit** `nicky-create-payment` if your app is public (e.g. per-IP or
  per-user) to avoid abuse creating many payment requests.
- **Validate amounts/products server-side** against your own catalog — don't let
  the client send an arbitrary `amountExpectedNative` for a fixed-price product.
  Pass trusted values from your own backend logic / metadata.
- **Rotate** the Nicky API key periodically and on any suspected exposure.
