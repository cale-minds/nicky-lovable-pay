import { describe, it, expect } from "vitest";
import {
  normalizeAcceptedAssets,
  AssetResponseError,
} from "../supabase/functions/_shared/assets.ts";

const sampleAsset = {
  id: "eth-usdc",
  assetName: "USD Coin",
  isFiat: false,
  decimalPrecisionUI: 6,
  assetChain: "Ethereum",
  assetTicker: "USDC",
};

describe("normalizeAcceptedAssets", () => {
  it("maps the real /AcceptedAsset/get-for-user shape to the frontend shape", () => {
    const [asset] = normalizeAcceptedAssets([sampleAsset]);
    expect(asset).toEqual({
      id: "eth-usdc",
      symbol: "USDC",
      name: "USD Coin",
      network: "Ethereum",
      decimals: 6,
      isFiat: false,
    });
  });

  it("accepts a wrapped envelope ({ items: [...] })", () => {
    const assets = normalizeAcceptedAssets({ items: [sampleAsset] });
    expect(assets).toHaveLength(1);
    expect(assets[0].symbol).toBe("USDC");
  });

  it("falls back to id when assetTicker is missing", () => {
    const [asset] = normalizeAcceptedAssets([
      { id: "some-asset-id", assetName: "Some Asset", decimalPrecisionUI: 2 },
    ]);
    expect(asset.symbol).toBe("some-asset-id");
    expect(asset.name).toBe("Some Asset");
  });

  it("derives numeric decimals from a string decimalPrecisionUI", () => {
    const [asset] = normalizeAcceptedAssets([{ ...sampleAsset, decimalPrecisionUI: "8" }]);
    expect(asset.decimals).toBe(8);
  });

  it("preserves the isFiat flag (does not assume USD/fiat-only)", () => {
    const [fiat] = normalizeAcceptedAssets([{ ...sampleAsset, isFiat: true }]);
    expect(fiat.isFiat).toBe(true);
  });

  it("throws a clear error on an empty list", () => {
    expect(() => normalizeAcceptedAssets([])).toThrowError(AssetResponseError);
    expect(() => normalizeAcceptedAssets([])).toThrow(/no accepted assets/i);
  });

  it("throws a clear error on an invalid shape (no array)", () => {
    expect(() => normalizeAcceptedAssets({ nope: true })).toThrowError(AssetResponseError);
    expect(() => normalizeAcceptedAssets(null)).toThrowError(AssetResponseError);
  });

  it("throws when an entry is missing the required id", () => {
    expect(() => normalizeAcceptedAssets([{ assetName: "No id" }])).toThrowError(
      AssetResponseError,
    );
  });
});
