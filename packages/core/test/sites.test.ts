// Checks every file in sites/ against the vocabulary the seed actually creates, so a site config
// can never name a capability, metro, fact or affiliate program the database does not have.

import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { validateSiteConfig, type SiteConfig, type Vocab } from "../src/index";

const root = join(__dirname, "..", "..", "..");
const sitesDir = join(root, "sites");
const siteFiles = readdirSync(sitesDir).filter((f) => f.endsWith(".json") && f !== "guides.json");
const guides = JSON.parse(readFileSync(join(sitesDir, "guides.json"), "utf8")) as Record<string, { approved: boolean; approvedAt: string | null }>;

let vocab: Vocab;

beforeAll(async () => {
  const db = new PGlite();
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
  `);
  const migrations = join(root, "supabase", "migrations");
  for (const f of readdirSync(migrations).filter((f) => f.endsWith(".sql")).sort()) {
    await db.exec(readFileSync(join(migrations, f), "utf8"));
  }
  await db.exec(readFileSync(join(root, "supabase", "seed.sql"), "utf8"));
  const col = async (sql: string) => (await db.query<{ v: string }>(sql)).rows.map((r) => r.v);
  vocab = {
    capabilities: await col(`select slug v from capabilities`),
    metros: await col(`select slug v from metros`),
    factKeys: await col(`select key v from fact_defs`),
    factGroups: await col(`select distinct fact_group v from fact_defs`),
    affiliates: await col(`select slug v from affiliate_programs`),
    guides: Object.keys(guides),
  };
}, 60_000);

describe("sites/*.json", () => {
  it("has at least one site", () => {
    expect(siteFiles.length).toBeGreaterThan(0);
  });

  it.each(siteFiles)("%s is valid against the seeded vocabulary", (file) => {
    const config = JSON.parse(readFileSync(join(sitesDir, file), "utf8")) as SiteConfig;
    expect(config.slug).toBe(file.replace(/\.json$/, ""));
    expect(validateSiteConfig(config, vocab)).toEqual([]);
  });

  it("guides.json: approved guides carry an approval date, drafts do not", () => {
    for (const [slug, g] of Object.entries(guides)) {
      expect(g.approved ? !!g.approvedAt : g.approvedAt === null, slug).toBe(true);
    }
  });
});
