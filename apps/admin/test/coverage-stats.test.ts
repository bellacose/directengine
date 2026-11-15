import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Fact, Listing, SiteConfig } from "@directory-engine/core";
import { describe, expect, it } from "vitest";
import { siteCoverage, verifiedFacts } from "../src/lib/sites.ts";
import { aggregateClicks, weekOf } from "../src/lib/stats.ts";

const root = join(__dirname, "..", "..", "..");
const site = (slug: string) => JSON.parse(readFileSync(join(root, "sites", `${slug}.json`), "utf8")) as SiteConfig;
const SITES = ["dtf", "laser", "tampa-makers"].map(site);

const fact = (key: string, group: string): Fact => ({ key, group, sort: 0, value: true, checkedAt: "2026-11-01", method: "phone_call", stale: false });
const listing = (over: Partial<Listing>): Listing => ({
  id: "L", slug: "example", name: "Example", status: "published", capabilities: ["dtf"], metros: ["buffalo"],
  updatedAt: "2026-11-01T00:00:00Z", facts: [], ...over,
});

describe("siteCoverage", () => {
  it("follows each site's filter and minFacts", () => {
    const l = listing({ facts: [fact("dtf_same_day_cutoff", "dtf"), fact("pickup_walk_in", "pickup"), fact("ships", "general")] });
    const cov = Object.fromEntries(siteCoverage(SITES, "makers", l).map((c) => [c.slug, c]));
    expect(cov.dtf).toMatchObject({ included: true, detailPage: true, angleFactCount: 3 });
    expect(cov.laser).toMatchObject({ included: false, matchesFilter: false, detailPage: false });
    expect(cov["tampa-makers"]).toMatchObject({ included: false, matchesFilter: false }); // Buffalo shop
  });

  it("a draft is on no site yet, but shows where it would go", () => {
    const l = listing({ status: "draft", metros: ["tampa-bay"], facts: [fact("pickup_walk_in", "pickup")] });
    const cov = Object.fromEntries(siteCoverage(SITES, "makers", l).map((c) => [c.slug, c]));
    expect(cov.dtf).toMatchObject({ included: false, matchesFilter: true, detailPage: false, angleFactCount: 1, minFacts: 3 });
    expect(cov["tampa-makers"]).toMatchObject({ included: false, matchesFilter: true });
  });

  it("ignores sites of other datasets", () => {
    expect(siteCoverage(SITES, "other", listing({}))).toEqual([]);
  });

  it("uses verified facts only", () => {
    const defs = [{ key: "a", fact_group: "dtf", sort: 1 }, { key: "b", fact_group: "dtf", sort: 2 }];
    const rows = [
      { key: "a", value: 1, verified: true, stale: false, checked_at: "2026-11-01", method: "website" },
      { key: "b", value: 2, verified: false, stale: false, checked_at: null, method: null },
    ];
    expect(verifiedFacts(rows, defs).map((f) => f.key)).toEqual(["a"]);
  });
});

describe("click stats", () => {
  it("weeks start on Monday (UTC)", () => {
    expect(weekOf("2026-11-15T23:00:00Z")).toBe("2026-11-09"); // Sunday
    expect(weekOf("2026-11-16T00:00:00Z")).toBe("2026-11-16"); // Monday
  });

  it("counts by site and week, program and listing", () => {
    const names = {
      sites: new Map([["s1", "dtf"], ["s2", "laser"]]),
      programs: new Map([["p1", "Transfer Express"]]),
      listings: new Map([["l1", "Example Prints"]]),
    };
    const c = (site_id: string, kind: string, created_at: string, extra: { listing_id?: string; program_id?: string } = {}) =>
      ({ site_id, kind, created_at, listing_id: extra.listing_id ?? null, program_id: extra.program_id ?? null });
    const s = aggregateClicks([
      c("s1", "affiliate", "2026-11-10T10:00:00Z", { program_id: "p1" }),
      c("s1", "affiliate", "2026-11-11T10:00:00Z", { program_id: "p1" }),
      c("s1", "website", "2026-11-11T10:00:00Z", { listing_id: "l1" }),
      c("s2", "call", "2026-11-03T10:00:00Z", { listing_id: "l1" }),
    ], names);
    expect(s.total).toBe(4);
    expect(s.bySiteWeek).toEqual([
      { key: ["dtf", "2026-11-09", "affiliate"], count: 2 },
      { key: ["dtf", "2026-11-09", "website"], count: 1 },
      { key: ["laser", "2026-11-02", "call"], count: 1 },
    ]);
    expect(s.byProgram).toEqual([{ key: ["dtf", "Transfer Express"], count: 2 }]);
    expect(s.byListing).toEqual([
      { key: ["dtf", "Example Prints", "website"], count: 1 },
      { key: ["laser", "Example Prints", "call"], count: 1 },
    ]);
  });
});
