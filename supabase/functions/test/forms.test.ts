// The public forms' Edge Functions (`submit-claim`, `report-change`), run in Node with the real
// supabase-js client against the real migration, seed, synced sites and fixture shops on in-memory
// Postgres (through the PostgREST stand-in), so the database's own rate-limit triggers answer.

import type { PGlite } from "@electric-sql/pglite";
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { freshDb, root, seedFixture } from "../../../apps/web/test/helpers.ts";
import type { Fixture } from "../../../apps/web/src/lib/load.ts";
import { syncSites } from "../../../scripts/sync-sites.ts";
import {
  FIELD_LIMITS, HONEYPOT, MAX_BODY, MESSAGES, SITEVERIFY, TURNSTILE_FIELD, backPath, formEnv, handleReportChange,
  handleSubmitClaim, rateLimitOutcome, type FormEnv,
} from "../_shared/forms.ts";
import { restFetch } from "./rest.ts";

const KEY = "dummy-service-key-for-function-tests";
const FN = "https://ref.supabase.co";
const SHOP = "00000000-0000-4000-8000-000000000001";
const DRAFT = "00000000-0000-4000-8000-000000000007";

let db: PGlite;
let client: ReturnType<typeof createClient>;

const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
const claims = () => q<{ site: string; listing_id: string | null; contact_email: string; payload: Record<string, unknown>; status: string }>(
  `select s.slug site, c.listing_id, c.contact_email, c.payload, c.status from claims c left join sites s on s.id = c.site_id order by c.created_at`);
const corrections = () => q<{ site: string; listing_id: string; detail: string; status: string }>(
  `select s.slug site, c.listing_id, c.detail, c.status from corrections c left join sites s on s.id = c.site_id order by c.created_at`);

type Fields = Record<string, string | string[]>;
const encode = (fields: Fields) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) for (const x of Array.isArray(v) ? v : [v]) p.append(k, x);
  return p.toString();
};
const post = (fn: string, site: string, body: string, headers: Record<string, string> = {}, method = "POST") =>
  new Request(`${FN}/${fn}/${site}/`, {
    method,
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", ...headers },
    body: method === "POST" ? body : undefined,
  });
const claim = (fields: Fields, env: FormEnv = {}, site = "dtf", headers: Record<string, string> = {}) =>
  handleSubmitClaim(post("submit-claim", site, encode(fields), headers), client, env);
const report = (fields: Fields, env: FormEnv = {}, site = "dtf", headers: Record<string, string> = {}) =>
  handleReportChange(post("report-change", site, encode(fields), headers), client, env);
const json = async (res: Response) => (await res.json()) as { ok: boolean; outcome: string; message: string; errors?: Record<string, string> };

const NEW_SHOP: Fields = {
  name: "Example New Prints", address: "1 Example Way", city: "Tampa", state: "fl", zip: "33602",
  phone: "(813) 555-0199", website: "https://example.com/new", contact_email: "owner@example.com",
  capabilities: ["dtf"], description: "Gang sheets while you wait.",
};

/** Everything a listing is made of; no public form may change any of it. */
const listingState = async () => JSON.stringify({
  listings: await q(`select * from listings order by id`),
  facts: await q(`select * from listing_facts order by listing_id, key`),
  checks: await q(`select * from verification_events order by id`),
  caps: await q(`select * from listing_capabilities order by 1, 2`),
  metros: await q(`select * from listing_metros order by 1, 2`),
});

beforeAll(async () => {
  db = await freshDb();
  await syncSites(db, join(root, "sites"));
  await seedFixture(db, JSON.parse(readFileSync(join(root, "fixtures", "demo.json"), "utf8")) as Fixture);
  client = createClient("http://supabase.test", KEY, { auth: { persistSession: false }, global: { fetch: restFetch(db, KEY) } });
}, 120_000);

beforeEach(async () => {
  await q(`delete from claims`);
  await q(`delete from corrections`);
});

