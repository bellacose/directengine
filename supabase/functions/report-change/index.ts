// Edge Function `report-change` (Deno): the shop page's report-a-change form. The logic and its tests live in
// ../_shared/forms.ts; this file only wires it to the service-key client and the Turnstile secret.
// Deployed with verify_jwt = false (supabase/config.toml): it is public.
import { createClient } from "npm:@supabase/supabase-js@2.119.0";
import { serviceKey } from "../_shared/db.ts";
import { formEnv, handleReportChange } from "../_shared/forms.ts";

const db = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey((k) => Deno.env.get(k)), {
  auth: { persistSession: false, autoRefreshToken: false },
});
const env = formEnv((k) => Deno.env.get(k));

Deno.serve(async (req) => {
  try {
    return await handleReportChange(req, db, env);
  } catch (e) {
    console.error(e);
    return new Response("Error", { status: 500, headers: { "Cache-Control": "no-store" } });
  }
});
