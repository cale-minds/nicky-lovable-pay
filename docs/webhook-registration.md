# Webhook Setup (one-time, manual)

Configuring the Nicky webhook is a **one-time setup operation**, performed during
installation — **not** something the plugin does at runtime, and **not** via any
script shipped in this repository.

> **Runtime vs. setup**
> - **Runtime plugin behavior:** the `nicky-webhook` Edge Function only
>   **processes** incoming webhooks. It never registers, lists, updates, or
>   deletes them.
> - **Setup behavior:** you configure the webhook **once** in Nicky — either by
>   following the Lovable setup/install prompt (see
>   [`lovable-install-prompt.md`](lovable-install-prompt.md)) or manually in the
>   Nicky dashboard.

There is intentionally **no** `nicky-register-webhooks` Edge Function, **no**
runtime webhook-registration code, and **no** local script that calls Nicky's
webhook setup endpoints. The plugin does not create, list, update, or delete
webhooks.

---

## The fixed callback URL

The callback URL is fixed and owned by the kit. Use exactly this — never an
arbitrary URL:

```
https://<project-ref>.functions.supabase.co/nicky-webhook
```

It is only known **after** you deploy the Supabase Edge Functions, so configure
the webhook after deployment.

## Required events

Register the callback URL for exactly these two Nicky events:

- `PaymentRequest_ReportAdded`
- `PaymentRequest_StatusChanged`

## How to configure it

Configure the webhook **once**, after deploying the Edge Functions, using
whichever Nicky-provided mechanism your account exposes (the Nicky dashboard or
Nicky's own API/console). The Lovable setup prompt will walk a user through this
step. Point both required events at the fixed callback URL above.

The plugin then simply **processes** the deliveries it receives:

- POST only.
- Source IP validated against `NICKY_WEBHOOK_ALLOWED_IP` (default
  `20.76.240.81`), using only the first `x-forwarded-for` entry.
- The raw event is stored for audit, then Nicky is **re-queried server-side**;
  an order only becomes `paid` when that lookup returns `Finished`.

## Verifying

After configuring the webhook, trigger a test payment and confirm a row appears
in `nicky_webhook_events` with `processing_status = 'processed'`. See
[`operations.md`](operations.md) and [`troubleshooting.md`](troubleshooting.md).