describe("submit-claim", () => {
  it("stores a new shop as a pending claim with the payload names the admin app reads", async () => {
    const res = await claim(NEW_SHOP);
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ ok: true, outcome: "sent", message: MESSAGES.sent });
    expect(await claims()).toEqual([{
      site: "dtf", listing_id: null, contact_email: "owner@example.com", status: "pending",
      payload: {
        name: "Example New Prints", address: "1 Example Way", city: "Tampa", state: "FL", zip: "33602",
        phone: "(813) 555-0199", website: "https://example.com/new", description: "Gang sheets while you wait.",
        capabilities: ["dtf"],
      },
    }]);
    const [row] = await q<{ dataset: string }>(`select d.slug dataset from claims c join datasets d on d.id = c.dataset_id`);
    expect(row.dataset).toBe("makers");
  });

  it("stores a claim for a listed shop with its listing and the owner's facts in their database types", async () => {
    const res = await claim({
      listing: SHOP, contact_email: "Owner@Example.com",
      "fact.dtf_same_day_cutoff": "14:30", "fact.pickup_walk_in": "true", "fact.ships": "false",
      "fact.dtf_price_per_foot_usd": "6.5", "fact.dtf_price_note": "  $6.50 a foot  ",
      "hours.mon.open": "09:00", "hours.mon.close": "17:00", "hours.sun.closed": "1",
      "fact.not_a_fact": "ignored", "fact.blanks_brands_note": "",
      notes: "Ask for Sam.",
    });
    expect(res.status).toBe(200);
    const [c] = await claims();
    expect(c.listing_id).toBe(SHOP);
    expect(c.payload).toEqual({
      notes: "Ask for Sam.",
      facts: {
        dtf_same_day_cutoff: "14:30", pickup_walk_in: true, ships: false, dtf_price_per_foot_usd: 6.5,
        dtf_price_note: "$6.50 a foot", hours: { mon: { open: "09:00", close: "17:00" }, sun: null },
      },
    });
  });

  it("refuses invalid input field by field and stores nothing", async () => {
    const res = await claim({
      listing: DRAFT, contact_email: "not-an-email", state: "Florida", zip: "123", website: "javascript:alert(1)",
      capabilities: ["dtf", "made-up"], "fact.dtf_price_per_foot_usd": "six", "fact.dtf_same_day_cutoff": "2pm",
      "fact.pickup_walk_in": "maybe", "hours.tue.open": "17:00", "hours.tue.close": "09:00",
    });
    expect(res.status).toBe(400);
    const out = await json(res);
    expect(out.outcome).toBe("invalid");
    expect(Object.keys(out.errors!).sort()).toEqual([
      "capabilities", "contact_email", "fact.dtf_price_per_foot_usd", "fact.dtf_same_day_cutoff", "fact.pickup_walk_in",
      "hours", "listing", "state", "website", "zip",
    ]);
    expect((await claim({ contact_email: "a@example.com" })).status).toBe(400); // a new shop needs a name
    expect((await claim({ ...NEW_SHOP, listing: "00000000-0000-4000-8000-999999999999" })).status).toBe(400);
    expect(await claims()).toEqual([]);
  });

  it("refuses oversize input: any field past its limit, or a body past the cap", async () => {
    for (const [k, limit] of Object.entries({ name: FIELD_LIMITS.name, description: FIELD_LIMITS.description, notes: FIELD_LIMITS.notes, "fact.dtf_price_note": FIELD_LIMITS.fact })) {
      const res = await claim({ ...NEW_SHOP, [k]: "x".repeat(limit + 1) });
      expect(res.status, k).toBe(400);
      expect((await json(res)).errors?.[k], k).toMatch(/Too long/);
    }
    const huge = await claim({ ...NEW_SHOP, notes: "x".repeat(MAX_BODY) });
    expect(huge.status).toBe(400);
    expect((await json(huge)).errors?.form).toMatch(/Too long/);
    expect(await claims()).toEqual([]);
  });

  it("refuses a duplicate with the friendly message, not the database error", async () => {
    expect((await claim(NEW_SHOP)).status).toBe(200);
    const res = await claim({ ...NEW_SHOP, contact_email: "OWNER@example.com" });
    expect(res.status).toBe(429);
    const out = await json(res);
    expect(out).toEqual({ ok: false, outcome: "duplicate", message: MESSAGES.duplicate });
    expect(JSON.stringify(out)).not.toContain("rate_limited");
    expect((await claims()).length).toBe(1);
  });

  it("refuses a flood with the friendly message", async () => {
    for (let i = 0; i < 20; i++) expect((await claim({ ...NEW_SHOP, contact_email: `owner${i}@example.com` })).status, String(i)).toBe(200);
    const res = await claim({ ...NEW_SHOP, contact_email: "one-more@example.com" });
    expect(res.status).toBe(429);
    expect(await json(res)).toEqual({ ok: false, outcome: "busy", message: MESSAGES.busy });
    expect((await claims()).length).toBe(20);
  });

  it("drops a filled honeypot silently: the normal answer, nothing stored, no Turnstile call", async () => {
    let calls = 0;
    const env: FormEnv = { turnstileSecret: "secret", fetch: (async () => (calls++, new Response("{}"))) as typeof fetch };
    const res = await claim({ ...NEW_SHOP, [HONEYPOT]: "555-0100" }, env);
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ ok: true, outcome: "sent", message: MESSAGES.sent });
    expect(calls).toBe(0);
    expect(await claims()).toEqual([]);
  });

  it("sends a plain form post (no JavaScript) back to the page with the outcome as a fragment", async () => {
    const send = (fields: Fields) => handleSubmitClaim(post("submit-claim", "dtf", encode(fields), { accept: "text/html" }), client);
    let res = await send({ ...NEW_SHOP, return: "/add-your-shop/" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/add-your-shop/#form-sent");
    res = await send({ ...NEW_SHOP, return: "/add-your-shop/" });
    expect(res.headers.get("location")).toBe("/add-your-shop/#form-duplicate");
    res = await send({ name: "x", contact_email: "bad", return: "//evil.example/" });
    expect(res.headers.get("location")).toBe("/add-your-shop/#form-invalid");
  });

  it("refuses other methods, unknown sites, other body types and bad paths", async () => {
    expect((await handleSubmitClaim(post("submit-claim", "dtf", "", {}, "GET"), client)).status).toBe(405);
    expect((await claim(NEW_SHOP, {}, "no-such-site")).status).toBe(404);
    expect((await handleSubmitClaim(post("submit-claim", "dtf", JSON.stringify(NEW_SHOP), { "content-type": "application/json" }), client)).status).toBe(415);
    expect((await handleSubmitClaim(new Request(`${FN}/submit-claim/`, { method: "POST" }), client)).status).toBe(404);
    expect(await claims()).toEqual([]);
  });
});

