# Webhook Setup (one-time setup)

Configuring the Nicky webhook is a **one-time setup operation**, performed during
installation, not something the deployed application does at runtime.

> **Runtime vs. setup**
> - **Runtime plugin behavior:** the `nicky-webhook` Edge Function only
>   **processes** incoming webhooks. It never registers, lists, updates, or
>   deletes them.
> - **Setup behavior:** after the Edge Functions are deployed and the callback
>   URL is known, the installer may configure the webhook once through Nicky's
>   Public API/private MCP, or the user may configure it manually in the Nicky
>   dashboard.

There is intentionally **no** `nicky-register-webhooks` Edge Function, **no**
runtime webhook-registration code, and **no** app runtime script that calls
Nicky's webhook setup endpoints.

---

## The Fixed Callback URL

The callback URL is fixed and owned by the kit. Use exactly this; never let a
user choose an arbitrary URL:

```text
https://<project-ref>.functions.supabase.co/nicky-webhook
```

It is only known **after** you deploy the Supabase Edge Functions, so configure
the webhook after deployment.

## Required Events

Register the callback URL for exactly these two Nicky events:

- `PaymentRequest_ReportAdded`
- `PaymentRequest_StatusChanged`

## Idempotent Setup

Before creating webhooks, list existing Nicky webhooks. For each required event,
create the webhook only when no existing webhook has the same `webHookType` and
the same fixed callback URL.

REST creation shape:

```http
POST https://api-public.pay.nicky.me/api/public/WebHookApi/create
X-API-KEY: <NICKY_API_KEY>
Content-Type: application/json
```

```json
{
  "webHookType": "PaymentRequest_ReportAdded",
  "url": "https://<project-ref>.functions.supabase.co/nicky-webhook"
}
```

Repeat for `PaymentRequest_StatusChanged` if it is missing.

Manual dashboard setup is still a valid fallback. The same idempotency idea
applies: do not create duplicates for the same event and callback URL.

## What The Plugin Processes

The plugin then simply **processes** deliveries it receives:

- POST only.
- Source IP validated against `NICKY_WEBHOOK_ALLOWED_IP` (default
  `20.76.240.81`), using only the first `x-forwarded-for` entry.
- The raw event is stored for audit, then Nicky is **re-queried server-side**.
- An order only becomes `paid` when that lookup returns `Finished`.

## Verifying

After configuring the webhook, trigger a test payment and confirm a row appears
in `nicky_webhook_events` with `processing_status = 'processed'`. See
[`operations.md`](operations.md) and [`troubleshooting.md`](troubleshooting.md).
