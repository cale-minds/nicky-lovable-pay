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
3. **Idempotency.** A `dedupe_key` is computed from
   `webHookId | webHookType | itemId | previousStatus | newStatus`. Insert is
   protected by a unique constraint; a redelivery returns `200 { duplicate: true }`
   without reprocessing.
4. **Source-IP validation.** The client IP must equal `NICKY_WEBHOOK_ALLOWED_IP`
   (default `20.76.240.81`). If not, the event is recorded and rejected with
   `403`.
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

## Configuring the webhook (once, outside the plugin)

The plugin does **not** register webhooks at runtime. Register it **once**,
after deploying the functions (the callback URL is only known then), using the
included setup script:

```bash
NICKY_API_KEY=your_key \
NICKY_WEBHOOK_URL=https://<project-ref>.functions.supabase.co/nicky-webhook \
  npm run nicky:register-webhooks
```

The script (`scripts/register-nicky-webhooks.mjs`) lists existing webhooks and
idempotently creates only the missing ones for both events
(`PaymentRequest_ReportAdded`, `PaymentRequest_StatusChanged`) at the fixed URL.
It is a one-time **setup** helper — not a deployed Edge Function. It never
deletes/updates webhooks, never exposes the API key, and rejects any URL that
isn't the fixed `/nicky-webhook` route. Full details:
[`webhook-registration.md`](webhook-registration.md).

There is no `nicky-register-webhooks` Edge Function and no `WEBHOOK_CALLBACK_URL`
runtime secret in this plugin. Webhook lifecycle management (create/list/delete)
is intentionally out of the plugin's production runtime; the setup-only variable
the script reads is `NICKY_WEBHOOK_URL`.

## Don't rely on webhooks alone

Webhooks can be delayed, dropped, or arrive out of order. Always also:

- **Poll** `nicky-sync-payment-status` from your success page after the payer
  returns (the `pollStatus` hook does this).
- Optionally run a **scheduled reconciliation** (e.g. a cron job) that calls
  `nicky-sync-payment-status` for any orders still in `waiting_payment` /
  `validation_required` after some time.
