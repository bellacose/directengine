/**
 * score-niches: scores niche ideas (niches/candidates.json) on the two gates data can answer, Demand
 * and Beatable, using DataForSEO, and writes niches/scores.md. Stage 1 of docs/FACTORY_PLAN.md.
 *
 *   npm run score-niches -- --dry-run                 # planned calls and estimated cost; sends nothing
 *   DATAFORSEO_LOGIN=... DATAFORSEO_PASSWORD=... npm run score-niches
 *   npm run score-niches -- --budget 3 --only laser-engraving,scrap-yards
 *
 * Calls per idea (endpoints and prices in the D?? decision "niche scorecard"):
 *   1. Keywords Data, Google Ads search volume (live): US volume and CPC for the seeds.
 *   2. Labs keyword suggestions (live), one per core term: close variants and their volume and CPC.
 *   3. SERP Google organic (live, regular), one per core term: the top 10 organic results.
 *   4. Labs bulk traffic estimation (live): each ranking domain's estimated organic traffic.
 *   5. Backlinks bulk ranks (live): each ranking domain's rank (0-1000). Optional; if the account
 *      can't use the Backlinks API the Beatable gate runs on Labs traffic alone.
 *
 * Cost safety: every raw response is cached under niches/.cache/ (git-ignored), keyed by endpoint and
 * payload, so a rerun costs nothing. Before each uncached call the run stops if the money already
 * spent plus that call's worst-case estimate would pass --budget (default $5). Spend is tracked from
 * the `cost` each response reports. Credentials come only from DATAFORSEO_LOGIN and
 * DATAFORSEO_PASSWORD in the environment; they are never printed, cached or written.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// ------------------------------------------------------------------ settings

export const API_BASE = "https://api.dataforseo.com/v3";
export const LOCATION_CODE = 2840; // United States
export const LANGUAGE_CODE = "en";

/** Demand gate: total monthly US searches across an idea's counted keywords. */
export const DEMAND_MIN = 100_000;
/** Beatable: a ranking domain counts as weak at or under this estimated organic traffic a month (Labs). */
export const WEAK_MAX_DOMAIN_ETV = 20_000;
/** Beatable: and, when Backlinks data is available, at or under this rank (0-1000 scale). */
export const WEAK_MAX_RANK = 250;
/** Beatable: "real traffic" is at least this many estimated visits a month from one core term. */
export const REAL_TRAFFIC_MIN = 100;
/** Variants fetched per core term from Labs keyword suggestions (the most searched first). */
export const SUGGESTION_LIMIT = 100;
/** Organic results read per core term (one SERP page). */
export const SERP_DEPTH = 10;

/**
 * Share of a term's searches that click each organic position, 1 to 10. An estimate in line with
 * published click-through studies; used only to turn a position into "visits from this term".
 */
export const CTR_BY_POSITION = [0.28, 0.15, 0.11, 0.08, 0.06, 0.05, 0.04, 0.03, 0.025, 0.02];

/** Prices in USD from dataforseo.com/pricing, checked 2026-11-25. Estimates use the worst case. */
export const PRICES = {
  searchVolume: { task: 0.09, item: 0 }, // Google Ads, live: per task, up to 1,000 keywords
  keywordSuggestions: { task: 0.012, item: 0.00012 }, // Labs: per task + per item returned
  serpOrganic: { task: 0.002, item: 0 }, // SERP live: per page of up to 10 results
  historicalSerps: { task: 0, item: 0.00012 }, // Labs exception: per SERP snapshot (up to 12 a year)
  bulkTraffic: { task: 0.012, item: 0.00012 }, // Labs: per task + per domain
  bulkRanks: { task: 0.024, item: 0.000036 }, // Backlinks: per task + per row
} as const;

export const ENDPOINTS = {
  searchVolume: "keywords_data/google_ads/search_volume/live",
  keywordSuggestions: "dataforseo_labs/google/keyword_suggestions/live",
  serpOrganic: "serp/google/organic/live/regular",
  historicalSerps: "dataforseo_labs/google/historical_serps/live",
  bulkTraffic: "dataforseo_labs/google/bulk_traffic_estimation/live",
  bulkRanks: "backlinks/bulk_ranks/live",
} as const;

const price = (p: { task: number; item: number }, items: number) => p.task + p.item * items;

// ------------------------------------------------------------------ candidates

