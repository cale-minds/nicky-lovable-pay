import { describe, it, expect } from "vitest";
import { mapRemoteStatus } from "../supabase/functions/_shared/status.ts";

describe("mapRemoteStatus", () => {
  it("maps the documented Nicky statuses (as strings)", () => {
    expect(mapRemoteStatus("PaymentPending")).toBe("waiting_payment");
    expect(mapRemoteStatus("PaymentValidationRequired")).toBe("validation_required");
    expect(mapRemoteStatus("Finished")).toBe("paid");
    expect(mapRemoteStatus("Canceled")).toBe("canceled");
  });

  it("only `Finished` ever yields paid", () => {
    const others = [
      "PaymentPending",
      "PaymentValidationRequired",
      "Canceled",
      "Whatever",
      "",
      undefined,
      null,
    ];
    for (const s of others) {
      expect(mapRemoteStatus(s)).not.toBe("paid");
    }
  });

  it("maps unknown/missing statuses conservatively to failed", () => {
    expect(mapRemoteStatus("SomethingNew")).toBe("failed");
    expect(mapRemoteStatus(undefined)).toBe("failed");
    expect(mapRemoteStatus(null)).toBe("failed");
    // Ensure no numeric-enum fallback: numeric-looking strings are still unknown.
    expect(mapRemoteStatus("3")).toBe("failed");
  });
});
