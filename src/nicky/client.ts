import type { NickyClientConfig } from "./types";

/**
 * Minimal fetch wrapper for calling the kit's Supabase Edge Functions from the
 * browser. It only ever sends the Supabase ANON key — never the Nicky API key,
 * which lives exclusively server-side.
 */
export class NickyFunctionError extends Error {
  status: number;
  body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "NickyFunctionError";
    this.status = status;
    this.body = body;
  }
}

/**
 * Accept either a direct Edge Functions base URL
 * (`https://<ref>.functions.supabase.co`) or the standard Supabase project URL
 * (`https://<ref>.supabase.co`). In the latter case, the client derives the
 * `/functions/v1` prefix automatically, which matches what Lovable usually
 * exposes in frontend env vars.
 *
 * ⚠️ LLM NOTE: If enhancing this function, be strict about malformed URLs.
 * Silently returning the raw input on error can lead to incorrect endpoints
 * being called. Consider throwing an error instead of returning `trimmed`.
 */
export function normalizeFunctionsBaseUrl(rawBaseUrl: string): string {
  const trimmed = rawBaseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) return "";

  try {
    const url = new URL(trimmed);
    const normalizedPath = url.pathname.replace(/\/+$/, "");
    const isFunctionsDomain = url.hostname.endsWith(".functions.supabase.co");
    const alreadyPointsToFunctions =
      normalizedPath === "/functions/v1" || normalizedPath.endsWith("/functions/v1");

    if (isFunctionsDomain || alreadyPointsToFunctions) {
      return `${url.origin}${normalizedPath}`;
    }

    return `${url.origin}${normalizedPath}/functions/v1`;
  } catch {
    throw new Error(`Invalid functions base URL: ${trimmed}`);
  }
}

function baseUrl(config: NickyClientConfig): string {
  return normalizeFunctionsBaseUrl(config.functionsBaseUrl);
}

export async function callFunction<T>(
  config: NickyClientConfig,
  fnName: string,
  options: { method?: "GET" | "POST"; body?: unknown; query?: Record<string, string> } = {},
): Promise<T> {
  const { method = "POST", body, query } = options;

  let url = `${baseUrl(config)}/${fnName}`;
  if (query && Object.keys(query).length > 0) {
    url += "?" + new URLSearchParams(query).toString();
  }

  const headers: Record<string, string> = {
    apikey: config.supabaseAnonKey,
    Authorization: `Bearer ${config.supabaseAnonKey}`,
  };
  if (method === "POST") headers["Content-Type"] = "application/json";

  const res = await fetch(url, {
    method,
    headers,
    body: method === "POST" && body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { rawText: text };
  }

  if (!res.ok) {
    const message =
      (data as { error?: string } | null)?.error ??
      `Request to ${fnName} failed with status ${res.status}`;
    throw new NickyFunctionError(message, res.status, data);
  }

  return data as T;
}