export interface Idea {
  slug: string;
  name: string;
  seeds: string[];
  core: string[];
  exclude?: string[];
}

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function validateCandidates(raw: unknown): { ideas: Idea[]; errors: string[] } {
  const errors: string[] = [];
  const list = (raw as { ideas?: unknown })?.ideas;
  if (!Array.isArray(list)) return { ideas: [], errors: ['candidates.json needs an "ideas" array'] };
  const seen = new Set<string>();
  const strs = (v: unknown) => Array.isArray(v) && v.every((s) => typeof s === "string" && s.trim() !== "");
  list.forEach((it: Record<string, unknown>, i) => {
    const where = `ideas[${i}]${typeof it?.slug === "string" ? ` (${it.slug})` : ""}`;
    if (typeof it?.slug !== "string" || !SLUG_RE.test(it.slug)) errors.push(`${where}: slug must be lowercase words joined by hyphens`);
    else if (seen.has(it.slug)) errors.push(`${where}: duplicate slug`);
    else seen.add(it.slug);
    if (typeof it?.name !== "string" || !it.name.trim()) errors.push(`${where}: name is required`);
    if (!strs(it?.seeds) || !(it.seeds as string[]).length || (it.seeds as string[]).length > 20) errors.push(`${where}: seeds must be 1 to 20 keywords`);
    else if ((it.seeds as string[]).some((s) => s.length > 80 || s.split(/\s+/).length > 10)) errors.push(`${where}: a seed is over 80 characters or 10 words`);
    if (!strs(it?.core) || !(it.core as string[]).length || (it.core as string[]).length > 3) errors.push(`${where}: core must be 1 to 3 keywords`);
    if (it?.exclude !== undefined && !strs(it.exclude)) errors.push(`${where}: exclude must be a list of words`);
  });
  return { ideas: errors.length ? [] : (list as Idea[]), errors };
}

// ------------------------------------------------------------------ DataForSEO client

export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export interface Credentials { login: string; password: string }

export interface DfsTask {
  status_code: number;
  status_message?: string;
  cost?: number;
  result?: unknown[] | null;
}

export class BudgetError extends Error {}
export class DfsError extends Error {}

export interface CallRecord {
  label: string;
  endpoint: string;
  estimate: number;
  /** "cached" (free), "planned" (dry run), "sent" (paid). */
  state: "cached" | "planned" | "sent";
  cost: number;
}

/** Stable JSON: object keys sorted, so the same payload always gets the same cache key. */
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

export function cacheKey(endpoint: string, payload: unknown): string {
  const hash = createHash("sha256").update(`${endpoint}\n${stableJson(payload)}`).digest("hex").slice(0, 24);
  return `${endpoint.replaceAll("/", "_")}-${hash}.json`;
}

export class DfsClient {
  readonly calls: CallRecord[] = [];
  spent = 0;
  /** Set to the refusal message once the live SERP API refuses this account; later ideas use Labs snapshots. */
  serpRefused: string | null = null;
  private readonly secrets: string[];
  private readonly fetchFn: Fetch;
  private readonly creds: Credentials | null;
  private readonly cacheDir: string;
  private readonly budget: number;
  private readonly dryRun: boolean;

  constructor(opts: { fetch: Fetch; creds: Credentials | null; cacheDir: string; budget: number; dryRun: boolean }) {
    this.fetchFn = opts.fetch;
    this.creds = opts.creds;
    this.cacheDir = opts.cacheDir;
    this.budget = opts.budget;
    this.dryRun = opts.dryRun;
    this.secrets = opts.creds
      ? [opts.creds.login, opts.creds.password, Buffer.from(`${opts.creds.login}:${opts.creds.password}`).toString("base64")].filter((s) => s.length > 0)
      : [];
  }

  /** Replaces any credential in a string. Used on every response body and error message. */
  redact(s: string): string {
    let out = s;
    for (const secret of this.secrets) out = out.replaceAll(secret, "[redacted]");
    return out;
  }

  /** Records a call that can't be built yet in a dry run (its payload depends on an uncached response). */
  plan(label: string, endpoint: string, estimate: number): null {
    this.calls.push({ label, endpoint, estimate, state: "planned", cost: 0 });
    return null;
  }

  get estimatedPlanned(): number {
    return this.calls.filter((c) => c.state === "planned").reduce((a, c) => a + c.estimate, 0);
  }

