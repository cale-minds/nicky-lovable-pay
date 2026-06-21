import { describe, it, expect } from "vitest";
import {
  isOverRateLimit,
  decideClaimAction,
  type ClaimOutcome,
} from "../supabase/functions/_shared/create-payment-helpers";

describe("isOverRateLimit", () => {
  it("is disabled when max <= 0", () => {
    expect(isOverRateLimit(1000, 0)).toBe(false);
    expect(isOverRateLimit(1000, -1)).toBe(false);
  });
  it("blocks at or above the cap", () => {
    expect(isOverRateLimit(5, 5)).toBe(true);
    expect(isOverRateLimit(6, 5)).toBe(true);
  });
  it("allows below the cap", () => {
    expect(isOverRateLimit(4, 5)).toBe(false);
  });
});

describe("decideClaimAction", () => {
  const base: ClaimOutcome = {
    orderId: "o1",
    status: "creating_payment",
    paymentUrl: null,
    nickyPaymentRequestId: null,
    nickyShortId: null,
    claimed: false,
  };

  it("returns existing when a payment_url is present (idempotent hit)", () => {
    expect(decideClaimAction({ ...base, paymentUrl: "https://pay/x", claimed: false })).toBe(
      "return_existing",
    );
    // payment_url wins even if claimed somehow true
    expect(decideClaimAction({ ...base, paymentUrl: "https://pay/x", claimed: true })).toBe(
      "return_existing",
    );
  });

  it("owns creation when claimed and no URL yet", () => {
    expect(decideClaimAction({ ...base, claimed: true })).toBe("owns_creation");
  });

  it("reports in_progress when not claimed and no URL (another caller owns it)", () => {
    expect(decideClaimAction({ ...base, claimed: false })).toBe("in_progress");
  });
});
