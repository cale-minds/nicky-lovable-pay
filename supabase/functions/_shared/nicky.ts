// Thin client for the Nicky public API.
//
// The Nicky API key is passed in by the caller (read from env) and sent as the
// `x-api-key` header. This module performs no logging of the key.
//
// Scope: this plugin only CREATES payment requests, LOOKS UP their status, and
// READS accepted assets. It intentionally does NOT register, list, or delete
// webhooks — webhooks are configured once, outside the plugin runtime (see
// docs/webhooks.md).
//
// ⚠️ LLM SECURITY CRITICAL: If you add new functions that call Nicky or
// integrate other parts of the API, NEVER return the `apiKey` field in any
// response to the client. The key should ONLY be sent as the `x-api-key`
// header to Nicky, never logged or exposed. See docs/security.md section 1.

import type { NickyEnv } from "./env.ts";

// Re-exported so existing importers keep working; the implementation lives in
// the pure, testable status module.
export { mapRemoteStatus } from "./status.ts";
export type { NickyLocalStatus, NickyRemoteStatus } from "./status.ts";

export interface CreatePaymentRequestBody {
  blockchainAssetId: string;
  amountExpectedNative: string;
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

/**
 * Loose shape of the Nicky create/lookup responses. We retain the full raw
 * payload for audit; the contractually-required identifiers are extracted by
 * `getRequiredPaymentRequestIdentifiers` in `./payment-identifiers.ts`.
 */
export interface NickyPaymentRequest {
  id?: string;
  bill?: { shortId?: string; [key: string]: unknown };
  status?: string;
  [key: string]: unknown;
}

function authHeaders(env: NickyEnv): Record<string, string> {
  return {
    "x-api-key": env.apiKey,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

async function parseJsonSafe(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { rawText: text };
  }
}

export class NickyApiError extends Error {
  status: number;
  body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "NickyApiError";
    this.status = status;
    this.body = body;
  }
}

/** Builds the payer-facing redirect URL from a short id. */
export function buildPaymentUrl(env: NickyEnv, shortId: string): string {
  return `${env.payBaseUrl}/home?paymentId=${encodeURIComponent(shortId)}`;
}

/** POST /api/public/PaymentRequestPublicApi/create */
export async function createPaymentRequest(
  env: NickyEnv,
  body: CreatePaymentRequestBody,
): Promise<NickyPaymentRequest> {
  const res = await fetch(
    `${env.apiBaseUrl}/api/public/PaymentRequestPublicApi/create`,
    { method: "POST", headers: authHeaders(env), body: JSON.stringify(body) },
  );
  const data = await parseJsonSafe(res);
  if (!res.ok) {
    throw new NickyApiError("Failed to create Nicky payment request", res.status, data);
  }
  return data as NickyPaymentRequest;
}

/** GET /api/public/PaymentRequestPublicApi/get-by-id?id=<uuid> */
export async function getPaymentRequestById(
  env: NickyEnv,
  id: string,
): Promise<NickyPaymentRequest> {
  const url = `${env.apiBaseUrl}/api/public/PaymentRequestPublicApi/get-by-id?id=${encodeURIComponent(id)}`;
  const res = await fetch(url, { headers: authHeaders(env) });
  const data = await parseJsonSafe(res);
  if (!res.ok) {
    throw new NickyApiError("Failed to look up Nicky payment request by id", res.status, data);
  }
  return data as NickyPaymentRequest;
}

/** GET /api/public/PaymentRequestPublicApi/get-by-short-id?shortId=<shortId> */
export async function getPaymentRequestByShortId(
  env: NickyEnv,
  shortId: string,
): Promise<NickyPaymentRequest> {
  const url = `${env.apiBaseUrl}/api/public/PaymentRequestPublicApi/get-by-short-id?shortId=${encodeURIComponent(shortId)}`;
  const res = await fetch(url, { headers: authHeaders(env) });
  const data = await parseJsonSafe(res);
  if (!res.ok) {
    throw new NickyApiError("Failed to look up Nicky payment request by short id", res.status, data);
  }
  return data as NickyPaymentRequest;
}

/**
 * GET /AcceptedAsset/get-for-user
 *
 * Returns the raw accepted-assets payload. Normalization (and empty/invalid
 * handling) is done by `normalizeAcceptedAssets` in `./assets.ts`.
 *
 * INTENTIONAL: this path is exactly `/AcceptedAsset/get-for-user` and does NOT
 * include the `/api/public` prefix that the PaymentRequest endpoints use. This
 * matches the current Nicky API contract for accepted assets — do NOT "fix" it
 * to `/api/public/AcceptedAsset/get-for-user`. Verify the exact path against the
 * live Nicky API during E2E before production.
 */
export async function getAcceptedAssets(env: NickyEnv): Promise<unknown> {
  // NOTE: no `/api/public` prefix here — intentional (see doc comment above).
  const res = await fetch(`${env.apiBaseUrl}/AcceptedAsset/get-for-user`, {
    headers: authHeaders(env),
  });
  const data = await parseJsonSafe(res);
  if (!res.ok) {
    throw new NickyApiError("Failed to fetch accepted assets", res.status, data);
  }
  return data;
}
