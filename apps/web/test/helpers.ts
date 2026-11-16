// Test helpers: the real migration and seed on in-memory Postgres (PGlite), a stand-in for the
// Supabase REST API (PostgREST) so the loader's real supabase-js client can read it, and a seeder
// that writes a fixture into the database the way the admin app will: drafts, record_check(), publish.

import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Fixture } from "../src/lib/load.ts";

export const root = join(__dirname, "..", "..", "..");

export async function freshDb(): Promise<PGlite> {
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

export interface RestLog {
  tables: string[];
  authHeaders: string[];
}

const IDENT = /^[a-z_][a-z0-9_]*$/;
const ident = (s: string) => {
  if (!IDENT.test(s)) throw new Error(`fake PostgREST: unsupported identifier "${s}"`);
  return `"${s}"`;
};
const unquote = (s: string) => (s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s);

/**
 * A fetch that answers supabase-js table reads from PGlite the way PostgREST does: select=, eq./in.
 * filters, order=, offset/limit, JSON built by Postgres (dates as YYYY-MM-DD, numerics as numbers).
 * Anything else is an error, so the loader can't quietly depend on a feature this doesn't check.
 */
export function restFetch(db: PGlite, expectKey: string, log: RestLog = { tables: [], authHeaders: [] }, opts: { maxRows?: number } = {}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const m = url.pathname.match(/^\/rest\/v1\/([a-z_]+)$/);
    if (req.method !== "GET" || !m) return new Response(JSON.stringify({ message: `unsupported ${req.method} ${url.pathname}` }), { status: 400 });
    log.authHeaders.push(req.headers.get("authorization") ?? "");
    if (req.headers.get("apikey") !== expectKey || req.headers.get("authorization") !== `Bearer ${expectKey}`) {
      return new Response(JSON.stringify({ message: "Invalid API key" }), { status: 401 });
    }
    const table = m[1];
    log.tables.push(table);

    const params: unknown[] = [];
    const where: string[] = [];
    let cols = "*";
    let order = "";
    let offset = 0;
    let limit = opts.maxRows ?? 1000;
    for (const [k, v] of url.searchParams) {
      if (k === "select") cols = v.split(",").map(ident).join(", ");
      else if (k === "order") {
        order = " order by " + v.split(",").map((o) => {
          const [c, dir] = o.split(".");
          if (dir !== "asc" && dir !== "desc") throw new Error(`fake PostgREST: order "${o}"`);
          return `${ident(c)} ${dir}`;
        }).join(", ");
      } else if (k === "offset") offset = Number(v);
      else if (k === "limit") limit = Math.min(Number(v), opts.maxRows ?? Infinity);
      else if (v.startsWith("eq.")) {
        params.push(v.slice(3));
        where.push(`${ident(k)}::text = $${params.length}`);
      } else if (v.startsWith("in.(") && v.endsWith(")")) {
        params.push(v.slice(4, -1).split(",").map(unquote));
        where.push(`${ident(k)}::text = any($${params.length}::text[])`);
      } else throw new Error(`fake PostgREST: unsupported parameter ${k}=${v}`);
    }
    const sql =
      `select coalesce(json_agg(t), '[]'::json) as rows from (select ${cols} from public.${ident(table)}` +
      (where.length ? ` where ${where.join(" and ")}` : "") + `${order} offset ${offset} limit ${limit}) t`;
    try {
      const res = await db.query<{ rows: unknown[] }>(sql, params);
      return new Response(JSON.stringify(res.rows[0].rows), { status: 200, headers: { "content-type": "application/json" } });
    } catch (e) {
      return new Response(JSON.stringify({ message: (e as Error).message }), { status: 400, headers: { "content-type": "application/json" } });
    }
  }) as typeof fetch;
}

