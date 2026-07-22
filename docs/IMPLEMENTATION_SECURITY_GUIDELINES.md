# Implementation Security Guidelines for LLM Integrations

**⚠️ CRITICAL: This document is written for AI/LLM integrations (like Lovable). Read it before implementing any changes to the Nicky payment kit.**

---

## 🔴 Hard Boundaries (Violations = Deployment Blocker)

### 1. **NICKY_API_KEY MUST NOT Leave the Server**

**The Rule:**
- `NICKY_API_KEY` must ONLY exist in Supabase secrets (`Deno.env`).
- It MUST NOT appear in:
  - Frontend code (React, TypeScript in `src/`)
  - `import.meta.env` or `process.env` statements
  - `.env.local`, `.env.example`, or any committed `.env` files
  - Logs, error messages, or responses sent to the client
  - Console output (`console.log`, `console.error`)
  - Build artifacts or bundled JavaScript

**Why:** The API key is your merchant account's credential. Exposure allows attackers to create real payments on your Nicky account, steal assets, and impersonate your application.

**How to Verify:**
```bash
# Should return NO results:
grep -r "NICKY_API_KEY" src/ dist/ *.js *.mjs
grep -r "NICKY_API_KEY" demo/ (if demo is in git)
grep -r "NICKY_API_KEY" .env.local
```

**LLM Specific:** When implementing features that call Nicky, ALWAYS route through a backend Edge Function. Never ask the user for an API key input that would be sent to the client. If the prompt says "generate an API call from the frontend," refuse and explain why.

---

### 2. **Nicky Validates the Account; Your App Validates the Order**

