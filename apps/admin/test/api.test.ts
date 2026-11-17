// The admin app's data calls (src/lib/api.ts) against the real migration and seed on in-memory
// Postgres, run as signed-in users so row level security applies exactly as in Supabase.

import type { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SiteConfig } from "@directory-engine/core";
import { beforeAll, describe, expect, it } from "vitest";
import * as api from "../src/lib/api.ts";
import type { CheckForm } from "../src/lib/facts.ts";
import { emptyCore } from "../src/lib/listing.ts";
import { siteCoverage } from "../src/lib/sites.ts";
import { freshDb, pgDb } from "./db.ts";

const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const root = join(__dirname, "..", "..", "..");
const site = (slug: string) => JSON.parse(readFileSync(join(root, "sites", `${slug}.json`), "utf8")) as SiteConfig;
const today = () => new Date().toISOString().slice(0, 10);

let pg: PGlite;
let ds: string;
let seededListing: string;

const form = (over: Partial<CheckForm> = {}): CheckForm => ({
  method: "phone_call",
  checkedBy: "chris",
  checkedAt: today(),
  note: "",
  evidenceUrl: "",
  core: [],
  facts: {},
  ...over,
});

beforeAll(async () => {
  pg = await freshDb();
  ds = (await pg.query<{ id: string }>(`select id from datasets where slug = 'makers'`)).rows[0].id;
  await pg.query(`insert into admins (user_id) values ($1)`, [ADMIN]);

  // One of everything, written as the database owner, so each source has rows to (not) see.
  const l = await pg.query<{ id: string }>(
    `insert into listings (dataset_id, slug, name, city, state) values ($1, 'example-seeded', 'Example Seeded', 'Tampa', 'FL') returning id`, [ds]);
  seededListing = l.rows[0].id;
  await pg.query(`insert into listing_capabilities select $1, id, $2 from capabilities where slug = 'dtf'`, [seededListing, ds]);
  await pg.query(`insert into listing_metros select $1, id, $2, true from metros where slug = 'tampa-bay'`, [seededListing, ds]);
  await pg.query(`select record_check($1, 'phone_call', 'chris', '{"pickup_walk_in": true}'::jsonb, array['phone'])`, [seededListing]);
  const s = await pg.query<{ id: string }>(`insert into sites (slug, name, dataset_id) values ('dtf', 'DTF', $1) returning id`, [ds]);
  await pg.query(`insert into site_affiliates (site_id, program_id, placements) select $1, id, '{ship-to-you}' from affiliate_programs where slug = 'transfer-express'`, [s.rows[0].id]);
  await pg.query(`insert into clicks (site_id, kind, listing_id) values ($1, 'website', $2)`, [s.rows[0].id, seededListing]);
  await pg.query(`insert into site_settings (site_id, name) values ($1, 'Example Seeded Name')`, [s.rows[0].id]);
  await pg.query(`insert into claims (dataset_id, listing_id, contact_email, payload) values ($1, $2, 'owner@example.com', '{"facts": {"dtf_same_day_cutoff": "15:00"}}')`, [ds, seededListing]);
  await pg.query(`insert into corrections (listing_id, detail) values ($1, 'Phone number changed.')`, [seededListing]);
  await pg.query(`insert into candidates (dataset_id, place_id, query) values ($1, 'ChIJexampleSeeded0001', 'DTF transfers in Tampa, FL')`, [ds]);
}, 60_000);

describe("access", () => {
  it("knows who is an admin", async () => {
    expect(await api.isAdmin(pgDb(pg, ADMIN), ADMIN)).toBe(true);
    expect(await api.isAdmin(pgDb(pg, OTHER), OTHER)).toBe(false);
  });

  it("a signed-in user who is not in admins sees no data from any source the app reads", async () => {
    const admin = pgDb(pg, ADMIN);
    const other = pgDb(pg, OTHER);
    for (const source of api.READ_SOURCES) {
      expect((await admin.select(source)).length, `admin should see rows in ${source}`).toBeGreaterThan(0);
      expect(await other.select(source), `non-admin saw rows in ${source}`).toEqual([]);
    }
    expect(await other.select("admins")).toEqual([]);
    expect(await api.searchListings(other, "")).toEqual([]);
    expect(await api.getListing(other, seededListing)).toBeNull();
    expect((await api.loadVocab(other)).factDefs).toEqual([]);
  });

  it("a non-admin cannot write either", async () => {
    const other = pgDb(pg, OTHER);
    await expect(api.createDraft(other, ds, { slug: "example-intruder", name: "X", city: "Tampa", state: "FL" })).rejects.toThrow();
    await expect(api.setListingStatus(other, seededListing, "removed")).rejects.toThrow(/Nothing was saved/);
    await expect(api.sendCheck(other, {
      p_listing: seededListing, p_method: "phone_call", p_checked_by: "x", p_facts: { pickup_walk_in: false },
      p_confirmed: [], p_checked_at: today(), p_note: null, p_evidence_url: null,
    })).rejects.toThrow();
    const facts = await pg.query(`select value from listing_facts where listing_id = $1 and key = 'pickup_walk_in'`, [seededListing]);
    expect(facts.rows).toEqual([{ value: true }]);
  });
});

