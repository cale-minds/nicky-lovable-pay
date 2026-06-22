import { describe, it, expect } from "vitest";
import {
  shouldSetPaidAt,
  buildReconcileUpdate,
} from "../supabase/functions/_shared/reconcile-helpers";

describe("shouldSetPaidAt", () => {
  it("sets paid_at on first transition to paid", () => {
    expect(shouldSetPaidAt("paid", null)).toBe(true);
    expect(shouldSetPaidAt("paid", undefined)).toBe(true);
  });

  it("does NOT overwrite an existing paid_at", () => {
    expect(shouldSetPaidAt("paid", "2026-01-01T00:00:00.000Z")).toBe(false);
  });

  it("never sets paid_at for non-paid statuses", () => {
    expect(shouldSetPaidAt("waiting_payment", null)).toBe(false);
    expect(shouldSetPaidAt("validation_required", null)).toBe(false);
    expect(shouldSetPaidAt("canceled", null)).toBe(false);
  });
});

describe("buildReconcileUpdate", () => {
  const baseOrder = {
    nicky_payment_request_id: "uuid-1",
    nicky_short_id: "ABCDE",
    paid_at: null,
  };

  it("always updates status and last_remote_status", () => {
    const u = buildReconcileUpdate({
      localStatus: "waiting_payment",
      remoteStatus: "PaymentPending",
      order: baseOrder,
    });
    expect(u.status).toBe("waiting_payment");
    expect(u.last_remote_status).toBe("PaymentPending");
    expect(u.paid_at).toBeUndefined();
  });

  it("sets paid_at once when transitioning to paid", () => {
    const u = buildReconcileUpdate({
      localStatus: "paid",
      remoteStatus: "Finished",
      order: { ...baseOrder, paid_at: null },
      now: "2026-06-21T12:00:00.000Z",
    });
    expect(u.paid_at).toBe("2026-06-21T12:00:00.000Z");
  });

  it("does not set paid_at when already paid earlier", () => {
    const u = buildReconcileUpdate({
      localStatus: "paid",
      remoteStatus: "Finished",
      order: { ...baseOrder, paid_at: "2020-01-01T00:00:00.000Z" },
      now: "2026-06-21T12:00:00.000Z",
    });
    expect(u.paid_at).toBeUndefined();
  });

  it("backfills linkage only when missing", () => {
    const u = buildReconcileUpdate({
      localStatus: "waiting_payment",
      order: { nicky_payment_request_id: null, nicky_short_id: null, paid_at: null },
      resolvedRequestId: "uuid-2",
      resolvedShortId: "ZZZZZ",
    });
    expect(u.nicky_payment_request_id).toBe("uuid-2");
    expect(u.nicky_short_id).toBe("ZZZZZ");
  });

  it("does not overwrite existing linkage", () => {
    const u = buildReconcileUpdate({
      localStatus: "waiting_payment",
      order: baseOrder,
      resolvedRequestId: "different",
      resolvedShortId: "DIFF",
    });
    expect(u.nicky_payment_request_id).toBeUndefined();
    expect(u.nicky_short_id).toBeUndefined();
  });

  // Business rule: `paid` is NOT terminal. A Payment Request can move from
  // Finished back to PaymentPending; local status must follow the latest trusted
  // Nicky lookup, while paid_at (first-confirmed-paid) is preserved.
  it("allows paid -> waiting_payment when Nicky returns PaymentPending, preserving paid_at", () => {
    const u = buildReconcileUpdate({
      localStatus: "waiting_payment",
      remoteStatus: "PaymentPending",
      order: { ...baseOrder, paid_at: "2026-01-01T00:00:00.000Z" },
      now: "2026-06-21T12:00:00.000Z",
    });
    expect(u.status).toBe("waiting_payment"); // status follows the latest lookup
    expect(u.last_remote_status).toBe("PaymentPending");
    expect(u.paid_at).toBeUndefined(); // not in the patch => existing value preserved
  });

  it("does not re-stamp paid_at if an order returns to paid after having been paid before", () => {
    const u = buildReconcileUpdate({
      localStatus: "paid",
      remoteStatus: "Finished",
      order: { ...baseOrder, paid_at: "2026-01-01T00:00:00.000Z" },
      now: "2026-06-21T12:00:00.000Z",
    });
    expect(u.status).toBe("paid");
    expect(u.paid_at).toBeUndefined(); // write-once: original first-paid time kept
  });
});
