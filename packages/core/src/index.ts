/**
 * Page planning for one site. Pure functions, no I/O: the Astro build loads data from Supabase,
 * passes it in, and renders exactly the pages this module returns.
 *
 * Every rule about which listings a site includes, which facts it shows, whether a shop gets its
 * own page on that site, and which pages are indexed lives here so it can be tested.
 */

export type SiteStatus = "launch" | "planned";

export interface SiteConfig {
  slug: string;
  status: SiteStatus;
  name: string;
  /** null until the domain is bought. */
  domain: string | null;
  dataset: string;
  /** Which listings belong on this site. null = no restriction on that axis. */
  filter: { capabilities: string[] | null; metros: string[] | null };
  pages: {
    /** Capabilities that get a /{capability}/{metro}/ page. */
    capabilityMetro: string[];
    metroHub: boolean;
    /** Capabilities that get a /ship/{capability}-to-{metro}/ page. */
    shipToYou: string[];
    guides: string[];
  };
  /** This site's angle on a shop: which facts its pages show. */
  angle: {
    factGroups: string[];
    facts: string[];
    /** The fact that leads cards and decides list order, or null. */
    headline: string | null;
    /** A shop gets its own page on this site only with at least this many verified angle facts. */
    minFacts: number;
  };
  /** A list page is indexed only at this many listings. */
  indexGate: number;
  /** program slug -> placements on this site */
  affiliates: Record<string, string[]>;
}

export interface Vocab {
  capabilities: string[];
  metros: string[];
  factKeys: string[];
  factGroups: string[];
  affiliates: string[];
  guides: string[];
}

export interface Fact {
  key: string;
  group: string;
  sort: number;
  value: unknown;
  /** YYYY-MM-DD of the check that verified the current value. */
  checkedAt: string;
  method: string;
  stale: boolean;
}

export interface Listing {
  id: string;
  slug: string;
  name: string;
  status: "draft" | "published" | "removed";
  capabilities: string[];
  metros: string[];
  /** ISO timestamp of the last change to the listing or its facts. */
  updatedAt: string;
  /** Verified facts only (rows of public_listing_facts). */
  facts: Fact[];
}

export interface AffiliateState {
  slug: string;
  status: string;
  url: string | null;
  hasSupplierFacts: boolean;
  factsCheckedAt: string | null;
}

export interface GuideState {
  slug: string;
  approved: boolean;
  approvedAt: string | null;
}

export type PageType = "home" | "metroHub" | "capabilityMetro" | "shop" | "shipToYou" | "guide";

export interface Page {
  type: PageType;
  path: string;
  /** false = build it with noindex,follow and leave it out of the sitemap. */
  indexable: boolean;
  /** Sitemap lastmod, from the page's own data. null = omit lastmod. Never the build time. */
  lastmod: string | null;
  capability?: string;
  metro?: string;
  listingIds?: string[];
}

export const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const PLACEMENTS = ["ship-to-you", "guides", "list-pages"];

/** Errors in a site config, checked against the dataset's vocabulary. Empty = valid. */
export function validateSiteConfig(c: SiteConfig, v: Vocab): string[] {
  const errs: string[] = [];
  const unknown = (label: string, values: string[] | null | undefined, known: string[]) => {
    for (const x of values ?? []) if (!known.includes(x)) errs.push(`${label}: unknown "${x}"`);
  };
  if (!SLUG_RE.test(c.slug ?? "")) errs.push("slug: must be lowercase-hyphenated");
  if (c.status !== "launch" && c.status !== "planned") errs.push('status: must be "launch" or "planned"');
  if (!c.name?.trim()) errs.push("name: required");
  if (c.domain !== null && !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(c.domain ?? "")) {
    errs.push("domain: must be null or a bare domain like example.com");
  }
  if (c.status === "launch" && c.domain === null) errs.push("domain: required before a site can launch");
  unknown("filter.capabilities", c.filter?.capabilities, v.capabilities);
  unknown("filter.metros", c.filter?.metros, v.metros);
  unknown("pages.capabilityMetro", c.pages?.capabilityMetro, v.capabilities);
  unknown("pages.shipToYou", c.pages?.shipToYou, v.capabilities);
  unknown("pages.guides", c.pages?.guides, v.guides);
  unknown("angle.factGroups", c.angle?.factGroups, v.factGroups);
  unknown("angle.facts", c.angle?.facts, v.factKeys);
  if (c.angle?.headline != null && !v.factKeys.includes(c.angle.headline)) {
    errs.push(`angle.headline: unknown "${c.angle.headline}"`);
  }
  for (const cap of [...(c.pages?.capabilityMetro ?? []), ...(c.pages?.shipToYou ?? [])]) {
    if (c.filter?.capabilities && !c.filter.capabilities.includes(cap)) {
      errs.push(`pages: "${cap}" has a page but is outside filter.capabilities`);
    }
  }
  if (!Number.isInteger(c.angle?.minFacts) || c.angle.minFacts < 1) errs.push("angle.minFacts: must be a whole number, 1 or more");
  if (!Number.isInteger(c.indexGate) || c.indexGate < 1) errs.push("indexGate: must be a whole number, 1 or more");
  if (!(c.angle?.factGroups?.length || c.angle?.facts?.length)) errs.push("angle: needs at least one fact or fact group");
  for (const [slug, placements] of Object.entries(c.affiliates ?? {})) {
    if (!v.affiliates.includes(slug)) errs.push(`affiliates: unknown program "${slug}"`);
    unknown(`affiliates.${slug}`, placements, PLACEMENTS);
  }
  return errs;
}

