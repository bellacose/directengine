// The build-time loader: fixture path, Supabase path (real supabase-js against the real migration and
// seed on in-memory Postgres), the rules both must keep, and where the service role key may appear.

import { PGlite } from "@electric-sql/pglite";
import { planPages, type Page } from "@directory-engine/core";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { syncSites } from "../../../scripts/sync-sites.ts";
import { LoadError, loadSite, type Fixture, type SiteData } from "../src/lib/load.ts";
import { freshDb, restFetch, root, seedFixture, type RestLog } from "./helpers.ts";

const KEY = "dummy-service-role-key-6f1c2b9e-never-real";
const URL_ = "http://supabase.test";
const SITES = readdirSync(join(root, "sites")).filter((f) => f.endsWith(".json") && f !== "guides.json").map((f) => f.replace(/\.json$/, "")).sort();
const fixture: Fixture = JSON.parse(readFileSync(join(root, "fixtures", "demo.json"), "utf8"));
const TODAY = "2026-11-15"; // fixed, so stale flags in fixture-only tests don't drift

let db: PGlite;
let dbToday: string;

beforeAll(async () => {
  db = await freshDb();
  await syncSites(db, join(root, "sites"));
  await seedFixture(db, fixture);
  dbToday = (await db.query<{ d: string }>(`select current_date::text d`)).rows[0].d;
}, 120_000);

const fromFixture = (site: string, today = TODAY) =>
  loadSite({ root, today, env: { SITE: site, DATA_FIXTURE: "fixtures/demo.json" } });
const fromDb = (site: string, log?: RestLog, maxRows?: number) =>
  loadSite({ root, env: { SITE: site, SUPABASE_URL: URL_, SUPABASE_SERVICE_ROLE_KEY: KEY }, fetch: restFetch(db, KEY, log, { maxRows }) });

/** updatedAt is set by the database clock, so it can't match the fixture's date. Everything else must. */
const comparable = (d: SiteData) => ({ ...d, listings: d.listings.map((l) => ({ ...l, updatedAt: "<db clock>" })) });

const listing = (d: SiteData, slug: string) => d.listings.find((l) => l.slug === slug);
const paths = (pages: Page[], type?: Page["type"]) => pages.filter((p) => !type || p.type === type).map((p) => p.path);
const plan = (d: SiteData) => planPages(d.site, d);

