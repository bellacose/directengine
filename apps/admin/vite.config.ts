import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // Only these reach client code: the project URL and the publishable (anon) key. Never the
  // service role key.
  envPrefix: "VITE_",
  // PGlite (demo mode only) ships its own WASM; the PGlite docs ask to keep it out of pre-bundling.
  optimizeDeps: { exclude: ["@electric-sql/pglite"] },
});
