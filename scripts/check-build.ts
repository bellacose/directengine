/**
 * check-build: checks a built site in apps/web/dist before it ships (T15).
 *
 *   npm run build -- --site dtf && npm run check-build -- dtf                 # production build
 *   npm run build -- --site dtf --fixture && npm run check-build -- dtf --fixture
 *   npm run check-build -- dtf --fixture fixtures/other.json --dist /tmp/out   # another fixture or folder
 *
 * It loads the same data the build used (Supabase from SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY,
 * or the fixture with --fixture) and takes the page list and index states from planPages() (rule 7).
 * Then it fails on: a page without a canonical, or one on another domain or not pointing at itself;
 * an indexable page missing from the sitemap, or a sitemap entry without an indexable page; a noindex
 * page in the sitemap; an affiliate link that bypasses /go/; a /go/ link without the disclosure line;
 * aggregateRating or reviews in a page; and, without --fixture, any fixture marker. Every failure is
 * printed with its page; the exit code is 1 on any failure, 2 when it can't run.
 * The rules are in scripts/lib/check-build.ts. No network access beyond the Supabase read.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { planPages } from "../packages/core/src/index.ts";
import { findRoot, loadSite, type SiteData } from "../apps/web/src/lib/load.ts";
import { STATIC_HTML } from "../apps/web/src/lib/static-pages.ts";
import { checkBuild, type Failure } from "./lib/check-build.ts";

const DEFAULT_FIXTURE = "fixtures/demo.json";

export interface Args {
  slug: string;
  /** Fixture path (relative to the repo root), or null for a production build. */
  fixture: string | null;
  dist: string | null;
}

export class UsageError extends Error {}

export function parseArgs(argv: string[]): Args {
  let slug: string | null = null;
  let fixture: string | null = null;
  let dist: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--fixture") fixture = argv[i + 1]?.endsWith(".json") ? argv[++i] : DEFAULT_FIXTURE;
    else if (a.startsWith("--fixture=")) fixture = a.slice("--fixture=".length);
    else if (a === "--dist") {
      dist = argv[++i] ?? null;
      if (!dist || dist.startsWith("--")) throw new UsageError("--dist needs a folder");
    } else if (a.startsWith("--dist=")) dist = a.slice("--dist=".length);
    else if (a.startsWith("--")) throw new UsageError(`unknown option ${a}`);
    else if (slug === null) slug = a;
    else throw new UsageError(`unexpected argument ${a}`);
  }
  if (!slug) throw new UsageError("usage: npm run check-build -- <slug> [--fixture [path]] [--dist <folder>]");
  return { slug, fixture, dist };
}

/** Every .html file and sitemap.xml under `dir`, keyed by path relative to it with "/" separators. */
export function readDist(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (f.endsWith(".html") || p === join(dir, "sitemap.xml")) out[relative(dir, p).replaceAll("\\", "/")] = readFileSync(p, "utf8");
    }
  };
  walk(dir);
  return out;
}

export interface Result {
  failures: Failure[];
  pages: number;
  host: string;
}

/** Runs every check on one built site. Throws if the data can't be loaded or the folder isn't a build. */
export async function run(args: Args, env: Record<string, string | undefined>, root = findRoot()): Promise<Result> {
  const dist = args.dist ? (isAbsolute(args.dist) ? args.dist : resolve(args.dist)) : join(root, "apps", "web", "dist");
  if (!existsSync(join(dist, "index.html"))) throw new UsageError(`no built site in ${dist} (run npm run build -- --site ${args.slug} first)`);

  const data: SiteData = await loadSite({
    root,
    env: args.fixture
      ? { SITE: args.slug, DATA_FIXTURE: args.fixture }
      : { SITE: args.slug, SUPABASE_URL: env.SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY },
  });
  const plan = planPages(data.site, data);
  const production = !args.fixture;
  const failures: Failure[] = [];
  // Same host rule as apps/web/src/lib/site.ts; a production build must have a real domain.
  const host = data.site.domain ?? `${data.site.slug}.preview.invalid`;
  if (production && !data.site.domain) failures.push({ page: `sites/${args.slug}.json`, reason: "has no domain, so canonicals use a preview host" });

  failures.push(
    ...checkBuild({
      host,
      plan,
      staticHtml: STATIC_HTML,
      affiliates: data.affiliates.map((a) => ({ slug: a.slug, status: a.status, url: a.url })),
      files: readDist(dist),
      production,
    }),
  );
  return { failures, pages: plan.length, host };
}

export async function main(argv: string[], env: Record<string, string | undefined>, log = console.log, err = console.error): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    err((e as Error).message);
    return 2;
  }
  let result: Result;
  try {
    result = await run(args, env);
  } catch (e) {
    err(`check-build ${args.slug}: ${(e as Error).message}`);
    return 2;
  }
  const mode = args.fixture ? `fixture ${args.fixture}` : "production";
  if (result.failures.length === 0) {
    log(`check-build ${args.slug} (${mode}): ${result.pages} planned pages on ${result.host}, all checks passed`);
    return 0;
  }
  for (const f of result.failures) err(`FAIL ${f.page}: ${f.reason}`);
  err(`check-build ${args.slug} (${mode}): ${result.failures.length} failure${result.failures.length === 1 ? "" : "s"}`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exit(await main(process.argv.slice(2), process.env));
}
