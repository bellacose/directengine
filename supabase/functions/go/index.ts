// Edge Function `go` (Deno). The logic and its tests live in ../_shared/go.ts; this file only wires it
// to the service-key client. Deployed with verify_jwt = false (supabase/config.toml): it is public.
import { createClient } from "npm:@supabase/supabase-js@2.119.0";
import { serviceKey } from "../_shared/db.ts";
import { handleGo } from "../_shared/go.ts";

const db = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey((k) => Deno.env.get(k)), {
  auth: { persistSession: false, autoRefreshToken: false },
});

Deno.serve(async (req) => {
  try {
    return await handleGo(req, db);
  } catch (e) {
    console.error(e);
    return new Response("Error", { status: 500, headers: { "Cache-Control": "no-store" } });
  }
});
