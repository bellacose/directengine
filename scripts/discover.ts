/**
 * discover: finds shops with Google Places Text Search and queues their place IDs for review.
 *
 *   DATABASE_URL=... GOOGLE_PLACES_API_KEY=... npm run discover -- --capability dtf --metro tampa-bay
 *   npm run discover -- --capability dtf --metro tampa-bay --dry-run    # print the queries only
 *
 * Options: --dataset <slug> (default makers), --capability <slug,...> and --metro <slug,...> (default
 * all in the dataset), --max-pages <1-3> (default 3; Google returns at most 20 per page, 60 in all).
 *
 * Queries are every search term for a capability (scripts/discover-queries.json, falling back to the
 * capability's name) in every city of the metro, e.g. "DTF transfers in Brandon, FL".
 *
 * What is stored (D8): **only** the place ID and the query that found it, in `candidates`. The
 * request's field mask asks Google for nothing but `places.id` and `nextPageToken` (the ID-only SKU),
 * so no name, address, phone, hours, rating or coordinate ever reaches this process. A place that is
 * already a candidate or already a listing is skipped. Shop details are looked at live in the admin
 * review screen and never saved.
 *
 * GOOGLE_PLACES_API_KEY is a server key restricted to the Places API (New). DATABASE_URL is the
 * Postgres connection string for the Supabase project. Both are read from the environment only and
 * never printed.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** The part of a Postgres client discover needs. pg's Client and PGlite both fit. */
export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export const TEXT_SEARCH_URL = "https://places.googleapis.com/v1/places:searchText";
/** Text Search Essentials (ID only): nothing but place IDs and the paging token. */
export const FIELD_MASK = "places.id,nextPageToken";
const PLACE_ID_RE = /^[A-Za-z0-9_-]{10,300}$/;

export interface Query {
  capability: string;
  metro: string;
  text: string;
}

export interface Vocab {
  datasetId: string;
  capabilities: { slug: string; name: string }[];
  metros: { slug: string; name: string; state: string; cities: string[] }[];
}

export async function loadVocab(db: Db, dataset: string): Promise<Vocab | null> {
  const ds = await db.query<{ id: string }>(`select id from public.datasets where slug = $1`, [dataset]);
  if (!ds.rows.length) return null;
  const datasetId = ds.rows[0].id;
  const capabilities = (await db.query<{ slug: string; name: string }>(
    `select slug, name from public.capabilities where dataset_id = $1 order by slug`, [datasetId])).rows;
  const metros = (await db.query<{ slug: string; name: string; state: string; cities: string[] }>(
    `select slug, name, state, cities from public.metros where dataset_id = $1 order by slug`, [datasetId])).rows;
  return { datasetId, capabilities, metros };
}

/** Every search term for each chosen capability, in every city of each chosen metro. */
export function buildQueries(
  vocab: Vocab,
  terms: Record<string, string[]>,
  pick: { capabilities?: string[]; metros?: string[] } = {},
): { queries: Query[]; errors: string[] } {
  const errors: string[] = [];
  const caps = pick.capabilities?.length ? pick.capabilities : vocab.capabilities.map((c) => c.slug);
  const metros = pick.metros?.length ? pick.metros : vocab.metros.map((m) => m.slug);
  for (const c of caps) if (!vocab.capabilities.some((x) => x.slug === c)) errors.push(`unknown capability "${c}"`);
  for (const m of metros) if (!vocab.metros.some((x) => x.slug === m)) errors.push(`unknown metro "${m}"`);
  if (errors.length) return { queries: [], errors };

  const queries: Query[] = [];
  for (const c of caps) {
    const cap = vocab.capabilities.find((x) => x.slug === c)!;
    const list = terms[c]?.length ? terms[c] : [cap.name];
    for (const m of metros) {
      const metro = vocab.metros.find((x) => x.slug === m)!;
      const cities = metro.cities.length ? metro.cities : [metro.name];
      for (const term of list) for (const city of cities) queries.push({ capability: c, metro: m, text: `${term} in ${city}, ${metro.state}` });
    }
  }
  return { queries, errors };
}

export class PlacesError extends Error {}

/** Runs one Text Search query through every page and returns the place IDs, nothing else. */
export async function searchPlaceIds(fetchFn: Fetch, apiKey: string, text: string, maxPages = 3): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const res = await fetchFn(TEXT_SEARCH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": apiKey, "X-Goog-FieldMask": FIELD_MASK },
      body: JSON.stringify(pageToken ? { textQuery: text, pageSize: 20, pageToken } : { textQuery: text, pageSize: 20 }),
    });
    if (!res.ok) {
      // Google's error body names the problem (bad key, API not enabled, quota); it never echoes the key.
      const detail = (await res.text().catch(() => "")).slice(0, 300).replaceAll(apiKey, "[key]");
      throw new PlacesError(`Places Text Search failed with HTTP ${res.status}: ${detail}`);
    }
    const body = (await res.json()) as { places?: { id?: unknown }[]; nextPageToken?: unknown };
    // Keep the ID and drop everything else, even if Google ever sent more than the mask asked for.
    for (const p of body.places ?? []) if (typeof p.id === "string" && PLACE_ID_RE.test(p.id)) ids.push(p.id);
    if (typeof body.nextPageToken !== "string" || !body.nextPageToken) break;
    pageToken = body.nextPageToken;
  }
  return ids;
}

