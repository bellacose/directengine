import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/** The browser client: project URL and publishable key only. Queries run as the signed-in user. */
export function makeClient(): SupabaseClient | null {
  const url = import.meta.env.VITE_SUPABASE_URL;
  const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: true, detectSessionInUrl: true } });
}
