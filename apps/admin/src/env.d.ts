/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string;
  /** Google browser key for live Place Details on the Candidates screen. Referrer- and API-restricted. */
  readonly VITE_GOOGLE_MAPS_BROWSER_KEY?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
