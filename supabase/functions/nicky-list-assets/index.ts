// Edge Function: nicky-list-assets
//
// Returns the settlement assets Nicky accepts for the account, normalized into
// a frontend-friendly shape (`NormalizedAsset[]`). The kit never hardcodes a
// currency list — assets always come from Nicky's official endpoint:
//
//   GET /AcceptedAsset/get-for-user
//
// The endpoint is fixed (not configurable). Normalization, plus empty/invalid
// handling, lives in the pure `_shared/assets.ts` helper.
//
// Optionally caches the normalized result in `nicky_assets_cache` so repeated
// frontend loads do not hit Nicky every time.

import { handlePreflight, json, errorResponse } from "../_shared/cors.ts";
import { getNickyEnv } from "../_shared/env.ts";
import { getServiceClient } from "../_shared/db.ts";
import { getAcceptedAssets, NickyApiError } from "../_shared/nicky.ts";
import { normalizeAcceptedAssets, AssetResponseError } from "../_shared/assets.ts";

const CACHE_TTL_SECONDS = 3600;

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

    // --- Fetch from Nicky's official accepted-assets endpoint -------------
    const raw = await getAcceptedAssets(env);

    // Throws AssetResponseError on empty list or invalid shape.
    const assets = normalizeAcceptedAssets(raw);

    // --- Cache (best-effort) ----------------------------------------------
    const expiresAt = new Date(Date.now() + CACHE_TTL_SECONDS * 1000).toISOString();
    await supabase.from("nicky_assets_cache").upsert(
      {
        cache_key: "default",
        assets,
        raw_response: raw as Record<string, unknown>,
        fetched_at: new Date().toISOString(),
        expires_at: expiresAt,
      },
      { onConflict: "cache_key" },
    );

    return json({ assets, cached: false });
  } catch (err) {
    if (err instanceof AssetResponseError) {
      // Empty or malformed asset response — surface a clear error.
      return errorResponse(err.message, 502);
    }
    if (err instanceof NickyApiError) {
      console.error("Nicky API error fetching assets", err.status);
      return errorResponse("Failed to fetch accepted assets from Nicky.", 502, {
        nickyStatus: err.status,
      });
    }
    console.error("nicky-list-assets error", (err as Error).message);
    return errorResponse("Unexpected error fetching assets.", 500);
  }
});