/**
 * The only write discover makes. Columns: dataset, place ID, query. Skips a place already queued for
 * this dataset or already a listing. Returns true when a new candidate was queued.
 */
export async function insertCandidate(db: Db, datasetId: string, placeId: string, query: string): Promise<boolean> {
  const r = await db.query(
    `insert into public.candidates (dataset_id, place_id, query)
     select $1, $2, $3
      where not exists (select 1 from public.listings where place_id = $2)
     on conflict (dataset_id, place_id) do nothing
     returning id`,
    [datasetId, placeId, query],
  );
  return r.rows.length === 1;
}

export interface DiscoverResult {
  queries: number;
  found: number;
  added: number;
}

export async function discover(
  db: Db,
  fetchFn: Fetch,
  apiKey: string,
  datasetId: string,
  queries: Query[],
  opts: { maxPages?: number; log?: (m: string) => void } = {},
): Promise<DiscoverResult> {
  const seen = new Set<string>();
  let added = 0;
  for (const q of queries) {
    const ids = await searchPlaceIds(fetchFn, apiKey, q.text, opts.maxPages ?? 3);
    let n = 0;
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      if (await insertCandidate(db, datasetId, id, q.text)) n++;
    }
    added += n;
    opts.log?.(`  ${q.text}: ${ids.length} found, ${n} new`);
  }
  return { queries: queries.length, found: seen.size, added };
}

// ------------------------------------------------------------------ CLI

const flag = (argv: string[], name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const list = (v: string | undefined) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined);

export interface MainDeps {
  connect(url: string): Promise<Db & { end?(): Promise<unknown> }>;
  fetch: Fetch;
  log(msg: string): void;
  error(msg: string): void;
  termsFile?: string;
}

/** CLI entry. Returns the process exit code. */
export async function main(argv: string[], env: Record<string, string | undefined>, deps: MainDeps): Promise<number> {
  const dryRun = argv.includes("--dry-run");
  const dataset = flag(argv, "--dataset") ?? "makers";
  const maxPages = Number(flag(argv, "--max-pages") ?? 3);
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 3) {
    deps.error("discover: --max-pages must be 1, 2 or 3.");
    return 2;
  }
  if (!env.DATABASE_URL) {
    deps.error("discover: DATABASE_URL is not set (Postgres connection string for the Supabase project).");
    return 2;
  }
  if (!dryRun && !env.GOOGLE_PLACES_API_KEY) {
    deps.error("discover: GOOGLE_PLACES_API_KEY is not set (server key restricted to the Places API).");
    return 2;
  }

  let db: Awaited<ReturnType<MainDeps["connect"]>> | undefined;
  try {
    db = await deps.connect(env.DATABASE_URL);
    const vocab = await loadVocab(db, dataset);
    if (!vocab) {
      deps.error(`discover: unknown dataset "${dataset}"`);
      return 1;
    }
    const termsFile = deps.termsFile ?? resolve("scripts", "discover-queries.json");
    const allTerms = JSON.parse(readFileSync(termsFile, "utf8")) as Record<string, Record<string, string[]>>;
    const { queries, errors } = buildQueries(vocab, allTerms[dataset] ?? {}, {
      capabilities: list(flag(argv, "--capability")),
      metros: list(flag(argv, "--metro")),
    });
    if (errors.length) {
      deps.error(`discover: ${errors.join("; ")}`);
      return 1;
    }
    if (dryRun) {
      deps.log(`Dry run: ${queries.length} queries, nothing sent to Google or written.`);
      for (const q of queries) deps.log(`  ${q.text}`);
      return 0;
    }
    const r = await discover(db, deps.fetch, env.GOOGLE_PLACES_API_KEY!, vocab.datasetId, queries, { maxPages, log: deps.log });
    deps.log(`Done: ${r.queries} queries, ${r.found} places found, ${r.added} new candidates queued for review.`);
    return 0;
  } catch (e) {
    const msg = (e as Error).message.replaceAll(env.GOOGLE_PLACES_API_KEY || "\u0000", "[key]");
    deps.error(`discover failed: ${msg}`);
    return 1;
  } finally {
    await db?.end?.();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const code = await main(process.argv.slice(2), process.env, {
    async connect(url) {
      const { default: pg } = await import("pg");
      const client = new pg.Client({ connectionString: url });
      await client.connect();
      return client as unknown as Db & { end(): Promise<void> };
    },
    fetch: (url, init) => fetch(url, init),
    log: (m) => console.log(m),
    error: (m) => console.error(m),
    termsFile: join(import.meta.dirname, "discover-queries.json"),
  });
  process.exitCode = code;
}
