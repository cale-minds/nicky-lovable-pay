// Pure helpers for extracting Payment Request identifiers from the Nicky
// create/lookup response. No Deno/Supabase imports — unit-testable with vitest.
//
// The Nicky create endpoint
//   POST /api/public/PaymentRequestPublicApi/create
// returns, per the API contract:
//   response.id              -> Payment Request UUID
//   response.bill.shortId    -> short id used in the payment link
//
// We do NOT probe legacy/alternate field names. A missing identifier is an
// exceptional invalid-protocol case, not a normal fallback.

export interface PaymentRequestIdentifiers {
  paymentRequestId: string;
  shortId: string;
}

/** Thrown when the Nicky response violates the expected create contract. */
export class PaymentRequestContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentRequestContractError";
  }
}

function readBill(response: unknown): Record<string, unknown> | undefined {
  if (!response || typeof response !== "object") return undefined;
  const bill = (response as Record<string, unknown>).bill;
  return bill && typeof bill === "object" ? (bill as Record<string, unknown>) : undefined;
}

/**
 * Strictly extracts the required identifiers from a Nicky create response.
 *
 * Throws `PaymentRequestContractError` if `response.id` or
 * `response.bill.shortId` is missing or empty.
 */
export function getRequiredPaymentRequestIdentifiers(response: unknown): PaymentRequestIdentifiers {
  const obj = response && typeof response === "object" ? (response as Record<string, unknown>) : undefined;

  const id = typeof obj?.id === "string" ? obj.id.trim() : "";
  if (!id) {
    throw new PaymentRequestContractError(
      "Nicky create response is missing the required `id` (Payment Request UUID).",
    );
  }

  const shortId = (() => {
    const bill = readBill(response);
    return typeof bill?.shortId === "string" ? bill.shortId.trim() : "";
  })();
  if (!shortId) {
    throw new PaymentRequestContractError(
      "Nicky create response is missing the required `bill.shortId`.",
    );
  }

  return { paymentRequestId: id, shortId };
}

/**
 * Soft read of `response.bill.shortId` for status-lookup responses, where the
 * short id is informational (used to backfill linkage) rather than required.
 * Returns undefined if absent. Does NOT probe alternate field names.
 */
export function getShortIdFromResponse(response: unknown): string | undefined {
  const bill = readBill(response);
  const shortId = typeof bill?.shortId === "string" ? bill.shortId.trim() : "";
  return shortId || undefined;
}
