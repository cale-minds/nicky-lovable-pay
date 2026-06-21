# Webhook Registration (one-time setup)

Registering the Nicky webhook is a **one-time setup operation**, performed during
installation — **not** something the plugin does at runtime.

> **Runtime vs. setup**
> - **Runtime plugin behavior:** the `nicky-webhook` Edge Function only
>   **processes** incoming webhooks. It never registers, lists, updates, or
>   deletes them.
> - **Setup behavior:** you register the webhook **once** using the helper script
>   below (or the Lovable/Claude setup flow), from a trusted local/setup
>   environment.

There is intentionally **no** `nicky-register-webhooks` Edge Function and **no**
runtime webhook-registration code.

---

## The fixed callback URL

The callback URL is fixed and owned by the kit:

```
https://<project-ref>.functions.supabase.co/nicky-webhook
```

End users do **not** choose arbitrary callback URLs. The setup script even
enforces that the URL is HTTPS and ends with `/nicky-webhook`.

## Required events

The script registers the URL for exactly these two Nicky events:

- `PaymentRequest_ReportAdded`
- `PaymentRequest_StatusChanged`

## Prerequisites

Run the script **after** deploying the Supabase Edge Functions — the project
ref / function URL must already exist, otherwise you cannot know the callback
URL.

You also need Node 18+ (the script uses built-in `fetch` and has no
dependencies).

## Environment variables (setup-only)

These are consumed **only** by the script. They are **not** Edge Function
secrets and **not** runtime plugin config. See
[`scripts/.env.webhook.example`](../scripts/.env.webhook.example).

| Variable             | Required | Default                            | Notes                                            |
| -------------------- | -------- | ---------------------------------- | ------------------------------------------------ |
| `NICKY_API_KEY`      | Yes      | —                                  | Used only by this script. Never printed in full. |
| `NICKY_API_BASE_URL` | No       | `https://api-public.pay.nicky.me`  | Nicky public API base URL.                       |
| `NICKY_WEBHOOK_URL`  | Yes      | —                                  | Fixed callback URL; HTTPS, ends `/nicky-webhook`.|

> **Do not** reintroduce `WEBHOOK_CALLBACK_URL` as a runtime variable — it does
> not exist in this plugin. The setup-only variable is `NICKY_WEBHOOK_URL`.

## Running it

```bash
NICKY_API_KEY=your_key \
NICKY_WEBHOOK_URL=https://<project-ref>.functions.supabase.co/nicky-webhook \
  npm run nicky:register-webhooks
```

Validate inputs without making any network calls:

```bash
NICKY_API_KEY=your_key \
NICKY_WEBHOOK_URL=https://<project-ref>.functions.supabase.co/nicky-webhook \
  node scripts/register-nicky-webhooks.mjs --dry-run
```

## What it does (idempotent)

1. `GET /api/public/WebHookApi/list` — fetch existing webhooks.
2. For each required event, check whether a webhook already exists for **that
   event type AND this URL**.
   - **Exists** → leave it untouched (no-op), print that it already exists.
   - **Missing** → create it via `POST /api/public/WebHookApi/create` with body
     `{ "webHookType": "<event>", "url": "<NICKY_WEBHOOK_URL>" }`.

Running it multiple times never creates duplicates. A webhook with the same
event type but a **different** URL is left alone — the script will create one for
your URL and will **not** delete or update the other.

The script **never**:

- deletes webhooks,
- updates existing webhooks,
- accepts arbitrary runtime callback URLs,
- creates an Edge Function,
- writes anything to Supabase.

## Security

- The Nicky API key is used only locally by the script to call Nicky directly.
  It is **never** exposed to the browser and **never** printed in full (the
  script logs only a masked prefix and the key length).
- Run the script from a **trusted local or setup environment** only.
