// Edge Function: nicky-list-assets
//
// Returns the list of settlement assets Nicky accepts, normalized into a
// frontend-friendly shape (`NickyAsset[]`). The kit never hardcodes a currency
// list — assets always come from Nicky.
//
// ASSUMPTION: the public Nicky API exposes an assets list endpoint. The exact
// path was not provided in the kit spec, so it is configurable via the
// `NICKY_ASSETS_ENDPOINT` env var (default below). If your account uses a
// different path, set that secret. We also tolerate several response shapes.
//
// Optionally caches the normalized result in `nicky_assets_cache` so repeated
// frontend loads do not hit Nicky every time.

import { handlePreflight, json, errorResponse } from "../_shared/cors.ts";
import { getNickyEnv } from "../_shared/env.ts";
import { getServiceClient } from "../_shared/db.ts";

interface NormalizedAsset {
  id: string;
  symbol: string;
  name: string;
  network?: string;
  iconUrl?: string;
  decimals?: number;
}

const DEFAULT_ASSETS_ENDPOINT = "/api/public/PaymentRequestPublicApi/get-supported-assets";
const CACHE_TTL_SECONDS = 3600;

/** Best-effort normalization of an arbitrary Nicky asset record. */
function normalizeAsset(raw: Record<string, unknown>): NormalizedAsset | null {
  const id =
    (raw.blockchainAssetId as string) ||
    (raw.assetId as string) ||
    (raw.id as string) ||
    "";
  if (!id) return null;

  const symbol =
    (raw.symbol as string) ||
    (raw.ticker as string) ||
    (raw.code as string) ||
    (raw.assetSymbol as string) ||
    id;

  const name =
    (raw.name as string) ||
    (raw.displayName as string) ||
    (raw.assetName as string) ||
    symbol;

  const network =
    (raw.network as string) ||
    (raw.blockchain as string) ||
    (raw.chain as string) ||
    (raw.networkName as string) ||
    undefined;

  const iconUrl =
    (raw.iconUrl as string) || (raw.icon as string) || (raw.logoUrl as string) || undefined;

  const decimalsRaw = raw.decimals;
  const decimals = typeof decimalsRaw === "number" ? decimalsRaw : undefined;

  return { id, symbol, name, network, iconUrl, decimals };
}

/** Pulls an array of asset records out of whatever wrapper Nicky returns. */
function extractAssetArray(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  const obj = data as Record<string, unknown> | null;
  if (!obj) return [];
  for (const key of ["assets", "items", "data", "result", "supportedAssets"]) {
    const v = obj[key];
    if (Array.isArray(v)) return v as Record<string, unknown>[];
  }
  return [];
}

Deno.serve(async (req) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;

  // GET (no body) or POST (optional { refresh: true }) both accepted.
  if (req.method !== "GET" && req.method !== "POST") {
    return errorResponse("Method not allowed. Use GET or POST.", 405);
  }

  try {
    const env = getNickyEnv();
    const supabase = getServiceClient();

    let forceRefresh = false;
    if (req.method === "POST") {
      try {
        const body = await req.json();
        forceRefresh = body?.refresh === true;
      } catch {
        // No/invalid body is fine for this endpoint.
      }
    } else {
      const url = new URL(req.url);
      forceRefresh = url.searchParams.get("refresh") === "true";
    }

    // --- Serve from cache when fresh --------------------------------------
    if (!forceRefresh) {
      const { data: cached } = await supabase
        .from("nicky_assets_cache")
        .select("assets, expires_at")
        .eq("cache_key", "default")
        .maybeSingle();

      if (cached && new Date(cached.expires_at).getTime() > Date.now()) {
        return json({ assets: cached.assets, cached: true });
      }
    }

    // --- Fetch from Nicky --------------------------------------------------
    const endpoint = Deno.env.get("NICKY_ASSETS_ENDPOINT") ?? DEFAULT_ASSETS_ENDPOINT;
    const res = await fetch(`${env.apiBaseUrl}${endpoint}`, {
      headers: {
        "x-api-key": env.apiKey,
        Accept: "application/json",
      },
    });

    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }

    if (!res.ok) {
      return errorResponse(
        "Failed to fetch supported assets from Nicky. If this persists, verify " +
          "NICKY_ASSETS_ENDPOINT matches your account's API.",
        502,
        { nickyStatus: res.status },
      );
    }

    const assets = extractAssetArray(data)
      .map(normalizeAsset)
      .filter((a): a is NormalizedAsset => a !== null);

    if (assets.length === 0) {
      return errorResponse(
        "Nicky returned no recognizable assets. Check NICKY_ASSETS_ENDPOINT and " +
          "the response shape.",
        502,
        { rawSample: data },
      );
    }

    // --- Cache (best-effort) ----------------------------------------------
    const expiresAt = new Date(Date.now() + CACHE_TTL_SECONDS * 1000).toISOString();
    await supabase.from("nicky_assets_cache").upsert(
      {
        cache_key: "default",
        assets,
        raw_response: data as Record<string, unknown>,
        fetched_at: new Date().toISOString(),
        expires_at: expiresAt,
      },
      { onConflict: "cache_key" },
    );

    return json({ assets, cached: false });
  } catch (err) {
    console.error("nicky-list-assets error", (err as Error).message);
    return errorResponse("Unexpected error fetching assets.", 500);
  }
});
