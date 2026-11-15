/**
 * Everything the home page and metro hub pages show, built from the plan and loaded data only.
 * Pure (no loading), so it is tested directly as well as through the built HTML.
 *
 * Counts come from the plan: a list link's count is its page's `listingIds.length`, a metro's count
 * is its hub page's `listingIds.length`. On a site without hubs, a metro's count is the site's
 * listings in that metro, chosen by siteListings() from packages/core, the same rule planPages()
 * uses. Nothing here decides which listings a site has or which pages exist (rule 7).
 */

import { siteListings, type Page, type SiteConfig } from "@directory-engine/core";
import { formatDate, latestCheck } from "./fact-format.ts";
import type { Vocabulary, WebListing } from "./load.ts";

export interface HubLink {
  href: string;
  text: string;
  count: number;
  /** "6 shops" */
  countText: string;
}

export interface CityCount {
  name: string;
  count: number;
  countText: string;
}

export interface MetroSummary {
  slug: string;
  name: string;
  /** Hub page path when the plan builds one, else null. */
  href: string | null;
  count: number;
  countText: string;
  lists: HubLink[];
  cities: CityCount[];
}

export interface HomeView {
  lead: string[];
  metros: MetroSummary[];
}

export interface MetroHubView {
  lead: string[];
  lists: HubLink[];
  cities: CityCount[];
  breadcrumbs: { name: string; path: string }[];
  jsonLd: Record<string, unknown>[];
}

export interface HubInput {
  site: SiteConfig;
  /** All loaded listings (the loader already keeps published ones only). */
  listings: WebListing[];
  vocabulary: Vocabulary;
  plan: Page[];
  titleOf: (page: Page) => string;
}

export const shopCount = (n: number) => `${n} ${n === 1 ? "shop" : "shops"}`;

/** "A", "A and B", "A, B and C". */
export function joinNames(names: string[]): string {
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function citiesOf(listings: WebListing[]): CityCount[] {
  const counts = new Map<string, number>();
  for (const l of listings) counts.set(l.city, (counts.get(l.city) ?? 0) + 1);
  return [...counts].map(([name, count]) => ({ name, count, countText: shopCount(count) })).sort((a, b) => a.name.localeCompare(b.name));
}

function lastChecked(listings: WebListing[]): string | null {
  const last = latestCheck(listings.flatMap((l) => [...l.facts, ...Object.values(l.keyChecks)]));
  return last ? `Last checked ${formatDate(last.checkedAt)}.` : null;
}

const listLink = (p: Page, titleOf: (page: Page) => string): HubLink => {
  const count = p.listingIds!.length;
  return { href: p.path, text: titleOf(p), count, countText: shopCount(count) };
};

/** Metros the plan builds pages for, in plan order. */
function plannedMetros(plan: Page[]): string[] {
  return [...new Set(plan.filter((p) => p.type === "metroHub" || p.type === "capabilityMetro").map((p) => p.metro!))];
}

function metroSummary(input: HubInput, mine: WebListing[], metro: string): MetroSummary {
  const { plan, vocabulary, titleOf } = input;
  const hub = plan.find((p) => p.type === "metroHub" && p.metro === metro);
  const byId = new Map(mine.map((l) => [l.id, l]));
  const inMetro = hub ? hub.listingIds!.map((id) => byId.get(id)!) : mine.filter((l) => l.metros.includes(metro));
  return {
    slug: metro,
    name: vocabulary.metros.find((m) => m.slug === metro)?.name ?? metro,
    href: hub?.path ?? null,
    count: inMetro.length,
    countText: shopCount(inMetro.length),
    lists: plan.filter((p) => p.type === "capabilityMetro" && p.metro === metro).map((p) => listLink(p, titleOf)),
    cities: citiesOf(inMetro),
  };
}

export function buildHomeView(input: HubInput): HomeView {
  const mine = siteListings(input.site, input.listings) as WebListing[];
  const metros = plannedMetros(input.plan).map((m) => metroSummary(input, mine, m));

  // Lead: data-built sentences only (rule 4).
  const lead: string[] = [];
  if (mine.length === 0) {
    lead.push("No shops are listed yet.");
  } else {
    const where = metros.length ? ` in ${joinNames(metros.map((m) => m.name))}` : "";
    lead.push(`${shopCount(mine.length)} listed${where}.`);
    const last = lastChecked(mine);
    if (last) lead.push(last);
  }
  return { lead, metros };
}

export function buildMetroHubView(input: HubInput & { page: Page; canonical: (path: string) => string }): MetroHubView {
  const { page, plan, titleOf, canonical } = input;
  const mine = siteListings(input.site, input.listings) as WebListing[];
  const m = metroSummary(input, mine, page.metro!);
  const inMetro = new Set(page.listingIds);

  const lead = [
    `${m.countText} listed in ${m.name}, in ${m.cities.length} ${m.cities.length === 1 ? "city" : "cities"}.`,
  ];
  const last = lastChecked(mine.filter((l) => inMetro.has(l.id)));
  if (last) lead.push(last);

  const home = plan.find((p) => p.type === "home");
  const breadcrumbs = [
    ...(home ? [{ name: titleOf(home), path: home.path }] : []),
    { name: titleOf(page), path: page.path },
  ];
  const jsonLd: Record<string, unknown>[] = [
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: breadcrumbs.map((b, i) => ({ "@type": "ListItem", position: i + 1, name: b.name, item: canonical(b.path) })),
    },
  ];
  return { lead, lists: m.lists, cities: m.cities, breadcrumbs, jsonLd };
}
