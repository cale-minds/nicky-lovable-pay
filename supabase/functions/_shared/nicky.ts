// Thin client for the Nicky public API plus shared domain helpers.
//
// The Nicky API key is passed in by the caller (read from env) and sent as the
// `x-api-key` header. This module performs no logging of the key.

import type { NickyEnv } from "./env.ts";

export type NickyRemoteStatus =
  | "PaymentPending"
  | "PaymentValidationRequired"
  | "Finished"
  | "Canceled";

export type NickyLocalStatus =
  | "idle"
  | "creating_payment"
  | "redirecting_to_nicky"
  | "waiting_payment"
  | "webhook_received"
  | "syncing_status"
  | "paid"
  | "validation_required"
  | "canceled"
  | "expired_or_abandoned"
  | "failed";

/** Maps a Nicky remote status to the kit's local status model. */
export function mapRemoteStatus(remote: string | undefined): NickyLocalStatus {
  switch (remote) {
    case "PaymentPending":
      return "waiting_payment";
    case "PaymentValidationRequired":
      return "validation_required";
    case "Finished":
      return "paid";
    case "Canceled":
      return "canceled";
    default:
      return "failed";
  }
}

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

/** Loose shape of the Nicky create/lookup responses. We keep the raw payload. */
export interface NickyPaymentRequest {
  id?: string;
  // Nicky returns the short/bill id under one of these keys depending on the
  // endpoint version; we probe all of them.
  shortId?: string;
  billId?: string;
  billShortId?: string;
  status?: NickyRemoteStatus;
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

/** Extracts the short id from a Nicky payment-request payload. */
export function extractShortId(pr: NickyPaymentRequest | null | undefined): string | undefined {
  if (!pr) return undefined;
  return (
    (pr.shortId as string) ||
    (pr.billShortId as string) ||
    (pr.billId as string) ||
    // Some responses nest bill details.
    ((pr.billDetails as Record<string, unknown> | undefined)?.shortId as string) ||
    undefined
  );
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

// ---------------------------------------------------------------------------
// Webhook management
// ---------------------------------------------------------------------------

export type NickyWebhookType =
  | "PaymentRequest_ReportAdded"
  | "PaymentRequest_StatusChanged";

export interface NickyWebhook {
  id?: string;
  webHookType?: NickyWebhookType;
  url?: string;
  callbackUrl?: string;
  [key: string]: unknown;
}

/** GET /api/public/WebHookApi/list */
export async function listWebhooks(env: NickyEnv): Promise<NickyWebhook[]> {
  const res = await fetch(`${env.apiBaseUrl}/api/public/WebHookApi/list`, {
    headers: authHeaders(env),
  });
  const data = await parseJsonSafe(res);
  if (!res.ok) {
    throw new NickyApiError("Failed to list Nicky webhooks", res.status, data);
  }
  // Tolerate either a bare array or an object wrapping `items`/`data`.
  if (Array.isArray(data)) return data as NickyWebhook[];
  const wrapped = data as Record<string, unknown> | null;
  const items = (wrapped?.items ?? wrapped?.data) as NickyWebhook[] | undefined;
  return items ?? [];
}

/** POST /api/public/WebHookApi/create */
export async function createWebhook(
  env: NickyEnv,
  webHookType: NickyWebhookType,
  url: string,
): Promise<NickyWebhook> {
  const res = await fetch(`${env.apiBaseUrl}/api/public/WebHookApi/create`, {
    method: "POST",
    headers: authHeaders(env),
    body: JSON.stringify({ webHookType, url }),
  });
  const data = await parseJsonSafe(res);
  if (!res.ok) {
    throw new NickyApiError("Failed to create Nicky webhook", res.status, data);
  }
  return data as NickyWebhook;
}

/** POST /api/public/WebHookApi/delete */
export async function deleteWebhook(env: NickyEnv, id: string): Promise<void> {
  const res = await fetch(`${env.apiBaseUrl}/api/public/WebHookApi/delete`, {
    method: "POST",
    headers: authHeaders(env),
    body: JSON.stringify({ id }),
  });
  if (!res.ok) {
    const data = await parseJsonSafe(res);
    throw new NickyApiError("Failed to delete Nicky webhook", res.status, data);
  }
}
