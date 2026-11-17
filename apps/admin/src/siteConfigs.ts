import type { SiteConfig } from "@directory-engine/core";

// Every sites/<slug>.json, bundled at build time. Rebuild the admin app after changing a site file.
const files = import.meta.glob<SiteConfig>("../../../sites/*.json", { eager: true, import: "default" });

export const SITE_CONFIGS: SiteConfig[] = Object.entries(files)
  .filter(([path]) => !path.endsWith("/guides.json"))
  .map(([, config]) => config)
  .sort((a, b) => a.slug.localeCompare(b.slug));

// Font families with a file in some sites/themes/*/fonts/ folder (lowercased, as themes name them).
// The build serves these; a theme naming any other family falls back to the next font in its list.
const fontFiles = import.meta.glob("../../../sites/themes/*/fonts/*.woff2", { query: "?url", import: "default" });
export const THEME_FONTS = new Set<string>([
  "archivo",
  ...Object.keys(fontFiles).map((p) => p.split("/").pop()!.replace(/\.woff2$/i, "").toLowerCase()),
]);
