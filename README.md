# Nicky Payment Kit for Lovable

A reusable, **non-custodial** crypto payment integration kit for apps built on
the Lovable stack (**React + TypeScript + Supabase + Edge Functions +
PostgreSQL**).

It lets your app accept payments through [Nicky](https://nicky.me) — *money,
routed* — by creating payment requests, redirecting the payer to Nicky's hosted
checkout, and confirming settlement **server-side** before unlocking anything.

> **Nicky is non-custodial.** It orchestrates and verifies payments but never
> holds your funds. This kit follows the same principle: it coordinates and
> confirms, and it never asks your users to trust a redirect or a webhook as
> proof of payment.

---

## What this kit is

- A **drop-in integration kit / template** you copy or install into an existing
  Lovable app.
- A set of **Supabase Edge Functions** that talk to the Nicky API using a secret
  API key that never touches the browser.
- A **SQL migration** that gives you durable orders, an audit trail, and
  idempotent webhook handling.
- A small set of **React components and hooks** to create payments, pick a
  settlement asset, redirect to Nicky, and reflect confirmed status.

## What this kit is **not**

- **Not** a demo storefront. There are no products, no cart, no sample shop.
- **Not** an account creator. It will **never** create a Nicky account or API
  key for you — you do that yourself (see below).
- **Not** custodial. It never receives, holds, or moves funds.
- **Not** a wallet, exchange, or fiat processor.
- **Not** USD-only. Supported assets are read live from Nicky.
- v1 does **not** implement refunds, marketplace/split payments, OAuth, or
  subaccounts.

---

## How it works (at a glance)

```
 ┌──────────────┐    create     ┌──────────────────────┐   POST create    ┌────────────┐
 │ React kit    │ ────────────▶ │ nicky-create-payment │ ───────────────▶ │   Nicky    │
 │ (browser)    │               │   (Edge Function)    │ ◀─────────────── │   API      │
 └──────┬───────┘               └──────────┬───────────┘ {id, bill.shortId} └─────┬──────┘
        │ redirect to pay.nicky.me/home?paymentId=<bill.shortId>                  │
        ▼                                                                         │
 ┌──────────────┐                                                                 │ webhook (IP 20.76.240.81)
 │ Nicky hosted │                                                                 ▼
 │  checkout    │                                          ┌──────────────────────────────┐
 └──────┬───────┘                                          │       nicky-webhook          │
        │ success/cancel redirect (UX only)                │ 1. validate source IP        │
        ▼                                                   │ 2. store raw event (idemp.)  │
 ┌──────────────┐   sync (server re-query)                 │ 3. RE-QUERY Nicky by itemId  │
 │ success page │ ───────────────────────────────────────▶ │ 4. mark paid only if Finished│
 └──────────────┘   nicky-sync-payment-status              └──────────────────────────────┘
```

**Golden rule:** an order is only marked `paid` after a **server-side Nicky
lookup returns `Finished`**. The success redirect and the webhook are signals,
never proof.

---

## Repository layout

```
.
├── README.md
├── .env.example
├── package.json
├── docs/
│   ├── setup.md                 # step-by-step setup
│   ├── security.md              # the security model (read this)
│   ├── webhooks.md              # webhook flow, IP validation, idempotency
│   ├── webhook-registration.md  # one-time setup script for webhook registration
│   ├── lovable-install-prompt.md# copy-paste prompt for Lovable
│   └── troubleshooting.md
├── scripts/                     # SETUP-ONLY helpers (not runtime, not Edge Fns)
│   ├── register-nicky-webhooks.mjs
│   ├── webhook-registration-helpers.mjs
│   └── .env.webhook.example
├── supabase/
│   ├── config.toml              # per-function verify_jwt settings
│   ├── migrations/
│   │   └── 001_nicky_payment_kit.sql
│   └── functions/
│       ├── _shared/             # env, db, validation, Nicky client, reconcile,
│       │                        # status, assets, payment-identifiers, webhook-ip
│       ├── nicky-create-payment/
│       ├── nicky-list-assets/
│       ├── nicky-webhook/
│       └── nicky-sync-payment-status/
└── src/
    └── nicky/                   # React kit (components, hooks, types)
        ├── index.ts
        ├── types.ts
        ├── status.ts
        ├── client.ts
        ├── useNickyAssets.ts
        ├── useNickyPayment.ts
        ├── NickyPayButton.tsx
        ├── NickyAssetSelector.tsx
        └── NickyPaymentStatus.tsx
```

---

## Setup (summary)

Full details in [`docs/setup.md`](docs/setup.md).

### 1. Create your Nicky account (manual)

Go to **https://nicky.me**, sign up, and complete onboarding. **This kit does
not create an account for you.**

### 2. Generate your Nicky API key (manual)

In the Nicky dashboard, create a public API key. You'll send it as the
`x-api-key` header. **Treat it like a password.**

### 3. Store the API key as a Supabase secret

**Never** put the key in frontend code or commit it. Store it as a secret:

```bash
supabase secrets set NICKY_API_KEY=your_key_here
# optional overrides (defaults shown):
supabase secrets set NICKY_API_BASE_URL=https://api-public.pay.nicky.me
supabase secrets set NICKY_PAY_BASE_URL=https://pay.nicky.me
supabase secrets set NICKY_WEBHOOK_ALLOWED_IP=20.76.240.81
```

### 4. Run the SQL migration

```bash
supabase db push
# or apply supabase/migrations/001_nicky_payment_kit.sql via the SQL editor
```

### 5. Deploy the Edge Functions

The plugin ships exactly four functions:

```bash
supabase functions deploy nicky-create-payment
supabase functions deploy nicky-list-assets
supabase functions deploy nicky-sync-payment-status
supabase functions deploy nicky-webhook            # verify_jwt = false
```

### 6. Register the webhook once (setup script — not a runtime function)

This plugin **only processes** webhooks at runtime — it does **not** create,
list, update, or delete them. Webhook registration is a **one-time setup step**,
done with the included helper script (or the Lovable/Claude setup flow). It is
**not** a deployed Edge Function.

Run it **after** deploying the functions (the callback URL is only known then):

```bash
NICKY_API_KEY=your_key \
NICKY_WEBHOOK_URL=https://<project-ref>.functions.supabase.co/nicky-webhook \
  npm run nicky:register-webhooks
```

The script is **idempotent**: it lists existing webhooks and only creates the
missing ones (`PaymentRequest_ReportAdded`, `PaymentRequest_StatusChanged`) for
the fixed callback URL `https://<project-ref>.functions.supabase.co/nicky-webhook`.
It never deletes or updates webhooks, and it never exposes the API key. The URL
is fixed and owned by the kit — arbitrary callback URLs are rejected.

See [`docs/webhook-registration.md`](docs/webhook-registration.md) for details,
and [`scripts/.env.webhook.example`](scripts/.env.webhook.example) for the
setup-only variables.

---

## Using the React kit in a Lovable app

Copy `src/nicky/` into your app (e.g. to `src/nicky/`) and configure the client
with **public** values only:

```tsx
import {
  NickyPayButton,
  NickyAssetSelector,
  NickyPaymentStatus,
  useNickyAssets,
  useNickyPayment,
  type NickyClientConfig,
} from "@/nicky";

const config: NickyClientConfig = {
  functionsBaseUrl: import.meta.env.VITE_SUPABASE_FUNCTIONS_URL, // https://<ref>.functions.supabase.co
  supabaseAnonKey: import.meta.env.VITE_SUPABASE_ANON_KEY,       // public anon key only
};

function Checkout() {
  const { assets, loading, error } = useNickyAssets(config);
  const [assetId, setAssetId] = React.useState<string | null>(null);

  return (
    <>
      <NickyAssetSelector
        assets={assets}
        value={assetId}
        onChange={setAssetId}
        loading={loading}
        error={error}
      />

      <NickyPayButton
        config={config}
        payment={{
          blockchainAssetId: assetId ?? "",
          amountExpectedNative: "25.00",
          invoiceReference: "order-1234",
          description: "Pro plan — 1 month",
          payerEmail: "buyer@example.com",
          payerName: "Ada Lovelace",
          successUrl: `${window.location.origin}/payment/success?ref=order-1234`,
          cancelUrl: `${window.location.origin}/payment/cancel?ref=order-1234`,
        }}
      />
    </>
  );
}
```

### Confirming payment on the success page

The success redirect is **UX only**. On your success page, re-query Nicky
server-side via the sync function and gate access on the confirmed status:

```tsx
function PaymentSuccess({ orderId }: { orderId: string }) {
  const { status, error, pollStatus } = useNickyPayment(config);

  React.useEffect(() => {
    void pollStatus({ orderId }); // polls nicky-sync-payment-status until terminal
  }, [orderId]);

  // Only `status === "paid"` should unlock the product.
  return <NickyPaymentStatus status={status} error={error} />;
}
```

---

## Payment confirmation & the status model

Local statuses: `idle`, `creating_payment`, `redirecting_to_nicky`,
`waiting_payment`, `webhook_received`, `syncing_status`, `paid`,
`validation_required`, `canceled`, `expired_or_abandoned`, `failed`.

Nicky → local mapping:

| Nicky status                | Local status            | Unlock product? |
| --------------------------- | ----------------------- | --------------- |
| `PaymentPending`            | `waiting_payment`       | No              |
| `PaymentValidationRequired` | `validation_required`   | **No**          |
| `Finished`                  | `paid`                  | **Yes**         |
| `Canceled`                  | `canceled`              | No              |

### Handling `PaymentValidationRequired`

This means Nicky still needs to validate the payment. The order is marked
`validation_required` and **paid features stay locked**. Keep the order open,
show the user a "we're confirming your payment" state, and let the webhook /
periodic `nicky-sync-payment-status` move it to `paid` once Nicky returns
`Finished`. Never unlock on `validation_required`.

---

## Environment variables

| Variable                    | Where        | Default                            | Notes                                  |
| --------------------------- | ------------ | ---------------------------------- | -------------------------------------- |
| `NICKY_API_KEY`             | Secret       | —                                  | **Required.** Never expose to browser. |
| `NICKY_API_BASE_URL`        | Secret/env   | `https://api-public.pay.nicky.me`  | Nicky public API base.                 |
| `NICKY_PAY_BASE_URL`        | Secret/env   | `https://pay.nicky.me`             | Used to build payer redirect URL.      |
| `NICKY_WEBHOOK_ALLOWED_IP`  | Secret/env   | `20.76.240.81`                     | Webhook source-IP allow list.          |
| `SUPABASE_URL`              | Auto         | —                                  | Injected by Supabase.                  |
| `SUPABASE_SERVICE_ROLE_KEY` | Auto         | —                                  | Injected by Supabase. Server-only.     |
| `VITE_SUPABASE_FUNCTIONS_URL` | Frontend   | —                                  | Public. Functions base URL.            |
| `VITE_SUPABASE_ANON_KEY`    | Frontend     | —                                  | Public anon key.                       |

> **Removed in this version:** there is no `NICKY_ASSETS_ENDPOINT` (assets come
> from the fixed endpoint `GET /AcceptedAsset/get-for-user`) and no
> `WEBHOOK_CALLBACK_URL` (the plugin no longer registers webhooks at runtime).

### Payment request identifiers

`nicky-create-payment` calls
`POST /api/public/PaymentRequestPublicApi/create` and reads exactly two fields
from the response:

- `response.id` — the Payment Request UUID.
- `response.bill.shortId` — the short id used to build the payment link
  (`https://pay.nicky.me/home?paymentId=<bill.shortId>`).

No alternate/legacy field names are probed. If **either** identifier is missing
or empty, that is treated as an **exceptional API-contract error**: the local
order is marked `failed`, the raw response is stored in `nicky_create_response`,
no `nicky_payment_requests` row is created, no `paymentUrl` is returned, and the
caller receives a clear `502`.

---

## Security

Read [`docs/security.md`](docs/security.md). The short version:

- The Nicky API key lives **only** in Supabase secrets and is used **only**
  inside Edge Functions.
- Webhooks are validated by **source IP** (`20.76.240.81`) and then
  **re-verified** against the Nicky API.
- Raw webhook payloads are stored for **audit**, and processing is
  **idempotent**.
- An order is **never** marked paid from a redirect or an unverified webhook.

---

## License

MIT. See repository for details.
