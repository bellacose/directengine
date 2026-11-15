/**
 * The one site this build is for: its data (loaded once), its page plan, and URL and naming helpers.
 * Every page and endpoint imports from here. Nothing here knows which site it is; it all comes from
 * SITE, sites/<slug>.json and the loader.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { planPages, sitemapEntries, type Page } from "@directory-engine/core";
import { findRoot, loadSite, type SiteData, type WebListing } from "./load.ts";

export const data: SiteData = await loadSite();
export const site = data.site;

/** Exactly what the build renders (rule 7). */
export const pages: Page[] = planPages(site, data);

/**
 * Host for canonical and sitemap URLs. A site without a domain is `planned` (validation refuses to
 * launch it without one), so its builds are previews: they use a reserved `.invalid` host that can
 * never resolve or be mistaken for a real site.
 */
export const host = site.domain ?? `${site.slug}.preview.invalid`;
if (!site.domain) console.warn(`[site] sites/${site.slug}.json has no domain; canonical URLs use https://${host}`);

export const canonical = (path: string) => `https://${host}${path}`;

/** Sitemap rows, straight from the plan. */
export const sitemap = () => sitemapEntries({ ...site, domain: host }, pages);

const capabilityNames = new Map(data.vocabulary.capabilities.map((c) => [c.slug, c.name]));
const metroNames = new Map(data.vocabulary.metros.map((m) => [m.slug, m.name]));
export const capabilityName = (slug: string) => capabilityNames.get(slug) ?? slug;
export const metroName = (slug: string) => metroNames.get(slug) ?? slug;

const listingsById = new Map(data.listings.map((l) => [l.id, l]));
export const listingsFor = (page: Page): WebListing[] => (page.listingIds ?? []).map((id) => listingsById.get(id)!);

const guidesFile = join(findRoot(), "sites", "guides.json");
const guideTitles: Record<string, { title?: string }> = existsSync(guidesFile) ? JSON.parse(readFileSync(guidesFile, "utf8")) : {};
export const guideTitle = (slug: string) => guideTitles[slug]?.title ?? slug;

/** The H1 and <title> text of a planned page, built from data only. */
export function pageTitle(page: Page): string {
  switch (page.type) {
    case "home":
      return site.name;
    case "metroHub":
      return `Shops in ${metroName(page.metro!)}`;
    case "capabilityMetro":
      return `${capabilityName(page.capability!)} in ${metroName(page.metro!)}`;
    case "shop": {
      const l = listingsFor(page)[0];
      return `${l.name}, ${l.city}`;
    }
    case "shipToYou":
      return `${capabilityName(page.capability!)} shipped to ${metroName(page.metro!)}`;
    case "guide":
      return guideTitle(page.path.split("/")[2]);
  }
}

/** Plan path for Astro's [...path] param: "/" -> undefined, "/dtf/tampa-bay/" -> "dtf/tampa-bay". */
export const toParam = (path: string) => path.replace(/^\/|\/$/g, "") || undefined;
