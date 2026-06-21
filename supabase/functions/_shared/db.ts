// Supabase service-role client factory for the Edge Functions.
//
// The service-role client bypasses Row Level Security and must only ever run
// server-side inside an Edge Function. It is never exposed to the browser.

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getSupabaseServiceEnv } from "./env.ts";

export function getServiceClient(): SupabaseClient {
  const { url, serviceRoleKey } = getSupabaseServiceEnv();
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