describe("Turnstile", () => {
  const verifier = (success: boolean) => {
    const seen: URLSearchParams[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      expect(url).toBe(SITEVERIFY);
      seen.push(new URLSearchParams(String(init.body)));
      return new Response(JSON.stringify({ success }), { headers: { "content-type": "application/json" } });
    }) as typeof globalThis.fetch;
    return { seen, env: { turnstileSecret: "turnstile-secret", fetch } satisfies FormEnv };
  };

  it("is off without the secret: no call, the form goes through", async () => {
    expect(formEnv(() => undefined)).toEqual({ turnstileSecret: undefined });
    expect(formEnv((k) => (k === "TURNSTILE_SECRET_KEY" ? " s " : undefined))).toEqual({ turnstileSecret: "s" });
    expect((await claim(NEW_SHOP, formEnv(() => undefined))).status).toBe(200);
  });

  it("with the secret, refuses a missing or failed token and accepts a passing one", async () => {
    const fail = verifier(false);
    let res = await claim(NEW_SHOP, fail.env);
    expect(res.status).toBe(403);
    expect((await json(res)).outcome).toBe("check-failed");
    expect(fail.seen).toEqual([]); // no token: no call
    res = await report({ listing: SHOP, detail: "Closed on Mondays now.", [TURNSTILE_FIELD]: "tok" }, fail.env);
    expect(res.status).toBe(403);
    expect(await claims()).toEqual([]);
    expect(await corrections()).toEqual([]);

    const pass = verifier(true);
    res = await claim({ ...NEW_SHOP, [TURNSTILE_FIELD]: "XXXX.DUMMY.TOKEN.XXXX" }, pass.env, "dtf", { "cf-connecting-ip": "203.0.113.9" });
    expect(res.status).toBe(200);
    expect(Object.fromEntries(pass.seen[0])).toEqual({ secret: "turnstile-secret", response: "XXXX.DUMMY.TOKEN.XXXX", remoteip: "203.0.113.9" });
    expect((await claims()).length).toBe(1);
  });
});