describe("listing workflow", () => {
  it("creating a draft, recording a check and publishing makes the facts public", async () => {
    const db = pgDb(pg, ADMIN);
    const vocab = await api.loadVocab(db);
    const defs = vocab.factDefs.filter((f) => f.dataset_id === ds);
    const dtf = vocab.capabilities.find((c) => c.slug === "dtf")!.id;
    const laser = vocab.capabilities.find((c) => c.slug === "laser")!.id;
    const tampa = vocab.metros.find((m) => m.slug === "tampa-bay")!.id;

    const l = await api.createDraft(db, ds, { ...emptyCore(), slug: "example-flow", name: "Example Flow Prints", city: "Tampa", state: "FL", zip: null, website: null, phone: null, lat: null, lng: null, address1: null, address2: null, place_id: null, description: null });
    expect(l.status).toBe("draft");
    await api.setCapabilities(db, l, [dtf, laser], []);
    await api.setMetros(db, l, [tampa], tampa, []);

    // Publishing before any check is refused by the database.
    await expect(api.setListingStatus(db, l.id, "published")).rejects.toThrow(/no verification event/);

    const res = await api.recordCheck(db, l.id, form({
      core: ["phone", "address"],
      facts: {
        dtf_same_day_cutoff: { action: "set", text: "14:00" },
        dtf_price_per_foot_usd: { action: "set", text: "6.5" },
        pickup_walk_in: { action: "set", text: "true" },
        hours: { action: "set", days: {
          mon: { state: "open", open: "09:00", close: "17:00" }, tue: { state: "open", open: "09:00", close: "17:00" },
          wed: { state: "unknown", open: "", close: "" }, thu: { state: "unknown", open: "", close: "" },
          fri: { state: "unknown", open: "", close: "" }, sat: { state: "unknown", open: "", close: "" },
          sun: { state: "closed", open: "", close: "" } } },
      },
      note: "Spoke to the owner.",
      evidenceUrl: "https://example.com/pricing",
    }), defs, new Set(), today());
    expect(res.ok).toBe(true);

    // Not public while still a draft.
    const before = await pg.query(`select key from public_listing_facts where listing_id = $1`, [l.id]);
    expect(before.rows).toEqual([]);

    await api.setListingStatus(db, l.id, "published");
    const pub = await pg.query<{ key: string; value: unknown; method: string }>(
      `select key, value, method from public_listing_facts where listing_id = $1 order by key`, [l.id]);
    expect(pub.rows).toEqual([
      { key: "dtf_price_per_foot_usd", value: 6.5, method: "phone_call" },
      { key: "dtf_same_day_cutoff", value: "14:00", method: "phone_call" },
      { key: "hours", value: { mon: { open: "09:00", close: "17:00" }, tue: { open: "09:00", close: "17:00" }, sun: null }, method: "phone_call" },
      { key: "pickup_walk_in", value: true, method: "phone_call" },
    ]);

    // The detail view and site coverage read the same state.
    const detail = (await api.getListing(db, l.id))!;
    expect(detail.factStatus.every((f) => f.verified)).toBe(true);
    expect(detail.checks[0].evidence_url).toBe("https://example.com/pricing");
    expect(detail.keyChecks.map((k) => k.key).sort()).toEqual(["address", "dtf_price_per_foot_usd", "dtf_same_day_cutoff", "hours", "phone", "pickup_walk_in"]);
    const cov = siteCoverage([site("dtf"), site("laser"), site("tampa-makers")], "makers", api.asCoreListing(detail, vocab));
    expect(cov.map((c) => [c.slug, c.included, c.detailPage, c.angleFactCount])).toEqual([
      ["dtf", true, true, 4],
      ["laser", true, false, 2], // only hours and pickup_walk_in are in the laser angle; minFacts is 3
      ["tampa-makers", true, true, 4],
    ]);

    // Unpublish and remove: facts leave the public view, the listing is kept.
    await api.setListingStatus(db, l.id, "removed");
    expect((await pg.query(`select 1 from public_listing_facts where listing_id = $1`, [l.id])).rows).toEqual([]);
    expect((await api.searchListings(db, "flow prints", "removed")).map((x) => x.slug)).toEqual(["example-flow"]);
  });

  it("editing core fields, capabilities and metros", async () => {
    const db = pgDb(pg, ADMIN);
    const vocab = await api.loadVocab(db);
    const [tampa, buffalo] = ["tampa-bay", "buffalo"].map((s) => vocab.metros.find((m) => m.slug === s)!.id);
    const l = await api.createDraft(db, ds, { slug: "example-edit", name: "Example Edit", city: "Tampa", state: "FL" });
    await api.updateListing(db, l.id, { name: "Example Edited", phone: "(813) 555-0199", status: "published" });
    let d = (await api.getListing(db, l.id))!;
    expect([d.listing.name, d.listing.phone, d.listing.status]).toEqual(["Example Edited", "(813) 555-0199", "draft"]);

    await api.setMetros(db, l, [tampa, buffalo], tampa, d.metros);
    d = (await api.getListing(db, l.id))!;
    await api.setMetros(db, l, [tampa, buffalo], buffalo, d.metros);
    d = (await api.getListing(db, l.id))!;
    expect(d.metros.find((m) => m.is_primary)?.metro_id).toBe(buffalo);
    await api.setMetros(db, l, [tampa], null, d.metros);
    d = (await api.getListing(db, l.id))!;
    expect(d.metros).toEqual([{ metro_id: tampa, is_primary: false }]);
  });

  it("a fact edited outside record_check shows as unverified", async () => {
    const db = pgDb(pg, ADMIN);
    await pg.query(`update listing_facts set value = 'false' where listing_id = $1 and key = 'pickup_walk_in'`, [seededListing]);
    const d = (await api.getListing(db, seededListing))!;
    expect(d.factStatus.find((f) => f.key === "pickup_walk_in")).toMatchObject({ verified: false, value: false });
    // Confirming the new value with a check verifies it again.
    const vocab = await api.loadVocab(db);
    const r = await api.recordCheck(db, seededListing, form({ facts: { pickup_walk_in: { action: "confirm" } } }), vocab.factDefs, new Set(["pickup_walk_in"]), today());
    expect(r.ok).toBe(true);
    expect((await api.getListing(db, seededListing))!.factStatus.find((f) => f.key === "pickup_walk_in")?.verified).toBe(true);
  });
});

