// Pure, dependency-free helpers for the one-time Nicky webhook registration
// setup script (scripts/register-nicky-webhooks.mjs).
//
// These are intentionally side-effect free (no network, no env, no I/O) so they
// can be unit-tested with vitest. The CLI script wires them to `fetch` and
// `process.env`.
//
// SCOPE: this is a SETUP/INSTALL helper, not runtime plugin code. The plugin
// runtime never registers, lists, updates, or deletes webhooks.

/** The Nicky webhook events the plugin requires. Order is stable. */
export const REQUIRED_EVENTS = Object.freeze([
  "PaymentRequest_ReportAdded",
  "PaymentRequest_StatusChanged",
]);

/**
 * Masks an API key so it can appear in logs without leaking the secret.
 * Shows only a short prefix and the length; never the full value.
 * @param {string} key
 * @returns {string}
 */
export function maskApiKey(key) {
  if (typeof key !== "string" || key.length === 0) return "(empty)";
  const prefix = key.slice(0, 3);
  return `${prefix}…(${key.length} chars, hidden)`;
}

/**
 * Validates the fixed webhook callback URL.
 * Must be HTTPS and must end with `/nicky-webhook` (the kit-owned route).
 * @param {unknown} url
 * @returns {{ ok: true, url: string } | { ok: false, error: string }}
 */
export function validateWebhookUrl(url) {
  if (typeof url !== "string" || url.trim() === "") {
    return { ok: false, error: "NICKY_WEBHOOK_URL is required." };
  }
  const value = url.trim();

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, error: `NICKY_WEBHOOK_URL is not a valid URL: ${value}` };
  }

  if (parsed.protocol !== "https:") {
    return { ok: false, error: "NICKY_WEBHOOK_URL must use HTTPS." };
  }

  // Must point at the fixed, kit-owned route. We compare the pathname so query
  // strings/trailing differences don't sneak arbitrary routes through.
  if (!parsed.pathname.endsWith("/nicky-webhook")) {
    return {
      ok: false,
      error: "NICKY_WEBHOOK_URL must end with `/nicky-webhook` (the fixed callback route).",
    };
  }

  return { ok: true, url: value };
}

/**
 * Validates the setup environment for the registration script.
 * @param {{ apiKey?: string, webhookUrl?: string }} env
 * @returns {{ ok: true, apiKey: string, webhookUrl: string } | { ok: false, errors: string[] }}
 */
export function validateSetupEnv({ apiKey, webhookUrl } = {}) {
  const errors = [];

  if (typeof apiKey !== "string" || apiKey.trim() === "") {
    errors.push("NICKY_API_KEY is required.");
  }

  const urlCheck = validateWebhookUrl(webhookUrl);
  if (!urlCheck.ok) errors.push(urlCheck.error);

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, apiKey: apiKey.trim(), webhookUrl: urlCheck.url };
}

/**
 * Normalizes whatever shape `GET /api/public/WebHookApi/list` returns into a
 * plain array of webhook records. Tolerates a bare array or an envelope with
 * `items` / `data`.
 * @param {unknown} data
 * @returns {Array<Record<string, unknown>>}
 */
export function extractWebhookList(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    const obj = /** @type {Record<string, unknown>} */ (data);
    if (Array.isArray(obj.items)) return obj.items;
    if (Array.isArray(obj.data)) return obj.data;
  }
  return [];
}

/**
 * Reads the callback URL off a webhook record, tolerating `url`/`callbackUrl`.
 * @param {Record<string, unknown>} webhook
 * @returns {string | undefined}
 */
export function getWebhookUrl(webhook) {
  if (!webhook || typeof webhook !== "object") return undefined;
  const url = webhook.url ?? webhook.callbackUrl;
  return typeof url === "string" ? url : undefined;
}

/**
 * True when an existing webhook record matches the given event type AND URL.
 * @param {Record<string, unknown>} webhook
 * @param {string} eventType
 * @param {string} url
 * @returns {boolean}
 */
export function webhookMatches(webhook, eventType, url) {
  return webhook?.webHookType === eventType && getWebhookUrl(webhook) === url;
}

/**
 * Decides, idempotently, what to do for each required event.
 *
 * For each required event:
 *   - if an existing webhook matches (same event type AND same URL) -> "exists"
 *     (no-op);
 *   - otherwise -> "create".
 *
 * NOTE: a webhook with the same event type but a DIFFERENT URL does NOT count as
 * a match — we plan a "create" for our URL and leave the other one untouched.
 * This script never updates or deletes existing webhooks.
 *
 * @param {object} args
 * @param {Array<Record<string, unknown>>} args.existing
 * @param {string} args.url
 * @param {readonly string[]} [args.requiredEvents]
 * @returns {Array<{ eventType: string, action: "exists" | "create", existingId?: unknown }>}
 */
export function planWebhookActions({ existing, url, requiredEvents = REQUIRED_EVENTS }) {
  const list = Array.isArray(existing) ? existing : [];
  return requiredEvents.map((eventType) => {
    const match = list.find((w) => webhookMatches(w, eventType, url));
    if (match) {
      return { eventType, action: "exists", existingId: match.id };
    }
    return { eventType, action: "create" };
  });
}

/**
 * Builds the request body for `POST /api/public/WebHookApi/create`.
 * @param {string} eventType
 * @param {string} url
 * @returns {{ webHookType: string, url: string }}
 */
export function buildCreateBody(eventType, url) {
  return { webHookType: eventType, url };
}