describe("report-change", () => {
  it("stores a report for a published shop", async () => {
    const res = await report({ listing: SHOP, detail: "  The cutoff is 3 PM now.  ", return: "/shop/example-dtf-tampa/" });
    expect(res.status).toBe(200);
    expect(await corrections()).toEqual([{ site: "dtf", listing_id: SHOP, detail: "The cutoff is 3 PM now.", status: "open" }]);
  });

  it("refuses unknown and draft shops, short and oversize reports", async () => {
    for (const fields of [
      { listing: DRAFT, detail: "Wrong phone number." },
      { listing: "00000000-0000-4000-8000-999999999999", detail: "Wrong phone number." },
      { listing: "not-a-uuid", detail: "Wrong phone number." },
      { listing: SHOP, detail: "bad" },
      { listing: SHOP, detail: "x".repeat(FIELD_LIMITS.detail + 1) },
    ]) {
      const res = await report(fields);
      expect(res.status, JSON.stringify(fields).slice(0, 80)).toBe(400);
    }
    expect((await json(await report({ listing: SHOP, detail: "x".repeat(FIELD_LIMITS.detail + 1) }))).errors?.detail).toMatch(/Too long/);
    expect(await corrections()).toEqual([]);
  });

  it("refuses duplicates and floods with the friendly messages", async () => {
    expect((await report({ listing: SHOP, detail: "Moved to 5 Example Ave." })).status).toBe(200);
    let res = await report({ listing: SHOP, detail: "moved to 5 example ave." });
    expect(res.status).toBe(429);
    expect(await json(res)).toEqual({ ok: false, outcome: "duplicate", message: MESSAGES.duplicate });
    for (let i = 1; i < 30; i++) expect((await report({ listing: SHOP, detail: `Report number ${i}` })).status, String(i)).toBe(200);
    res = await report({ listing: SHOP, detail: "One report too many." });
    expect(res.status).toBe(429);
    expect(await json(res)).toEqual({ ok: false, outcome: "busy", message: MESSAGES.busy });
    expect((await corrections()).length).toBe(30);
  });

  it("drops a filled honeypot silently", async () => {
    const res = await report({ listing: SHOP, detail: "Buy cheap watches", [HONEYPOT]: "x" });
    expect(res.status).toBe(200);
    expect((await json(res)).ok).toBe(true);
    expect(await corrections()).toEqual([]);
  });

  it("without JavaScript, goes back to the shop page with the outcome", async () => {
    const res = await handleReportChange(post("report-change", "dtf", encode({ listing: SHOP, detail: "New hours.", return: "/shop/example-dtf-tampa/" }), { accept: "*/*" }), client);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/shop/example-dtf-tampa/#form-sent");
  });
});

describe("no public form can change a listing or a fact", () => {
  it("leaves listings, facts, checks, tags and metros exactly as they were", async () => {
    const before = await listingState();
    // Accepted claims and reports, including ones that name listing columns and facts.
    await claim({ listing: SHOP, contact_email: "a@example.com", status: "removed", slug: "hijack", name: "Renamed", "fact.dtf_same_day_cutoff": "23:00", "fact.pickup_walk_in": "false" });
    await claim({ ...NEW_SHOP, id: SHOP, listing_id: SHOP, dataset_id: "x" });
    await report({ listing: SHOP, detail: "Set status to removed", status: "removed", "fact.hours": "{}" });
    // Refused ones.
    await claim({ listing: DRAFT, contact_email: "b@example.com" });
    await report({ listing: DRAFT, detail: "Publish this one" });
    expect((await claims()).length).toBe(2);
    expect((await corrections()).length).toBe(1);
    expect(await listingState()).toBe(before);
  });

  it("the form code writes only to claims and corrections, and never updates, deletes or calls functions", () => {
    const src = readFileSync(join(__dirname, "..", "_shared", "forms.ts"), "utf8");
    expect(src).not.toMatch(/\.(update|upsert|delete|rpc)\(/);
    expect([...src.matchAll(/insert\(req, db, "([a-z_]+)"/g)].map((m) => m[1]).sort()).toEqual(["claims", "corrections"]);
    expect([...src.matchAll(/\.insert\(/g)].length).toBe(1); // the one insert() helper, typed to those two tables
  });
});

describe("helpers", () => {
  it("maps the database's rate-limit errors to friendly outcomes", () => {
    expect(rateLimitOutcome("rate_limited: duplicate report")).toBe("duplicate");
    expect(rateLimitOutcome("rate_limited: this claim is already waiting for review")).toBe("duplicate");
    expect(rateLimitOutcome("rate_limited: too many claims this hour")).toBe("busy");
    expect(rateLimitOutcome("violates check constraint")).toBeNull();
  });

  it("only sends a plain form post back to a path on this site", () => {
    expect(backPath("/shop/example/")).toBe("/shop/example/");
    expect(backPath("//evil.example/")).toBeNull();
    expect(backPath("https://evil.example/")).toBeNull();
    expect(backPath(null)).toBeNull();
  });
});
