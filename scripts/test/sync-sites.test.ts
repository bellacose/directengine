// sync-sites against the real migration and seed on in-memory Postgres (PGlite).

import { PGlite } from "@electric-sql/pglite";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ConfigError, main, syncSites, type Db } from "../sync-sites.ts";
import type { PlacementEntry } from "../../packages/core/src/index.ts";

const root = join(__dirname, "..", "..");
const realSites = join(root, "sites");

async function freshDb(): Promise<PGlite> {
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
  return db;
}

let db: PGlite;
let dir: string;

beforeAll(async () => {
  db = await freshDb(); // migration + seed once
}, 60_000);

beforeEach(async () => {
  // Back to a just-seeded database.
  await db.exec(`delete from site_affiliates; delete from sites; delete from capabilities where slug = 'screen-print';`);
  dir = mkdtempSync(join(tmpdir(), "sync-sites-"));
  cpSync(realSites, dir, { recursive: true });
}, 60_000);

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const rows = async (sql: string, params: unknown[] = []) => (await db.query<Record<string, unknown>>(sql, params)).rows;
const siteFiles = () => readdirSync(realSites).filter((f) => f.endsWith(".json") && f !== "guides.json");
const editSite = (slug: string, fn: (c: Record<string, any>) => void) => {
  const p = join(dir, `${slug}.json`);
  const c = JSON.parse(readFileSync(p, "utf8"));
  fn(c);
  writeFileSync(p, JSON.stringify(c, null, 2));
};
const affiliates = () =>
  rows(`select s.slug site, p.slug program, sa.status, sa.url, sa.placements
          from site_affiliates sa join sites s on s.id = sa.site_id join affiliate_programs p on p.id = sa.program_id
         order by 1, 2`);

