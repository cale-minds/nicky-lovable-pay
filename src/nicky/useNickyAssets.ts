import { useCallback, useEffect, useState } from "react";
import type { NickyAsset, NickyClientConfig } from "./types";
import { callFunction } from "./client";

interface ListAssetsResponse {
  assets: NickyAsset[];
  cached?: boolean;
}

export interface UseNickyAssetsResult {
  assets: NickyAsset[];
  loading: boolean;
  error: string | null;
  /** Re-fetch assets, optionally forcing Nicky to be re-queried (bypass cache). */
  refresh: (force?: boolean) => Promise<void>;
}

/**
 * Loads the available settlement assets from the `nicky-list-assets` Edge
 * Function. Assets are sourced from Nicky — the kit never hardcodes a currency.
 */
export function useNickyAssets(config: NickyClientConfig): UseNickyAssetsResult {
  const [assets, setAssets] = useState<NickyAsset[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(
    async (force = false) => {
      setLoading(true);
      setError(null);
      try {
        const data = await callFunction<ListAssetsResponse>(config, "nicky-list-assets", {
          method: "POST",
          body: { refresh: force },
        });
        setAssets(data.assets ?? []);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [config],
  );

  useEffect(() => {
    void refresh(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.functionsBaseUrl, config.supabaseAnonKey]);

  return { assets, loading, error, refresh };
}
