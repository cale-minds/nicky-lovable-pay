import { describe, it, expect } from "vitest";
import {
  REQUIRED_EVENTS,
  validateWebhookUrl,
  validateSetupEnv,
  maskApiKey,
  extractWebhookList,
  getWebhookUrl,
  webhookMatches,
  planWebhookActions,
  buildCreateBody,
} from "../scripts/webhook-registration-helpers.mjs";

const URL_OK = "https://abcde.functions.supabase.co/nicky-webhook";

describe("REQUIRED_EVENTS", () => {
  it("is exactly the two required Nicky events", () => {
    expect([...REQUIRED_EVENTS]).toEqual([
      "PaymentRequest_ReportAdded",
      "PaymentRequest_StatusChanged",
    ]);
  });
});

describe("validateWebhookUrl", () => {
  it("accepts a valid https /nicky-webhook URL", () => {
    expect(validateWebhookUrl(URL_OK)).toEqual({ ok: true, url: URL_OK });
  });

  it("rejects http (non-HTTPS)", () => {
    const r = validateWebhookUrl("http://abcde.functions.supabase.co/nicky-webhook");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/HTTPS/);
  });

  it("rejects a URL that does not end with /nicky-webhook", () => {
    const r = validateWebhookUrl("https://abcde.functions.supabase.co/some-other-route");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/nicky-webhook/);
  });

  it("rejects empty/missing values", () => {
    expect(validateWebhookUrl("").ok).toBe(false);
    expect(validateWebhookUrl(undefined).ok).toBe(false);
  });

  it("rejects a malformed URL", () => {
    expect(validateWebhookUrl("not a url").ok).toBe(false);
  });
});

describe("validateSetupEnv", () => {
  it("passes with a key and a valid URL", () => {
    const r = validateSetupEnv({ apiKey: "secret-key", webhookUrl: URL_OK });
    expect(r).toEqual({ ok: true, apiKey: "secret-key", webhookUrl: URL_OK });
  });

  it("collects all errors when both are bad", () => {
    const r = validateSetupEnv({ apiKey: "", webhookUrl: "http://x/nicky-webhook" });
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBe(2);
  });
});

describe("maskApiKey", () => {
  it("never reveals the full key", () => {
    const masked = maskApiKey("sk_live_supersecretvalue");
    expect(masked).not.toContain("supersecretvalue");
    expect(masked).toContain("sk_");
  });

  it("handles empty input", () => {
    expect(maskApiKey("")).toBe("(empty)");
  });
});

describe("extractWebhookList", () => {
  it("returns a bare array as-is", () => {
    expect(extractWebhookList([{ a: 1 }])).toEqual([{ a: 1 }]);
  });
  it("unwraps { items } and { data }", () => {
    expect(extractWebhookList({ items: [1] })).toEqual([1]);
    expect(extractWebhookList({ data: [2] })).toEqual([2]);
  });
  it("returns [] for unrecognized shapes", () => {
    expect(extractWebhookList(null)).toEqual([]);
    expect(extractWebhookList({ nope: true })).toEqual([]);
  });
});

describe("getWebhookUrl / webhookMatches", () => {
  it("reads url or callbackUrl", () => {
    expect(getWebhookUrl({ url: URL_OK })).toBe(URL_OK);
    expect(getWebhookUrl({ callbackUrl: URL_OK })).toBe(URL_OK);
  });
  it("matches only on same event type AND url", () => {
    const wh = { webHookType: "PaymentRequest_StatusChanged", url: URL_OK };
    expect(webhookMatches(wh, "PaymentRequest_StatusChanged", URL_OK)).toBe(true);
    expect(webhookMatches(wh, "PaymentRequest_ReportAdded", URL_OK)).toBe(false);
    expect(webhookMatches(wh, "PaymentRequest_StatusChanged", "https://x/nicky-webhook")).toBe(
      false,
    );
  });
});

describe("planWebhookActions (idempotency)", () => {
  it("creates both when nothing exists", () => {
    const plan = planWebhookActions({ existing: [], url: URL_OK });
    expect(plan.map((p) => p.action)).toEqual(["create", "create"]);
  });

  it("no-ops when both already exist for the same URL", () => {
    const existing = [
      { id: "1", webHookType: "PaymentRequest_ReportAdded", url: URL_OK },
      { id: "2", webHookType: "PaymentRequest_StatusChanged", url: URL_OK },
    ];
    const plan = planWebhookActions({ existing, url: URL_OK });
    expect(plan).toEqual([
      { eventType: "PaymentRequest_ReportAdded", action: "exists", existingId: "1" },
      { eventType: "PaymentRequest_StatusChanged", action: "exists", existingId: "2" },
    ]);
  });

  it("creates only the missing event", () => {
    const existing = [{ id: "1", webHookType: "PaymentRequest_ReportAdded", url: URL_OK }];
    const plan = planWebhookActions({ existing, url: URL_OK });
    expect(plan).toEqual([
      { eventType: "PaymentRequest_ReportAdded", action: "exists", existingId: "1" },
      { eventType: "PaymentRequest_StatusChanged", action: "create" },
    ]);
  });

  it("same event but DIFFERENT url => create needed (does not touch the old one)", () => {
    const existing = [
      {
        id: "old",
        webHookType: "PaymentRequest_StatusChanged",
        url: "https://OLD.functions.supabase.co/nicky-webhook",
      },
    ];
    const plan = planWebhookActions({ existing, url: URL_OK });
    const statusPlan = plan.find((p) => p.eventType === "PaymentRequest_StatusChanged");
    expect(statusPlan.action).toBe("create");
    // The plan never contains delete/update actions — only "create" / "exists".
    for (const p of plan) expect(["create", "exists"]).toContain(p.action);
  });
});

describe("buildCreateBody", () => {
  it("uses the exact API contract field names", () => {
    expect(buildCreateBody("PaymentRequest_StatusChanged", URL_OK)).toEqual({
      webHookType: "PaymentRequest_StatusChanged",
      url: URL_OK,
    });
  });
});
