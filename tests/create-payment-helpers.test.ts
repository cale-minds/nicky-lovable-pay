import { describe, it, expect } from "vitest";
import {
  isOverRateLimit,
  decideClaimAction,
  mergeMetadata,
  buildPersistFailureBody,
  PERSIST_FAILURE_MESSAGE,
  type ClaimOutcome,
} from "../supabase/functions/_shared/create-payment-helpers";

describe("mergeMetadata", () => {
  it("preserves existing app-specific metadata while adding flags", () => {
    const existing = { userId: "u1", sku: "PRO", cartId: "c9" };
    const merged = mergeMetadata(existing, { needs_operator_review: true });
    expect(merged).toEqual({
      userId: "u1",
      sku: "PRO",
      cartId: "c9",
      needs_operator_review: true,
    });
  });

  it("patch overrides only the same keys", () => {
    const merged = mergeMetadata({ a: 1, flag: false }, { flag: true });
    expect(merged).toEqual({ a: 1, flag: true });
  });

  it("handles null/undefined existing metadata safely", () => {
    expect(mergeMetadata(null, { x: 1 })).toEqual({ x: 1 });
    expect(mergeMetadata(undefined, { x: 1 })).toEqual({ x: 1 });
  });

  it("does not mutate the existing object", () => {
    const existing = { a: 1 };
    mergeMetadata(existing, { b: 2 });
    expect(existing).toEqual({ a: 1 });
  });
});

describe("buildPersistFailureBody / PERSIST_FAILURE_MESSAGE", () => {
  it("returns only safe operational fields", () => {
    const body = buildPersistFailureBody("order-123");
    expect(body).toEqual({ orderId: "order-123", retryable: false, needsReview: true });
  });

  it("never exposes payment identifiers", () => {
    const body = buildPersistFailureBody("order-123") as Record<string, unknown>;
    expect(body).not.toHaveProperty("paymentUrl");
    expect(body).not.toHaveProperty("nickyShortId");
    expect(body).not.toHaveProperty("nickyPaymentRequestId");
  });

  it("has a clear, actionable message", () => {
    expect(PERSIST_FAILURE_MESSAGE).toMatch(/created at Nicky/i);
    expect(PERSIST_FAILURE_MESSAGE).toMatch(/manual review/i);
  });
});

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

  // The Edge Function passes the count of PREVIOUS orders in the window
  // (current order excluded via `.neq("id", orderId)`), so `recentCount` here is
  // "how many were created before this one". The cap should allow up to N and
  // block the (N+1)th.
  describe("with current order excluded from the count", () => {
    it("cap 1: first new order allowed (0 previous), second blocked (1 previous)", () => {
      expect(isOverRateLimit(0, 1)).toBe(false); // creating the 1st
      expect(isOverRateLimit(1, 1)).toBe(true); // creating the 2nd
    });

    it("cap 5: first five allowed (0..4 previous), sixth blocked (5 previous)", () => {
      for (let previous = 0; previous < 5; previous++) {
        expect(isOverRateLimit(previous, 5)).toBe(false);
      }
      expect(isOverRateLimit(5, 5)).toBe(true); // creating the 6th
    });
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
    needsReview: false,
  };

  it("returns existing when a payment_url is present (idempotent hit)", () => {
    expect(decideClaimAction({ ...base, paymentUrl: "https://pay/x", claimed: false })).toBe(
      "return_existing",
    );
    // payment_url wins even if claimed somehow true
    expect(decideClaimAction({ ...base, paymentUrl: "https://pay/x", claimed: true })).toBe(
      "return_existing",
    );
    // payment_url even wins over a needsReview flag (the order is usable).
    expect(decideClaimAction({ ...base, paymentUrl: "https://pay/x", needsReview: true })).toBe(
      "return_existing",
    );
  });

  it("needs_review when a prior attempt reached Nicky without linkage", () => {
    expect(decideClaimAction({ ...base, needsReview: true, claimed: false })).toBe("needs_review");
  });

  it("owns creation when claimed and no URL yet", () => {
    expect(decideClaimAction({ ...base, claimed: true })).toBe("owns_creation");
  });

  it("reports in_progress when not claimed and no URL (another caller owns it)", () => {
    expect(decideClaimAction({ ...base, claimed: false })).toBe("in_progress");
  });
});

// The rate-limit ORDERING (idempotent hits exempt; only new creation is capped)
// is enforced in the Edge Function control flow, expressed here as the contract
// the function relies on: only the "owns_creation" action proceeds to the rate
// check + Nicky call. return_existing / in_progress / needs_review all short-
// circuit before the cap is consulted.
describe("rate-limit ordering contract", () => {
  const base: ClaimOutcome = {
    orderId: "o1",
    status: "creating_payment",
    paymentUrl: null,
    nickyPaymentRequestId: null,
    nickyShortId: null,
    claimed: false,
    needsReview: false,
  };

  it("an existing payment URL short-circuits before any creation/rate-limit", () => {
    const action = decideClaimAction({ ...base, paymentUrl: "https://pay/x" });
    expect(action).toBe("return_existing");
    // Callers must return the URL on this action without consulting the cap.
  });

  it("only owns_creation reaches the creation path where the cap applies", () => {
    const willCreate = (o: ClaimOutcome) => decideClaimAction(o) === "owns_creation";
    expect(willCreate({ ...base, claimed: true })).toBe(true);
    expect(willCreate({ ...base, paymentUrl: "https://pay/x" })).toBe(false);
    expect(willCreate({ ...base, claimed: false })).toBe(false); // in_progress
    expect(willCreate({ ...base, needsReview: true })).toBe(false);
  });
});
