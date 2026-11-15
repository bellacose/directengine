// The Candidates review screen: its data calls on the real migration with RLS, the live Place
// Details call against a stub, and proof that nothing fetched from Google can reach a write.

import type { PGlite } from "@electric-sql/pglite";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as api from "../src/lib/api.ts";
import { buildCore, draftStart, emptyCore } from "../src/lib/listing.ts";
import { DETAILS_FIELD_MASK, DETAILS_URL, fetchPlacePreview, mapsLink } from "../src/lib/places.ts";
import { freshDb, pgDb } from "./db.ts";

const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PLACE = "ChIJexampleCandidate0001";
const src = join(__dirname, "..", "src");

let pg: PGlite;
let ds: string;

beforeAll(async () => {
  pg = await freshDb();
  ds = (await pg.query<{ id: string }>(`select id from datasets where slug = 'makers'`)).rows[0].id;
  await pg.query(`insert into admins (user_id) values ($1)`, [ADMIN]);
}, 60_000);

beforeEach(async () => {
  await pg.exec(`delete from candidates; delete from listings;`);
  await pg.query(`insert into candidates (dataset_id, place_id, query) values ($1, $2, 'DTF transfers in Tampa, FL')`, [ds, PLACE]);
});

const theCandidate = async () => (await api.listCandidates(pgDb(pg, ADMIN)))[0];

/** What the reviewer typed from the shop's own website. */
const reviewerInput = () => {
  const built = buildCore({ ...draftStart(PLACE), name: "Example Reviewed Shop", slug: "example-reviewed-shop", city: "Tampa", state: "FL", website: "https://example.com" });
  if (!built.ok) throw new Error(JSON.stringify(built.errors));
  return built.row;
};

describe("candidate workflow", () => {
  it("lists new candidates for admins only", async () => {
    const c = await theCandidate();
    expect(c).toMatchObject({ dataset_id: ds, place_id: PLACE, query: "DTF transfers in Tampa, FL", status: "new" });
    expect(await api.listCandidates(pgDb(pg, OTHER))).toEqual([]);
  });

  it("Add as draft creates a draft from the reviewer's form with the place ID, and marks the candidate added", async () => {
    const admin = pgDb(pg, ADMIN);
    const l = await api.addCandidateAsDraft(admin, await theCandidate(), reviewerInput());
    expect(l).toMatchObject({
      status: "draft", place_id: PLACE, name: "Example Reviewed Shop", slug: "example-reviewed-shop", city: "Tampa", state: "FL",
      website: "https://example.com", address1: null, phone: null, lat: null, lng: null, description: null,
    });
    expect((await api.listCandidates(admin, "added")).map((c) => c.place_id)).toEqual([PLACE]);
    expect(await api.listCandidates(admin, "new")).toEqual([]);
    expect((await pg.query(`select count(*)::int n from listing_facts`)).rows).toEqual([{ n: 0 }]);
    expect((await pg.query(`select count(*)::int n from verification_events`)).rows).toEqual([{ n: 0 }]);
  });

  it("the place ID always comes from the candidate, not the form", async () => {
    const l = await api.addCandidateAsDraft(pgDb(pg, ADMIN), await theCandidate(), { ...reviewerInput(), place_id: "ChIJsomethingElseTyped" });
    expect(l.place_id).toBe(PLACE);
  });

  it("a candidate is reviewed once", async () => {
    const admin = pgDb(pg, ADMIN);
    const c = await theCandidate();
    await api.addCandidateAsDraft(admin, c, reviewerInput());
    await expect(api.addCandidateAsDraft(admin, { ...c, status: "added" }, reviewerInput())).rejects.toThrow(/already been reviewed/);
    await expect(api.rejectCandidate(admin, c.id)).rejects.toThrow(/Nothing was saved/);
  });

  it("a stale screen can't add the same place twice", async () => {
    const admin = pgDb(pg, ADMIN);
    const c = await theCandidate();
    await api.addCandidateAsDraft(admin, c, reviewerInput());
    await expect(api.addCandidateAsDraft(admin, c, { ...reviewerInput(), slug: "example-again" })).rejects.toThrow();
    expect((await pg.query(`select count(*)::int n from listings`)).rows).toEqual([{ n: 1 }]);
  });

  it("Reject marks the candidate rejected and writes no listing", async () => {
    const admin = pgDb(pg, ADMIN);
    await api.rejectCandidate(admin, (await theCandidate()).id);
    expect((await api.listCandidates(admin, "rejected")).map((c) => c.place_id)).toEqual([PLACE]);
    expect((await pg.query(`select count(*)::int n from listings`)).rows).toEqual([{ n: 0 }]);
  });

  it("a non-admin can neither add nor reject", async () => {
    const other = pgDb(pg, OTHER);
    const c = await theCandidate();
    await expect(api.addCandidateAsDraft(other, c, reviewerInput())).rejects.toThrow();
    await expect(api.rejectCandidate(other, c.id)).rejects.toThrow(/Nothing was saved/);
    expect((await theCandidate()).status).toBe("new");
  });

  it("the draft form starts blank except the place ID", () => {
    expect(draftStart(PLACE)).toEqual({ ...emptyCore(), place_id: PLACE });
  });
});