  /**
   * One live task. Returns the task from cache or the API, or null in a dry run when it isn't cached.
   * A task the API rejects (task status other than 20000) is returned but not cached.
   */
  async call(label: string, endpoint: string, payload: Record<string, unknown>, estimate: number): Promise<DfsTask | null> {
    const file = join(this.cacheDir, cacheKey(endpoint, payload));
    if (existsSync(file)) {
      this.calls.push({ label, endpoint, estimate, state: "cached", cost: 0 });
      return firstTask(JSON.parse(readFileSync(file, "utf8")));
    }
    if (this.dryRun) {
      this.calls.push({ label, endpoint, estimate, state: "planned", cost: 0 });
      return null;
    }
    if (this.spent + estimate > this.budget + 1e-9) {
      throw new BudgetError(
        `budget stop: $${this.spent.toFixed(4)} spent, next call (${label}) could cost up to $${estimate.toFixed(4)}, budget is $${this.budget.toFixed(2)}`,
      );
    }
    if (!this.creds) throw new DfsError("no DataForSEO credentials");
    const auth = Buffer.from(`${this.creds.login}:${this.creds.password}`).toString("base64");
    const res = await this.fetchFn(`${API_BASE}/${endpoint}`, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
      body: JSON.stringify([payload]),
    });
    const text = this.redact(await res.text());
    let body: { status_code?: number; status_message?: string; cost?: number; tasks?: DfsTask[] };
    try {
      body = JSON.parse(text);
    } catch {
      this.spent += estimate; // unknown charge: assume the worst case
      this.calls.push({ label, endpoint, estimate, state: "sent", cost: estimate });
      throw new DfsError(`${endpoint}: HTTP ${res.status}, not JSON: ${text.slice(0, 200)}`);
    }
    const cost = typeof body.cost === "number" ? body.cost : estimate; // no reported cost: assume the worst case
    this.spent += cost;
    this.calls.push({ label, endpoint, estimate, state: "sent", cost });
    if (!res.ok || body.status_code !== 20000) {
      throw new DfsError(`${endpoint}: HTTP ${res.status}, status ${body.status_code} ${body.status_message ?? ""}`.trim());
    }
    const task = firstTask(body);
    if (task.status_code === 20000) {
      mkdirSync(this.cacheDir, { recursive: true });
      writeFileSync(file, text);
    }
    return task;
  }
}

function firstTask(body: { tasks?: DfsTask[] }): DfsTask {
  const t = body.tasks?.[0];
  if (!t) throw new DfsError("response has no task");
  return t;
}

const taskError = (endpoint: string, t: DfsTask) => new DfsError(`${endpoint}: task status ${t.status_code} ${t.status_message ?? ""}`.trim());

// ------------------------------------------------------------------ keywords and Demand

export interface KeywordRow {
  keyword: string;
  volume: number;
  cpc: number | null;
  source: "seed" | "variant";
}

/** "Laser engravers near me" and "laser engraver near me" are one search to Google Ads; count it once. */
export function normalizeKeyword(k: string): string {
  return k.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(Boolean)
    .map((w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w)).sort().join(" ");
}

export function isExcluded(keyword: string, exclude: string[] = []): boolean {
  const k = ` ${keyword.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim()} `;
  return exclude.some((x) => k.includes(` ${x.toLowerCase().trim()} `));
}

interface AdsResult { keyword?: string; search_volume?: number | null; cpc?: number | null }
interface SuggestionItem { keyword?: string; keyword_info?: { search_volume?: number | null; cpc?: number | null } }

/** Seeds (Google Ads numbers) plus variants (Labs numbers), excluded terms dropped, close variants merged. */
export function collectKeywords(idea: Idea, ads: AdsResult[], suggestions: SuggestionItem[]): KeywordRow[] {
  const rows = new Map<string, KeywordRow>();
  const bySeed = new Map(ads.filter((a) => a.keyword).map((a) => [a.keyword!.toLowerCase(), a]));
  for (const seed of idea.seeds) {
    const a = bySeed.get(seed.toLowerCase());
    const key = normalizeKeyword(seed);
    const row: KeywordRow = { keyword: seed, volume: a?.search_volume ?? 0, cpc: a?.cpc ?? null, source: "seed" };
    const prev = rows.get(key);
    if (!prev || row.volume > prev.volume) rows.set(key, row);
  }
  // Labs gives close synonyms one shared number ("24 hour" and "24 hrs laundromat near me" both 74,000 at
  // $0.89), so a variant whose volume and CPC equal a keyword already counted is the same searches again.
  const sig = (volume: number, cpc: number | null | undefined) => `${volume}|${cpc == null ? "-" : cpc.toFixed(2)}`;
  const seen = new Set([...rows.values()].map((r) => sig(r.volume, r.cpc)));
  for (const s of suggestions) {
    if (s.keyword && rows.has(normalizeKeyword(s.keyword))) seen.add(sig(s.keyword_info?.search_volume ?? 0, s.keyword_info?.cpc));
  }
  for (const s of suggestions) {
    if (!s.keyword || isExcluded(s.keyword, idea.exclude)) continue;
    const volume = s.keyword_info?.search_volume ?? 0;
    if (!volume) continue;
    const key = normalizeKeyword(s.keyword);
    if (rows.has(key)) continue; // a seed's Google Ads number wins over Labs; first variant wins over a near-copy
    const k = sig(volume, s.keyword_info?.cpc);
    if (seen.has(k)) continue;
    seen.add(k);
    rows.set(key, { keyword: s.keyword, volume, cpc: s.keyword_info?.cpc ?? null, source: "variant" });
  }
  return [...rows.values()].sort((a, b) => b.volume - a.volume || a.keyword.localeCompare(b.keyword));
}

