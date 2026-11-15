// discover against the real migration and seed on in-memory Postgres, with a stubbed Places API.

import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  buildQueries, discover, FIELD_MASK, insertCandidate, loadVocab, main, searchPlaceIds, TEXT_SEARCH_URL,
  type Db, type Fetch, type Vocab,
} from "../discover.ts";

const root = join(__dirname, "..", "..");
const KEY = "test-places-key-do-not-print";

// What a careless or future Google response could carry. None of it may reach the database.
const GOOGLE_ONLY = {
  displayName: { text: "Stub Shop From Google", languageCode: "en" },
  formattedAddress: "1 Stub Street, Tampa, FL 33602",
  nationalPhoneNumber: "(555) 555-0142",
  rating: 4.9,
  location: { latitude: 27.95, longitude: -82.45 },
  regularOpeningHours: { weekdayDescriptions: ["Monday: 9AM-5PM"] },
};
const GOOGLE_STRINGS = ["Stub Shop From Google", "1 Stub Street", "555-0142", "4.9", "27.95", "Monday: 9AM"];

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

interface Call { url: string; headers: Record<string, string>; body: Record<string, unknown> }

/** A Places Text Search stand-in: pages of IDs per query, each place padded with extra Google fields. */
function stubPlaces(pages: Record<string, string[][]>, opts: { status?: number } = {}) {
  const calls: Call[] = [];
  const fetchFn: Fetch = async (url, init) => {
    const body = JSON.parse(init.body) as { textQuery: string; pageToken?: string };
    calls.push({ url, headers: init.headers, body });
    if (opts.status) {
      return { ok: false, status: opts.status, json: async () => ({}), text: async () => `{"error":{"message":"API key not valid"}}` };
    }
    const all = pages[body.textQuery] ?? [];
    const i = body.pageToken ? Number(body.pageToken.replace("page-", "")) : 0;
    const res = {
      places: (all[i] ?? []).map((id) => ({ id, ...GOOGLE_ONLY })),
      ...(i + 1 < all.length ? { nextPageToken: `page-${i + 1}` } : {}),
    };
    return { ok: true, status: 200, json: async () => res, text: async () => JSON.stringify(res) };
  };
  return { fetchFn, calls };
}

/** Records every statement sent to the database. */
function recording(db: PGlite): Db & { log: { sql: string; params: unknown[] }[] } {
  const log: { sql: string; params: unknown[] }[] = [];
  return {
    log,
    async query<T>(sql: string, params: unknown[] = []) {
      log.push({ sql, params });
      return db.query<T>(sql, params) as Promise<{ rows: T[] }>;
    },
  };
}

const pid = (n: number) => `ChIJstub${String(n).padStart(10, "0")}`;

let pg: PGlite;
let vocab: Vocab;

beforeAll(async () => {
  pg = await freshDb();
  vocab = (await loadVocab(pg as unknown as Db, "makers"))!;
}, 60_000);

beforeEach(async () => {
  await pg.exec(`delete from candidates; delete from listings;`);
});

describe("buildQueries", () => {
  it("makes every term for each capability in every city of each metro", () => {
    const { queries, errors } = buildQueries(vocab, { dtf: ["DTF transfers", "DTF printing"] }, { capabilities: ["dtf"], metros: ["tampa-bay"] });
    expect(errors).toEqual([]);
    const cities = vocab.metros.find((m) => m.slug === "tampa-bay")!.cities;
    expect(queries).toHaveLength(2 * cities.length);
    expect(queries[0]).toEqual({ capability: "dtf", metro: "tampa-bay", text: `DTF transfers in ${cities[0]}, FL` });
    expect(queries.map((q) => q.text)).toContain("DTF printing in Brandon, FL");
  });

  it("falls back to the capability name when the terms file has none", () => {
    const { queries } = buildQueries(vocab, {}, { capabilities: ["laser"], metros: ["buffalo"] });
    expect(queries[0].text).toBe("Laser engraving and cutting in Buffalo, NY");
  });

  it("refuses unknown capabilities and metros", () => {
    expect(buildQueries(vocab, {}, { capabilities: ["nope"], metros: ["mars"] }).errors).toEqual([
      'unknown capability "nope"', 'unknown metro "mars"',
    ]);
  });

  it("the shipped terms file names only capabilities in the seed", () => {
    const terms = JSON.parse(readFileSync(join(root, "scripts", "discover-queries.json"), "utf8")) as Record<string, Record<string, string[]>>;
    for (const cap of Object.keys(terms.makers)) expect(vocab.capabilities.map((c) => c.slug)).toContain(cap);
  });
});

