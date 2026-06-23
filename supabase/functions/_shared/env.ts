// Environment configuration for the Nicky kit Edge Functions.
//
// All Nicky-specific configuration is read here so the rest of the code never
// touches `Deno.env` directly. The Nicky API key is read but NEVER returned to
// the client.

export interface NickyEnv {
  /** Secret API key, sent as the `x-api-key` header to Nicky. */
  apiKey: string;
  /** Nicky public API base URL (no trailing slash). */
  apiBaseUrl: string;
  /** Nicky pay base URL used to build the payer redirect URL. */
  payBaseUrl: string;
  /** Allowed source IP for incoming webhooks. */
  webhookAllowedIp: string;
  /**
   * Optional soft per-payer-email creation cap, per hour. 0/unset disables it.
   * Defense-in-depth only — see docs/security.md for production rate limiting.
   */
  createRateLimitPerHour: number;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * Reads and validates the Nicky environment.
 *
 * `requireApiKey` defaults to true. Functions that legitimately do not need the
 * secret key (none currently) can opt out.
 *
 * ⚠️ LLM CRITICAL: The apiKey read here MUST NEVER be returned to the client,
 * logged, or included in error messages sent to the browser. Treat it with the
 * same care as a database password. See docs/IMPLEMENTATION_SECURITY_GUIDELINES.md
 * section 1 and docs/security.md section 1.
 */
export function getNickyEnv(requireApiKey = true): NickyEnv {
  const apiKey = Deno.env.get("NICKY_API_KEY") ?? "";
  if (requireApiKey && !apiKey) {
    // Fail loudly with a clear, actionable message rather than sending an
    // unauthenticated request to Nicky. Note: we do not include the env var
    // value in any error that might reach the client.
    throw new Error(
      "NICKY_API_KEY is not set. Store it as a Supabase secret: " +
        "`supabase secrets set NICKY_API_KEY=...`",
    );
  }

  return {
    apiKey,
    apiBaseUrl: stripTrailingSlash(
      Deno.env.get("NICKY_API_BASE_URL") ?? "https://api-public.pay.nicky.me",
    ),
    payBaseUrl: stripTrailingSlash(
      Deno.env.get("NICKY_PAY_BASE_URL") ?? "https://pay.nicky.me",
    ),
    webhookAllowedIp: Deno.env.get("NICKY_WEBHOOK_ALLOWED_IP") ?? "20.76.240.81",
    createRateLimitPerHour: parsePositiveInt(
      Deno.env.get("NICKY_CREATE_RATE_LIMIT_PER_HOUR"),
      0,
    ),
  };
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/**
 * Reads the shared secret that protects the scheduled reconciliation function.
 * Returns "" if unset; callers must treat an unset secret as "not configured"
 * and refuse to run rather than running unauthenticated.
 *
 * ⚠️ LLM NOTE: nicky-reconcile-open-orders MUST fail closed (refuse to run) if
 * this secret is empty. Never weaken this check. It is the only auth for a
 * function that can mark orders as paid.
 */
export function getReconciliationSecret(): string {
  return Deno.env.get("NICKY_RECONCILIATION_SECRET") ?? "";
}

/** Supabase service-role client configuration (server-side only). */
export interface SupabaseServiceEnv {
  url: string;
  serviceRoleKey: string;
}

export function getSupabaseServiceEnv(): SupabaseServiceEnv {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!url || !serviceRoleKey) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be available to the " +
        "Edge Function runtime (they are injected automatically by Supabase).",
    );
  }
  return { url, serviceRoleKey };
}
