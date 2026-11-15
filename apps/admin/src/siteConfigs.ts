import type { SiteConfig } from "@directory-engine/core";

// Every sites/<slug>.json, bundled at build time. Rebuild the admin app after changing a site file.
const files = import.meta.glob<SiteConfig>("../../../sites/*.json", { eager: true, import: "default" });

export const SITE_CONFIGS: SiteConfig[] = Object.entries(files)
  .filter(([path]) => !path.endsWith("/guides.json"))
  .map(([, config]) => config)
  .sort((a, b) => a.slug.localeCompare(b.slug));
