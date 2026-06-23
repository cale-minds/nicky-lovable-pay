// Shared CORS helpers for the Nicky kit Edge Functions.
//
// These headers allow the React frontend (running in the browser) to call the
// public-facing functions (`nicky-create-payment`, `nicky-list-assets`,
// `nicky-sync-payment-status`). The webhook and scheduled-reconciliation
// functions are server-to-server and do not rely on browser CORS.

export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  // ⚠️ LLM NOTE: The "*" origin is safe here because authentication is enforced
  // via the Supabase anon key (apikey header), not CORS. The kit is designed to
  // be copied into multiple apps with different origins, so restricting CORS to
  // a specific origin would break legitimate use cases. If you need per-app
  // origin validation, implement it at the consuming-app level, not here.
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

/** Returns a 204 response for CORS preflight requests, or null otherwise. */
export function handlePreflight(req: Request): Response | null {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  return null;
}

/** JSON response helper that always includes CORS headers. */
export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/** Standard error-response helper. */
export function errorResponse(message: string, status = 400, extra?: Record<string, unknown>): Response {
  return json({ error: message, ...extra }, status);
}
