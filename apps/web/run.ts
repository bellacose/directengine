/**
 * Runs Astro for one site. Astro's own `--site` flag means a URL, so this wrapper takes the site slug
 * first and hands every other argument to Astro unchanged.
 *
 *   npm run build -- --site dtf --fixture            # build sites/dtf.json from fixtures/demo.json
 *   SITE=dtf DATA_FIXTURE=fixtures/demo.json npm run build
 *   npm run build -- --site dtf                      # build from Supabase (keys in the environment)
 *   npm run dev -- --site tampa-makers               # dev server; uses the fixture unless Supabase is set
 *
 * --site <slug>       sets SITE
 * --fixture [path]    sets DATA_FIXTURE (default fixtures/demo.json, relative to the repo root)
 *
 * A build never falls back to the fixture by itself, so a production build that is missing its keys
 * stops instead of shipping fake shops. The dev server does fall back, since it never deploys.
 */

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_FIXTURE = "fixtures/demo.json";
const here = dirname(fileURLToPath(import.meta.url));

export interface Parsed {
  command: string;
  env: Record<string, string>;
  astroArgs: string[];
}

/** Splits our flags from Astro's. Pure, for tests. */
export function parseArgs(argv: string[], env: Record<string, string | undefined>): Parsed {
  const [command = "build", ...rest] = argv;
  const out: Record<string, string> = {};
  const astroArgs: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--site" || a.startsWith("--site=")) {
      const v = a.includes("=") ? a.slice(a.indexOf("=") + 1) : rest[++i];
      if (!v || v.startsWith("--")) throw new Error("--site needs a site slug, e.g. --site dtf");
      out.SITE = v;
    } else if (a === "--fixture" || a.startsWith("--fixture=")) {
      if (a.includes("=")) out.DATA_FIXTURE = a.slice(a.indexOf("=") + 1);
      else if (rest[i + 1] && !rest[i + 1].startsWith("--")) out.DATA_FIXTURE = rest[++i];
      else out.DATA_FIXTURE = DEFAULT_FIXTURE;
    } else {
      astroArgs.push(a);
    }
  }
  if (command === "dev" && !out.DATA_FIXTURE && !env.DATA_FIXTURE && !env.SUPABASE_URL) out.DATA_FIXTURE = DEFAULT_FIXTURE;
  return { command, env: out, astroArgs };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let parsed: Parsed;
  try {
    parsed = parseArgs(process.argv.slice(2), process.env);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(2);
  }
  const env: NodeJS.ProcessEnv = { ...process.env, ASTRO_TELEMETRY_DISABLED: "1", ...parsed.env };
  if (!env.SITE) {
    console.error("No site given. Use --site <slug> or SITE=<slug> (a file in sites/).");
    process.exit(2);
  }
  console.log(`site: ${env.SITE}${env.DATA_FIXTURE ? `, data: ${env.DATA_FIXTURE}` : ", data: Supabase"}`);
  const astroBin = join(dirname(createRequire(import.meta.url).resolve("astro/package.json")), "bin", "astro.mjs");
  const r = spawnSync(process.execPath, [astroBin, parsed.command, ...parsed.astroArgs], { cwd: here, env, stdio: "inherit" });
  process.exit(r.status ?? 1);
}