describe("queues", () => {
  it("approving a claim records an owner_submitted check and closes the claim", async () => {
    const db = pgDb(pg, ADMIN);
    const vocab = await api.loadVocab(db);
    const [claim] = await api.listClaims(db);
    expect(claim.listing_id).toBe(seededListing);
    expect(claim.email_confirmed_at).toBeNull();
    const f = form({
      method: "phone_call", // forced to owner_submitted
      facts: { dtf_same_day_cutoff: { action: "set", text: "15:00" } },
    });
    // Unconfirmed email: refused without the override, and nothing is recorded.
    const events = (await pg.query(`select count(*)::int n from verification_events`)).rows;
    expect(await api.approveClaim(db, claim, seededListing, f, vocab.factDefs, new Set(), today()))
      .toEqual({ ok: false, errors: { form: api.UNCONFIRMED_EMAIL } });
    expect((await pg.query(`select count(*)::int n from verification_events`)).rows).toEqual(events);
    const r = await api.approveClaim(db, claim, seededListing, f, vocab.factDefs, new Set(), today(), { overrideUnconfirmed: true });
    expect(r).toEqual({ ok: true });
    expect((await api.listClaims(db, "approved"))[0]).toMatchObject({ id: claim.id, approved_without_email: true, email_confirmed_at: null });
    const ev = await pg.query(`select method, fact_keys from verification_events where listing_id = $1 order by created_at desc limit 1`, [seededListing]);
    expect(ev.rows).toEqual([{ method: "owner_submitted", fact_keys: ["dtf_same_day_cutoff"] }]);
    expect(await api.listClaims(db)).toEqual([]);
    const l = (await api.getListing(db, seededListing))!.listing;
    expect(l.claimed_email).toBe("owner@example.com");
    expect(l.status).toBe("draft"); // publishing stays a separate step
  });

  it("a claim whose email is confirmed approves without the override, and shows as confirmed", async () => {
    const db = pgDb(pg, ADMIN);
    const vocab = await api.loadVocab(db);
    const { rows: [c] } = await pg.query<{ id: string }>(
      `insert into claims (dataset_id, listing_id, contact_email, payload) values ($1, $2, 'confirmed@example.com', '{}') returning id`, [ds, seededListing]);
    const hash = "c".repeat(64);
    await pg.query(`insert into claim_email_tokens (claim_id, token_hash) values ($1, $2)`, [c.id, hash]);
    await pg.query(`select confirm_claim_email($1)`, [hash]);
    const claim = (await api.listClaims(db)).find((x) => x.id === c.id)!;
    expect(claim.email_confirmed_at).not.toBeNull();
    const r = await api.approveClaim(db, claim, seededListing, form({ facts: { pickup_walk_in: { action: "set", text: "true" } } }), vocab.factDefs, new Set(), today());
    expect(r).toEqual({ ok: true });
    expect((await api.listClaims(db, "approved")).find((x) => x.id === c.id)?.approved_without_email).toBe(false);
  });

  it("the database refuses to approve an unconfirmed claim without the override, even for an admin", async () => {
    const db = pgDb(pg, ADMIN);
    const { rows: [c] } = await pg.query<{ id: string }>(
      `insert into claims (dataset_id, contact_email, payload) values ($1, 'sneaky@example.com', '{}') returning id`, [ds]);
    await expect(db.update("claims", { status: "approved" }, [{ col: "id", op: "eq", value: c.id }])).rejects.toThrow(/email_not_confirmed/);
    await expect(db.update("claims", { email_confirmed_at: new Date().toISOString() }, [{ col: "id", op: "eq", value: c.id }])).rejects.toThrow(/confirm_claim_email/);
    await pg.query(`delete from claims where id = $1`, [c.id]);
  });

  it("rejecting a claim records nothing on the listing", async () => {
    const db = pgDb(pg, ADMIN);
    await pg.query(`insert into claims (dataset_id, contact_email, payload) values ($1, 'new@example.com', '{"name": "Example New"}')`, [ds]);
    const [claim] = await api.listClaims(db);
    const before = (await pg.query(`select count(*)::int n from verification_events`)).rows;
    await api.rejectClaim(db, claim.id);
    expect((await api.listClaims(db, "rejected")).map((c) => c.id)).toEqual([claim.id]);
    expect((await pg.query(`select count(*)::int n from verification_events`)).rows).toEqual(before);
    await expect(api.rejectClaim(db, claim.id)).rejects.toThrow(/Nothing was saved/);
  });

  it("corrections can be closed", async () => {
    const db = pgDb(pg, ADMIN);
    const [c] = await api.listCorrections(db);
    await api.setCorrectionStatus(db, c.id, "done");
    expect(await api.listCorrections(db)).toEqual([]);
    expect((await api.listCorrections(db, "done")).map((x) => x.id)).toEqual([c.id]);
  });
});

