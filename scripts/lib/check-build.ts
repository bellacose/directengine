/**
 * The checks behind `npm run check-build` (T15), as pure functions over a built site's files.
 * The CLI (scripts/check-build.ts) loads the site's data and plan and reads apps/web/dist; everything
 * here takes those as arguments, so each rule is tested on small synthetic HTML.
 *
 * Source of truth for which pages exist and which are indexed is the plan from planPages() (rule 7).
 * Each check reports a Failure with the page and the reason; none stops at the first problem.
 */

import { hasGoLink } from "../../apps/web/src/lib/affiliate.ts";
import { DISCLOSURE_LINE } from "../../apps/web/src/lib/info.ts";

export interface Failure {
  /** Site path ("/dtf/tampa-bay/"), output file ("404.html") or "sitemap.xml". */
  page: string;
  reason: string;
}

export interface PlannedPage {
  path: string;
  indexable: boolean;
}

export interface AffiliateLink {
  slug: string;
  status: string;
  /** The stored network link (never allowed in a page), or null. */
  url: string | null;
}

export interface BuildInput {
  /** Host every canonical and sitemap URL must use: the site's own domain. */
  host: string;
  /** What planPages() returns for this site and data. */
  plan: PlannedPage[];
  /** HTML files the build writes outside the plan (apps/web/src/lib/static-pages.ts). */
  staticHtml: string[];
  /** This site's affiliate programs (status and stored link). */
  affiliates: AffiliateLink[];
  /** Built files by path relative to the output folder, "/" separators: every .html file and sitemap.xml. */
  files: Record<string, string>;
  /** A production build (data from Supabase): fixture markers fail it. */
  production: boolean;
}

/** Served at any missing URL, so it has no URL of its own and no canonical (see Base.astro). */
export const NO_CANONICAL = ["404.html"];

// ------------------------------------------------------------------ small HTML helpers

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[e.toLowerCase()] ?? whole;
  });
}

/** Visible text: no scripts, styles or tags, entities decoded, whitespace collapsed, curly quotes straightened. */
export function visibleText(html: string): string {
  return decodeEntities(
    html
      .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** Attributes of one tag, names lowercased, values entity-decoded. */
export function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const body = tag.replace(/^<[a-z0-9-]+/i, "").replace(/\/?>$/, "");
  for (const m of body.matchAll(/([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+)))?/g)) {
    out[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return out;
}

const tags = (html: string, name: string) => [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, "gi"))].map((m) => attrs(m[0]));
const relHas = (rel: string | undefined, word: string) => (rel ?? "").toLowerCase().split(/\s+/).includes(word);

export const canonicalsOf = (html: string) => tags(html, "link").filter((a) => relHas(a.rel, "canonical")).map((a) => a.href ?? "");

export const isNoindex = (html: string) =>
  tags(html, "meta").some((a) => ["robots", "googlebot"].includes((a.name ?? "").toLowerCase()) && /\bnoindex\b/i.test(a.content ?? ""));

/** "index.html" -> "/", "dtf/tampa-bay/index.html" -> "/dtf/tampa-bay/", "404.html" -> "/404.html". */
export function fileToPath(file: string): string {
  if (file === "index.html") return "/";
  if (file.endsWith("/index.html")) return `/${file.slice(0, -"index.html".length)}`;
  return `/${file}`;
}
export const pathToFile = (path: string) => `${path.slice(1)}index.html`;

export const sitemapLocs = (xml: string) => [...xml.matchAll(/<loc>\s*([^<]*?)\s*<\/loc>/g)].map((m) => decodeEntities(m[1]));

// ------------------------------------------------------------------ affiliate links

/**
 * Hosts that only serve affiliate tracking links (networks and link shorteners). A link to one of
 * these from a page is an affiliate link that skipped /go/. Matched on the host or any parent domain.
 */
export const AFFILIATE_HOSTS = [
  "awin1.com", "awin.com", "zenaps.com",
  "shareasale.com", "shareasale-analytics.com",
  "sjv.io", "pxf.io", "impact.com", "impactradius.com", "ojrq.net", "evyy.net",
  "anrdoezrs.net", "dpbolvw.net", "jdoqocy.com", "kqzyfj.com", "tkqlhce.com", "emjcd.com", "qksrv.net",
  "linksynergy.com", "click.linksynergy.com",
  "prf.hn", "avantlink.com", "pjtra.com", "pjatr.com", "pntra.com", "gopjn.com",
  "refersion.com", "rfsn.co", "goaffpro.com", "partnerstack.com", "tapfiliate.com", "affpaying.com",
  "amzn.to", "go.skimresources.com", "redirect.viglink.com", "flexoffers.com",
];

/** Query parameters that carry an affiliate ID or sub-ID. */
export const AFFILIATE_PARAMS = ["aff", "affid", "aff_id", "affiliate", "affiliate_id", "clickref", "irclickid", "subid", "sub_id", "subid1", "ref_id"];

const hostMatches = (host: string, list: string[]) => list.some((h) => host === h || host.endsWith(`.${h}`));

