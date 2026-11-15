// Static output only (D1). Which site is built comes from SITE; see run.ts.
import { defineConfig } from "astro/config";

export default defineConfig({
  output: "static",
  trailingSlash: "always",
  build: { format: "directory", inlineStylesheets: "always" },
  devToolbar: { enabled: false },
});