describe("affiliates and stats", () => {
  it("sets a site's status and link, refusing an approval without a link", async () => {
    const db = pgDb(pg, ADMIN);
    const { sites, programs, links } = await api.loadAffiliates(db);
    expect(links).toHaveLength(1);
    const prog = programs.find((p) => p.slug === "transfer-express")!;
    await expect(api.updateSiteAffiliate(db, sites[0].id, prog.id, "approved", "")).rejects.toThrow(/tracking link/);
    await expect(api.updateSiteAffiliate(db, sites[0].id, prog.id, "approved", "http://x.example")).rejects.toThrow(/https/);
    await api.updateSiteAffiliate(db, sites[0].id, prog.id, "approved", "https://example.com/ref?id=1");
    expect((await api.loadAffiliates(db)).links[0]).toMatchObject({ status: "approved", url: "https://example.com/ref?id=1" });
  });

  it("saves supplier notes only with their check date", async () => {
    const db = pgDb(pg, ADMIN);
    const prog = (await api.loadAffiliates(db)).programs.find((p) => p.slug === "transfer-express")!;
    await expect(api.updateSupplierNotes(db, prog.id, "Order by 2 PM CT", "", "", today())).rejects.toThrow(/date/);
    await api.updateSupplierNotes(db, prog.id, "Order by 2 PM CT", "", today(), today());
    const p = (await api.loadAffiliates(db)).programs.find((x) => x.id === prog.id)!;
    expect([p.cutoff_note, p.price_note, String(p.facts_checked_at).slice(0, 10)]).toEqual(["Order by 2 PM CT", null, today()]);
  });

  it("loads clicks page by page", async () => {
    const db = pgDb(pg, ADMIN);
    await pg.query(`insert into clicks (site_id, kind) select (select id from sites limit 1), 'call' from generate_series(1, 4)`);
    const all = await api.loadClicks(db, "2000-01-01", 2);
    expect(all).toHaveLength(5);
    expect(await api.loadClicks(pgDb(pg, OTHER), "2000-01-01", 2)).toEqual([]);
  });
});

