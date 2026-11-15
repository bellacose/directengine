// Static output only (D1). Which site is built comes from SITE; see run.ts.
import { fileURLToPath } from "node:url";
import { defineConfig } from "astro/config";
import { writeHostRouting } from "./src/lib/host-routing.ts";

export default defineConfig({
  output: "static",
  trailingSlash: "always",
  build: { format: "directory", inlineStylesheets: "always" },
  devToolbar: { enabled: false },
  integrations: [
    // /go/* and /track/ reach the Edge Functions from the site's own domain (T8).
    { name: "host-routing", hooks: { "astro:build:done": ({ dir }) => writeHostRouting(fileURLToPath(dir), process.env) } },
  ],
});