describe("fixture", () => {
  it("is obviously fake: Example names, example.com websites, 555 numbers", () => {
    for (const l of fixture.listings) {
      expect(l.name).toMatch(/^Example /);
      expect(l.website).toMatch(/^https:\/\/example\.com\//);
      expect(l.phone).toMatch(/^\(\d{3}\) 555-01\d\d$/);
    }
  });

  it("has at least 12 published shops across both metros", () => {
    const published = fixture.listings.filter((l) => l.status === "published");
    expect(published.length).toBeGreaterThanOrEqual(12);
    expect(new Set(published.flatMap((l) => l.metros))).toEqual(new Set(["tampa-bay", "buffalo"]));
  });

  it("has the same vocabulary and programs as the seed", async () => {
    const q = async (sql: string) => (await db.query<Record<string, unknown>>(sql)).rows;
    expect(await q(`select slug, name from capabilities order by slug`)).toEqual(fixture.vocabulary.capabilities);
    expect(await q(`select slug, name, state, cities from metros order by slug`)).toEqual(fixture.vocabulary.metros);
    expect(await q(`select key, label, value_type as type, fact_group as "group", sort from fact_defs order by sort`)).toEqual(fixture.vocabulary.factDefs);
    expect(await q(`select slug, name from affiliate_programs order by slug`)).toEqual(fixture.affiliatePrograms.map(({ slug, name }) => ({ slug, name })));
  });
});

describe("fixture path covers every case", () => {
  it("loads published listings only, with core fields and core-field checks", async () => {
    const d = await fromFixture("tampa-makers");
    expect(d.listings.every((l) => l.status === "published")).toBe(true);
    expect(listing(d, "example-draft-shop-tampa")).toBeUndefined();
    expect(listing(d, "example-closed-shop-tampa")).toBeUndefined();
    const shop = listing(d, "example-dtf-tampa")!;
    expect(shop).toMatchObject({ city: "Tampa", state: "FL", zip: "33602", phone: "(813) 555-0101", website: "https://example.com/example-dtf-tampa", lat: 27.95, lng: -82.46 });
    expect(Object.keys(shop.keyChecks).sort()).toEqual(["address", "capabilities", "metros", "name", "phone", "website"]);
    expect(shop.keyChecks.phone).toEqual({ checkedAt: "2026-11-10", method: "phone_call" });
  });

  it("drops a fact typed in without a check", async () => {
    const shop = listing(await fromFixture("dtf"), "example-dtf-tampa")!;
    expect(shop.facts.map((f) => f.key)).not.toContain("dtf_price_per_foot_usd");
    expect(shop.facts.map((f) => f.key)).toContain("dtf_same_day_cutoff");
  });

  it("flags a fact checked over 180 days ago as stale, and only that one", async () => {
    const all = (await fromFixture("tampa-makers")).listings.flatMap((l) => l.facts.map((f) => ({ slug: l.slug, ...f })));
    expect(all.filter((f) => f.stale).map((f) => [f.slug, f.key])).toEqual([["example-dtf-buffalo", "hours"]]);
  });

  it("has a list page at the index gate and one below it", async () => {
    const pages = plan(await fromFixture("dtf"));
    const list = (path: string) => pages.find((p) => p.path === path)!;
    expect(list("/dtf/tampa-bay/")).toMatchObject({ indexable: true, listingIds: expect.any(Array) });
    expect(list("/dtf/tampa-bay/").listingIds).toHaveLength(5); // exactly the gate
    expect(list("/dtf/buffalo/").indexable).toBe(false);
  });

  it("has shops with both capabilities, with a page on each site", async () => {
    const dtf = paths(plan(await fromFixture("dtf")), "shop");
    const laser = paths(plan(await fromFixture("laser")), "shop");
    for (const slug of ["example-makers-st-pete", "example-makers-hamburg"]) {
      expect(dtf).toContain(`/shop/${slug}/`);
      expect(laser).toContain(`/shop/${slug}/`);
    }
  });

  it("has a shop below minFacts in one angle: listed there, no page there", async () => {
    const dtf = await fromFixture("dtf");
    const laser = await fromFixture("laser");
    const largo = listing(laser, "example-laser-and-print-largo")!;
    expect(paths(plan(dtf), "shop")).toContain("/shop/example-laser-and-print-largo/");
    expect(paths(plan(laser), "shop")).not.toContain("/shop/example-laser-and-print-largo/");
    expect(plan(laser).find((p) => p.path === "/laser/tampa-bay/")!.listingIds).toContain(largo.id);
  });

  it("covers uv-dtf, and builds every configured site", async () => {
    const dtf = await fromFixture("dtf");
    expect(dtf.listings.some((l) => l.capabilities.includes("uv-dtf"))).toBe(true);
    for (const s of SITES) expect(plan(await fromFixture(s)).length).toBeGreaterThan(1);
  });

  it("returns this site's affiliates with their state, and guide states", async () => {
    const d = await fromFixture("dtf");
    expect(d.affiliates.map((a) => a.slug)).toEqual(Object.keys(d.site.affiliates).sort());
    expect(d.affiliates.find((a) => a.slug === "jiffy")).toEqual({
      slug: "jiffy", name: "Jiffy", status: "apply", url: null, hasSupplierFacts: false, factsCheckedAt: null,
      placements: ["ship-to-you", "guides"], cutoffNote: null, priceNote: null,
    });
    expect(d.guides.find((g) => g.slug === "best-heat-press-for-dtf")).toEqual({ slug: "best-heat-press-for-dtf", approved: false, approvedAt: null });
  });
});

describe("Supabase path", () => {
  it.each(SITES)("produces exactly what the fixture path produces (%s)", async (site) => {
    expect(comparable(await fromDb(site))).toEqual(comparable(await fromFixture(site, dbToday)));
  });

  it("produces the same plan as the fixture path, apart from dates", async () => {
    for (const site of SITES) {
      const strip = (ps: Page[]) => ps.map(({ lastmod, ...p }) => p);
      expect(strip(plan(await fromDb(site)))).toEqual(strip(plan(await fromFixture(site, dbToday))));
    }
  });

  it("reads every row when the API returns fewer rows per request than asked", async () => {
    expect(await fromDb("tampa-makers", undefined, 2)).toEqual(await fromDb("tampa-makers"));
  });

  it("reads facts only from public_listing_facts, never listing_facts", async () => {
    const log: RestLog = { tables: [], authHeaders: [] };
    await fromDb("dtf", log);
    expect(log.tables).toContain("public_listing_facts");
    expect(log.tables).not.toContain("listing_facts");
    expect(log.tables).not.toContain("listing_fact_status");
  });

  it("a fact that exists only in listing_facts, without a check, never reaches the output", async () => {
    const id = fixture.listings.find((l) => l.slug === "example-makers-st-pete")!.id;
    await db.query(
      `insert into listing_facts (listing_id, dataset_id, key, value)
       select $1, dataset_id, 'dtf_max_width_in', '24'::jsonb from listings where id = $1`, [id]);
    // and a verified value edited without a new check
    await db.query(`update listing_facts set value = '"17:00"' where listing_id = $1 and key = 'dtf_same_day_cutoff'`, [id]);
    try {
      for (const site of SITES) {
        const shop = listing(await fromDb(site), "example-makers-st-pete");
        if (!shop) continue;
        expect(shop.facts.map((f) => f.key)).not.toContain("dtf_max_width_in");
        expect(shop.facts.map((f) => f.key)).not.toContain("dtf_same_day_cutoff");
        expect(JSON.stringify(shop)).not.toMatch(/17:00|"24"|:24\b/);
      }
    } finally {
      await db.query(`delete from listing_facts where listing_id = $1 and key = 'dtf_max_width_in'`, [id]);
      await db.query(`select record_check($1, 'phone_call', 'fixture', '{"dtf_same_day_cutoff": "16:00"}'::jsonb, '{}', '2026-11-10')`, [id]);
    }
  });

  it("carries an approved affiliate's link and supplier facts, same as the fixture path", async () => {
    const variant: Fixture = structuredClone(fixture);
    const te = variant.affiliatePrograms.find((p) => p.slug === "transfer-express")!;
    Object.assign(te, { cutoffNote: "Example cutoff note", priceNote: "Example price note", factsCheckedAt: "2026-11-01" });
    variant.siteAffiliates = { dtf: { "transfer-express": { status: "approved", url: "https://example.com/track?site=dtf" } } };
    const vdb = await freshDb();
    await syncSites(vdb, join(root, "sites"));
    await seedFixture(vdb, variant);
    const dir = mkdtempSync(join(tmpdir(), "fixture-"));
    try {
      writeFileSync(join(dir, "variant.json"), JSON.stringify(variant));
      const today = (await vdb.query<{ d: string }>(`select current_date::text d`)).rows[0].d;
      const a = await loadSite({ root, env: { SITE: "dtf", SUPABASE_URL: URL_, SUPABASE_SERVICE_ROLE_KEY: KEY }, fetch: restFetch(vdb, KEY) });
      const b = await loadSite({ root, today, env: { SITE: "dtf", DATA_FIXTURE: join(dir, "variant.json") } });
      expect(comparable(a)).toEqual(comparable(b));
      expect(a.affiliates.find((x) => x.slug === "transfer-express")).toMatchObject({
        status: "approved", url: "https://example.com/track?site=dtf", hasSupplierFacts: true, factsCheckedAt: "2026-11-01",
      });
      expect(paths(plan(a), "shipToYou")).toEqual(["/ship/dtf-to-buffalo/", "/ship/dtf-to-tampa-bay/"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await vdb.close();
    }
  }, 120_000);
});

describe("the loader stops the build", () => {
  const dbEnv = { SUPABASE_URL: URL_, SUPABASE_SERVICE_ROLE_KEY: KEY };
  const fails = (env: Record<string, string>, pattern: RegExp, r = root) =>
    expect(loadSite({ root: r, env, fetch: restFetch(db, KEY) })).rejects.toThrow(expect.objectContaining({ name: "LoadError", message: expect.stringMatching(pattern) }));

  it("without SITE", () => fails({ ...dbEnv }, /SITE is not set/));
  it("on an unknown or malformed SITE", async () => {
    await fails({ SITE: "no-such-site", ...dbEnv }, /site config for "no-such-site" not found/);
    await fails({ SITE: "../package", ...dbEnv }, /not a valid site slug/);
  });
  it("without the Supabase URL or key", async () => {
    await fails({ SITE: "dtf" }, /SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY not set/);
    await fails({ SITE: "dtf", SUPABASE_URL: URL_ }, /SUPABASE_SERVICE_ROLE_KEY not set/);
    await fails({ SITE: "dtf", SUPABASE_SERVICE_ROLE_KEY: KEY }, /SUPABASE_URL not set/);
  });
  it("on a missing fixture file", () => fails({ SITE: "dtf", DATA_FIXTURE: "fixtures/nope.json" }, /DATA_FIXTURE not found/));
  it("on a wrong key", () =>
    expect(loadSite({ root, env: { SITE: "dtf", SUPABASE_URL: URL_, SUPABASE_SERVICE_ROLE_KEY: "wrong" }, fetch: restFetch(db, KEY) })).rejects.toThrow(LoadError));

  describe("on an invalid config", () => {
    let tmp: string;
    beforeAll(() => {
      tmp = mkdtempSync(join(tmpdir(), "load-root-"));
      cpSync(join(root, "sites"), join(tmp, "sites"), { recursive: true });
      cpSync(join(root, "fixtures"), join(tmp, "fixtures"), { recursive: true });
      mkdirSync(join(tmp, "packages", "core"), { recursive: true });
      const p = join(tmp, "sites", "dtf.json");
      const c = JSON.parse(readFileSync(p, "utf8"));
      c.angle.headline = "no_such_fact";
      c.filter.capabilities.push("no-such-capability");
      writeFileSync(p, JSON.stringify(c));
      writeFileSync(join(tmp, "sites", "misnamed.json"), readFileSync(join(root, "sites", "laser.json")));
    });
    afterAll(() => rmSync(tmp, { recursive: true, force: true }));

    it("on the Supabase path", () => fails({ SITE: "dtf", ...dbEnv }, /invalid site config[\s\S]*filter\.capabilities: unknown "no-such-capability"[\s\S]*angle\.headline: unknown "no_such_fact"/, tmp));
    it("on the fixture path", () => fails({ SITE: "dtf", DATA_FIXTURE: "fixtures/demo.json" }, /invalid site config[\s\S]*angle\.headline/, tmp));
    it("when the slug doesn't match the file", () => fails({ SITE: "misnamed", DATA_FIXTURE: "fixtures/demo.json" }, /must match the file name/, tmp));
  });

  it("when the site hasn't been synced to the database", async () => {
    const empty = await freshDb();
    try {
      await expect(loadSite({ root, env: { SITE: "dtf", ...dbEnv }, fetch: restFetch(empty, KEY) })).rejects.toThrow(/not in the database yet; run npm run sync-sites/);
    } finally {
      await empty.close();
    }
  }, 60_000);
});

describe("the service role key", () => {
  it("is sent to the API and never appears in what the loader returns or throws", async () => {
    const log: RestLog = { tables: [], authHeaders: [] };
    const d = await fromDb("dtf", log);
    expect(log.authHeaders.every((h) => h === `Bearer ${KEY}`)).toBe(true);
    expect(JSON.stringify(d)).not.toContain(KEY);
    const err = await loadSite({ root, env: { SITE: "dtf", SUPABASE_URL: URL_, SUPABASE_SERVICE_ROLE_KEY: KEY }, fetch: restFetch(db, "other") }).catch((e) => e);
    expect(err).toBeInstanceOf(LoadError);
    expect(`${err.message}\n${err.stack}`).not.toContain(KEY);
  });

  it("is named nowhere in the web app's source except the loader", () => {
    const src = join(root, "apps", "web", "src");
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]));
    const hits = files(src).filter((f) => /SERVICE_ROLE|service_role|serviceRole/.test(readFileSync(f, "utf8")));
    expect(hits.map((f) => relative(root, f).replaceAll("\\", "/"))).toEqual(["apps/web/src/lib/load.ts"]);
  });

  // The Astro build arrives in T3. Once apps/web has a build script, this builds every site from the
  // fixture with a dummy key in the environment and greps the output for it.
  const pkg = JSON.parse(readFileSync(join(root, "apps", "web", "package.json"), "utf8"));
  it.skipIf(!pkg.scripts?.build)("appears nowhere in any site's built output", () => {
    for (const site of SITES) {
      const out = mkdtempSync(join(tmpdir(), `build-${site}-`));
      try {
        execFileSync("npm", ["run", "build", "--", "--outDir", out], {
          cwd: join(root, "apps", "web"), shell: true, stdio: "pipe",
          env: { ...process.env, SITE: site, DATA_FIXTURE: "fixtures/demo.json", SUPABASE_URL: URL_, SUPABASE_SERVICE_ROLE_KEY: KEY },
        });
        const files = (dir: string): string[] =>
          readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]));
        expect(existsSync(out) && files(out).length).toBeTruthy();
        for (const f of files(out)) expect(readFileSync(f, "utf8"), relative(out, f)).not.toContain(KEY);
      } finally {
        rmSync(out, { recursive: true, force: true });
      }
    }
  }, 600_000);
});
