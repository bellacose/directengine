// Edge Function `confirm-claim` (Deno): the link in the claim confirmation email (T19). The logic and
// its tests live in ../_shared/claim-email.ts; this file only wires it to the service-key client.
// Deployed with verify_jwt = false (supabase/config.toml): it is opened from an email.
import { createClient } from "npm:@supabase/supabase-js@2.119.0";
import { handleConfirmClaim } from "../_shared/claim-email.ts";
import { serviceKey } from "../_shared/db.ts";

const db = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey((k) => Deno.env.get(k)), {
  auth: { persistSession: false, autoRefreshToken: false },
});

Deno.serve(async (req) => {
  try {
    return await handleConfirmClaim(req, db);
  } catch (e) {
    console.error(e);
    return new Response("Error", { status: 500, headers: { "Cache-Control": "no-store" } });
  }
});
