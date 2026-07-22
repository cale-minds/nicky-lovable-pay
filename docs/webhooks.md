# Webhooks

This kit owns a single, fixed webhook route. End users do **not** choose
arbitrary callback URLs. The route is always the deployed `nicky-webhook`
function.

```text
https://<project-ref>.functions.supabase.co/nicky-webhook
```

> **The plugin only PROCESSES webhooks. It does not create, update, or delete
> them at runtime.** The webhook must be configured **once**, outside the plugin
> runtime, by setup automation or manual fallback. See
> [Configuring the webhook](#configuring-the-webhook-once) below.

---

## Supported events

The plugin handles two Nicky event types. These are the events you register once
in Nicky:

| Event                          | Meaning                                      |
| ------------------------------ | -------------------------------------------- |
| `PaymentRequest_StatusChanged` | A payment request's status changed.          |
| `PaymentRequest_ReportAdded`   | A report, such as a payment attempt, was added. |

Both are handled the same way: they trigger a **server-side re-query** of the
payment request and a local status update.

## Webhook payload shape

```jsonc
{
  "webHookId": "...",
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

1. **POST only.** Any other method returns `405`.
2. **Source-IP validation first, before reading or storing the body.** The client
   IP must equal `NICKY_WEBHOOK_ALLOWED_IP` (default `20.76.240.81`), using only
   the first `x-forwarded-for` entry (direct IP fallback). If it does not match,
   the function returns `403` **without reading/parsing/persisting the body** and
   logs only a concise warning (source IP plus truncated user-agent). Rejected
   unauthorized attempts are therefore not stored in `nicky_webhook_events`.
3. **Body size cap for authorized requests.** A small defense-in-depth limit
   (`MAX_WEBHOOK_BODY_BYTES`, 64 KB) is enforced. If `Content-Length` exceeds it,
   the function returns `413`; the body is also read with a running byte cap so a
   chunked request without `Content-Length` cannot bypass it.
4. **Persist the raw authorized event** with `processing_status = 'received'`.
5. **Idempotency with poisoning-safe retry.** A `dedupe_key` is computed from
   `webHookId | webHookType | itemId | previousStatus | newStatus`. Insert is
   protected by a unique constraint, and each event carries a
   `processing_status` (`received` -> `processed` / `failed_retryable` /
   `failed_non_retryable`). On redelivery, the prior record's status decides what
   happens:
   - prior **`processed`** acks `200 { duplicate: true, alreadyProcessed: true }`
     with no rework;
   - prior **`failed_non_retryable`** acks as duplicate;
   - any other prior state reprocesses and refreshes audit fields.
6. **Re-query Nicky.** Using `itemId`, the function calls Nicky's `get-by-id`
   endpoint server-side and maps the authoritative status.
7. **Update the order.** Only `Finished` maps to `paid`.
   `PaymentValidationRequired` maps to `validation_required` and stays locked.
   `Canceled` maps to `canceled`. `PaymentPending` maps to `waiting_payment`,
   even if the order was previously `paid`; `paid` is not terminal in Nicky, only
   `Canceled` is.
8. **Acknowledge.** Returns `200` with the resolved status, or `500` so Nicky
   retries if the re-query failed.

## A note on proxy headers and IP spoofing

Supabase Edge Functions sit behind a proxy, so the raw socket IP is the proxy's,
not Nicky's. The kit therefore inspects `x-forwarded-for` and uses **only the
first, left-most entry**: the original client as recorded by the trusted edge.

The kit does **not** scan arbitrary positions in `x-forwarded-for`, and it does
**not** consult freely settable headers like `x-real-ip` or `cf-connecting-ip`.
That closes the trivial spoof of inserting the allowed IP somewhere in a loosely
scanned header. If the first entry is not the allowed IP, the request is
rejected with `403`.

Even so, IP validation is only defense-in-depth. The real guarantee comes from
the mandatory **server-side re-query**: the webhook only ever causes the order to
reflect what Nicky's API says when queried directly.

### Recommended: edge / WAF IP allowlisting for production

The code-side IP check is necessary but runs inside the function. In production
you should **also** restrict the webhook endpoint at the infrastructure layer
(Cloudflare/WAF/API gateway/Supabase network controls) to Nicky's current source
IP (`20.76.240.81`) so junk traffic never reaches the function at all.

If your deployment sits behind a different/known proxy, set
`NICKY_WEBHOOK_ALLOWED_IP` accordingly and review `checkWebhookIp()` in
`supabase/functions/_shared/webhook-ip.ts`.

## Configuring the webhook once

The plugin does **not** register webhooks at runtime, and there is **no**
`nicky-register-webhooks` Edge Function. Configure the webhook **once**, after
the API key is validated and the functions are deployed (the callback URL is
only known then). Assisted setup through the Lovable prompt/Nicky Public
API/private MCP is the default; manual Nicky dashboard configuration is the
fallback:

- Callback URL (use exactly this, never an arbitrary URL):
  `https://<project-ref>.functions.supabase.co/nicky-webhook`
- Events: `PaymentRequest_ReportAdded` and `PaymentRequest_StatusChanged`

Assisted setup must call `GET /api/public/WebHookApi/list` first and create only
missing event+URL pairs with `POST /api/public/WebHookApi/create`. A webhook-step
failure never restarts signup or secret/database setup. There is no
`WEBHOOK_CALLBACK_URL` runtime secret. Webhook lifecycle management from the
deployed app is intentionally out of scope. Full details:
[`webhook-registration.md`](webhook-registration.md).

## Do not rely on webhooks alone

Webhooks can be delayed, dropped, or arrive out of order. Always also:

- **Poll** `nicky-sync-payment-status` from your success page after the payer
  returns. The `pollStatus` hook does this.
- Optionally run a **scheduled reconciliation** that calls
  `nicky-sync-payment-status` for orders still in `waiting_payment` or
  `validation_required` after some time.