describe("site settings (D31)", () => {
  const brand = { primary: "#1d4ed8", accent: "#b45309" };
  const blank: api.SettingsForm = { name: "", operatorName: "", operatorEmail: "", themeConfig: "", themeCss: "" };
  const themelab = readFileSync(join(root, "sites", "themes", "themelab", "tailwind.config.ts"), "utf8");

  it("checks the form like the table does, and checks the theme as data", () => {
    expect(api.siteSettingsErrors(blank, brand)).toEqual({ errors: [], theme: null });
    expect(api.siteSettingsErrors({ ...blank, operatorEmail: "nope" }, brand).errors.join(" ")).toMatch(/isn't an email.*operator's name/);
    const r = api.siteSettingsErrors({ ...blank, themeConfig: themelab, themeCss: ":root { --primary: #0b0f14; --background: #fff; --foreground: #111; --accent: #0072b5; --muted: #f2f5f7; --muted-foreground: #56606b; --border: #dfe4e8; --input: #c3cbd2; --radius: 0.5rem; }" }, brand);
    expect(r.errors).toEqual([]);
    expect(r.theme?.variables).toMatchObject({ brand: "#0b0f14", font: '"inter", system-ui, sans-serif' });
    expect(api.siteSettingsErrors({ ...blank, themeConfig: themelab }, brand).errors.join(" ")).toMatch(/var\(--primary\)" isn't a color we can check/);
    expect(api.siteSettingsErrors({ ...blank, themeConfig: "export default { theme: require('x') }" }, brand).errors.join(" ")).toMatch(/line 1: only plain values/);
  });

  it("an admin saves, then updates; blank fields are stored as null; a non-admin can do neither", async () => {
    const admin = pgDb(pg, ADMIN);
    const fresh = await pg.query<{ id: string }>(`insert into sites (slug, name, dataset_id) values ('settings-site', 'Settings', $1) returning id`, [ds]);
    const id = fresh.rows[0].id;
    await expect(api.saveSiteSettings(pgDb(pg, OTHER), id, { ...blank, name: "Hijack" }, brand, false)).rejects.toThrow();
    await api.saveSiteSettings(admin, id, { ...blank, name: " Find Example ", operatorName: "Example Operator", operatorEmail: "ops@example.com" }, brand, false);
    await api.saveSiteSettings(admin, id, { ...blank, name: "Find Example", themeConfig: "export default { theme: { extend: { colors: { primary: '#0b0f14' } } } }" }, brand, true);
    const { settings } = await api.loadSiteSettings(admin);
    expect(settings.find((r) => r.site_id === id)).toMatchObject({
      name: "Find Example", operator_name: null, operator_email: null, theme_css: null,
      theme_config: "export default { theme: { extend: { colors: { primary: '#0b0f14' } } } }",
    });
    await expect(api.saveSiteSettings(pgDb(pg, OTHER), id, blank, brand, true)).rejects.toThrow(/Nothing was saved/);
    await expect(api.saveSiteSettings(admin, id, { ...blank, operatorEmail: "x@example.com" }, brand, true)).rejects.toThrow(/operator's name/);
  });
});
