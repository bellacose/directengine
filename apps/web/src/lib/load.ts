/**
 * Build-time data loader. Returns everything one site's pages need, shaped as packages/core types.
 *
 *   SITE=dtf SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=...   reads the Supabase project
 *   SITE=dtf DATA_FIXTURE=fixtures/demo.json                     reads a fake dataset from a file
 *
 * Both paths produce the same raw rows and go through the same assemble() step, so their output has
 * the same shape. Facts come only from the `public_listing_facts` view (verified facts of published
 * listings); core-field checks come from `listing_key_checks`. The table `listing_facts` is never read.
 *
 * The service role key is read here and handed to the Supabase client. It is never returned, logged
 * or written into any value a page can render. Any error stops the build.
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  SLUG_RE, validateSiteConfig,
  type AffiliateState, type Fact, type GuideState, type Listing, type SiteConfig, type Vocab,
} from "@directory-engine/core";

// ------------------------------------------------------------------ output shape

/** Keys every listing has outside fact_defs (public.core_fact_keys() in the migration). */
export const CORE_KEYS = ["name", "address", "phone", "website", "capabilities", "metros"] as const;
export type CoreKey = (typeof CORE_KEYS)[number];

export interface KeyCheck {
  /** YYYY-MM-DD */
  checkedAt: string;
  method: string;
}

/** A published listing with its core fields. `facts` holds verified facts only. */
export interface WebListing extends Listing {
  status: "published";
  address1: string | null;
  address2: string | null;
  city: string;
  state: string;
  zip: string | null;
  phone: string | null;
  website: string | null;
  /** ZIP centroid. */
  lat: number | null;
  lng: number | null;
  /** Owner-written. */
  description: string | null;
  /** Latest check per core field; a field with no check is absent. */
  keyChecks: Partial<Record<CoreKey, KeyCheck>>;
}

export interface Vocabulary {
  capabilities: { slug: string; name: string }[];
  metros: { slug: string; name: string; state: string; cities: string[] }[];
  factDefs: { key: string; label: string; type: string; group: string; sort: number }[];
}

/** One affiliate program configured for this site, with this site's approval state. */
export interface SiteAffiliate extends AffiliateState {
  name: string;
  /** From the site config. */
  placements: string[];
  cutoffNote: string | null;
  priceNote: string | null;
}

export interface SiteData {
  site: SiteConfig;
  vocabulary: Vocabulary;
  /** Every published listing in the site's dataset, by name. planPages() picks this site's. */
  listings: WebListing[];
  affiliates: SiteAffiliate[];
  guides: GuideState[];
}

export class LoadError extends Error {
  constructor(message: string) {
    super(`load: ${message}`);
    this.name = "LoadError";
  }
}

// ------------------------------------------------------------------ raw rows (shared by both paths)

interface Raw {
  vocabulary: Vocabulary;
  listings: {
    id: string; slug: string; name: string; status: string;
    address1: string | null; address2: string | null; city: string; state: string; zip: string | null;
    phone: string | null; website: string | null; lat: number | string | null; lng: number | string | null;
    description: string | null; updated_at: string;
  }[];
  capabilities: { listing_id: string; slug: string }[];
  metros: { listing_id: string; slug: string; is_primary: boolean }[];
  /** Rows of public_listing_facts. */
  facts: { listing_id: string; key: string; value: unknown; checked_at: string; method: string; stale: boolean }[];
  /** Rows of listing_key_checks. */
  keyChecks: { listing_id: string; key: string; checked_at: string; method: string }[];
  /** Programs configured for this site that exist, with this site's row if there is one. */
  affiliates: {
    slug: string; name: string; status: string | null; url: string | null;
    cutoff_note: string | null; price_note: string | null; facts_checked_at: string | null;
  }[];
}

const byKey = <T>(rows: T[], key: (r: T) => string) => {
  const m = new Map<string, T[]>();
  for (const r of rows) m.set(key(r), [...(m.get(key(r)) ?? []), r]);
  return m;
};
const num = (v: number | string | null) => (v === null || v === undefined ? null : Number(v));