export interface DemandSummary {
  total: number;
  pass: boolean;
  /** Search-weighted average CPC over keywords that have one, USD. */
  cpcAvg: number | null;
  cpcMax: number | null;
}

export function summarizeDemand(rows: KeywordRow[]): DemandSummary {
  const total = rows.reduce((a, r) => a + r.volume, 0);
  const priced = rows.filter((r) => r.cpc !== null && r.volume > 0);
  const w = priced.reduce((a, r) => a + r.volume, 0);
  return {
    total,
    pass: total >= DEMAND_MIN,
    cpcAvg: w ? priced.reduce((a, r) => a + r.volume * r.cpc!, 0) / w : null,
    cpcMax: priced.length ? Math.max(...priced.map((r) => r.cpc!)) : null,
  };
}

// ------------------------------------------------------------------ SERPs and Beatable

export interface SerpRow { term: string; volume: number; results: { position: number; domain: string; url: string }[] }
export interface DomainStats { etv: number; keywords: number; rank: number | null }

export function domainOf(d: string): string {
  return d.toLowerCase().replace(/^(?:www|m)\./, ""); // m.yelp.com and yelp.com are one site
}

/**
 * Google now wraps many organic links in `https://google.com/goto?url=...` (seen 2026-11 on local
 * queries), so DataForSEO reports the domain as google.com. The real site is then the start of the
 * breadcrumb ("https://theclaynetwork.com › studio").
 */
