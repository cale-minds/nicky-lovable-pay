import { describe, it, expect } from "vitest";
import {
  getRequiredPaymentRequestIdentifiers,
  getShortIdFromResponse,
  PaymentRequestContractError,
} from "../supabase/functions/_shared/payment-identifiers.ts";

describe("getRequiredPaymentRequestIdentifiers", () => {
  it("extracts id and bill.shortId from a valid create response", () => {
    const result = getRequiredPaymentRequestIdentifiers({
      id: "11111111-2222-3333-4444-555555555555",
      bill: { shortId: "ABCDE" },
    });
    expect(result).toEqual({
      paymentRequestId: "11111111-2222-3333-4444-555555555555",
      shortId: "ABCDE",
    });
  });

  it("trims whitespace around the identifiers", () => {
    const result = getRequiredPaymentRequestIdentifiers({
      id: "  uuid-1  ",
      bill: { shortId: "  XYZ  " },
    });
    expect(result).toEqual({ paymentRequestId: "uuid-1", shortId: "XYZ" });
  });

  it("throws when id is missing", () => {
    expect(() => getRequiredPaymentRequestIdentifiers({ bill: { shortId: "ABCDE" } })).toThrowError(
      PaymentRequestContractError,
    );
    expect(() => getRequiredPaymentRequestIdentifiers({ bill: { shortId: "ABCDE" } })).toThrow(
      /missing the required `id`/,
    );
  });

  it("throws when id is empty", () => {
    expect(() =>
      getRequiredPaymentRequestIdentifiers({ id: "   ", bill: { shortId: "ABCDE" } }),
    ).toThrowError(PaymentRequestContractError);
  });

  it("throws when bill.shortId is missing", () => {
    expect(() => getRequiredPaymentRequestIdentifiers({ id: "uuid-1" })).toThrowError(
      PaymentRequestContractError,
    );
    expect(() => getRequiredPaymentRequestIdentifiers({ id: "uuid-1", bill: {} })).toThrow(
      /missing the required `bill.shortId`/,
    );
  });

  it("does NOT probe legacy/alternate short-id fields", () => {
    // shortId / billShortId / billId at the top level must be ignored.
    expect(() =>
      getRequiredPaymentRequestIdentifiers({
        id: "uuid-1",
        shortId: "LEGACY",
        billShortId: "LEGACY2",
        billId: "LEGACY3",
      }),
    ).toThrowError(PaymentRequestContractError);
  });

  it("throws on a non-object response", () => {
    expect(() => getRequiredPaymentRequestIdentifiers(null)).toThrowError(
      PaymentRequestContractError,
    );
  });
});

describe("getShortIdFromResponse", () => {
  it("reads bill.shortId when present", () => {
    expect(getShortIdFromResponse({ bill: { shortId: "ABCDE" } })).toBe("ABCDE");
  });

  it("returns undefined when absent (no probing of alternates)", () => {
    expect(getShortIdFromResponse({ shortId: "LEGACY" })).toBeUndefined();
    expect(getShortIdFromResponse({})).toBeUndefined();
    expect(getShortIdFromResponse(null)).toBeUndefined();
  });
});