/** Turns raw rows into the page-ready shape. The only place output is built, for both paths. */
function assemble(site: SiteConfig, raw: Raw, guides: GuideState[]): SiteData {
  const defs = new Map(raw.vocabulary.factDefs.map((d) => [d.key, d]));
  const caps = byKey(raw.capabilities, (r) => r.listing_id);
  const metros = byKey(raw.metros, (r) => r.listing_id);
  const facts = byKey(raw.facts, (r) => r.listing_id);
  const checks = byKey(raw.keyChecks, (r) => r.listing_id);
  const core = new Set<string>(CORE_KEYS);

  const listings: WebListing[] = raw.listings
    .filter((l) => l.status === "published")
    .map((l) => {
      const ownFacts: Fact[] = (facts.get(l.id) ?? []).map((f) => {
        const d = defs.get(f.key);
        if (!d) throw new LoadError(`fact "${f.key}" on listing ${l.slug} has no definition`);
        return { key: f.key, group: d.group, sort: d.sort, value: f.value, checkedAt: f.checked_at, method: f.method, stale: f.stale };
      });
      ownFacts.sort((a, b) => a.sort - b.sort || a.key.localeCompare(b.key));
      const keyChecks: WebListing["keyChecks"] = {};
      for (const c of (checks.get(l.id) ?? []).filter((c) => core.has(c.key)).sort((a, b) => a.key.localeCompare(b.key))) {
        keyChecks[c.key as CoreKey] = { checkedAt: c.checked_at, method: c.method };
      }
      return {
        id: l.id, slug: l.slug, name: l.name, status: "published" as const,
        capabilities: (caps.get(l.id) ?? []).map((c) => c.slug).sort(),
        metros: (metros.get(l.id) ?? [])
          .sort((a, b) => Number(b.is_primary) - Number(a.is_primary) || a.slug.localeCompare(b.slug))
          .map((m) => m.slug),
        updatedAt: new Date(l.updated_at).toISOString(),
        facts: ownFacts,
        address1: l.address1, address2: l.address2, city: l.city, state: l.state, zip: l.zip,
        phone: l.phone, website: l.website, lat: num(l.lat), lng: num(l.lng), description: l.description,
        keyChecks,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.slug.localeCompare(b.slug));

  const programs = new Map(raw.affiliates.map((a) => [a.slug, a]));
  const affiliates: SiteAffiliate[] = Object.keys(site.affiliates).sort().map((slug) => {
    const a = programs.get(slug);
    if (!a) throw new LoadError(`affiliate program "${slug}" is not in the dataset`);
    return {
      slug, name: a.name,
      status: a.status ?? "apply",
      url: a.status === "approved" ? a.url : null, // only an approved program's link is ever used
      hasSupplierFacts: a.cutoff_note !== null || a.price_note !== null,
      factsCheckedAt: a.facts_checked_at,
      placements: [...site.affiliates[slug]],
      cutoffNote: a.cutoff_note,
      priceNote: a.price_note,
    };
  });

  const vocabulary: Vocabulary = {
    capabilities: [...raw.vocabulary.capabilities].sort((a, b) => a.slug.localeCompare(b.slug)),
    metros: [...raw.vocabulary.metros].sort((a, b) => a.slug.localeCompare(b.slug)),
    factDefs: [...raw.vocabulary.factDefs].sort((a, b) => a.sort - b.sort || a.key.localeCompare(b.key)),
  };
  return { site, vocabulary, listings, affiliates, guides };
}

// ------------------------------------------------------------------ config and guides (repo files)

/** The repo root: the nearest folder up from `from` that holds sites/ and packages/core/. */
export function findRoot(from = process.cwd()): string {
  let dir = resolve(from);
  for (;;) {
    if (existsSync(join(dir, "sites")) && existsSync(join(dir, "packages", "core"))) return dir;
    const up = dirname(dir);
    if (up === dir) throw new LoadError(`no repo root (a folder with sites/ and packages/core/) above ${from}`);
    dir = up;
  }
}

function readJson(path: string, what: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new LoadError(`${what} not found: ${path}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new LoadError(`${what} is not valid JSON (${path}): ${(e as Error).message}`);
  }
}

function readSite(root: string, slug: string): SiteConfig {
  if (!SLUG_RE.test(slug)) throw new LoadError(`SITE "${slug}" is not a valid site slug`);
  const config = readJson(join(root, "sites", `${slug}.json`), `site config for "${slug}"`) as SiteConfig;
  if (config?.slug !== slug) throw new LoadError(`sites/${slug}.json: slug "${config?.slug}" must match the file name`);
  return config;
}

type GuideFile = Record<string, { title: string; approved: boolean; approvedAt: string | null }>;

function readGuides(root: string): GuideState[] {
  const path = join(root, "sites", "guides.json");
  if (!existsSync(path)) return [];
  const file = readJson(path, "sites/guides.json") as GuideFile;
  return Object.entries(file)
    .map(([slug, g]) => ({ slug, approved: g.approved === true, approvedAt: g.approvedAt ?? null }))
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

function validate(site: SiteConfig, vocabulary: Vocabulary, affiliateSlugs: string[], guides: GuideState[]) {
  const vocab: Vocab = {
    capabilities: vocabulary.capabilities.map((c) => c.slug),
    metros: vocabulary.metros.map((m) => m.slug),
    factKeys: vocabulary.factDefs.map((d) => d.key),
    factGroups: [...new Set(vocabulary.factDefs.map((d) => d.group))],
    affiliates: affiliateSlugs,
    guides: guides.map((g) => g.slug),
  };
  const errors = validateSiteConfig(site, vocab);
  if (errors.length) throw new LoadError(`invalid site config sites/${site.slug}.json:\n  ${errors.join("\n  ")}`);
}

// ------------------------------------------------------------------ fixture path

/** The file format of fixtures/*.json. See fixtures/README.md. */
export interface Fixture {
  dataset: string;
  vocabulary: Vocabulary;
  affiliatePrograms: {
    slug: string; name: string; cutoffNote: string | null; priceNote: string | null; factsCheckedAt: string | null;
  }[];
  /** site slug -> program slug -> this site's approval state. Missing = "apply", no link. */
  siteAffiliates: Record<string, Record<string, { status: string; url: string | null }>>;
  listings: FixtureListing[];
}

export interface FixtureListing {
  id: string;
  slug: string;
  name: string;
  status: "draft" | "published" | "removed";
  address1: string | null;
  address2: string | null;
  city: string;
  state: string;
  zip: string | null;
  phone: string | null;
  website: string | null;
  lat: number | null;
  lng: number | null;
  description: string | null;
  updatedAt: string;
  capabilities: string[];
  /** Primary metro first. */
  metros: string[];
  /** checkedAt null = a value typed in without a check: not verified, never shown. */
  facts: { key: string; value: unknown; checkedAt: string | null; method: string | null }[];
  /** Core-field checks. */
  keyChecks: { key: CoreKey; checkedAt: string; method: string }[];
}

const STALE_DAYS = 180;

/** YYYY-MM-DD of `today` minus `days`. */
function daysBefore(today: string, days: number): string {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/** Applies the rules the database views apply: published only, verified facts only, stale flag. */
function fixtureRaw(fx: Fixture, site: SiteConfig, today: string): Raw {
  const staleBefore = daysBefore(today, STALE_DAYS);
  const published = fx.listings.filter((l) => l.status === "published");
  const own = fx.siteAffiliates?.[site.slug] ?? {};
  return {
    vocabulary: fx.vocabulary,
    listings: published.map((l) => ({
      id: l.id, slug: l.slug, name: l.name, status: l.status,
      address1: l.address1, address2: l.address2, city: l.city, state: l.state, zip: l.zip,
      phone: l.phone, website: l.website, lat: l.lat, lng: l.lng, description: l.description, updated_at: l.updatedAt,
    })),
    capabilities: published.flatMap((l) => l.capabilities.map((slug) => ({ listing_id: l.id, slug }))),
    metros: published.flatMap((l) => l.metros.map((slug, i) => ({ listing_id: l.id, slug, is_primary: i === 0 }))),
    facts: published.flatMap((l) =>
      l.facts
        .filter((f) => f.checkedAt !== null && f.method !== null)
        .map((f) => ({
          listing_id: l.id, key: f.key, value: f.value, checked_at: f.checkedAt!, method: f.method!,
          stale: f.checkedAt! < staleBefore,
        })),
    ),
    keyChecks: published.flatMap((l) => l.keyChecks.map((c) => ({ listing_id: l.id, key: c.key, checked_at: c.checkedAt, method: c.method }))),
    affiliates: fx.affiliatePrograms
      .filter((p) => p.slug in site.affiliates)
      .map((p) => ({
        slug: p.slug, name: p.name, status: own[p.slug]?.status ?? null, url: own[p.slug]?.url ?? null,
        cutoff_note: p.cutoffNote, price_note: p.priceNote, facts_checked_at: p.factsCheckedAt,
      })),
  };
}

const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export function loadFromFixture(site: SiteConfig, fx: Fixture, guides: GuideState[], opts: { today?: string } = {}): SiteData {
  if (fx.dataset !== site.dataset) {
    throw new LoadError(`fixture holds dataset "${fx.dataset}" but sites/${site.slug}.json uses "${site.dataset}"`);
  }
  validate(site, fx.vocabulary, fx.affiliatePrograms.map((p) => p.slug), guides);
  return assemble(site, fixtureRaw(fx, site, opts.today ?? localToday()), guides);
}

// ------------------------------------------------------------------ Supabase path

/** The part of a supabase-js client the loader uses. */
export interface SupabaseLike {
  from(table: string): any;
}

const PAGE = 1000; // PostgREST's default row cap per request

/**
 * Reads every row of a table or view, page by page. `order` must make the order total. Stops only on
 * an empty page, so a project whose max-rows setting is below PAGE still returns every row.
 */
async function all<T>(
  sb: SupabaseLike, table: string, columns: string, order: string[],
  filter: (q: any) => any = (q) => q,
): Promise<T[]> {
  const out: T[] = [];
  for (;;) {
    let q = filter(sb.from(table).select(columns));
    for (const col of order) q = q.order(col, { ascending: true });
    const { data, error } = await q.range(out.length, out.length + PAGE - 1);
    if (error) throw new LoadError(`reading ${table}: ${error.message}`);
    if (!data?.length) return out;
    out.push(...(data as T[]));
  }
}

export async function loadFromSupabase(sb: SupabaseLike, site: SiteConfig, guides: GuideState[]): Promise<SiteData> {
  const ds = await all<{ id: string }>(sb, "datasets", "id", ["id"], (q) => q.eq("slug", site.dataset));
  if (ds.length !== 1) throw new LoadError(`dataset "${site.dataset}" (from sites/${site.slug}.json) is not in the database`);
  const dataset = ds[0].id;
  const inDataset = (q: any) => q.eq("dataset_id", dataset);

  const [capRows, metroRows, defRows, programRows, siteRows] = await Promise.all([
    all<{ id: string; slug: string; name: string }>(sb, "capabilities", "id,slug,name", ["slug"], inDataset),
    all<{ id: string; slug: string; name: string; state: string; cities: string[] }>(sb, "metros", "id,slug,name,state,cities", ["slug"], inDataset),
    all<{ key: string; label: string; value_type: string; fact_group: string; sort: number }>(
      sb, "fact_defs", "key,label,value_type,fact_group,sort", ["key"], inDataset),
    all<{ id: string; slug: string; name: string; cutoff_note: string | null; price_note: string | null; facts_checked_at: string | null }>(
      sb, "affiliate_programs", "id,slug,name,cutoff_note,price_note,facts_checked_at", ["slug"]),
    all<{ id: string; dataset_id: string }>(sb, "sites", "id,dataset_id", ["id"], (q) => q.eq("slug", site.slug)),
  ]);

  const vocabulary: Vocabulary = {
    capabilities: capRows.map((c) => ({ slug: c.slug, name: c.name })),
    metros: metroRows.map((m) => ({ slug: m.slug, name: m.name, state: m.state, cities: m.cities })),
    factDefs: defRows.map((d) => ({ key: d.key, label: d.label, type: d.value_type, group: d.fact_group, sort: d.sort })),
  };
  validate(site, vocabulary, programRows.map((p) => p.slug), guides);

  if (siteRows.length !== 1) throw new LoadError(`site "${site.slug}" is not in the database yet; run npm run sync-sites`);
  if (siteRows[0].dataset_id !== dataset) throw new LoadError(`site "${site.slug}" is on another dataset in the database`);

  const [listings, lc, lm, facts, keyChecks, siteAffs] = await Promise.all([
    all<Raw["listings"][number]>(
      sb, "listings",
      "id,slug,name,status,address1,address2,city,state,zip,phone,website,lat,lng,description,updated_at",
      ["id"], (q) => inDataset(q).eq("status", "published")),
    all<{ listing_id: string; capability_id: string }>(sb, "listing_capabilities", "listing_id,capability_id", ["listing_id", "capability_id"], inDataset),
    all<{ listing_id: string; metro_id: string; is_primary: boolean }>(sb, "listing_metros", "listing_id,metro_id,is_primary", ["listing_id", "metro_id"], inDataset),
    // The only fact source: verified facts of published listings.
    all<Raw["facts"][number]>(sb, "public_listing_facts", "listing_id,key,value,checked_at,method,stale", ["listing_id", "key"], inDataset),
    all<Raw["keyChecks"][number]>(sb, "listing_key_checks", "listing_id,key,checked_at,method", ["listing_id", "key"],
      (q) => q.in("key", [...CORE_KEYS])),
    all<{ program_id: string; status: string; url: string | null }>(sb, "site_affiliates", "program_id,status,url", ["program_id"],
      (q) => q.eq("site_id", siteRows[0].id)),
  ]);

  const capSlug = new Map(capRows.map((c) => [c.id, c.slug]));
  const metroSlug = new Map(metroRows.map((m) => [m.id, m.slug]));
  const published = new Set(listings.map((l) => l.id));
  const ownAff = new Map(siteAffs.map((a) => [a.program_id, a]));

  return assemble(site, {
    vocabulary,
    listings,
    capabilities: lc.filter((r) => published.has(r.listing_id)).map((r) => ({ listing_id: r.listing_id, slug: capSlug.get(r.capability_id)! })),
    metros: lm.filter((r) => published.has(r.listing_id)).map((r) => ({ listing_id: r.listing_id, slug: metroSlug.get(r.metro_id)!, is_primary: r.is_primary })),
    facts,
    keyChecks: keyChecks.filter((r) => published.has(r.listing_id)),
    affiliates: programRows
      .filter((p) => p.slug in site.affiliates)
      .map((p) => ({
        slug: p.slug, name: p.name, status: ownAff.get(p.id)?.status ?? null, url: ownAff.get(p.id)?.url ?? null,
        cutoff_note: p.cutoff_note, price_note: p.price_note, facts_checked_at: p.facts_checked_at,
      })),
  }, guides);
}

// ------------------------------------------------------------------ entry point

export interface LoadOptions {
  /** Defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Repo root; found from the working directory by default. */
  root?: string;
  /** Fixture path only: the date stale flags are measured from. Defaults to today. */
  today?: string;
  /** Supabase path only: replaces fetch (tests). */
  fetch?: typeof fetch;
}

/** Loads the site named by SITE. Throws LoadError on a missing key, an invalid config or a read error. */
export async function loadSite(opts: LoadOptions = {}): Promise<SiteData> {
  const env = opts.env ?? process.env;
  const root = opts.root ?? findRoot();
  const slug = env.SITE?.trim();
  if (!slug) throw new LoadError("SITE is not set (the slug of a file in sites/, e.g. SITE=dtf)");
  const site = readSite(root, slug);
  const guides = readGuides(root);

  const fixturePath = env.DATA_FIXTURE?.trim();
  if (fixturePath) {
    const path = isAbsolute(fixturePath) ? fixturePath : join(root, fixturePath);
    return loadFromFixture(site, readJson(path, "DATA_FIXTURE") as Fixture, guides, { today: opts.today });
  }

  const url = env.SUPABASE_URL?.trim();
  const key = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  const missing = [!url && "SUPABASE_URL", !key && "SUPABASE_SERVICE_ROLE_KEY"].filter(Boolean);
  if (missing.length) {
    throw new LoadError(`${missing.join(" and ")} not set. Set them in the build environment, or set DATA_FIXTURE=fixtures/demo.json to build from fake data.`);
  }
  const { createClient } = await import("@supabase/supabase-js");
  const sb = createClient(url!, key!, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    ...(opts.fetch ? { global: { fetch: opts.fetch } } : {}),
  });
  return loadFromSupabase(sb, site, guides);
}
