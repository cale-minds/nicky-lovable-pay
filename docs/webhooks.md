# Webhooks

This kit owns a single, fixed webhook route. End users do **not** choose
arbitrary callback URLs — the route is always the deployed `nicky-webhook`
function.

```
https://<project-ref>.functions.supabase.co/nicky-webhook
```

---

## Supported events

The kit registers and handles two Nicky event types:

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
not Nicky's. The kit therefore inspects `x-forwarded-for` and takes the
**left-most** entry — the original client as recorded by the trusted edge.

`x-forwarded-for` is, in general, a client-settable header. The kit does **not**
rely on it as a security boundary on its own. The actual guarantee comes from
step 5: the webhook only ever causes the order to reflect what Nicky's API says
when queried directly. A forged IP can, at worst, get an event recorded — it
cannot fabricate a `Finished` status.

If your deployment sits behind a different/known proxy, set
`NICKY_WEBHOOK_ALLOWED_IP` accordingly and review `extractClientIps()` in
`supabase/functions/nicky-webhook/index.ts`.

## Registering webhooks (`nicky-register-webhooks`)

The callback URL is only known after deployment, so registration is a separate,
idempotent step:

```bash
supabase secrets set WEBHOOK_CALLBACK_URL=https://<project-ref>.functions.supabase.co/nicky-webhook
supabase functions deploy nicky-register-webhooks
curl -X POST https://<project-ref>.functions.supabase.co/nicky-register-webhooks
```

The function:

- Calls `GET /api/public/WebHookApi/list` first.
- Skips any event type already pointing at your callback URL (**idempotent**).
- Creates the missing ones via `POST /api/public/WebHookApi/create`.

To remove a webhook, use `POST /api/public/WebHookApi/delete` (the
`deleteWebhook` helper is available in `_shared/nicky.ts`).

## Don't rely on webhooks alone

Webhooks can be delayed, dropped, or arrive out of order. Always also:

- **Poll** `nicky-sync-payment-status` from your success page after the payer
  returns (the `pollStatus` hook does this).
- Optionally run a **scheduled reconciliation** (e.g. a cron job) that calls
  `nicky-sync-payment-status` for any orders still in `waiting_payment` /
  `validation_required` after some time.