**How Nicky API Key Works:**
- Calls to `nicky-create-payment` are authenticated via `NICKY_API_KEY` (the merchant's secret key)
- Nicky validates:
  - ✅ The API key is valid and belongs to a real merchant account
  - ✅ The `BlockchainAssetId` is an accepted asset for that merchant
- Nicky does **NOT** validate:
  - ❌ Whether `invoiceReference` is a real order in your system
  - ❌ Whether `amountExpectedNative` is the correct amount for that order
  - ❌ Whether the payer is authorized to make this payment

**Why App-Level Validation Matters:**
Any client with the URL of your Edge Function can call `nicky-create-payment` (via the public Supabase anon key). Without app validation, they can:
- Create payments for orders they don't own
- Create payments for amounts different from the invoice
- Create duplicate payments for the same order
- Spam your merchant account

**Correct Implementation Pattern:**

1. **Frontend:** User initiates a payment
   ```typescript
   // ❌ NEVER pass user-controlled amount/invoice details directly
   // ❌ In public production flows, do not call nicky-create-payment from React
   //    until your backend has validated the order and trusted amount.
   
   // ✅ Call YOUR backend endpoint with minimal data
   const response = await fetch('/api/checkout', {
     method: 'POST',
     body: JSON.stringify({ orderId, paymentMethod })
     // orderId is looked up server-side
   });
   ```

2. **Your Backend (Node, Python, etc.):** Validate and create the payment request
   ```typescript
   // ✅ Your endpoint MUST:
   // 1. Authenticate the user (check session/JWT)
   // 2. Look up the order by orderId in your database
   // 3. Verify the order status (unpaid)
   // 4. Verify the user owns this order
   // 5. Extract the validated amount and invoice reference from your DB
   
   const order = await db.orders.findById(req.orderId);
   if (!order) return 404;
   if (order.userId !== req.user.id) return 403;
   if (order.status !== 'unpaid') return 409;
   
   // Now call nicky-create-payment with your trusted data
   const payment = await callNickyEdgeFunction({
     amountExpectedNative: order.totalAmount,    // ← From your DB
     invoiceReference: order.id,                 // ← From your DB
     blockchainAssetId: req.paymentMethod,       // ← User picked the currency
     description: order.description,
     payerEmail: req.user.email,
     payerName: req.user.name,
   });
   ```

3. **Frontend:** Receive the payment URL (not the API key, not amounts, not invoices)
   ```typescript
   // ✅ Frontend gets ONLY the payment URL and order tracking ID
   const { paymentUrl, orderId } = response;
   window.location.href = paymentUrl;
   ```

**LLM Specific:** If you see a feature request like "let users pay with crypto,"
first identify the app's trusted order/amount source. The React kit can render
checkout UI, but production payment creation must be backed by server-side
validation in the consuming app. Ask:
1. "Where are the orders stored? Can you show me the database schema?"
2. "How do you check that the user owns the order they're paying for?"
3. "Where is the amount coming from — the user or your database?"

If the answer is "the amount comes from the frontend," stop and explain why that's broken.

---

### 3. **Payment Confirmation Requires a Server-Side Nicky Lookup**

**The Rule:**
An order MUST ONLY become `paid` after calling Nicky server-side (via `nicky-sync-payment-status` Edge Function) and receiving `Finished` status.

**NEVER mark an order paid based on:**
- ❌ The success redirect URL being visited
- ❌ The webhook body's `newStatus` field alone (you must re-query)
- ❌ Client-side flags or localStorage
- ❌ The user claiming they paid

**Why:** Users can navigate directly to the success URL without paying. Webhooks can be spoofed or delayed. Only Nicky's server is the source of truth.

**Code Pattern:**
```typescript
// ✅ CORRECT: Always re-query Nicky before trusting the status
const remoteStatus = await nicky.getPaymentRequestById(env, paymentRequestId);
if (remoteStatus.status === "Finished") {
  // Mark order as paid
} else if (remoteStatus.status === "PaymentValidationRequired") {
  // Keep order open, never unlock content
} else {
  // Still pending
}
```

**LLM Specific:** If you see code that reads a status from `nicky_orders.last_remote_status` and trusts it, you've caught a bug. Always do a live re-query from Nicky during reconciliation or before granting access.

---

### 3b. **Transform Internal Payloads Into Nicky's Public Create DTO**

**The Rule:**
Your app's internal create-payment request body does not need to match Nicky's
public API shape. But the final server-side call to
`POST /api/public/PaymentRequestPublicApi/create` MUST match Nicky's DTO exactly.

**Nicky's required public create shape:**
```typescript
{
  blockchainAssetId: string;
  amountExpectedNative: string | number;
  billDetails: {
    invoiceReference: string;
    description: string;
  };
  requester: {
    email: string;
    name: string;
  };
  sendNotification: boolean;
  successUrl?: string;
  cancelUrl?: string;
}
```

**Common integration mistake:**
```typescript
// ❌ Wrong for the public Nicky API
{
  blockchainAssetId,
  amountExpectedNative,
  invoiceReference,
  description,
  payerEmail,
  payerName,
  acceptedAssetId,
}
```

This flat payload looks plausible, but Nicky's backend will reject it because
`billDetails` and `requester` are required nested properties.

**Correct pattern:**
```typescript
// Browser -> your Edge Function
{ selectedAssetId, name, email }

// Your Edge Function -> Nicky public API
{
  blockchainAssetId: selectedAsset.id,
  amountExpectedNative,
  billDetails: {
    invoiceReference,
    description,
  },
  requester: {
    email,
    name,
  },
  sendNotification: true,
  successUrl,
  cancelUrl,
}
```

**Important:**
- `acceptedAssetId` is not part of the public Nicky create DTO.
- Use the accepted asset's `id` as `blockchainAssetId`.
- If you keep an internal `selectedAssetId` field, transform it before the
  external API call instead of forwarding it blindly.

---

### 4. **Metadata Object Must Keep Its Size Limit**

**The Rule:**
The `metadata` field in `nicky-create-payment` accepts a client-supplied object.
This can be abused to write extremely large rows, so the function currently caps
serialized metadata at 10 KB.

**Current Mitigation:**
- Serialized metadata is capped at 10 KB.
- Oversized metadata returns a validation error before any Nicky Payment Request
  is created.
- Keep this guard in place if you refactor validation.

**Current Behavior:**
```typescript
const metadata =
  typeof body.metadata === "object" && body.metadata !== null
    ? (body.metadata as Record<string, unknown>)
    : {};

const MAX_METADATA_BYTES = 10_000;
const metadataStr = JSON.stringify(metadata);
const metadataBytes = new Blob([metadataStr]).size;
if (metadataBytes > MAX_METADATA_BYTES) {
  throw new ValidationError(
    `Metadata exceeds maximum size of ${MAX_METADATA_BYTES} bytes (${metadataBytes} provided).`,
  );
}
```

**LLM Specific:** Do not remove this check. If you enhance metadata validation,
make it stricter without increasing the accepted size unless the user explicitly
asks for a different limit.

---

### 5. **CORS Headers Allow Origin "*"** — Be Aware

**Current Implementation:**
```typescript
// In supabase/functions/_shared/cors.ts:
"Access-Control-Allow-Origin": "*",
```

**Why This Is OK:**
- The Edge Functions authenticate using the Supabase `anon` key (sent as the `apikey` header)
- CORS `*` does not bypass that authentication — the anon key must be valid
- The functions require Supabase JWT verification (see `config.toml`)
- The webhook function explicitly does NOT use CORS (it's server-to-server)

**Why We Don't Restrict to Specific Origins:**
- The kit is designed to be copied into multiple apps, each with a different domain
- Making the kit more restrictive would require per-app configuration

**LLM Specific:** Do NOT tighten CORS to a specific origin without user consent, because:
1. It breaks the kit for legitimate cross-origin deployments
2. CORS alone is not the security boundary here (authentication is)
3. If you need per-app origin validation, implement it in the consuming app, not in the kit

---

## 🟡 Medium-Priority Improvements (Nice to Have)

### 6. **Email Validation Should Stay Conservative**

**Current:**
```typescript
const EMAIL_RE = /^[a-zA-Z0-9._%-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
```

**Notes:**
- This is intentionally lightweight runtime validation, not SMTP/DNS validation.
- Keep obvious invalid values out (`@example.com`, `user@`, spaces, no TLD).

**LLM Specific:** If you enhance email validation, test against common invalid cases:
- `@example.com` (no user)
- `user@` (no domain)
- `user example@example.com` (space)
- `user@example` (no TLD)

---

### 7. **String Fields Lack Size Limits**

**Current Behavior:**
```typescript
const invoiceReference = asString(body.invoiceReference, "invoiceReference");
const description = asString(body.description, "description");
const payerName = asString(body.payerName, "payerName");
// No length validation — could be 10 MB each
```

**Recommended Limits:**
- `invoiceReference`: 256 chars (typical order ID)
- `description`: 512 chars (bill description)
- `payerName`: 256 chars (typical name field)

**LLM Specific:** If adding length validation, do it in the validators in `validate.ts`:
```typescript
export function asString(value: unknown, field: string, maxLength = 1000): string {
  const s = asString(value, field);
  if (s.length > maxLength) {
    throw new ValidationError(`"${field}" exceeds maximum length of ${maxLength}.`);
  }
  return s;
}
```

---

### 8. **Frontend URL Normalization Fails Loudly**

**Current:**
```typescript
export function normalizeFunctionsBaseUrl(rawBaseUrl: string): string {
  // ...
  try {
    const url = new URL(trimmed);
    // ...
  } catch {
    throw new Error(`Invalid functions base URL: ${trimmed}`);
  }
}
```

**LLM Specific:** Failing loudly is better than silently accepting bad input. If the user provides a bad base URL, they should know immediately, not discover it when a payment request fails.

---

## 🟢 Current Best Practices (Maintain These)

### ✅ Idempotency is Race-Safe
The `nicky_create_or_claim_order` RPC prevents duplicate Nicky payment requests even under concurrent load. Keep this logic as-is.

### ✅ Authorized Webhook Events Stored Before Processing
Authorized events are inserted into `nicky_webhook_events` with a `processing_status` before any processing. This creates an audit trail even if processing fails. Unauthorized source IPs are rejected before the body is read or stored.

### ✅ Webhook IP Validation is Done Early
IP validation happens BEFORE reading/parsing the body, preventing storage-amplification attacks.

### ✅ Re-Query Before Marking Paid
The webhook ALWAYS re-queries Nicky by `itemId` and only marks paid if Nicky returns `Finished`. This is non-negotiable and well-implemented.

### ✅ RLS Enabled with No Permissive Policies
All kit tables have Row Level Security enabled. The Edge Functions use the service-role key, which bypasses RLS.

---

## 🔍 Pre-Deployment Checklist for LLM Implementations

Before the consuming app goes live, verify:

- [ ] `NICKY_API_KEY` is set as a Supabase secret (not in `.env.local` or committed files)
- [ ] Setup began with the exact YES/NO account question; signup-returned keys were reused directly and existing keys were never echoed by the assistant
- [ ] For agent signup, the user explicitly declared both email confirmation and Terms/Privacy acceptance before the agreement API call
- [ ] API-key validation distinguished an authenticated empty accepted-assets list from an invalid key
- [ ] `NICKY_RECONCILIATION_SECRET` is set as a Supabase secret and is a long random string
- [ ] Frontend code never imports or references `NICKY_API_KEY`
- [ ] Consuming app has server-side authentication and order validation before calling `nicky-create-payment`
- [ ] Consuming app re-queries Nicky before unlocking paid features (via `nicky-sync-payment-status`)
- [ ] Webhook is configured once after key validation and deployment, using idempotent assisted setup or the manual fallback
- [ ] Merchant Configuration, Wallet Connections, and Payment Routes are confirmed for every accepted asset; no custody material was collected by the installer
- [ ] Scheduled reconciliation is running every few minutes (optional but recommended)
- [ ] Rate limiting is configured (app auth + WAF; optionally the built-in soft cap)
- [ ] Success and cancel redirect URLs are configured and tested
- [ ] `paid_at` is gated on current `status === "paid"`, not just existence of `paid_at`
- [ ] All CI checks pass: `npm run typecheck && npm test && npm run typecheck:edge`

---

## 📝 Common LLM Mistakes to Avoid

| ❌ Mistake | ✅ Correct Approach |
|-----------|-------------------|
| Putting API key in frontend `.env` | Store as Supabase secret, read in Edge Function |
| Frontend passing user-supplied amounts to nicky-create-payment | Frontend → your backend → lookup amount in DB → nicky-create-payment |
| Frontend passing user-supplied invoiceReference to nicky-create-payment | Frontend → your backend → lookup invoice in DB → nicky-create-payment |
| Trusting the redirect URL as proof of payment | Always re-query Nicky server-side first |
| Calling Nicky API directly from React | Route through Edge Function (Nicky validates account + asset; your app validates order) |
| Skipping IP validation on webhooks | Check `x-forwarded-for` before reading body |
| Removing metadata size limits | Keep the 10 KB serialized metadata cap |
| Marking `paid` on webhook body alone | Always re-query Nicky before trusting status |
| Hardcoding a single currency | Load assets live from Nicky at runtime |
| Creating webhooks via an Edge Function | Configure once during setup; deployed runtime only processes webhooks |
| Trusting `paid_at` alone for entitlement | Gate on current `status === "paid"` |

---

## 📚 Cross-References

- [`docs/security.md`](security.md) — Full security model (13 sections, very detailed)
- [`docs/lovable-install-prompt.md`](lovable-install-prompt.md) — AI-facing copy-paste prompt with strict rules
- [`docs/production-checklist.md`](production-checklist.md) — Pre-launch gates
- [`docs/operations.md`](operations.md) — Day-2 troubleshooting and recovery procedures
