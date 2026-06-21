import { describe, it, expect } from "vitest";
import {
  OPEN_STATUSES,
  parseReconcileParams,
  cutoffIso,
  hasNickyIdentifier,
} from "../supabase/functions/_shared/reconcile-open-orders-helpers";

describe("OPEN_STATUSES", () => {
  it("includes in-flight statuses and excludes terminal ones", () => {
    expect(OPEN_STATUSES).toContain("waiting_payment");
    expect(OPEN_STATUSES).toContain("validation_required");
    expect(OPEN_STATUSES).not.toContain("paid");
    expect(OPEN_STATUSES).not.toContain("canceled");
    expect(OPEN_STATUSES).not.toContain("failed");
    expect(OPEN_STATUSES).not.toContain("expired_or_abandoned");
  });
});

describe("parseReconcileParams", () => {
  it("applies sensible defaults", () => {
    expect(parseReconcileParams({})).toEqual({
      limit: 50,
      olderThanMinutes: 5,
      dryRun: false,
    });
    expect(parseReconcileParams(null)).toEqual({ limit: 50, olderThanMinutes: 5, dryRun: false });
  });

  it("clamps limit to [1, 200]", () => {
    expect(parseReconcileParams({ limit: 0 }).limit).toBe(1);
    expect(parseReconcileParams({ limit: 5000 }).limit).toBe(200);
    expect(parseReconcileParams({ limit: "25" }).limit).toBe(25);
  });

  it("clamps olderThanMinutes to >= 0 and parses strings", () => {
    expect(parseReconcileParams({ olderThanMinutes: -10 }).olderThanMinutes).toBe(0);
    expect(parseReconcileParams({ olderThanMinutes: "15" }).olderThanMinutes).toBe(15);
  });

  it("parses dryRun from boolean and string forms", () => {
    expect(parseReconcileParams({ dryRun: true }).dryRun).toBe(true);
    expect(parseReconcileParams({ dryRun: "true" }).dryRun).toBe(true);
    expect(parseReconcileParams({ dryRun: "1" }).dryRun).toBe(true);
    expect(parseReconcileParams({ dryRun: "no" }).dryRun).toBe(false);
  });
});

describe("cutoffIso", () => {
  it("computes an ISO timestamp N minutes before now", () => {
    const now = Date.parse("2026-06-21T12:00:00.000Z");
    expect(cutoffIso(5, now)).toBe("2026-06-21T11:55:00.000Z");
    expect(cutoffIso(0, now)).toBe("2026-06-21T12:00:00.000Z");
  });
});

describe("hasNickyIdentifier", () => {
  it("requires at least one Nicky identifier", () => {
    expect(hasNickyIdentifier({ nicky_payment_request_id: "x", nicky_short_id: null })).toBe(true);
    expect(hasNickyIdentifier({ nicky_payment_request_id: null, nicky_short_id: "y" })).toBe(true);
    expect(hasNickyIdentifier({ nicky_payment_request_id: null, nicky_short_id: null })).toBe(
      false,
    );
    expect(hasNickyIdentifier({})).toBe(false);
  });
});