describe("searchPlaceIds", () => {
  it("asks Google for place IDs only, and keeps only the IDs", async () => {
    const { fetchFn, calls } = stubPlaces({ q: [[pid(1), pid(2)]] });
    expect(await searchPlaceIds(fetchFn, KEY, "q")).toEqual([pid(1), pid(2)]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(TEXT_SEARCH_URL);
    expect(calls[0].headers["X-Goog-FieldMask"]).toBe("places.id,nextPageToken");
    expect(FIELD_MASK.split(",").sort()).toEqual(["nextPageToken", "places.id"]);
    expect(calls[0].headers["X-Goog-Api-Key"]).toBe(KEY);
    expect(calls[0].body).toEqual({ textQuery: "q", pageSize: 20 });
  });

  it("follows the page token, up to the page limit", async () => {
    const { fetchFn, calls } = stubPlaces({ q: [[pid(1)], [pid(2)], [pid(3)]] });
    expect(await searchPlaceIds(fetchFn, KEY, "q")).toEqual([pid(1), pid(2), pid(3)]);
    expect(calls.map((c) => c.body.pageToken)).toEqual([undefined, "page-1", "page-2"]);
    const two = stubPlaces({ q: [[pid(1)], [pid(2)], [pid(3)]] });
    expect(await searchPlaceIds(two.fetchFn, KEY, "q", 2)).toEqual([pid(1), pid(2)]);
  });

  it("drops anything that isn't a place ID", async () => {
    const fetchFn: Fetch = async () => ({
      ok: true, status: 200, text: async () => "",
      json: async () => ({ places: [{ id: pid(1) }, { id: 42 }, { id: "has spaces in it" }, {}, { id: "<script>alert(1)</script>" }] }),
    });
    expect(await searchPlaceIds(fetchFn, KEY, "q")).toEqual([pid(1)]);
  });

  it("stops on an HTTP error without printing the key", async () => {
    const { fetchFn } = stubPlaces({}, { status: 403 });
    await expect(searchPlaceIds(fetchFn, KEY, "q")).rejects.toThrow(/HTTP 403.*API key not valid/);
    await expect(searchPlaceIds(fetchFn, KEY, "q")).rejects.not.toThrow(KEY);
  });
});

describe("discover writes", () => {
  it("the insert into candidates contains only place ID, query and dataset", async () => {
    const db = recording(pg);
    const { fetchFn } = stubPlaces({ "DTF transfers in Tampa, FL": [[pid(1), pid(2)]] });
    await discover(db, fetchFn, KEY, vocab.datasetId, [{ capability: "dtf", metro: "tampa-bay", text: "DTF transfers in Tampa, FL" }]);

    const writes = db.log.filter((s) => /^\s*(insert|update|delete|merge|copy)\b/i.test(s.sql) || /\b(insert into|update\s+\w|delete from)\b/i.test(s.sql));
    expect(writes).toHaveLength(2);
    for (const w of writes) {
      const m = w.sql.match(/insert\s+into\s+public\.candidates\s*\(([^)]*)\)/i);
      expect(m, w.sql).not.toBeNull();
      expect(m![1].split(",").map((c) => c.trim()).sort()).toEqual(["dataset_id", "place_id", "query"]);
      expect(w.params).toHaveLength(3);
      expect(w.params[0]).toBe(vocab.datasetId);
      expect([pid(1), pid(2)]).toContain(w.params[1]);
      expect(w.params[2]).toBe("DTF transfers in Tampa, FL");
      expect(w.sql).not.toMatch(/\b(listings|listing_facts)\s*\(/i); // never inserts there
    }

    // Nothing Google sent beyond the ID is anywhere in what was sent to the database.
    const sent = JSON.stringify(db.log);
    for (const s of GOOGLE_STRINGS) expect(sent).not.toContain(s);

    const rows = (await pg.query<Record<string, unknown>>(`select dataset_id, place_id, query, status from candidates order by place_id`)).rows;
    expect(rows).toEqual([
      { dataset_id: vocab.datasetId, place_id: pid(1), query: "DTF transfers in Tampa, FL", status: "new" },
      { dataset_id: vocab.datasetId, place_id: pid(2), query: "DTF transfers in Tampa, FL", status: "new" },
    ]);
  });

  it("writes nothing to listings or listing_facts", async () => {
    const before = await pg.query(`select (select count(*) from listings) l, (select count(*) from listing_facts) f`);
    const { fetchFn } = stubPlaces({ a: [[pid(1)]], b: [[pid(2)]] });
    await discover(pg as unknown as Db, fetchFn, KEY, vocab.datasetId, [
      { capability: "dtf", metro: "tampa-bay", text: "a" }, { capability: "dtf", metro: "tampa-bay", text: "b" },
    ]);
    expect((await pg.query(`select (select count(*) from listings) l, (select count(*) from listing_facts) f`)).rows).toEqual(before.rows);
  });

  it("skips places already queued, already listed, or found twice in one run", async () => {
    const l = await pg.query<{ id: string }>(
      `insert into listings (dataset_id, slug, name, city, state, place_id) values ($1, 'example-listed', 'Example Listed', 'Tampa', 'FL', $2) returning id`,
      [vocab.datasetId, pid(3)]);
    expect(l.rows).toHaveLength(1);
    await insertCandidate(pg as unknown as Db, vocab.datasetId, pid(1), "earlier query");

    const { fetchFn } = stubPlaces({ a: [[pid(1), pid(2), pid(3)]], b: [[pid(2), pid(4)]] });
    const r = await discover(pg as unknown as Db, fetchFn, KEY, vocab.datasetId, [
      { capability: "dtf", metro: "tampa-bay", text: "a" }, { capability: "dtf", metro: "tampa-bay", text: "b" },
    ]);
    expect(r).toEqual({ queries: 2, found: 4, added: 2 });
    const rows = (await pg.query<{ place_id: string; query: string }>(`select place_id, query from candidates order by place_id`)).rows;
    expect(rows).toEqual([
      { place_id: pid(1), query: "earlier query" },
      { place_id: pid(2), query: "a" },
      { place_id: pid(4), query: "b" },
    ]);
  });

  it("a rejected candidate is not queued again", async () => {
    await insertCandidate(pg as unknown as Db, vocab.datasetId, pid(1), "q");
    await pg.query(`update candidates set status = 'rejected'`);
    expect(await insertCandidate(pg as unknown as Db, vocab.datasetId, pid(1), "q again")).toBe(false);
    expect((await pg.query(`select status, query from candidates`)).rows).toEqual([{ status: "rejected", query: "q" }]);
  });
});

describe("main", () => {
  const deps = (fetchFn: Fetch) => {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out, err,
      deps: {
        connect: async () => pg as unknown as Db,
        fetch: fetchFn,
        log: (m: string) => out.push(m),
        error: (m: string) => err.push(m),
        termsFile: join(root, "scripts", "discover-queries.json"),
      },
    };
  };

  it("needs DATABASE_URL and, unless dry, GOOGLE_PLACES_API_KEY", async () => {
    const d = deps(stubPlaces({}).fetchFn);
    expect(await main([], {}, d.deps)).toBe(2);
    expect(await main([], { DATABASE_URL: "x" }, d.deps)).toBe(2);
    expect(d.err.join("\n")).toMatch(/GOOGLE_PLACES_API_KEY is not set/);
  });

  it("--dry-run prints the queries and sends nothing", async () => {
    const stub = stubPlaces({});
    const d = deps(stub.fetchFn);
    expect(await main(["--dry-run", "--capability", "dtf", "--metro", "buffalo"], { DATABASE_URL: "x" }, d.deps)).toBe(0);
    expect(stub.calls).toEqual([]);
    expect(d.out.join("\n")).toContain("DTF transfers in Buffalo, NY");
    expect((await pg.query(`select * from candidates`)).rows).toEqual([]);
  });

  it("queues candidates and never prints the key, even on failure", async () => {
    const stub = stubPlaces({ "DTF transfers in Buffalo, NY": [[pid(1)]] });
    const d = deps(stub.fetchFn);
    expect(await main(["--capability", "dtf", "--metro", "buffalo"], { DATABASE_URL: "x", GOOGLE_PLACES_API_KEY: KEY }, d.deps)).toBe(0);
    expect(d.out.at(-1)).toMatch(/1 new candidates queued/);
    expect((await pg.query(`select place_id from candidates`)).rows).toEqual([{ place_id: pid(1) }]);

    const bad = deps(stubPlaces({}, { status: 403 }).fetchFn);
    expect(await main(["--capability", "dtf", "--metro", "buffalo"], { DATABASE_URL: "x", GOOGLE_PLACES_API_KEY: KEY }, bad.deps)).toBe(1);
    expect(bad.err.join("\n")).toMatch(/HTTP 403/);
    expect([...bad.out, ...bad.err, ...d.out, ...d.err].join("\n")).not.toContain(KEY);
  });

  it("refuses an unknown capability or metro before calling Google", async () => {
    const stub = stubPlaces({});
    const d = deps(stub.fetchFn);
    expect(await main(["--capability", "nope"], { DATABASE_URL: "x", GOOGLE_PLACES_API_KEY: KEY }, d.deps)).toBe(1);
    expect(stub.calls).toEqual([]);
  });
});
