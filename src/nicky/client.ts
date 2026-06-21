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

function baseUrl(config: NickyClientConfig): string {
  return config.functionsBaseUrl.replace(/\/+$/, "");
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