describe("live Place Details (display only)", () => {
  const stub = (status: number, body: unknown) => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const fn = async (url: string, init: { headers: Record<string, string> }) => {
      calls.push({ url, headers: init.headers });
      return { ok: status < 400, status, json: async () => body };
    };
    return { fn, calls };
  };

  it("asks for the review fields only, with the browser key", async () => {
    const s = stub(200, {
      displayName: { text: "Example Google Name", languageCode: "en" }, formattedAddress: "1 Example St, Tampa, FL",
      nationalPhoneNumber: "(555) 555-0100", websiteUri: "https://example.com", googleMapsUri: "https://maps.google.com/?cid=1",
      businessStatus: "OPERATIONAL", rating: 4.8,
    });
    const p = await fetchPlacePreview(PLACE, "browser-key", s.fn);
    expect(s.calls).toEqual([{ url: DETAILS_URL + PLACE, headers: { "X-Goog-Api-Key": "browser-key", "X-Goog-FieldMask": DETAILS_FIELD_MASK } }]);
    expect(DETAILS_FIELD_MASK).not.toMatch(/rating|review|location|photos|\*/i);
    expect(p).toEqual({
      name: "Example Google Name", address: "1 Example St, Tampa, FL", phone: "(555) 555-0100", website: "https://example.com",
      mapsUrl: "https://maps.google.com/?cid=1", businessStatus: "OPERATIONAL",
    });
  });

  it("drops links that aren't http(s) and falls back to a Maps link", async () => {
    const p = await fetchPlacePreview(PLACE, "k", stub(200, { websiteUri: "javascript:alert(1)", googleMapsUri: "javascript:x" }).fn);
    expect(p.website).toBeNull();
    expect(p.mapsUrl).toBe(mapsLink(PLACE));
    expect(mapsLink(PLACE)).toBe(`https://www.google.com/maps/place/?q=place_id:${PLACE}`);
  });

  it("reports an HTTP error", async () => {
    await expect(fetchPlacePreview(PLACE, "k", stub(403, {}).fn)).rejects.toThrow(/HTTP 403/);
  });
});

describe("nothing fetched from Google is written by code", () => {
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));
  const sources = files(src).filter((f) => /\.tsx?$/.test(f));
  const importers = (mod: string) =>
    sources.filter((f) => new RegExp(`from\\s+["'][./]+(?:[\\w/]+/)?${mod}(\\.tsx?)?["']`).test(readFileSync(f, "utf8"))).map((f) => relative(src, f).replaceAll("\\", "/"));

  it("only the display panel calls Google, and only the Candidates screen shows that panel", () => {
    expect(importers("places")).toEqual(["pages/PlacePanel.tsx"]);
    expect(importers("PlacePanel")).toEqual(["pages/Candidates.tsx"]);
    const callers = sources.filter((f) => readFileSync(f, "utf8").includes("places.googleapis.com")).map((f) => relative(src, f).replaceAll("\\", "/"));
    expect(callers).toEqual(["lib/places.ts"]);
  });

  it("the panel takes no callbacks and hands nothing back", () => {
    const panel = readFileSync(join(src, "pages", "PlacePanel.tsx"), "utf8");
    expect(panel).toMatch(/export function PlacePanel\(\{ placeId, apiKey \}: \{ placeId: string; apiKey: string \| undefined \}\)/);
    expect(panel).not.toMatch(/useApp|\bdb\b|api\.ts|insert|update\(|rpc\(/);
    expect(readFileSync(join(src, "lib", "places.ts"), "utf8")).not.toMatch(/import .*(api|db|supabase)/);
  });

  it("the draft form on the Candidates screen starts from draftStart, not from Google details", () => {
    const page = readFileSync(join(src, "pages", "Candidates.tsx"), "utf8");
    expect(page).toContain("initial={draftStart(c.place_id)}");
    expect(page).toMatch(/<PlacePanel placeId=\{c\.place_id\} apiKey=\{PLACES_KEY\} \/>/);
  });
});
