/**
 * sync-sites: copies every sites/*.json into the database.
 *
 *   DATABASE_URL=postgres://... npm run sync-sites            # validate, then write
 *   DATABASE_URL=postgres://... npm run sync-sites -- --dry-run   # validate and roll back
 *
 * 1. Reads the live vocabulary (capabilities, metros, fact definitions, affiliate programs) from the
 *    database and validates every config with validateSiteConfig(). Any error stops the run before
 *    anything is written.
 * 2. In one transaction, upserts a `sites` row per config and a `site_affiliates` row per configured
 *    program. Placements follow the config: `placements` gets the placement names and
 *    `placement_rules` the full entries, with any metro or capability limits. An existing affiliate's `status` and `url` (Chris's
 *    approvals and tracking links, set in the admin app) are never changed, and an existing site
 *    domain is never cleared by a config that still says null.
 *
 * DATABASE_URL is a Postgres connection string for the Supabase project (dashboard > Connect). It is
 * read from the environment only and never printed.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { placementNames, placementRules, validateSiteConfig, type SiteConfig, type Vocab } from "../packages/core/src/index.ts";

/** The part of a Postgres client sync-sites needs. pg's Client and PGlite both fit. */
export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface SiteFile {
  file: string;
  config: SiteConfig;
}

export interface SyncResult {
  sites: { slug: string; created: boolean }[];
  affiliates: { site: string; program: string; created: boolean }[];
  /** Affiliate rows whose program was removed from a config: placements cleared, row kept. */
  retired: { site: string; program: string }[];
}

export class ConfigError extends Error {
  errors: string[];
  constructor(errors: string[]) {
    super(`invalid site config:\n  ${errors.join("\n  ")}`);
    this.errors = errors;
  }
}

/** Reads every site config in a directory. guides.json is guide state, not a site. */
export function readSiteFiles(sitesDir: string): { files: SiteFile[]; errors: string[] } {
  const files: SiteFile[] = [];
  const errors: string[] = [];
  const names = readdirSync(sitesDir)
    .filter((f) => f.endsWith(".json") && f !== "guides.json")
    .sort();
  for (const file of names) {
    try {
      const config = JSON.parse(readFileSync(join(sitesDir, file), "utf8")) as SiteConfig;
      if (config.slug !== file.replace(/\.json$/, "")) errors.push(`${file}: slug "${config.slug}" must match the file name`);
      files.push({ file, config });
    } catch (e) {
      errors.push(`${file}: ${(e as Error).message}`);
    }
  }
  if (files.length === 0 && errors.length === 0) errors.push(`${sitesDir}: no site configs found`);
  return { files, errors };
}

function readGuideSlugs(sitesDir: string): string[] {
  try {
    return Object.keys(JSON.parse(readFileSync(join(sitesDir, "guides.json"), "utf8")));
  } catch {
    return [];
  }
}

/** The vocabulary a dataset has in the database right now, or null if the dataset doesn't exist. */
export async function loadVocab(db: Db, dataset: string, guides: string[]): Promise<Vocab | null> {
  const ds = await db.query<{ id: string }>(`select id from public.datasets where slug = $1`, [dataset]);
  if (ds.rows.length === 0) return null;
  const id = ds.rows[0].id;
  const col = async (sql: string, params: unknown[] = []) => (await db.query<{ v: string }>(sql, params)).rows.map((r) => r.v);
  return {
    capabilities: await col(`select slug v from public.capabilities where dataset_id = $1`, [id]),
    metros: await col(`select slug v from public.metros where dataset_id = $1`, [id]),
    factKeys: await col(`select key v from public.fact_defs where dataset_id = $1`, [id]),
    factGroups: await col(`select distinct fact_group v from public.fact_defs where dataset_id = $1`, [id]),
    affiliates: await col(`select slug v from public.affiliate_programs`),
    guides,
  };
}

/** Validates every config against the live vocabulary. Returns all errors, prefixed by file. */
export async function validateAll(db: Db, sitesDir: string): Promise<{ files: SiteFile[]; errors: string[] }> {
  const { files, errors } = readSiteFiles(sitesDir);
  const guides = readGuideSlugs(sitesDir);
  const vocabs = new Map<string, Vocab | null>();
  for (const { file, config } of files) {
    const dataset = String(config.dataset ?? "");
    if (!vocabs.has(dataset)) vocabs.set(dataset, await loadVocab(db, dataset, guides));
    const vocab = vocabs.get(dataset);
    if (!vocab) {
      errors.push(`${file}: dataset: unknown "${dataset}"`);
      continue;
    }
    for (const err of validateSiteConfig(config, vocab)) errors.push(`${file}: ${err}`);
  }
  return { files, errors };
}