/** The stored network link with its sub-ID placeholder and query removed: what must never appear in a page. */
function networkBase(url: string): string | null {
  try {
    const u = new URL(url.replace(/\{subid\}/g, ""));
    return `${u.host}${u.pathname}`.replace(/\/$/, "").toLowerCase();
  } catch {
    return null;
  }
}

/** Why an outbound href is an affiliate link (not through /go/), or null. */
export function affiliateReason(href: string, affiliates: AffiliateLink[]): string | null {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase();
  const here = `${u.host}${u.pathname}`.replace(/\/$/, "").toLowerCase();
  const stored = affiliates.find((a) => a.url && networkBase(a.url) === here);
  if (stored) return `is the stored network link for ${stored.slug}`;
  if (hostMatches(host, AFFILIATE_HOSTS)) return `links to the affiliate network ${host}`;
  if (/(^|\.)amazon\.[a-z.]+$/.test(host) && u.searchParams.has("tag")) return "links to Amazon with an affiliate tag";
  const param = [...u.searchParams.keys()].find((k) => AFFILIATE_PARAMS.includes(k.toLowerCase()));
  if (param) return `carries the affiliate parameter "${param}"`;
  if (/\{subid\}/i.test(href)) return "carries a {subid} placeholder";
  return null;
}

// ------------------------------------------------------------------ ratings and reviews

const RATING_KEYS = new Set(["aggregateRating", "review", "reviews", "reviewRating"]);

function ratingKeys(value: unknown, found: Set<string>): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => ratingKeys(v, found));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (RATING_KEYS.has(k)) found.add(k);
      const type = k === "@type" ? [v].flat() : [];
      for (const t of type) if (t === "Review" || t === "AggregateRating") found.add(`@type ${t}`);
      ratingKeys(v, found);
    }
  }
  return found;
}

// ------------------------------------------------------------------ fixture markers

/**
 * Text that only fake data has. fixtures/demo.json names every shop "Example ...", puts them on
 * "Example Street", writes "Example price note: ..." and "Example: ..." fact values, uses example.com
 * websites and 555 phone numbers (test helpers add "Example cutoff note ..."). "Example" alone is not
 * a marker: a real guide may have an "Example presses" heading. The test keeps this in step with the fixture.
 */
export const FIXTURE_MARKERS: { name: string; re: RegExp }[] = [
  { name: '"Example" fixture text', re: /\bExample(?: [A-Z0-9]|:| (?:price|cutoff) note)/ },
  { name: "example.com address", re: /\bexample\.(?:com|org|net)\b/i },
  { name: "555 phone number", re: /(?<![\d-])(?:\+?1[-. ]?)?\(?\d{3}\)?[-. ]?555[-. ]?\d{4}(?![\d-])/ },
];

/** The markers found in a piece of text, with what matched. */
export function fixtureMarkers(text: string): string[] {
  const out: string[] = [];
  for (const m of FIXTURE_MARKERS) {
    const hit = text.match(m.re);
    if (hit) out.push(`${m.name} ("${hit[0]}")`);
  }
  return out;
}

// ------------------------------------------------------------------ one page

interface PageCtx {
  path: string;
  html: string;
  host: string;
  /** Expected index state: from the plan, false for static pages. */
  indexable: boolean;
  needsCanonical: boolean;
  affiliates: AffiliateLink[];
  production: boolean;
}

