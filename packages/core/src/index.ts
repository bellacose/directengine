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
  /**
   * program slug -> placements on this site. A plain placement name means "everywhere on this site";
   * a rule limits it to pages about listed metros and/or capabilities.
   */
  affiliates: Record<string, PlacementEntry[]>;
  /**
   * Colors for this site's pages, as #rrggbb. Both are used for text and links on white and as
   * backgrounds behind white text, so each needs 4.5:1 contrast against white.
   */
  brand: { primary: string; accent: string };
  /**
   * Who runs the site: named in the footer and on the about, privacy, terms and contact pages, and
   * the contact page's email. null until set; name and email are required before a site can launch.
   */
  operator: { name: string; email?: string } | null;
}

/** Where on a site an affiliate program may appear. */
export const PLACEMENTS = ["ship-to-you", "guides", "list-pages"] as const;
export type Placement = (typeof PLACEMENTS)[number];

/**
 * A placement limited to pages about some metros and/or capabilities, e.g.
 * `{ "placement": "ship-to-you", "metros": ["tampa-bay"] }`. A missing list means no limit on that axis.
 */
export interface PlacementRule {
  placement: string;
  metros?: string[];
  capabilities?: string[];
}
export type PlacementEntry = string | PlacementRule;

/** What a page is about, for matching placement rules. Guide and info pages are about neither. */
export interface PlacementScope {
  metro?: string;
  capability?: string;
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

export type PageType = "home" | "metroHub" | "capabilityMetro" | "shop" | "shipToYou" | "guide" | "info";

/**
 * Static pages every site builds at /{slug}/, always indexed (docs/SPEC.md): the add-your-shop form,
 * then the info and legal pages. Their text is templated from the site config.
 */
export const INFO_PAGES = ["add-your-shop", "about", "disclosure", "privacy", "terms", "contact"] as const;
export type InfoPage = (typeof INFO_PAGES)[number];

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
const HEX_RE = /^#[0-9a-f]{6}$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** WCAG contrast ratio between a #rrggbb color and white. */
export function contrastWithWhite(hex: string): number {
  const lin = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const lum = 0.2126 * lin(1) + 0.7152 * lin(3) + 0.0722 * lin(5);
  return 1.05 / (lum + 0.05);
}

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
  for (const key of ["primary", "accent"] as const) {
    const color = c.brand?.[key];
    if (typeof color !== "string" || !HEX_RE.test(color)) errs.push(`brand.${key}: must be a lowercase #rrggbb color`);
    else if (contrastWithWhite(color) < 4.5) errs.push(`brand.${key}: ${color} is too light; needs 4.5:1 contrast with white`);
  }
  if (c.operator !== null && (typeof c.operator?.name !== "string" || !c.operator.name.trim())) {
    errs.push("operator: must be null or { \"name\": \"...\" }");
  }
  if (c.operator?.email !== undefined && (typeof c.operator.email !== "string" || !EMAIL_RE.test(c.operator.email))) {
    errs.push("operator.email: must be an email address");
  }
  if (c.status === "launch" && c.operator === null) errs.push("operator: required before a site can launch");
  if (c.status === "launch" && c.operator && c.operator.email === undefined) errs.push("operator.email: required before a site can launch");
  for (const [slug, entries] of Object.entries(c.affiliates ?? {})) {
    if (!v.affiliates.includes(slug)) errs.push(`affiliates: unknown program "${slug}"`);
    if (!Array.isArray(entries)) {
      errs.push(`affiliates.${slug}: must be a list of placements`);
      continue;
    }
    const label = `affiliates.${slug}`;
    const known: readonly string[] = PLACEMENTS;
    for (const e of entries as unknown[]) {
      if (typeof e === "string") {
        if (!known.includes(e)) errs.push(`${label}: unknown "${e}"`);
        continue;
      }
      if (typeof e !== "object" || e === null || Array.isArray(e)) {
        errs.push(`${label}: each placement must be a name or { "placement": ..., "metros"?: [...], "capabilities"?: [...] }`);
        continue;
      }
      const r = e as Record<string, unknown>;
      for (const k of Object.keys(r)) {
        if (!["placement", "metros", "capabilities"].includes(k)) errs.push(`${label}: unknown key "${k}"`);
      }
      if (typeof r.placement !== "string" || !known.includes(r.placement)) {
        errs.push(`${label}: unknown placement "${String(r.placement)}"`);
      }
      for (const [axis, vocab] of [["metros", v.metros], ["capabilities", v.capabilities]] as const) {
        if (r[axis] === undefined) continue;
        const list = r[axis];
        if (!Array.isArray(list) || list.length === 0 || !list.every((x) => typeof x === "string")) {
          errs.push(`${label}.${axis}: must be a non-empty list of slugs (leave it out for no limit)`);
          continue;
        }
        unknown(`${label}.${axis}`, list, vocab);
      }
      // A guide is about no metro or capability, so a limited guides placement would never show.
      if (r.placement === "guides" && (r.metros !== undefined || r.capabilities !== undefined)) {
        errs.push(`${label}: guides pages have no metro or capability, so a guides placement can't be limited`);
      }
    }
  }
  return errs;
}

