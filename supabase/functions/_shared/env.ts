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
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * Reads and validates the Nicky environment.
 *
 * `requireApiKey` defaults to true. Functions that legitimately do not need the
 * secret key (none currently) can opt out.
 */
export function getNickyEnv(requireApiKey = true): NickyEnv {
  const apiKey = Deno.env.get("NICKY_API_KEY") ?? "";
  if (requireApiKey && !apiKey) {
    // Fail loudly with a clear, actionable message rather than sending an
    // unauthenticated request to Nicky.
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
  };
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
