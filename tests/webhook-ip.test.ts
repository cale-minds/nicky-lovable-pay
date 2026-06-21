import { describe, it, expect } from "vitest";
import {
  getClientIpFromForwardedFor,
  checkWebhookIp,
} from "../supabase/functions/_shared/webhook-ip.ts";

const ALLOWED = "20.76.240.81";

describe("getClientIpFromForwardedFor", () => {
  it("returns the first (left-most) IP", () => {
    expect(getClientIpFromForwardedFor("20.76.240.81, 10.0.0.1, 10.0.0.2")).toBe("20.76.240.81");
  });

  it("trims whitespace", () => {
    expect(getClientIpFromForwardedFor("  20.76.240.81 , 10.0.0.1")).toBe("20.76.240.81");
  });

  it("returns undefined for empty/missing values", () => {
    expect(getClientIpFromForwardedFor(null)).toBeUndefined();
    expect(getClientIpFromForwardedFor("")).toBeUndefined();
  });
});

describe("checkWebhookIp", () => {
  it("allows when the FIRST x-forwarded-for entry is the Nicky IP", () => {
    const res = checkWebhookIp({ allowedIp: ALLOWED, forwardedFor: "20.76.240.81, 10.0.0.1" });
    expect(res.allowed).toBe(true);
    expect(res.clientIp).toBe("20.76.240.81");
  });

  it("rejects spoofing where the allowed IP is in a later position", () => {
    // Attacker prepends their own IP and tries to smuggle the allowed IP after.
    const res = checkWebhookIp({ allowedIp: ALLOWED, forwardedFor: "1.2.3.4, 20.76.240.81" });
    expect(res.allowed).toBe(false);
    expect(res.clientIp).toBe("1.2.3.4");
  });

  it("falls back to the direct connection IP when no XFF header is present", () => {
    expect(checkWebhookIp({ allowedIp: ALLOWED, directIp: ALLOWED }).allowed).toBe(true);
    expect(checkWebhookIp({ allowedIp: ALLOWED, directIp: "9.9.9.9" }).allowed).toBe(false);
  });

  it("prefers x-forwarded-for over the direct IP", () => {
    const res = checkWebhookIp({
      allowedIp: ALLOWED,
      forwardedFor: "20.76.240.81",
      directIp: "9.9.9.9",
    });
    expect(res.allowed).toBe(true);
    expect(res.clientIp).toBe("20.76.240.81");
  });
});
