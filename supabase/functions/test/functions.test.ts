// The `go` and `track` Edge Functions, run in Node with the real supabase-js client against the real
// migration, seed, synced sites and fixture shops on in-memory Postgres (through a PostgREST stand-in).

import type { PGlite } from "@electric-sql/pglite";
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { freshDb, root, seedFixture } from "../../../apps/web/test/helpers.ts";
import type { Fixture } from "../../../apps/web/src/lib/load.ts";
import { syncSites } from "../../../scripts/sync-sites.ts";
import { serviceKey } from "../_shared/db.ts";
import { handleGo, pagePathFromReferer, subId, withSubId } from "../_shared/go.ts";
import { handleTrack } from "../_shared/track.ts";
import { restFetch } from "./rest.ts";

const KEY = "dummy-service-key-for-function-tests";
// A deployed function sees its own name first in the path: /go/..., /track/...
const FN = "https://ref.supabase.co";
const TE_LINK = "https://transferexpress.example/aff?id=123";
const DTFSHEET_LINK = "https://dtfsheet.example/?ref=abc&sid={subid}";
const SHOP = "00000000-0000-4000-8000-000000000001";
const DRAFT = "00000000-0000-4000-8000-000000000007";

let db: PGlite;
let client: ReturnType<typeof createClient>;

const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
const clicks = () => q<{ kind: string; site: string; program: string | null; listing_id: string | null; page_path: string | null }>(
  `select c.kind, s.slug site, p.slug program, c.listing_id, c.page_path
     from clicks c join sites s on s.id = c.site_id left join affiliate_programs p on p.id = c.program_id order by c.id`);
const setAffiliate = (site: string, program: string, status: string, url: string | null) =>
  q(`update site_affiliates set status = $3, url = $4
      where site_id = (select id from sites where slug = $1) and program_id = (select id from affiliate_programs where slug = $2)`,
    [site, program, status, url]);

const go = (path: string, headers: Record<string, string> = {}, method = "GET") =>
  handleGo(new Request(`${FN}${path}`, { method, headers: { "user-agent": "Mozilla/5.0", ...headers } }), client);
const track = (site: string, body: unknown, method = "POST") =>
  handleTrack(new Request(`${FN}/track/${site}/`, { method, body: method === "POST" ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined }), client);

beforeAll(async () => {
  db = await freshDb();
  await syncSites(db, join(root, "sites"));
  await seedFixture(db, JSON.parse(readFileSync(join(root, "fixtures", "demo.json"), "utf8")) as Fixture);
  // Sites have no domain in config yet (H3); give dtf one so Referer matching can be tested.
  await q(`update sites set domain = 'dtf.example' where slug = 'dtf'`);
  client = createClient("http://supabase.test", KEY, { auth: { persistSession: false }, global: { fetch: restFetch(db, KEY) } });
}, 120_000);

beforeEach(async () => {
  await q(`delete from clicks`);
  await q(`update site_affiliates set status = 'apply', url = null`);
  await setAffiliate("dtf", "transfer-express", "approved", TE_LINK);
});

