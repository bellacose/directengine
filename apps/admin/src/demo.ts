/**
 * Local demo mode (`npm run dev:demo -w apps/admin`): the real migration and seed in an in-browser
 * Postgres (PGlite), signed in as a fake admin, with obviously fake shops ("Example ...",
 * example.com, 555 numbers). For screenshots and trying the screens without a Supabase project.
 * Production builds never include this file (main.tsx loads it only in `demo` mode).
 */
import { PGlite } from "@electric-sql/pglite";
import type { SiteConfig } from "@directory-engine/core";
import type { Db } from "./lib/db.ts";
import { PG_PARSERS, pgDb, SUPABASE_SETUP } from "./lib/pgDb.ts";
import { SITE_CONFIGS } from "./siteConfigs.ts";

const migrations = import.meta.glob<string>("../../../supabase/migrations/*.sql", { query: "?raw", import: "default", eager: true });
const seeds = import.meta.glob<string>("../../../supabase/seed.sql", { query: "?raw", import: "default", eager: true });

export const DEMO_USER = { id: "00000000-0000-4000-8000-00000000d3e0", email: "demo-admin@example.com" };

const SHOPS: { slug: string; name: string; city: string; metro: string; caps: string[]; facts: Record<string, unknown>; publish: boolean }[] = [
  { slug: "example-dtf-tampa", name: "Example DTF Tampa", city: "Tampa", metro: "tampa-bay", caps: ["dtf"], publish: true,
    facts: { dtf_same_day_cutoff: "14:00", dtf_price_per_foot_usd: 6.5, pickup_walk_in: true, hours: { mon: { open: "09:00", close: "17:00" }, sun: null } } },
  { slug: "example-print-and-laser", name: "Example Print and Laser", city: "Clearwater", metro: "tampa-bay", caps: ["dtf", "laser"], publish: true,
    facts: { dtf_same_day_cutoff: "12:00", pickup_walk_in: true, ships: true, laser_customer_items: true } },
  { slug: "example-buffalo-transfers", name: "Example Buffalo Transfers", city: "Buffalo", metro: "buffalo", caps: ["dtf"], publish: true,
    facts: { dtf_price_note: "Example: priced per gang sheet" } },
  { slug: "example-laser-works", name: "Example Laser Works", city: "Amherst", metro: "buffalo", caps: ["laser"], publish: false,
    facts: { laser_types: "CO2 and fiber" } },
];

export async function demoDb(): Promise<Db> {
  const pg = new PGlite({ parsers: PG_PARSERS });
  await pg.exec(SUPABASE_SETUP);
  for (const [, sql] of Object.entries(migrations).sort(([a], [b]) => a.localeCompare(b))) await pg.exec(sql);
  for (const sql of Object.values(seeds)) await pg.exec(sql);

  const one = async <T>(sql: string, params: unknown[] = []) => (await pg.query<T>(sql, params)).rows[0];
  const ds = (await one<{ id: string }>(`select id from datasets where slug = 'makers'`)).id;
  await pg.query(`insert into admins (user_id) values ($1)`, [DEMO_USER.id]);

  const ids: string[] = [];
  let n = 0;
  for (const s of SHOPS) {
    n++;
    const l = await one<{ id: string }>(
      `insert into listings (dataset_id, slug, name, city, state, zip, phone, website)
       values ($1, $2, $3, $4, $5, $6, $7, 'https://example.com') returning id`,
      [ds, s.slug, s.name, s.city, s.metro === "buffalo" ? "NY" : "FL", s.metro === "buffalo" ? "14202" : "33602", `(555) 555-01${String(n).padStart(2, "0")}`],
    );
    ids.push(l.id);
    for (const c of s.caps) await pg.query(`insert into listing_capabilities select $1, id, $2 from capabilities where slug = $3`, [l.id, ds, c]);
    await pg.query(`insert into listing_metros select $1, id, $2, true from metros where slug = $3`, [l.id, ds, s.metro]);
    await pg.query(`select record_check($1, 'phone_call', 'demo', $2::jsonb, array['phone','address'], current_date - 3, 'Demo data.')`, [l.id, JSON.stringify(s.facts)]);
    if (s.publish) await pg.query(`update listings set status = 'published' where id = $1`, [l.id]);
  }
  // A fact edited outside a check, to show the "changed since last check" state.
  await pg.query(`update listing_facts set value = '"11:00"' where listing_id = $1 and key = 'dtf_same_day_cutoff'`, [ids[1]]);

  for (const site of SITE_CONFIGS as SiteConfig[]) {
    const s = await one<{ id: string }>(`insert into sites (slug, name, domain, dataset_id) values ($1, $2, $3, $4) returning id`, [site.slug, site.name, site.domain, ds]);
    for (const [program, placements] of Object.entries(site.affiliates)) {
      await pg.query(`insert into site_affiliates (site_id, program_id, placements) select $1, id, $2 from affiliate_programs where slug = $3`, [s.id, placements, program]);
    }
    for (let i = 0; i < 6; i++) {
      await pg.query(`insert into clicks (site_id, kind, listing_id, created_at) values ($1, $2, $3, now() - ($4 || ' days')::interval)`,
        [s.id, i % 2 ? "website" : "call", ids[i % 3], String(i * 4)]);
    }
  }
  await pg.query(`insert into claims (dataset_id, listing_id, contact_email, payload) values ($1, $2, 'owner@example.com', $3)`,
    [ds, ids[2], JSON.stringify({ name: "Example Buffalo Transfers", facts: { dtf_same_day_cutoff: "15:00", pickup_walk_in: true } })]);
  await pg.query(`insert into claims (dataset_id, contact_email, payload) values ($1, 'new-shop@example.com', $2)`,
    [ds, JSON.stringify({ name: "Example New Shop", city: "Brandon", state: "FL", phone: "(555) 555-0199", website: "https://example.com" })]);
  await pg.query(`insert into corrections (listing_id, detail) values ($1, 'Example report: they close at 4 on Fridays now.')`, [ids[0]]);
  // Fake place IDs (not real Google places): the review screen shows them with a Maps link only.
  for (const [n, q] of [[1, "DTF transfers in Brandon, FL"], [2, "DTF printing in Largo, FL"], [3, "laser engraving in Amherst, NY"]] as const) {
    await pg.query(`insert into candidates (dataset_id, place_id, query) values ($1, $2, $3)`, [ds, `ExampleDemoPlaceId000${n}`, q]);
  }

  return pgDb(pg, DEMO_USER.id);
}