export function resultDomain(i: { domain?: string; url?: string; breadcrumb?: string }): string {
  const d = domainOf(i.domain ?? "");
  if (/^google\.[a-z.]+$/.test(d) && /\/goto\?/.test(i.url ?? "") && i.breadcrumb) {
    const host = i.breadcrumb.split("›")[0].trim().replace(/^https?:\/\//, "").split("/")[0];
    if (host) return domainOf(host);
  }
  return d;
}

export function parseSerp(term: string, volume: number, task: DfsTask): SerpRow {
  const result = (task.result?.[0] ?? {}) as { items?: { type?: string; rank_group?: number; domain?: string; url?: string; breadcrumb?: string }[] };
  const results = (result.items ?? [])
    .filter((i) => i.type === "organic" && i.domain && typeof i.rank_group === "number")
    .map((i) => ({ position: i.rank_group!, domain: resultDomain(i), url: i.url ?? "" }))
    .filter((r) => r.position <= SERP_DEPTH);
  return { term, volume, results };
}

/**
 * Labs Historical SERPs: result[0].items holds monthly snapshots, each with its own items. Uses the
 * newest snapshot. Fallback for accounts the live SERP API refuses.
 */
export function parseHistoricalSerp(term: string, volume: number, task: DfsTask): { serp: SerpRow; date: string | null } {
  const snaps = (((task.result?.[0] ?? {}) as { items?: { datetime?: string; items?: unknown[] }[] }).items ?? [])
    .filter((x) => Array.isArray(x.items));
  const newest = [...snaps].sort((a, b) => (b.datetime ?? "").localeCompare(a.datetime ?? ""))[0];
  return {
    serp: parseSerp(term, volume, { ...task, result: [{ items: newest?.items ?? [] }] } as DfsTask),
    date: newest?.datetime?.slice(0, 10) ?? null,
  };
}

export const ctrFor = (position: number) => CTR_BY_POSITION[position - 1] ?? 0;

export interface BeatableHit {
  term: string;
  position: number;
  domain: string;
  url: string;
  termVisits: number;
  etv: number;
  keywords: number;
  rank: number | null;
  weak: boolean;
}

export interface BeatableSummary {
  pass: boolean;
  /** The weakest domain getting real traffic from a core term (smallest overall traffic), if any. */
  weakest: BeatableHit | null;
  hits: BeatableHit[];
}

/**
 * Beatable: some domain in the top 10 for a core term gets real traffic from that term
 * (term volume x click share of its position >= REAL_TRAFFIC_MIN) while its whole-site footprint is
 * small (Labs organic traffic <= WEAK_MAX_DOMAIN_ETV and, if known, Backlinks rank <= WEAK_MAX_RANK).
 * A domain Labs has no data for counts as traffic 0.
 */
export function assessBeatable(serps: SerpRow[], stats: Map<string, DomainStats>): BeatableSummary {
  const hits: BeatableHit[] = [];
  for (const s of serps) {
    for (const r of s.results) {
      const st = stats.get(r.domain) ?? { etv: 0, keywords: 0, rank: null };
      const weak = st.etv <= WEAK_MAX_DOMAIN_ETV && (st.rank === null || st.rank <= WEAK_MAX_RANK);
      hits.push({ term: s.term, position: r.position, domain: r.domain, url: r.url, termVisits: Math.round(s.volume * ctrFor(r.position)), ...st, weak });
    }
  }
  const real = hits.filter((h) => h.termVisits >= REAL_TRAFFIC_MIN);
  const weakest = [...real].sort((a, b) => a.etv - b.etv || (a.rank ?? 0) - (b.rank ?? 0) || a.position - b.position)[0] ?? null;
  return { pass: real.some((h) => h.weak), weakest, hits };
}

// ------------------------------------------------------------------ one idea

export interface IdeaScore {
  idea: Idea;
  keywords: KeywordRow[];
  demand: DemandSummary;
  serps: SerpRow[];
  beatable: BeatableSummary;
  ranksAvailable: boolean;
  notes: string[];
}

const geo = { location_code: LOCATION_CODE, language_code: LANGUAGE_CODE };

/** Scores one idea, or returns null in a dry run once a needed response isn't cached (calls are still planned). */
export async function scoreIdea(client: DfsClient, idea: Idea): Promise<IdeaScore | null> {
  const notes: string[] = [];
  let complete = true;
  const tag = (s: string) => `${idea.slug}: ${s}`;

  const adsTask = await client.call(tag(`search volume, ${idea.seeds.length} seed${idea.seeds.length === 1 ? "" : "s"}`), ENDPOINTS.searchVolume,
    { keywords: idea.seeds, ...geo }, price(PRICES.searchVolume, 0));
  if (adsTask && adsTask.status_code !== 20000) throw taskError(ENDPOINTS.searchVolume, adsTask);
  if (!adsTask) complete = false;
  const ads = (adsTask?.result ?? []) as AdsResult[];

  const suggestions: SuggestionItem[] = [];
  for (const term of idea.core) {
    const t = await client.call(tag(`variants of "${term}"`), ENDPOINTS.keywordSuggestions,
      { keyword: term, ...geo, limit: SUGGESTION_LIMIT }, price(PRICES.keywordSuggestions, SUGGESTION_LIMIT));
    if (t && t.status_code !== 20000) throw taskError(ENDPOINTS.keywordSuggestions, t);
    if (!t) complete = false;
    for (const r of (t?.result ?? []) as { items?: SuggestionItem[] | null }[]) suggestions.push(...(r?.items ?? []));
  }

  const keywords = collectKeywords(idea, ads, suggestions);
  const volumeOf = (term: string) => {
    const k = normalizeKeyword(term);
    return keywords.find((r) => normalizeKeyword(r.keyword) === k)?.volume
      ?? suggestions.find((s) => s.keyword && normalizeKeyword(s.keyword) === k)?.keyword_info?.search_volume ?? 0;
  };

  const serps: SerpRow[] = [];
  for (const term of idea.core) {
    let t: DfsTask | null = null;
    if (!client.serpRefused) {
      try {
        t = await client.call(tag(`top ${SERP_DEPTH} for "${term}"`), ENDPOINTS.serpOrganic,
          { keyword: term, ...geo, device: "desktop", depth: SERP_DEPTH }, price(PRICES.serpOrganic, 0) * Math.ceil(SERP_DEPTH / 10));
        if (t && t.status_code !== 20000) throw taskError(ENDPOINTS.serpOrganic, t);
      } catch (e) {
        if (!(e instanceof DfsError)) throw e; // budget stops still stop
        client.serpRefused = client.redact((e as Error).message);
        t = null;
      }
      if (!client.serpRefused) {
        if (!t) complete = false;
        else serps.push(parseSerp(term, volumeOf(term), t));
        continue;
      }
    }
    // Live SERP refused (some accounts need extra verification for it): newest Labs snapshot instead.
    const h = await client.call(tag(`top ${SERP_DEPTH} for "${term}" (Labs snapshot)`), ENDPOINTS.historicalSerps,
      { keyword: term, ...geo }, price(PRICES.historicalSerps, 12));
    if (h && h.status_code !== 20000) throw taskError(ENDPOINTS.historicalSerps, h);
    if (!h) { complete = false; continue; }
    const { serp, date } = parseHistoricalSerp(term, volumeOf(term), h);
    serps.push(serp);
    notes.push(`Top results for "${term}" come from the DataForSEO Labs snapshot of ${date ?? "unknown date"}, because the live SERP API refused this account (${client.serpRefused}).`);
  }

  // Domain calls depend on the SERPs. Unknown in a dry run: plan them at the worst case (all distinct).
  const known = [...new Set(serps.flatMap((s) => s.results.map((r) => r.domain)))].sort();
  const serpsComplete = serps.length === idea.core.length;
  const domainCount = serpsComplete ? known.length : idea.core.length * SERP_DEPTH;
  const stats = new Map<string, DomainStats>();
  let ranksAvailable = false;

  if (domainCount > 0) {
    const targets = serpsComplete ? known : [];
    const tt = serpsComplete
      ? await client.call(tag(`traffic for ${domainCount} domains`), ENDPOINTS.bulkTraffic,
        { targets, ...geo, item_types: ["organic"] }, price(PRICES.bulkTraffic, domainCount))
      : client.plan(tag(`traffic for up to ${domainCount} domains`), ENDPOINTS.bulkTraffic, price(PRICES.bulkTraffic, domainCount));
    if (tt && tt.status_code !== 20000) throw taskError(ENDPOINTS.bulkTraffic, tt);
    if (!tt) complete = false;
    const items = ((tt?.result?.[0] ?? {}) as { items?: { target?: string; metrics?: { organic?: { etv?: number; count?: number } | null } }[] }).items ?? [];
    for (const d of known) stats.set(d, { etv: 0, keywords: 0, rank: null });
    for (const it of items) {
      if (!it.target) continue;
      const d = domainOf(it.target);
      stats.set(d, { etv: Math.round(it.metrics?.organic?.etv ?? 0), keywords: it.metrics?.organic?.count ?? 0, rank: null });
    }

    let rt: DfsTask | null = null;
    try {
      rt = serpsComplete
        ? await client.call(tag(`backlinks rank for ${domainCount} domains`), ENDPOINTS.bulkRanks,
          { targets, rank_scale: "one_thousand" }, price(PRICES.bulkRanks, domainCount))
        : client.plan(tag(`backlinks rank for up to ${domainCount} domains`), ENDPOINTS.bulkRanks, price(PRICES.bulkRanks, domainCount));
    } catch (e) {
      if (!(e instanceof DfsError)) throw e; // budget stops still stop
      notes.push(`Backlinks rank unavailable (${client.redact((e as Error).message)}); Beatable uses Labs traffic only.`);
    }
    if (rt && rt.status_code === 20000) {
      ranksAvailable = true;
      for (const it of ((rt.result?.[0] ?? {}) as { items?: { target?: string; rank?: number }[] }).items ?? []) {
        if (!it.target || typeof it.rank !== "number") continue;
        const d = domainOf(it.target);
        const s = stats.get(d) ?? { etv: 0, keywords: 0, rank: null };
        stats.set(d, { ...s, rank: it.rank });
      }
    } else if (rt) {
      notes.push(`Backlinks rank unavailable (task status ${rt.status_code} ${rt.status_message ?? ""}); Beatable uses Labs traffic only.`.replace(" )", ")"));
    }
  }

  if (!complete) return null;
  return { idea, keywords, demand: summarizeDemand(keywords), serps, beatable: assessBeatable(serps, stats), ranksAvailable, notes };
}

// ------------------------------------------------------------------ scores.md

const n = (v: number) => v.toLocaleString("en-US");
const usd = (v: number | null) => (v === null ? "n/a" : `$${v.toFixed(2)}`);
const cell = (s: string) => s.replaceAll("|", "\\|");

export function renderScores(scores: IdeaScore[], meta: { date: string; spent: number; unscored: { slug: string; reason: string }[] }): string {
  const L: string[] = [];
  L.push("# Niche scores", "");
  L.push(`Generated by \`npm run score-niches\` on ${meta.date} from \`niches/candidates.json\`. DataForSEO spend this run: $${meta.spent.toFixed(4)} (cached responses are free).`, "");
  L.push("Gates (docs/FACTORY_PLAN.md, Stage 1). All five must pass; this file fills in the two data can answer.", "");
  L.push(`- **Demand:** ${n(DEMAND_MIN)}+ monthly US searches across the idea's seeds and close variants (Google Ads volume for seeds, DataForSEO Labs for variants; excluded words dropped; singular and plural counted once).`);
  L.push(`- **Beatable:** a domain in Google's US top ${SERP_DEPTH} for a core term gets real traffic from it (term volume x click share of its position >= ${n(REAL_TRAFFIC_MIN)} visits a month) while its whole site is small (Labs estimated organic traffic <= ${n(WEAK_MAX_DOMAIN_ETV)} a month and, where Backlinks data is available, rank <= ${WEAK_MAX_RANK} of 1000).`);
  L.push("- **Hard on Maps, Data, Hook:** left blank for a person to judge.", "");
  L.push("Traffic figures are DataForSEO estimates, not measurements. Click shares by position: " + CTR_BY_POSITION.map((c, i) => `${i + 1}: ${Math.round(c * 1000) / 10}%`).join(", ") + ".", "");

  L.push("| Idea | Demand | Demand gate | CPC avg (max) | Weakest domain with real traffic | Beatable gate | Hard on Maps | Data | Hook |");
  L.push("|---|---:|---|---|---|---|---|---|---|");
  for (const s of scores) {
    const w = s.beatable.weakest;
    const weakest = w
      ? `${w.domain} (#${w.position} for "${w.term}", ~${n(w.termVisits)}/mo from it; site ~${n(w.etv)}/mo${w.rank === null ? "" : `, rank ${w.rank}`})`
      : "none";
    L.push(`| ${cell(s.idea.name)} | ${n(s.demand.total)} | ${s.demand.pass ? "pass" : "fail"} | ${usd(s.demand.cpcAvg)} (${usd(s.demand.cpcMax)}) | ${cell(weakest)} | ${s.beatable.pass ? "pass" : "fail"} |  |  |  |`);
  }
  for (const u of meta.unscored) L.push(`| ${cell(u.slug)} | | not scored | | | |  |  |  |`);
  L.push("");
  if (meta.unscored.length) {
    L.push("Not scored:", "");
    for (const u of meta.unscored) L.push(`- **${u.slug}:** ${u.reason}`);
    L.push("");
  }

  for (const s of scores) {
    L.push(`## ${s.idea.name} (\`${s.idea.slug}\`)`, "");
    L.push(`Demand ${n(s.demand.total)} (${s.demand.pass ? "pass" : "fail"}), Beatable ${s.beatable.pass ? "pass" : "fail"}${s.ranksAvailable ? "" : " (Labs traffic only)"}.`, "");
    for (const note of s.notes) L.push(`- ${note}`);
    if (s.notes.length) L.push("");
    L.push("| Keyword | Monthly searches | CPC | Source |", "|---|---:|---:|---|");
    for (const k of s.keywords.slice(0, 25)) L.push(`| ${cell(k.keyword)} | ${n(k.volume)} | ${usd(k.cpc)} | ${k.source === "seed" ? "seed (Google Ads)" : "variant (Labs)"} |`);
    if (s.keywords.length > 25) L.push(`| ${s.keywords.length - 25} more | ${n(s.keywords.slice(25).reduce((a, k) => a + k.volume, 0))} | | |`);
    L.push("");
    for (const serp of s.serps) {
      L.push(`Top ${SERP_DEPTH} for "${serp.term}" (${n(serp.volume)} searches a month):`, "");
      L.push("| # | Domain | Visits from term | Site traffic | Ranking keywords | Rank | Weak |", "|---:|---|---:|---:|---:|---:|---|");
      for (const h of s.beatable.hits.filter((x) => x.term === serp.term)) {
        L.push(`| ${h.position} | ${cell(h.domain)} | ${n(h.termVisits)} | ${n(h.etv)} | ${n(h.keywords)} | ${h.rank ?? "n/a"} | ${h.weak ? "yes" : "no"} |`);
      }
      L.push("");
    }
  }
  return L.join("\n");
}

// ------------------------------------------------------------------ CLI

const flag = (argv: string[], name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

export interface MainDeps {
  fetch: Fetch;
  log(msg: string): void;
  error(msg: string): void;
  /** Repository root; candidates, scores and cache paths hang off it. */
  root: string;
  now?: () => Date;
}

/** CLI entry. Returns the process exit code. */
export async function main(argv: string[], env: Record<string, string | undefined>, deps: MainDeps): Promise<number> {
  const dryRun = argv.includes("--dry-run");
  const budget = Number(flag(argv, "--budget") ?? 5);
  if (!Number.isFinite(budget) || budget <= 0) {
    deps.error("score-niches: --budget must be a positive number of US dollars.");
    return 2;
  }
  const only = flag(argv, "--only")?.split(",").map((s) => s.trim()).filter(Boolean);
  const login = env.DATAFORSEO_LOGIN ?? "";
  const password = env.DATAFORSEO_PASSWORD ?? "";
  if (!dryRun && (!login || !password)) {
    deps.error("score-niches: DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD must be set in your shell (API login and password from app.dataforseo.com). Use --dry-run to see the planned calls without them.");
    return 2;
  }

  const nichesDir = join(deps.root, "niches");
  let ideas: Idea[];
  try {
    const v = validateCandidates(JSON.parse(readFileSync(join(nichesDir, "candidates.json"), "utf8")));
    if (v.errors.length) {
      deps.error(`score-niches: niches/candidates.json: ${v.errors.join("; ")}`);
      return 1;
    }
    ideas = v.ideas;
  } catch (e) {
    deps.error(`score-niches: can't read niches/candidates.json: ${(e as Error).message}`);
    return 1;
  }
  if (only?.length) {
    const unknown = only.filter((s) => !ideas.some((i) => i.slug === s));
    if (unknown.length) {
      deps.error(`score-niches: unknown idea ${unknown.map((s) => `"${s}"`).join(", ")}`);
      return 1;
    }
    ideas = ideas.filter((i) => only.includes(i.slug));
  }

  const client = new DfsClient({
    fetch: deps.fetch,
    creds: login && password ? { login, password } : null,
    cacheDir: join(nichesDir, ".cache"),
    budget,
    dryRun,
  });

  const scores: IdeaScore[] = [];
  const unscored: { slug: string; reason: string }[] = [];
  let code = 0;
  for (const idea of ideas) {
    if (code !== 0) {
      unscored.push({ slug: idea.slug, reason: "run stopped before this idea" });
      continue;
    }
    try {
      const s = await scoreIdea(client, idea);
      if (s) scores.push(s);
    } catch (e) {
      const msg = client.redact((e as Error).message);
      deps.error(`score-niches: ${idea.slug}: ${msg}`);
      unscored.push({ slug: idea.slug, reason: e instanceof BudgetError ? "budget reached" : msg });
      code = 1;
    }
  }

  if (dryRun) {
    const planned = client.calls.filter((c) => c.state === "planned");
    deps.log(`Dry run: ${client.calls.length} calls for ${ideas.length} idea${ideas.length === 1 ? "" : "s"}, ${planned.length} not cached. Nothing sent.`);
    for (const c of client.calls) deps.log(`  ${c.state === "cached" ? "cached " : `$${c.estimate.toFixed(4)}`}  ${c.endpoint}  ${c.label}`);
    deps.log(`Estimated cost (worst case): $${client.estimatedPlanned.toFixed(4)}; budget $${budget.toFixed(2)}${client.estimatedPlanned > budget ? " - over budget, the run would stop early; raise --budget" : ""}.`);
    return code;
  }

  const out = join(nichesDir, "scores.md");
  const date = (deps.now?.() ?? new Date()).toISOString().slice(0, 10);
  writeFileSync(out, client.redact(renderScores(scores, { date, spent: client.spent, unscored })));
  const sent = client.calls.filter((c) => c.state === "sent").length;
  const cached = client.calls.filter((c) => c.state === "cached").length;
  deps.log(`Scored ${scores.length} of ${ideas.length} idea${ideas.length === 1 ? "" : "s"}. ${sent} calls sent, ${cached} from cache. Spent $${client.spent.toFixed(4)} of $${budget.toFixed(2)}. Wrote niches/scores.md.`);
  return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2), process.env, {
    fetch: (url, init) => fetch(url, init),
    log: (m) => console.log(m),
    error: (m) => console.error(m),
    root: resolve(import.meta.dirname, ".."),
  });
}