function checkPage(c: PageCtx): string[] {
  const reasons: string[] = [];
  const { html } = c;

  // Canonical: exactly one, on this site's own domain, pointing at this page (rule 8).
  const canon = canonicalsOf(html);
  const expected = `https://${c.host}${c.path}`;
  if (c.needsCanonical) {
    if (canon.length === 0) reasons.push("no canonical link");
    else if (canon.length > 1) reasons.push(`${canon.length} canonical links (expected one)`);
    else if (canon[0] !== expected) {
      let otherHost = false;
      try {
        otherHost = new URL(canon[0]).host !== c.host;
      } catch {}
      reasons.push(`canonical ${canon[0]} ${otherHost ? "points at another domain" : "is not this page"} (expected ${expected})`);
    }
  }

  // Index state from the plan.
  const noindex = isNoindex(html);
  if (c.indexable && noindex) reasons.push("has noindex but the plan says indexable");
  if (!c.indexable && !noindex) reasons.push("is indexable but the plan says noindex (or it is outside the plan)");

  // Affiliate links go through /go/ with rel="sponsored nofollow" (rule 10).
  const approved = new Set(c.affiliates.filter((a) => a.status === "approved" && a.url).map((a) => a.slug));
  for (const a of tags(html, "a")) {
    const href = a.href ?? "";
    if (href.startsWith("/go/")) {
      const program = href.match(/^\/go\/([a-z0-9-]+)\/$/)?.[1];
      if (!program) reasons.push(`affiliate link ${href} is not /go/<program>/`);
      else if (!approved.has(program)) reasons.push(`affiliate link ${href}: ${program} is not approved for this site`);
      if (!relHas(a.rel, "sponsored") || !relHas(a.rel, "nofollow")) reasons.push(`affiliate link ${href} lacks rel="sponsored nofollow"`);
      continue;
    }
    if (relHas(a.rel, "sponsored")) {
      reasons.push(`sponsored link ${href || "(no href)"} bypasses /go/`);
      continue;
    }
    const why = affiliateReason(href, c.affiliates);
    if (why) reasons.push(`affiliate link ${href} bypasses /go/: it ${why}`);
  }
  // A stored network link anywhere in the page (not only in an href) leaks it.
  const lower = html.toLowerCase();
  const hrefs = tags(html, "a").map((t) => (t.href ?? "").toLowerCase());
  for (const a of c.affiliates) {
    const base = a.url ? networkBase(a.url) : null;
    // Only a link with a path is distinctive enough to look for in text; a bare host is checked on hrefs above.
    if (base && base.includes("/") && lower.includes(base) && !hrefs.some((h) => h.includes(base))) reasons.push(`contains the stored network link for ${a.slug}`);
  }

  // Disclosure line on every page with a /go/ link (rule 10).
  if (hasGoLink(html) && !visibleText(html).includes(DISCLOSURE_LINE.replace(/[‘’]/g, "'"))) {
    reasons.push("has a /go/ link but no disclosure line");
  }

  // No ratings or reviews (rule 3).
  if (/aggregateRating/i.test(html)) reasons.push("contains aggregateRating");
  for (const m of html.matchAll(/<script\b[^>]*type=["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi)) {
    let data: unknown;
    try {
      data = JSON.parse(m[1]);
    } catch (e) {
      reasons.push(`structured data is not valid JSON: ${(e as Error).message}`);
      continue;
    }
    const keys = [...ratingKeys(data, new Set())].filter((k) => k !== "aggregateRating");
    if (keys.length) reasons.push(`structured data has ${keys.map((k) => (k.startsWith("@type") ? k : `"${k}"`)).join(", ")}`);
  }
  const itemprops = [...html.matchAll(/\bitemprop=["']?(review|reviews|reviewRating)\b/gi)].map((m) => m[1]);
  if (itemprops.length) reasons.push(`microdata has itemprop "${itemprops[0]}"`);

  // Fixture markers in a production build.
  if (c.production) {
    const content = decodeEntities(html.replace(/<style\b[\s\S]*?<\/style>/gi, " "));
    for (const m of fixtureMarkers(content)) reasons.push(`fixture marker: ${m}`);
  }
  return reasons;
}

// ------------------------------------------------------------------ the whole build

export function checkBuild(input: BuildInput): Failure[] {
  const failures: Failure[] = [];
  const fail = (page: string, reason: string) => failures.push({ page, reason });
  const htmlFiles = Object.keys(input.files).filter((f) => f.endsWith(".html")).sort();
  const planned = new Map(input.plan.map((p) => [pathToFile(p.path), p]));
  const statics = new Set(input.staticHtml);

  // The output is exactly the plan plus the static pages (rule 7).
  for (const p of input.plan) if (!(pathToFile(p.path) in input.files)) fail(p.path, "is in the plan but was not built");
  for (const f of htmlFiles) if (!planned.has(f) && !statics.has(f)) fail(fileToPath(f), `is not in the plan (${f})`);

  for (const f of htmlFiles) {
    const plan = planned.get(f);
    if (!plan && !statics.has(f)) continue;
    const path = fileToPath(f);
    for (const reason of checkPage({
      path,
      html: input.files[f],
      host: input.host,
      indexable: plan?.indexable ?? false,
      needsCanonical: !NO_CANONICAL.includes(f),
      affiliates: input.affiliates,
      production: input.production,
    })) {
      fail(NO_CANONICAL.includes(f) ? f : path, reason);
    }
  }

  // Sitemap: every indexable page, nothing else.
  const xml = input.files["sitemap.xml"];
  if (xml === undefined) {
    fail("sitemap.xml", "missing");
    return failures;
  }
  const locs = sitemapLocs(xml);
  const origin = `https://${input.host}`;
  const seen = new Set<string>();
  for (const loc of locs) {
    if (seen.has(loc)) fail("sitemap.xml", `lists ${loc} more than once`);
    seen.add(loc);
    if (!loc.startsWith(`${origin}/`)) {
      fail("sitemap.xml", `entry ${loc} is not on ${origin}`);
      continue;
    }
    const path = loc.slice(origin.length);
    const file = pathToFile(path);
    const html = path.endsWith("/") ? input.files[file] : undefined;
    if (html === undefined) fail(path, "is in the sitemap but has no page");
    else if (isNoindex(html)) fail(path, "is noindex but in the sitemap");
    else if (!planned.get(file)?.indexable) fail(path, "is in the sitemap but the plan says it is not indexable");
  }
  for (const p of input.plan) if (p.indexable && !seen.has(`${origin}${p.path}`)) fail(p.path, "is indexable but not in the sitemap");

  return failures;
}
