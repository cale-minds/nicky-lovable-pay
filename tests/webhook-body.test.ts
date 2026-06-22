import { describe, it, expect } from "vitest";
import {
  MAX_WEBHOOK_BODY_BYTES,
  contentLengthExceeds,
} from "../supabase/functions/_shared/webhook-body";

describe("contentLengthExceeds", () => {
  it("returns false for a missing/empty header (enforced while streaming instead)", () => {
    expect(contentLengthExceeds(null)).toBe(false);
    expect(contentLengthExceeds(undefined)).toBe(false);
    expect(contentLengthExceeds("")).toBe(false);
  });

  it("returns false for a non-numeric header", () => {
    expect(contentLengthExceeds("not-a-number")).toBe(false);
  });

  it("allows sizes at or below the cap", () => {
    expect(contentLengthExceeds(String(MAX_WEBHOOK_BODY_BYTES))).toBe(false);
    expect(contentLengthExceeds("100")).toBe(false);
    expect(contentLengthExceeds("0")).toBe(false);
  });

  it("rejects sizes above the cap", () => {
    expect(contentLengthExceeds(String(MAX_WEBHOOK_BODY_BYTES + 1))).toBe(true);
    expect(contentLengthExceeds("10000000")).toBe(true);
  });

  it("respects a custom cap argument", () => {
    expect(contentLengthExceeds("200", 100)).toBe(true);
    expect(contentLengthExceeds("50", 100)).toBe(false);
  });

  it("uses a small default cap (Nicky webhook payloads are tiny)", () => {
    expect(MAX_WEBHOOK_BODY_BYTES).toBeLessThanOrEqual(256 * 1024);
    expect(MAX_WEBHOOK_BODY_BYTES).toBeGreaterThan(0);
  });
});