const overlaps = (wanted: string[] | null, have: string[]) => wanted === null || have.some((x) => wanted.includes(x));

/** Published listings that belong on this site, by name. */
export function siteListings(site: SiteConfig, all: Listing[]): Listing[] {
  return all
    .filter((l) => l.status === "published")
    .filter((l) => overlaps(site.filter.capabilities, l.capabilities) && overlaps(site.filter.metros, l.metros))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The verified facts this site shows for a shop: headline first, then by sort order. */
export function angleFacts(site: SiteConfig, listing: Listing): Fact[] {
  const { factGroups, facts, headline } = site.angle;
  return listing.facts
    .filter((f) => factGroups.includes(f.group) || facts.includes(f.key))
    .sort((a, b) => Number(b.key === headline) - Number(a.key === headline) || a.sort - b.sort);
}

/** Whether this site builds its own page for the shop, or only shows it in lists. */
export function hasDetailPage(site: SiteConfig, listing: Listing): boolean {
  return angleFacts(site, listing).length >= site.angle.minFacts;
}

/** List order: shops with the headline fact first (higher value first, e.g. later cutoff), then by name. */
export function orderForList(site: SiteConfig, listings: Listing[]): Listing[] {
  const head = (l: Listing) => l.facts.find((f) => f.key === site.angle.headline)?.value;
  const rank = (v: unknown) => (typeof v === "number" ? String(v).padStart(12, "0") : typeof v === "string" ? v : v === true ? "1" : "");
  return [...listings].sort((a, b) => {
    const [ha, hb] = [head(a), head(b)];
    if ((ha === undefined) !== (hb === undefined)) return ha === undefined ? 1 : -1;
    if (ha !== undefined && rank(ha) !== rank(hb)) return rank(hb).localeCompare(rank(ha));
    return a.name.localeCompare(b.name);
  });
}

const newest = (dates: (string | null | undefined)[]): string | null => {
  const real = dates.filter((d): d is string => !!d).sort();
  return real.length ? real[real.length - 1] : null;
};

export interface PlanInput {
  listings: Listing[];
  affiliates: AffiliateState[];
  guides: GuideState[];
}

/** Every page this site builds, with its index decision and sitemap date. */
export function planPages(site: SiteConfig, input: PlanInput): Page[] {
  const mine = siteListings(site, input.listings);
  const metros = [...new Set(mine.flatMap((l) => l.metros))]
    .filter((m) => site.filter.metros === null || site.filter.metros.includes(m))
    .sort();
  const pages: Page[] = [{ type: "home", path: "/", indexable: true, lastmod: newest(mine.map((l) => l.updatedAt)) }];

  for (const metro of metros) {
    const inMetro = mine.filter((l) => l.metros.includes(metro));
    if (site.pages.metroHub) {
      pages.push({
        type: "metroHub", path: `/${metro}/`, metro,
        indexable: inMetro.length >= site.indexGate,
        lastmod: newest(inMetro.map((l) => l.updatedAt)),
        listingIds: inMetro.map((l) => l.id),
      });
    }
    for (const capability of site.pages.capabilityMetro) {
      const hits = orderForList(site, inMetro.filter((l) => l.capabilities.includes(capability)));
      if (!hits.length) continue; // an empty page is not built at all
      pages.push({
        type: "capabilityMetro", path: `/${capability}/${metro}/`, capability, metro,
        indexable: hits.length >= site.indexGate,
        lastmod: newest(hits.map((l) => l.updatedAt)),
        listingIds: hits.map((l) => l.id),
      });
    }
    const suppliers = input.affiliates.filter(
      (a) => a.status === "approved" && a.url && a.hasSupplierFacts && (site.affiliates[a.slug] ?? []).includes("ship-to-you"),
    );
    for (const capability of site.pages.shipToYou) {
      if (!suppliers.length) continue; // hidden until at least one approved supplier has checked facts
      pages.push({
        type: "shipToYou", path: `/ship/${capability}-to-${metro}/`, capability, metro,
        indexable: true,
        lastmod: newest(suppliers.map((a) => a.factsCheckedAt)),
      });
    }
  }

  for (const l of mine) {
    if (!hasDetailPage(site, l)) continue;
    pages.push({ type: "shop", path: `/shop/${l.slug}/`, indexable: true, lastmod: l.updatedAt, listingIds: [l.id] });
  }

  for (const slug of site.pages.guides) {
    const g = input.guides.find((x) => x.slug === slug);
    if (!g) continue;
    pages.push({ type: "guide", path: `/guides/${slug}/`, indexable: g.approved, lastmod: g.approved ? g.approvedAt : null });
  }
  return pages;
}

/** Sitemap rows: indexable pages only, each with its own date. */
export function sitemapEntries(site: SiteConfig, pages: Page[]): { loc: string; lastmod: string | null }[] {
  if (!site.domain) throw new Error(`site "${site.slug}" has no domain yet`);
  return pages.filter((p) => p.indexable).map((p) => ({ loc: `https://${site.domain}${p.path}`, lastmod: p.lastmod }));
}