/** A site's placements for one program, each as a rule (a plain name becomes a rule with no limits). */
export function placementRules(site: SiteConfig, program: string): PlacementRule[] {
  return (site.affiliates[program] ?? []).map((e) => (typeof e === "string" ? { placement: e } : e));
}

/** The placement names a program has on a site, without their limits, in config order. */
export function placementNames(entries: PlacementEntry[]): string[] {
  return [...new Set(entries.map((e) => (typeof e === "string" ? e : e.placement)))];
}

/**
 * Whether a program may appear in this placement on a page about `scope`. A rule limited to metros
 * matches only a page about one of them; likewise for capabilities. The one rule every page uses.
 */
export function isPlaced(site: SiteConfig, program: string, placement: Placement, scope: PlacementScope): boolean {
  return placementRules(site, program).some(
    (r) =>
      r.placement === placement &&
      (r.metros === undefined || (scope.metro !== undefined && r.metros.includes(scope.metro))) &&
      (r.capabilities === undefined || (scope.capability !== undefined && r.capabilities.includes(scope.capability))),
  );
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

/**
 * The suppliers the ship-to-you page for one capability and metro lists: programs approved for this
 * site with a stored link, placed on `ship-to-you` for that page in the site config (see isPlaced),
 * and with checked cutoff or price notes. By slug.
 */
export function shipSuppliers<T extends AffiliateState>(site: SiteConfig, affiliates: T[], page: { capability: string; metro: string }): T[] {
  const scope = { capability: page.capability, metro: page.metro };
  return affiliates
    .filter((a) => a.status === "approved" && !!a.url && a.hasSupplierFacts && isPlaced(site, a.slug, "ship-to-you", scope))
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

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
    for (const capability of site.pages.shipToYou) {
      const suppliers = shipSuppliers(site, input.affiliates, { capability, metro });
      if (!suppliers.length) continue; // hidden until an approved supplier placed here has checked facts
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

  // No data date belongs to these pages, so no lastmod (never the build time).
  for (const slug of INFO_PAGES) pages.push({ type: "info", path: `/${slug}/`, indexable: true, lastmod: null });

  // A metro slug like "about" would collide with an info page; refuse rather than build one over the other.
  const seen = new Set<string>();
  for (const p of pages) {
    if (seen.has(p.path)) throw new Error(`planPages: two pages at ${p.path}`);
    seen.add(p.path);
  }
  return pages;
}

/** Sitemap rows: indexable pages only, each with its own date. */
export function sitemapEntries(site: SiteConfig, pages: Page[]): { loc: string; lastmod: string | null }[] {
  if (!site.domain) throw new Error(`site "${site.slug}" has no domain yet`);
  return pages.filter((p) => p.indexable).map((p) => ({ loc: `https://${site.domain}${p.path}`, lastmod: p.lastmod }));
}
