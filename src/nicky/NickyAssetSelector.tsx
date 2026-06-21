import type { NickyAsset } from "./types";

export interface NickyAssetSelectorProps {
  assets: NickyAsset[];
  /** Currently selected asset id (`blockchainAssetId`). */
  value: string | null;
  onChange: (assetId: string) => void;
  loading?: boolean;
  error?: string | null;
  disabled?: boolean;
  className?: string;
  /** Optional label override. */
  label?: string;
}

/**
 * Headless-ish, dependency-free settlement asset picker. Renders a native
 * <select> so it works in any Lovable app without a component library. Style it
 * via `className` or replace it entirely — the logic lives in `useNickyAssets`.
 *
 * The option list comes from Nicky; nothing here is hardcoded to USD.
 */
export function NickyAssetSelector({
  assets,
  value,
  onChange,
  loading = false,
  error = null,
  disabled = false,
  className,
  label = "Pay with",
}: NickyAssetSelectorProps) {
  if (error) {
    return (
      <div className={className} role="alert">
        Failed to load assets: {error}
      </div>
    );
  }

  return (
    <label className={className} style={{ display: "block" }}>
      <span style={{ display: "block", marginBottom: 4 }}>{label}</span>
      <select
        value={value ?? ""}
        disabled={disabled || loading || assets.length === 0}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="" disabled>
          {loading ? "Loading assets…" : "Select an asset"}
        </option>
        {assets.map((asset) => (
          <option key={asset.id} value={asset.id}>
            {asset.symbol}
            {asset.network ? ` (${asset.network})` : ""} — {asset.name}
          </option>
        ))}
      </select>
    </label>
  );
}
