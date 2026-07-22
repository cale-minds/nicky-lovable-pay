# Webhook Setup (one-time setup)

Configuring the Nicky webhook is a **one-time setup operation**, performed during
installation, not something the deployed application does at runtime.

> **Runtime vs. setup**
> - **Runtime plugin behavior:** the `nicky-webhook` Edge Function only
>   **processes** incoming webhooks. It never registers, lists, updates, or
>   deletes them.
> - **Setup behavior:** after the API key is validated, the Edge Functions are
>   deployed, and the callback URL is known, the installer configures the
>   webhook through Nicky's Public API/private MCP. Manual dashboard setup is
>   the fallback when assisted registration cannot succeed.

There is intentionally **no** `nicky-register-webhooks` Edge Function, **no**
runtime webhook-registration code, and **no** app runtime script that calls
Nicky's webhook setup endpoints.

## Preconditions

Do not start registration until:

- `NICKY_API_KEY` is stored as a Supabase secret and a setup-time server call to
  `GET /AcceptedAsset/get-for-user` has authenticated it;
- for agent signup, the user has explicitly declared both email confirmation
  and Terms/Privacy acceptance, and the agreement API call has succeeded;
- all five Edge Functions are deployed and the project ref is known.

A `2xx` response containing a bare asset array or supported array envelope from
the accepted-assets endpoint authenticates the key even when the extracted
array is empty. An empty array means merchant configuration still needs
attention; it is not an invalid-key result and does not itself prevent webhook
registration. A `401`/`403` or `2xx` shape with no recognized asset array must
be resolved before registration.

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

## Idempotent Assisted Setup

List existing Nicky webhooks:

```http
GET https://api-public.pay.nicky.me/api/public/WebHookApi/list
X-API-KEY: <NICKY_API_KEY>
```

For each required event, create the webhook only when no existing webhook has
the same `webHookType` and fixed callback URL.

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

Existing event+URL pairs count as success and must not be recreated. Report
which pairs already existed and which were created. Do not report overall
success unless both required pairs are confirmed by the list/create results.

If an assisted call fails, retry only the webhook step. If it continues to fail,
offer manual dashboard setup with the same fixed URL and events. Do not repeat
signup, ask for the API key again, reset secrets, or recreate database objects.
The same idempotency rule applies to the fallback.

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