/** Validates, then writes every site and its affiliate rows in one transaction. */
export async function syncSites(db: Db, sitesDir: string, opts: { dryRun?: boolean } = {}): Promise<SyncResult> {
  const { files, errors } = await validateAll(db, sitesDir);
  if (errors.length) throw new ConfigError(errors);

  const result: SyncResult = { sites: [], affiliates: [], retired: [] };
  await db.query("begin");
  try {
    for (const { config: c } of files) {
      // xmax = 0 only on a freshly inserted row: tells "created" from "updated".
      const site = await db.query<{ id: string; dataset_id: string; wanted: string; created: boolean }>(
        `insert into public.sites (slug, name, domain, dataset_id)
         select $1, $2, $3, d.id from public.datasets d where d.slug = $4
         on conflict (slug) do update
           set name = excluded.name,
               domain = coalesce(excluded.domain, public.sites.domain)
         returning id, dataset_id, (select id from public.datasets where slug = $4) as wanted, (xmax = 0) as created`,
        [c.slug, c.name, c.domain, c.dataset],
      );
      const row = site.rows[0];
      if (row.dataset_id !== row.wanted) {
        throw new ConfigError([`${c.slug}.json: dataset: the site already exists on another dataset; moving it is not supported`]);
      }
      result.sites.push({ slug: c.slug, created: row.created });

      const programs = Object.keys(c.affiliates ?? {}).sort();
      for (const program of programs) {
        // On conflict only placements change. status and url are Chris's and stay as they are.
        const aff = await db.query<{ created: boolean }>(
          `insert into public.site_affiliates (site_id, program_id, placements, placement_rules)
           select $1, p.id, $3, $4::jsonb from public.affiliate_programs p where p.slug = $2
           on conflict (site_id, program_id) do update
             set placements = excluded.placements, placement_rules = excluded.placement_rules
           returning (xmax = 0) as created`,
          [row.id, program, placementNames(c.affiliates[program]), JSON.stringify(placementRules(c, program))],
        );
        result.affiliates.push({ site: c.slug, program, created: aff.rows[0].created });
      }

      const retired = await db.query<{ program: string }>(
        `update public.site_affiliates sa set placements = '{}', placement_rules = '[]'
           from public.affiliate_programs p
          where sa.program_id = p.id and sa.site_id = $1
            and not (p.slug = any($2::text[])) and (sa.placements <> '{}' or sa.placement_rules <> '[]')
          returning p.slug as program`,
        [row.id, programs],
      );
      for (const r of retired.rows) result.retired.push({ site: c.slug, program: r.program });
    }
    await db.query(opts.dryRun ? "rollback" : "commit");
  } catch (e) {
    await db.query("rollback");
    throw e;
  }
  return result;
}

export function formatResult(r: SyncResult, dryRun: boolean): string {
  const lines = [dryRun ? "Dry run: nothing was written." : "Synced."];
  for (const s of r.sites) {
    const affs = r.affiliates.filter((a) => a.site === s.slug);
    const created = affs.filter((a) => a.created).map((a) => a.program);
    lines.push(
      `  ${s.slug}: site ${s.created ? "created" : "updated"}, ${affs.length} affiliate program(s)` +
        (created.length ? `, new: ${created.join(", ")}` : ""),
    );
  }
  for (const x of r.retired) lines.push(`  ${x.site}: ${x.program} no longer in config, placements cleared (status and link kept)`);
  return lines.join("\n");
}

export interface MainDeps {
  connect(url: string): Promise<Db & { end?(): Promise<unknown> }>;
  log(msg: string): void;
  error(msg: string): void;
}

/** CLI entry. Returns the process exit code. */
export async function main(argv: string[], env: Record<string, string | undefined>, deps: MainDeps): Promise<number> {
  const dryRun = argv.includes("--dry-run");
  const sitesFlag = argv.indexOf("--sites");
  const sitesDir = resolve(sitesFlag >= 0 && argv[sitesFlag + 1] ? argv[sitesFlag + 1] : "sites");
  if (!env.DATABASE_URL) {
    deps.error("sync-sites: DATABASE_URL is not set (Postgres connection string for the Supabase project).");
    return 2;
  }
  let db: Awaited<ReturnType<MainDeps["connect"]>> | undefined;
  try {
    db = await deps.connect(env.DATABASE_URL);
    deps.log(formatResult(await syncSites(db, sitesDir, { dryRun }), dryRun));
    return 0;
  } catch (e) {
    deps.error(e instanceof ConfigError ? `sync-sites: ${e.message}` : `sync-sites failed: ${(e as Error).message}`);
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
    log: (m) => console.log(m),
    error: (m) => console.error(m),
  });
  process.exitCode = code;
}