describe("go", () => {
  it("redirects an approved program to the stored link with a site and page sub-ID, and logs the click", async () => {
    const res = await go("/go/dtf/transfer-express/", { referer: "https://dtf.example/ship/dtf-to-tampa-bay/" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${TE_LINK}&subid=dtf_ship_dtf-to-tampa-bay`);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await clicks()).toEqual([
      { kind: "affiliate", site: "dtf", program: "transfer-express", listing_id: null, page_path: "/ship/dtf-to-tampa-bay/" },
    ]);
  });

  it("puts the sub-ID where the stored link has {subid}", async () => {
    await setAffiliate("dtf", "dtfsheet", "approved", DTFSHEET_LINK);
    const res = await go("/go/dtf/dtfsheet", { referer: "https://www.dtf.example/" });
    expect(res.headers.get("location")).toBe("https://dtfsheet.example/?ref=abc&sid=dtf_home");
    expect((await clicks()).map((c) => c.page_path)).toEqual(["/"]);
  });

  it("returns 404 and logs nothing for a program that isn't approved on this site", async () => {
    for (const status of ["apply", "applied", "rejected", "paused"]) {
      await setAffiliate("dtf", "dtfsheet", status, status === "apply" ? null : DTFSHEET_LINK);
      expect((await go("/go/dtf/dtfsheet/")).status, status).toBe(404);
    }
    // Approved for dtf only: another site's /go/ link doesn't work.
    expect((await go("/go/laser/transfer-express/")).status).toBe(404);
    expect(await clicks()).toEqual([]);
  });

  it("returns 404 and logs nothing for an unknown program, site or path", async () => {
    for (const path of ["/go/dtf/no-such-program/", "/go/no-such-site/transfer-express/", "/go/dtf/", "/go/dtf/Transfer-Express/", "/go/dtf/transfer-express/extra/"]) {
      expect((await go(path)).status, path).toBe(404);
    }
    expect(await clicks()).toEqual([]);
  });

  it("ignores a url parameter (or any other) in the request", async () => {
    const res = await go("/go/dtf/transfer-express/?url=https://evil.example/&to=https://evil.example/&subid=x", {
      referer: "https://dtf.example/",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${TE_LINK}&subid=dtf_home`);
    expect(res.headers.get("location")).not.toContain("evil");
  });

  it("logs no page path for a Referer from another domain or none", async () => {
    await go("/go/dtf/transfer-express/", { referer: "https://other.example/dtf/tampa-bay/" });
    const res = await go("/go/dtf/transfer-express/");
    expect(res.headers.get("location")).toBe(`${TE_LINK}&subid=dtf_unknown`);
    expect((await clicks()).map((c) => c.page_path)).toEqual([null, null]);
  });

  it("redirects crawlers and HEAD requests without logging them, and refuses other methods", async () => {
    expect((await go("/go/dtf/transfer-express/", { "user-agent": "Googlebot/2.1" })).status).toBe(302);
    expect((await go("/go/dtf/transfer-express/", {}, "HEAD")).status).toBe(302);
    expect((await go("/go/dtf/transfer-express/", {}, "POST")).status).toBe(405);
    expect(await clicks()).toEqual([]);
  });
});

describe("track", () => {
  it("logs website, call and directions clicks for a published listing", async () => {
    for (const kind of ["website", "call", "directions"]) {
      expect((await track("dtf", { listing: SHOP, kind, page: "/dtf/tampa-bay/" })).status, kind).toBe(204);
    }
    expect(await clicks()).toEqual(["website", "call", "directions"].map((kind) => (
      { kind, site: "dtf", program: null, listing_id: SHOP, page_path: "/dtf/tampa-bay/" })));
  });

  it("rejects unknown kinds, including affiliate", async () => {
    for (const kind of ["affiliate", "claim_cta", "email", "", null, 1]) {
      expect((await track("dtf", { listing: SHOP, kind })).status, String(kind)).toBe(400);
    }
    expect(await clicks()).toEqual([]);
  });

  it("rejects unknown sites and listings, drafts, and malformed bodies", async () => {
    expect((await track("no-such-site", { listing: SHOP, kind: "call" })).status).toBe(404);
    expect((await track("dtf", { listing: "00000000-0000-4000-8000-999999999999", kind: "call" })).status).toBe(404);
    expect((await track("dtf", { listing: DRAFT, kind: "call" })).status).toBe(404);
    expect((await track("dtf", { listing: "not-a-uuid", kind: "call" })).status).toBe(400);
    expect((await track("dtf", "{not json")).status).toBe(400);
    expect((await track("dtf", { listing: SHOP, kind: "call", page: "x".repeat(3000) })).status).toBe(413);
    expect((await track("dtf", null, "GET")).status).toBe(405);
    expect(await clicks()).toEqual([]);
  });

  it("drops a page path that isn't a site path", async () => {
    await track("dtf", { listing: SHOP, kind: "call", page: "https://evil.example/" });
    expect((await clicks()).map((c) => c.page_path)).toEqual([null]);
  });
});

describe("helpers", () => {
  it("builds sub-IDs from the site and page", () => {
    expect(subId("dtf", "/")).toBe("dtf_home");
    expect(subId("dtf", "/shop/example-dtf-tampa/")).toBe("dtf_shop_example-dtf-tampa");
    expect(subId("dtf", null)).toBe("dtf_unknown");
    expect(subId("dtf", `/${"a".repeat(300)}/`).length).toBe(100);
  });

  it("only uses https stored links", () => {
    expect(withSubId("http://x.example/", "dtf_home")).toBeNull();
    expect(withSubId("not a url", "dtf_home")).toBeNull();
    expect(withSubId("https://x.example/a?b=1", "dtf_home")).toBe("https://x.example/a?b=1&subid=dtf_home");
  });

  it("reads the page path only from the site's own https pages", () => {
    expect(pagePathFromReferer("https://dtf.example/dtf/buffalo/", "dtf.example")).toBe("/dtf/buffalo/");
    expect(pagePathFromReferer("http://dtf.example/dtf/buffalo/", "dtf.example")).toBeNull();
    expect(pagePathFromReferer("https://dtf.example.evil.example/", "dtf.example")).toBeNull();
    expect(pagePathFromReferer("https://dtf.example/", null)).toBeNull();
  });

  it("prefers the new secret key and falls back to the legacy service role key", () => {
    const env = (vars: Record<string, string>) => (k: string) => vars[k];
    expect(serviceKey(env({ SUPABASE_SECRET_KEYS: '{"default":"sb_secret_x"}', SUPABASE_SERVICE_ROLE_KEY: "legacy" }))).toBe("sb_secret_x");
    expect(serviceKey(env({ SUPABASE_SECRET_KEYS: "{}", SUPABASE_SERVICE_ROLE_KEY: "legacy" }))).toBe("legacy");
    expect(() => serviceKey(env({}))).toThrow(/No service key/);
  });
});
