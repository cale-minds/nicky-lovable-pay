// Pure normalization for the Nicky accepted-assets endpoint
// (GET /AcceptedAsset/get-for-user).
//
// No Deno/Supabase imports — unit-testable in Node with vitest.
//
// Real API item shape (relevant fields):
//   id                 string
//   assetName          string
//   isFiat             boolean
//   decimalPrecisionUI number | string
//   assetChain         string
//   assetTicker        string

/** Normalized, frontend-friendly asset shape. */
export interface NormalizedAsset {
  id: string;
  symbol: string;
  name: string;
  network?: string;
  decimals?: number;
  isFiat?: boolean;
}

/** Thrown when the accepted-assets response is empty or malformed. */
export class AssetResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssetResponseError";
  }
}

/**
 * Pulls the asset array out of the response. The endpoint may return a bare
 * array or wrap it in a common envelope key. Returns `null` when no array can
 * be found (i.e. the shape is invalid).
 */
function extractArray(data: unknown): unknown[] | null {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    for (const key of ["items", "data", "result", "assets"]) {
      if (Array.isArray(obj[key])) return obj[key] as unknown[];
    }
  }
  return null;
}

function toDecimals(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/**
 * Normalizes a single raw accepted-asset record.
 *
 * Throws `AssetResponseError` if the record is not an object or lacks the
 * required `id` — that indicates an unexpected response shape, not a normal
 * "this asset is unsupported" case.
 */
function normalizeOne(raw: unknown): NormalizedAsset {
  if (!raw || typeof raw !== "object") {
    throw new AssetResponseError("Invalid asset entry: expected an object.");
  }
  const a = raw as Record<string, unknown>;

  const id = typeof a.id === "string" ? a.id.trim() : "";
  if (!id) {
    throw new AssetResponseError("Invalid asset entry: missing required `id`.");
  }

  const ticker = typeof a.assetTicker === "string" ? a.assetTicker.trim() : "";
  const symbol = ticker || id;
  const name =
    typeof a.assetName === "string" && a.assetName.trim() !== "" ? a.assetName.trim() : symbol;
  const network =
    typeof a.assetChain === "string" && a.assetChain.trim() !== "" ? a.assetChain.trim() : undefined;
  const decimals = toDecimals(a.decimalPrecisionUI);
  const isFiat = typeof a.isFiat === "boolean" ? a.isFiat : undefined;

  return { id, symbol, name, network, decimals, isFiat };
}

/**
 * Normalizes the full accepted-assets response.
 *
 * - Throws `AssetResponseError` if the shape is invalid (no array found, or an
 *   entry is malformed).
 * - Throws `AssetResponseError` if the (valid) list is empty.
 */
export function normalizeAcceptedAssets(data: unknown): NormalizedAsset[] {
  const arr = extractArray(data);
  if (arr === null) {
    throw new AssetResponseError(
      "Unexpected response shape from /AcceptedAsset/get-for-user (no asset array found).",
    );
  }
  if (arr.length === 0) {
    throw new AssetResponseError("Nicky returned no accepted assets for this account.");
  }
  return arr.map(normalizeOne);
}
