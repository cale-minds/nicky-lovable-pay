# Webhooks

This kit owns a single, fixed webhook route. End users do **not** choose
arbitrary callback URLs — the route is always the deployed `nicky-webhook`
function.

```
https://<project-ref>.functions.supabase.co/nicky-webhook
```

> **The plugin only PROCESSES webhooks. It does not create, update, or delete
> them at runtime.** The webhook must be configured **once**, outside the plugin
> runtime — manually in the Nicky dashboard or via the Lovable setup prompt. See
> [Configuring the webhook](#configuring-the-webhook-once-outside-the-plugin)
> below.

---

## Supported events

The plugin handles two Nicky event types (these are the events you register
once in Nicky):

| Event                            | Meaning                                            |
| -------------------------------- | -------------------------------------------------- |
| `PaymentRequest_StatusChanged`   | A payment request's status changed.                |
| `PaymentRequest_ReportAdded`     | A report (e.g. a payment attempt) was added.       |

Both are handled the same way: they trigger a **server-side re-query** of the
payment request and a local status update.

## Webhook payload shape

```jsonc
{
  "webHookId": "…",
  "webHookType": "PaymentRequest_StatusChanged",
  "itemId": "<payment request uuid>",
  "data": {
    "previousStatus": "PaymentPending",
    "newStatus": "Finished"
  }
}
```

The kit reads `itemId` to identify the payment request. It records
`previousStatus`/`newStatus` for audit but **does not trust them** as truth.

## Processing flow (`nicky-webhook`)

1. **POST only.** Any other method → `405`.
2. **Read and persist the raw body first.** The full payload + selected headers
   are stored in `nicky_webhook_events` before any processing, so even rejected
   events are auditable.
3. **Idempotency with poisoning-safe retry.** A `dedupe_key` is computed from
   `webHookId | webHookType | itemId | previousStatus | newStatus`. Insert is
   protected by a unique constraint, and each event carries a `processing_status`
   (`received` → `processed` / `rejected` / `failed_retryable` /
   `failed_non_retryable`). On a redelivery the prior record's status decides
   what happens (see `_shared/webhook-dedupe-helpers.ts`):
   - prior **`processed`** (the only success state) → ack
     `200 { duplicate: true, alreadyProcessed: true }`, no rework;
   - prior **`failed_non_retryable`** (e.g. missing `itemId`) → ack as duplicate;
   - prior **`rejected`** (unauthorized IP), **`failed_retryable`**, or
     **`received`** (crashed mid-process) → if the **current** request is
     authorized, **reprocess**; if the current request is also unauthorized,
     **reject** (`403`).

   This closes a **dedupe-poisoning** hole: a `processed = true`-only check let an
   unauthorized caller pre-insert a dedupe key (marked done) and block the later
   legitimate Nicky delivery. Now unauthorized events are `rejected`, never
   `processed`, so a later authorized delivery with the same key is still
   processed. A current authorized request is never blocked by a prior
   unauthorized one.
4. **Source-IP validation.** The client IP must equal `NICKY_WEBHOOK_ALLOWED_IP`
   (default `20.76.240.81`), using only the first `x-forwarded-for` entry. If not,
   the event is recorded with `processing_status = 'rejected'` and rejected with
   `403` — never marked processed.
5. **Re-query Nicky.** Using `itemId`, the function calls Nicky's
   `get-by-id` endpoint server-side and maps the authoritative status.
6. **Update the order.** Only `Finished` → `paid`. `PaymentValidationRequired` →
   `validation_required` (stays locked). `Canceled` → `canceled`.
7. **Acknowledge.** Returns `200` with the resolved status, or `500` (so Nicky
   retries) if the re-query failed. The raw event is already stored either way.

## A note on proxy headers and IP spoofing

Supabase Edge Functions sit behind a proxy, so the raw socket IP is the proxy's,
not Nicky's. The kit therefore inspects `x-forwarded-for` and uses **only the
first (left-most) entry** — the original client as recorded by the trusted edge.

This is deliberate: the kit does **not** scan arbitrary positions in
`x-forwarded-for`, and it does **not** consult freely-settable headers like
`x-real-ip` or `cf-connecting-ip`. That closes the trivial spoof of inserting
the allowed IP somewhere in a loosely-scanned header. If the first entry is not
the allowed IP, the request is rejected with `403`.

Even so, IP validation is only defense-in-depth. The real guarantee comes from
the mandatory **server-side re-query** (step 5): the webhook only ever causes the
order to reflect what Nicky's API says when queried directly. A forged IP can, at
worst, get an event recorded — it cannot fabricate a `Finished` status.

If your deployment sits behind a different/known proxy, set
`NICKY_WEBHOOK_ALLOWED_IP` accordingly and review `checkWebhookIp()` in
`supabase/functions/_shared/webhook-ip.ts`.

## Configuring the webhook (once, manually — no script)

The plugin does **not** register webhooks at runtime, and there is **no** local
script in this repository that calls Nicky's webhook setup endpoints. Configure
the webhook **once**, after deploying the functions (the callback URL is only
known then), in Nicky — via the Lovable setup prompt or manually in the Nicky
dashboard:

- Callback URL (use exactly this, never an arbitrary URL):
  `https://<project-ref>.functions.supabase.co/nicky-webhook`
- Events: `PaymentRequest_ReportAdded` and `PaymentRequest_StatusChanged`

There is no `nicky-register-webhooks` Edge Function, no local registration
script, and no `WEBHOOK_CALLBACK_URL` runtime secret. Webhook lifecycle
management (create/list/update/delete) is intentionally out of the plugin
entirely. Full details: [`webhook-registration.md`](webhook-registration.md).

## Don't rely on webhooks alone

Webhooks can be delayed, dropped, or arrive out of order. Always also:

- **Poll** `nicky-sync-payment-status` from your success page after the payer
  returns (the `pollStatus` hook does this).
- Optionally run a **scheduled reconciliation** (e.g. a cron job) that calls
  `nicky-sync-payment-status` for any orders still in `waiting_payment` /
  `validation_required` after some time.
