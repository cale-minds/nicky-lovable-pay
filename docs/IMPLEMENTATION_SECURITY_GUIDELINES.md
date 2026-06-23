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
   // ❌ NEVER pass user input directly
   // ❌ NEVER call nicky-create-payment from React
   
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

**LLM Specific:** If you see a feature request like "let users pay with crypto," always ask:
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

### 4. **Metadata Object Must Have Size Limits**

**The Rule:**
The `metadata` field in `nicky-create-payment` accepts a client-supplied object. This can be abused to write extremely large rows.

**Mitigation (NOT currently implemented):**
- Cap metadata size at ~5-10 KB
- Validate that metadata keys/values are strings, numbers, booleans, or null (no nested objects)
- Log warnings if metadata approaches the limit

**Current Behavior:**
```typescript
// In nicky-create-payment/index.ts, lines 133-136:
const metadata =
  typeof body.metadata === "object" && body.metadata !== null
    ? (body.metadata as Record<string, unknown>)
    : {};
// ⚠️ No size check — a malicious client can pass 1 MB of data
```

**LLM Specific:** If enhancing `nicky-create-payment`, add a metadata size check:
```typescript
const maxMetadataBytes = 10_000; // 10 KB
const metadataStr = JSON.stringify(metadata);
if (new Blob([metadataStr]).size > maxMetadataBytes) {
  throw new ValidationError("Metadata exceeds size limit.");
}
```

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

### 6. **Email Validation is Simplistic**

**Current:**
```typescript
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
```

**Issues:**
- Accepts `a@b.c` (valid technically, but unusual)
- Does not validate against SMTP/DNS
- Does not reject obviously invalid formats like `@example.com` or `user@.com`

**Improvement:**
```typescript
const EMAIL_RE = /^[a-zA-Z0-9._%-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
```

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

### 8. **Frontend URL Normalization Can Accept Malformed URLs**

**Current:**
```typescript
export function normalizeFunctionsBaseUrl(rawBaseUrl: string): string {
  // ...
  try {
    const url = new URL(trimmed);
    // ...
  } catch {
    return trimmed; // ⚠️ Returns the raw string if URL() throws
  }
}
```

**Risk:**
If the URL is malformed, the function returns the untrimmed input, which could be used in string concatenation and create incorrect endpoints.

**Better:**
```typescript
catch {
  throw new Error(`Invalid functions base URL: ${trimmed}`);
}
```

**LLM Specific:** Failing loudly is better than silently accepting bad input. If the user provides a bad base URL, they should know immediately, not discover it when a payment request fails.

---

## 🟢 Current Best Practices (Maintain These)

### ✅ Idempotency is Race-Safe
The `nicky_create_or_claim_order` RPC prevents duplicate Nicky payment requests even under concurrent load. Keep this logic as-is.

### ✅ Webhook Events Stored Before Processing
Events are inserted into `nicky_webhook_events` with a `processing_status` before any processing. This creates an audit trail even if processing fails.

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
- [ ] `NICKY_RECONCILIATION_SECRET` is set as a Supabase secret and is a long random string
- [ ] Frontend code never imports or references `NICKY_API_KEY`
- [ ] Consuming app has server-side authentication and order validation before calling `nicky-create-payment`
- [ ] Consuming app re-queries Nicky before unlocking paid features (via `nicky-sync-payment-status`)
- [ ] Webhook is configured in Nicky dashboard pointing to the correct URL (no local script creates it)
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
| Using metadata without size limits | Cap at ~5-10 KB and validate types |
| Marking `paid` on webhook body alone | Always re-query Nicky before trusting status |
| Hardcoding a single currency | Load assets live from Nicky at runtime |
| Creating webhooks via an Edge Function | Configure once manually in Nicky dashboard |
| Trusting `paid_at` alone for entitlement | Gate on current `status === "paid"` |

---

## 📚 Cross-References

- [`docs/security.md`](security.md) — Full security model (13 sections, very detailed)
- [`docs/lovable-install-prompt.md`](lovable-install-prompt.md) — AI-facing copy-paste prompt with strict rules
- [`docs/production-checklist.md`](production-checklist.md) — Pre-launch gates
- [`docs/operations.md`](operations.md) — Day-2 troubleshooting and recovery procedures
