import { describe, it, expect } from "vitest";
import {
  decideDuplicateAction,
} from "../supabase/functions/_shared/webhook-dedupe-helpers";

describe("decideDuplicateAction", () => {
  it("prior successfully processed -> duplicate_ack (no reprocess)", () => {
    expect(decideDuplicateAction({ processing_status: "processed" }, true)).toBe("duplicate_ack");
    expect(decideDuplicateAction({ processing_status: "processed" }, false)).toBe("duplicate_ack");
  });

  it("prior structurally non-retryable -> duplicate_ack", () => {
    expect(decideDuplicateAction({ processing_status: "failed_non_retryable" }, true)).toBe(
      "duplicate_ack",
    );
  });

  it("prior rejected (unauthorized) + current AUTHORIZED -> reprocess", () => {
    // This is the dedupe-poisoning fix: an unauthorized pre-insert must not block
    // a later legitimate Nicky delivery.
    expect(decideDuplicateAction({ processing_status: "rejected" }, true)).toBe("reprocess");
  });

  it("prior failed_retryable + current authorized -> reprocess", () => {
    expect(decideDuplicateAction({ processing_status: "failed_retryable" }, true)).toBe(
      "reprocess",
    );
  });

  it("prior 'received' (crashed mid-process) + authorized -> reprocess", () => {
    expect(decideDuplicateAction({ processing_status: "received" }, true)).toBe("reprocess");
  });

  it("prior rejected + current UNAUTHORIZED -> reject (don't touch anything)", () => {
    expect(decideDuplicateAction({ processing_status: "rejected" }, false)).toBe("reject");
  });

  it("a current AUTHORIZED request is never blocked by a prior unauthorized event", () => {
    // No matter the non-success prior state, an authorized request reprocesses.
    for (const status of ["rejected", "received", "failed_retryable"]) {
      expect(decideDuplicateAction({ processing_status: status }, true)).toBe("reprocess");
    }
  });

  it("unknown/missing prior status: authorized reprocesses, unauthorized rejected", () => {
    expect(decideDuplicateAction(null, true)).toBe("reprocess");
    expect(decideDuplicateAction({}, false)).toBe("reject");
  });
});