describe("sync-sites", () => {
  it("creates a site row per config and an affiliate row per configured program", async () => {
    const result = await syncSites(db, dir);

    const sites = await rows(`select s.slug, s.name, s.domain, d.slug dataset from sites s join datasets d on d.id = s.dataset_id order by 1`);
    const expected = siteFiles().map((f) => JSON.parse(readFileSync(join(realSites, f), "utf8")));
    expect(sites).toEqual(
      expected.map((c) => ({ slug: c.slug, name: c.name, domain: c.domain, dataset: c.dataset })).sort((a, b) => a.slug.localeCompare(b.slug)),
    );
    expect(result.sites.every((s) => s.created)).toBe(true);

    const want = expected.flatMap((c) =>
      Object.entries(c.affiliates as Record<string, PlacementEntry[]>).map(([program, entries]) => ({
        site: c.slug, program, status: "apply", url: null,
        placements: [...new Set(entries.map((e) => (typeof e === "string" ? e : e.placement)))],
      })),
    );
    expect(await affiliates()).toEqual(want.sort((a, b) => a.site.localeCompare(b.site) || a.program.localeCompare(b.program)));
  });

  it("stores metro and capability limits in placement_rules, and plain names as unlimited rules", async () => {
    editSite("dtf", (c) => {
      c.affiliates.eazydtf = [{ placement: "ship-to-you", metros: ["tampa-bay"] }];
      c.affiliates.jiffy = [{ placement: "ship-to-you", capabilities: ["dtf"], metros: ["buffalo"] }, "guides"];
    });
    await syncSites(db, dir);
    const rules = async (program: string) =>
      (await rows(
        `select sa.placements, sa.placement_rules from site_affiliates sa join sites s on s.id = sa.site_id
           join affiliate_programs p on p.id = sa.program_id where s.slug = 'dtf' and p.slug = $1`, [program],
      ))[0];
    expect(await rules("eazydtf")).toEqual({ placements: ["ship-to-you"], placement_rules: [{ placement: "ship-to-you", metros: ["tampa-bay"] }] });
    expect(await rules("jiffy")).toEqual({
      placements: ["ship-to-you", "guides"],
      placement_rules: [{ placement: "ship-to-you", capabilities: ["dtf"], metros: ["buffalo"] }, { placement: "guides" }],
    });
    expect(await rules("transfer-express")).toEqual({ placements: ["ship-to-you"], placement_rules: [{ placement: "ship-to-you" }] });

    // Back to the plain form: the limit goes away.
    editSite("dtf", (c) => (c.affiliates.eazydtf = ["ship-to-you"]));
    await syncSites(db, dir);
    expect(await rules("eazydtf")).toEqual({ placements: ["ship-to-you"], placement_rules: [{ placement: "ship-to-you" }] });
  });

  it("refuses a placement limited to an unknown metro or capability, writing nothing", async () => {
    editSite("dtf", (c) => (c.affiliates.eazydtf = [{ placement: "ship-to-you", metros: ["orlando"], capabilities: ["vinyl"] }]));
    const err = await syncSites(db, dir).catch((e) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect(err.errors).toEqual(expect.arrayContaining([
      'dtf.json: affiliates.eazydtf.metros: unknown "orlando"',
      'dtf.json: affiliates.eazydtf.capabilities: unknown "vinyl"',
    ]));
    expect(await rows(`select * from site_affiliates`)).toEqual([]);
  });

  it("is safe to run twice", async () => {
    await syncSites(db, dir);
    const sitesBefore = await rows(`select * from sites order by slug`);
    const affBefore = await affiliates();

    const second = await syncSites(db, dir);

    expect(second.sites.some((s) => s.created)).toBe(false);
    expect(second.affiliates.some((a) => a.created)).toBe(false);
    expect(await rows(`select * from sites order by slug`)).toEqual(sitesBefore);
    expect(await affiliates()).toEqual(affBefore);
  });

  it("leaves an approved affiliate's status and link untouched", async () => {
    await syncSites(db, dir);
    await db.query(
      `update site_affiliates set status = 'approved', url = 'https://partner.example.com/track?id=1'
        where site_id = (select id from sites where slug = 'dtf')
          and program_id = (select id from affiliate_programs where slug = 'jiffy')`,
    );
    editSite("dtf", (c) => (c.affiliates.jiffy = ["guides"])); // placements change in config

    await syncSites(db, dir);

    const jiffy = (await affiliates()).find((a) => a.site === "dtf" && a.program === "jiffy");
    expect(jiffy).toEqual({
      site: "dtf", program: "jiffy", status: "approved", url: "https://partner.example.com/track?id=1", placements: ["guides"],
    });
  });

  it("keeps a removed program's row, status and link, and clears its placements", async () => {
    await syncSites(db, dir);
    await db.query(
      `update site_affiliates set status = 'approved', url = 'https://partner.example.com/x'
        where program_id = (select id from affiliate_programs where slug = 'dtfsheet')`,
    );
    editSite("dtf", (c) => delete c.affiliates.dtfsheet);

    const result = await syncSites(db, dir);

    expect(result.retired).toEqual([{ site: "dtf", program: "dtfsheet" }]);
    expect((await affiliates()).find((a) => a.program === "dtfsheet")).toMatchObject({
      status: "approved", url: "https://partner.example.com/x", placements: [],
    });
    const [{ placement_rules }] = await rows(
      `select placement_rules from site_affiliates where program_id = (select id from affiliate_programs where slug = 'dtfsheet')`,
    );
    expect(placement_rules).toEqual([]);
  });

  it("updates name and domain from config, but a null domain never clears an existing one", async () => {
    await syncSites(db, dir);
    editSite("dtf", (c) => Object.assign(c, { name: "Same Day DTF", domain: "dtf-example.com" }));
    await syncSites(db, dir);
    expect(await rows(`select name, domain from sites where slug = 'dtf'`)).toEqual([{ name: "Same Day DTF", domain: "dtf-example.com" }]);

    editSite("dtf", (c) => (c.domain = null));
    await syncSites(db, dir);
    expect(await rows(`select domain from sites where slug = 'dtf'`)).toEqual([{ domain: "dtf-example.com" }]);
  });

  it("refuses an invalid config and writes nothing, even for the valid ones", async () => {
    editSite("laser", (c) => (c.filter.capabilities = ["laser", "no-such-capability"]));
    editSite("dtf", (c) => (c.affiliates["no-such-program"] = ["guides"]));

    const err = await syncSites(db, dir).catch((e) => e);

    expect(err).toBeInstanceOf(ConfigError);
    expect(err.errors).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^laser\.json: filter\.capabilities: unknown "no-such-capability"/),
        expect.stringMatching(/^dtf\.json: affiliates: unknown program "no-such-program"/),
      ]),
    );
    expect(await rows(`select count(*)::int n from sites`)).toEqual([{ n: 0 }]);
  });

  it("refuses a file whose slug doesn't match its name, broken JSON, and an unknown dataset", async () => {
    writeFileSync(join(dir, "misnamed.json"), readFileSync(join(realSites, "dtf.json")));
    writeFileSync(join(dir, "broken.json"), "{ not json");
    editSite("laser", (c) => (c.dataset = "no-such-dataset"));

    const err = await syncSites(db, dir).catch((e) => e);

    expect(err).toBeInstanceOf(ConfigError);
    expect(err.errors.join("\n")).toMatch(/misnamed\.json: slug "dtf" must match/);
    expect(err.errors.join("\n")).toMatch(/broken\.json: /);
    expect(err.errors.join("\n")).toMatch(/laser\.json: dataset: unknown "no-such-dataset"/);
  });

  it("validates against the live vocabulary, not a copy", async () => {
    await db.query(`insert into capabilities (dataset_id, slug, name) select id, 'screen-print', 'Screen printing' from datasets where slug = 'makers'`);
    editSite("tampa-makers", (c) => c.pages.capabilityMetro.push("screen-print"));
    await expect(syncSites(db, dir)).resolves.toBeTruthy();
  });

  it("dry run validates and writes nothing", async () => {
    const result = await syncSites(db, dir, { dryRun: true });
    expect(result.sites.length).toBe(siteFiles().length);
    expect(await rows(`select count(*)::int n from sites`)).toEqual([{ n: 0 }]);
  });
});

describe("sync-sites CLI", () => {
  const run = async (argv: string[], env: Record<string, string | undefined>) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(argv, env, {
      connect: async () => db as unknown as Db,
      log: (m) => out.push(m),
      error: (m) => err.push(m),
    });
    return { code, out: out.join("\n"), err: err.join("\n") };
  };
  const env = { DATABASE_URL: "postgres://user:secret-password@db.invalid/postgres" };

  it("exits 0 and reports what it did", async () => {
    const r = await run(["--sites", dir], env);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/dtf: site created/);
  });

  it("exits non-zero on an invalid config", async () => {
    editSite("dtf", (c) => (c.angle.headline = "no_such_fact"));
    const r = await run(["--sites", dir], env);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/dtf\.json: angle\.headline: unknown "no_such_fact"/);
    expect(await rows(`select count(*)::int n from sites`)).toEqual([{ n: 0 }]);
  });

  it("exits non-zero without DATABASE_URL and never prints the connection string", async () => {
    expect((await run(["--sites", dir], {})).code).not.toBe(0);
    editSite("dtf", (c) => (c.indexGate = 0));
    const r = await run(["--sites", dir], env);
    expect(`${r.out}\n${r.err}`).not.toMatch(/secret-password/);
  });
});