/** Writes a fixture into the database through the same rules as real data. */
export async function seedFixture(db: PGlite, fx: Fixture): Promise<void> {
  const one = async (sql: string, params: unknown[] = []) => (await db.query<Record<string, any>>(sql, params)).rows[0];
  const ds = (await one(`select id from datasets where slug = $1`, [fx.dataset])).id;

  for (const p of fx.affiliatePrograms) {
    await db.query(
      `update affiliate_programs set cutoff_note = $2, price_note = $3, facts_checked_at = $4 where slug = $1`,
      [p.slug, p.cutoffNote, p.priceNote, p.factsCheckedAt],
    );
  }

  for (const l of fx.listings) {
    await db.query(
      `insert into listings (id, dataset_id, slug, name, address1, address2, city, state, zip, phone, website, lat, lng, description)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [l.id, ds, l.slug, l.name, l.address1, l.address2, l.city, l.state, l.zip, l.phone, l.website, l.lat, l.lng, l.description],
    );
    for (const c of l.capabilities) {
      await db.query(`insert into listing_capabilities select $1, id, $2 from capabilities where dataset_id = $2 and slug = $3`, [l.id, ds, c]);
    }
    for (const [i, mt] of l.metros.entries()) {
      await db.query(`insert into listing_metros select $1, id, $2, $4 from metros where dataset_id = $2 and slug = $3`, [l.id, ds, mt, i === 0]);
    }

    // One record_check() per check date and method, oldest first.
    const checks = new Map<string, { date: string; method: string; facts: Record<string, unknown>; confirmed: string[] }>();
    const group = (date: string, method: string) => {
      const k = `${date}|${method}`;
      if (!checks.has(k)) checks.set(k, { date, method, facts: {}, confirmed: [] });
      return checks.get(k)!;
    };
    for (const f of l.facts) if (f.checkedAt && f.method) group(f.checkedAt, f.method).facts[f.key] = f.value;
    for (const c of l.keyChecks) group(c.checkedAt, c.method).confirmed.push(c.key);
    for (const c of [...checks.values()].sort((a, b) => a.date.localeCompare(b.date))) {
      await db.query(`select record_check($1, $2, 'fixture', $3::jsonb, $4::text[], $5::date)`, [l.id, c.method, JSON.stringify(c.facts), c.confirmed, c.date]);
    }
    // Values typed in without a check (they must stay hidden).
    for (const f of l.facts.filter((f) => !f.checkedAt)) {
      await db.query(`insert into listing_facts (listing_id, dataset_id, key, value) values ($1, $2, $3, $4::jsonb)`, [l.id, ds, f.key, JSON.stringify(f.value)]);
    }
    if (l.status !== "draft") await db.query(`update listings set status = 'published' where id = $1`, [l.id]);
    if (l.status === "removed") await db.query(`update listings set status = 'removed' where id = $1`, [l.id]);
  }

  for (const [site, programs] of Object.entries(fx.siteAffiliates ?? {})) {
    for (const [program, s] of Object.entries(programs)) {
      await db.query(
        `update site_affiliates set status = $3, url = $4
          where site_id = (select id from sites where slug = $1) and program_id = (select id from affiliate_programs where slug = $2)`,
        [site, program, s.status, s.url],
      );
    }
  }
}

/**
 * fixtures/demo.json with ship-to-you suppliers for `site` (T9). Notes are obviously fake ("Example
 * ...") and exist only in test builds. Besides the suppliers in `listed`, it adds programs that must
 * NOT be listed on sites/dtf.json: heat-press-nation approved with notes but placed on guides only,
 * dtfsheet approved without notes, eazydtf with notes but only "applied".
 */
export function shipVariant(fx: Fixture, site: string, listed: string[]): Fixture {
  const v: Fixture = structuredClone(fx);
  const notes = (slug: string, date: string) =>
    Object.assign(v.affiliatePrograms.find((p) => p.slug === slug)!, {
      cutoffNote: `Example cutoff note for ${slug}: orders by 1:00 PM ship the same day`,
      priceNote: `Example price note for ${slug}: from $9 per sheet`,
      factsCheckedAt: date,
    });
  const own: Fixture["siteAffiliates"][string] = {};
  listed.forEach((slug, i) => {
    notes(slug, `2026-11-0${i + 1}`);
    own[slug] = { status: "approved", url: `https://example.com/aff/${slug}?ref={subid}` };
  });
  notes("heat-press-nation", "2026-11-09");
  own["heat-press-nation"] = { status: "approved", url: "https://example.com/aff/heat-press-nation" };
  if (!listed.includes("dtfsheet")) own.dtfsheet = { status: "approved", url: "https://example.com/aff/dtfsheet" };
  if (!listed.includes("eazydtf")) {
    notes("eazydtf", "2026-11-08");
    own.eazydtf = { status: "applied", url: null };
  }
  v.siteAffiliates = { ...v.siteAffiliates, [site]: own };
  return v;
}
