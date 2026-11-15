import { describe, expect, it } from "vitest";
import {
  angleFacts, hasDetailPage, orderForList, planPages, siteListings, sitemapEntries, validateSiteConfig,
  type AffiliateState, type Fact, type GuideState, type Listing, type SiteConfig, type Vocab,
} from "../src/index";

const vocab: Vocab = {
  capabilities: ["dtf", "uv-dtf", "laser", "blanks"],
  metros: ["tampa-bay", "buffalo"],
  factKeys: ["hours", "ships", "pickup_walk_in", "dtf_same_day_cutoff", "dtf_price_note", "laser_materials", "laser_price_note", "laser_types"],
  factGroups: ["general", "pickup", "dtf", "laser"],
  affiliates: ["transfer-express", "xtool"],
  guides: ["best-heat-press-for-dtf"],
};

const dtfSite: SiteConfig = {
  slug: "dtf", status: "launch", name: "DTF", domain: "dtf.example.com", dataset: "makers",
  filter: { capabilities: ["dtf", "uv-dtf"], metros: null },
  pages: { capabilityMetro: ["dtf"], metroHub: false, shipToYou: ["dtf"], guides: ["best-heat-press-for-dtf"] },
  angle: { factGroups: ["dtf", "pickup"], facts: ["hours"], headline: "dtf_same_day_cutoff", minFacts: 3 },
  indexGate: 5,
  affiliates: { "transfer-express": ["ship-to-you"] },
};
const laserSite: SiteConfig = {
  ...dtfSite, slug: "laser", domain: "laser.example.com",
  filter: { capabilities: ["laser"], metros: null },
  pages: { capabilityMetro: ["laser"], metroHub: false, shipToYou: [], guides: [] },
  angle: { factGroups: ["laser", "pickup"], facts: ["hours"], headline: null, minFacts: 3 },
  affiliates: {},
};
const tampaSite: SiteConfig = {
  ...dtfSite, slug: "tampa", domain: "tampa.example.com",
  filter: { capabilities: null, metros: ["tampa-bay"] },
  pages: { capabilityMetro: ["dtf", "laser"], metroHub: true, shipToYou: [], guides: [] },
  angle: { factGroups: ["general", "pickup", "dtf", "laser"], facts: [], headline: null, minFacts: 3 },
  affiliates: {},
};

const GROUP: Record<string, string> = {
  hours: "general", ships: "general", pickup_walk_in: "pickup", dtf_same_day_cutoff: "dtf", dtf_price_note: "dtf",
  laser_materials: "laser", laser_price_note: "laser", laser_types: "laser",
};
const fact = (key: string, value: unknown = true): Fact => ({
  key, group: GROUP[key], sort: Object.keys(GROUP).indexOf(key), value, checkedAt: "2026-11-20", method: "phone_call", stale: false,
});
let seq = 0;
const shop = (over: Partial<Listing> = {}): Listing => {
  seq++;
  return {
    id: `id-${seq}`, slug: `shop-${seq}`, name: `Shop ${String(seq).padStart(3, "0")}`, status: "published",
    capabilities: ["dtf"], metros: ["tampa-bay"], updatedAt: "2026-11-20T15:00:00Z",
    facts: [fact("dtf_same_day_cutoff", "14:00"), fact("pickup_walk_in"), fact("hours", {})],
    ...over,
  };
};
const noExtras = { affiliates: [] as AffiliateState[], guides: [] as GuideState[] };

describe("which listings a site includes", () => {
  const both = shop({ capabilities: ["dtf", "laser"] });
  const laserOnly = shop({ capabilities: ["laser"], metros: ["buffalo"] });
  const draft = shop({ status: "draft" });
  const removed = shop({ status: "removed" });
  const all = [both, laserOnly, draft, removed];

  it("filters by capability, metro and status", () => {
    expect(siteListings(dtfSite, all).map((l) => l.id)).toEqual([both.id]);
    expect(siteListings(laserSite, all).map((l) => l.id)).toEqual([both.id, laserOnly.id]);
    expect(siteListings(tampaSite, all).map((l) => l.id)).toEqual([both.id]);
  });
});

describe("angles: the same shop on different sites", () => {
  const both = shop({
    capabilities: ["dtf", "laser"],
    facts: [
      fact("hours", {}), fact("pickup_walk_in"),
      fact("dtf_same_day_cutoff", "14:00"), fact("dtf_price_note", "$6/ft"),
      fact("laser_materials", "wood, acrylic"),
    ],
  });

  it("each site shows only its own facts, headline first", () => {
    expect(angleFacts(dtfSite, both).map((f) => f.key)).toEqual(["dtf_same_day_cutoff", "hours", "pickup_walk_in", "dtf_price_note"]);
    expect(angleFacts(laserSite, both).map((f) => f.key)).toEqual(["hours", "pickup_walk_in", "laser_materials"]);
    expect(angleFacts(tampaSite, both)).toHaveLength(5);
  });

  it("the pages differ between sites", () => {
    const dtfKeys = angleFacts(dtfSite, both).map((f) => f.key);
    const laserKeys = angleFacts(laserSite, both).map((f) => f.key);
    expect(dtfKeys).not.toEqual(laserKeys);
    expect(laserKeys).not.toContain("dtf_same_day_cutoff");
    expect(dtfKeys).not.toContain("laser_materials");
  });

  it("a shop gets its own page only with enough verified facts for that angle", () => {
    const thin = shop({ capabilities: ["dtf", "laser"], facts: [fact("dtf_same_day_cutoff", "14:00"), fact("dtf_price_note", "$6"), fact("pickup_walk_in")] });
    expect(hasDetailPage(dtfSite, thin)).toBe(true);
    expect(hasDetailPage(laserSite, thin)).toBe(false); // only 1 fact in the laser angle
    const pages = planPages(laserSite, { listings: [thin], ...noExtras });
    expect(pages.some((p) => p.type === "shop")).toBe(false);
    expect(pages.find((p) => p.type === "capabilityMetro")?.listingIds).toEqual([thin.id]); // still in the list
  });
});

describe("list order", () => {
  it("puts shops with the headline fact first, later cutoff first, then by name", () => {
    const a = shop({ name: "A", facts: [fact("dtf_same_day_cutoff", "12:00")] });
    const b = shop({ name: "B", facts: [fact("dtf_same_day_cutoff", "16:00")] });
    const c = shop({ name: "C", facts: [fact("pickup_walk_in")] });
    const d = shop({ name: "D", facts: [] });
    expect(orderForList(dtfSite, [d, c, a, b]).map((l) => l.name)).toEqual(["B", "A", "C", "D"]);
  });
});

describe("page plan", () => {
  it("indexes a capability x metro page only at the gate", () => {
    const four = Array.from({ length: 4 }, () => shop());
    const p4 = planPages(dtfSite, { listings: four, ...noExtras }).find((p) => p.type === "capabilityMetro")!;
    expect(p4.path).toBe("/dtf/tampa-bay/");
    expect(p4.indexable).toBe(false);
    const p5 = planPages(dtfSite, { listings: [...four, shop()], ...noExtras }).find((p) => p.type === "capabilityMetro")!;
    expect(p5.indexable).toBe(true);
  });

  it("does not build empty pages, and counts only published listings", () => {
    const pages = planPages(dtfSite, { listings: [shop({ status: "draft" }), shop({ capabilities: ["laser"] })], ...noExtras });
    expect(pages.map((p) => p.type)).toEqual(["home"]);
  });

  it("uses each page's own data for lastmod, never one date for all", () => {
    const old = shop({ updatedAt: "2026-11-01T00:00:00Z" });
    const fresh = shop({ updatedAt: "2026-11-20T00:00:00Z", metros: ["buffalo"] });
    const pages = planPages(dtfSite, { listings: [old, fresh], ...noExtras });
    const by = (path: string) => pages.find((p) => p.path === path)!.lastmod;
    expect(by("/dtf/tampa-bay/")).toBe("2026-11-01T00:00:00Z");
    expect(by("/dtf/buffalo/")).toBe("2026-11-20T00:00:00Z");
    expect(by(`/shop/${old.slug}/`)).toBe("2026-11-01T00:00:00Z");
    expect(by("/")).toBe("2026-11-20T00:00:00Z");
  });

  it("builds metro hubs only for sites that want them, inside the site's metros", () => {
    const shops = [shop(), shop({ metros: ["tampa-bay", "buffalo"] })];
    expect(planPages(dtfSite, { listings: shops, ...noExtras }).some((p) => p.type === "metroHub")).toBe(false);
    const hubs = planPages(tampaSite, { listings: shops, ...noExtras }).filter((p) => p.type === "metroHub");
    expect(hubs.map((p) => p.path)).toEqual(["/tampa-bay/"]); // no Buffalo pages on the Tampa site
  });

  it("hides ship-to-you pages until an approved supplier has checked facts", () => {
    const listings = [shop()];
    const base: AffiliateState = { slug: "transfer-express", status: "applied", url: null, hasSupplierFacts: false, factsCheckedAt: null };
    const ship = (a: AffiliateState) => planPages(dtfSite, { listings, affiliates: [a], guides: [] }).find((p) => p.type === "shipToYou");
    expect(ship(base)).toBeUndefined();
    expect(ship({ ...base, status: "approved", url: "https://x.example/?r=1" })).toBeUndefined(); // no facts yet
    const live = ship({ ...base, status: "approved", url: "https://x.example/?r=1", hasSupplierFacts: true, factsCheckedAt: "2026-11-18" })!;
    expect(live.path).toBe("/ship/dtf-to-tampa-bay/");
    expect(live.lastmod).toBe("2026-11-18");
  });

  it("ignores a supplier this site has not placed on ship-to-you pages", () => {
    const xtool: AffiliateState = { slug: "xtool", status: "approved", url: "https://x.example", hasSupplierFacts: true, factsCheckedAt: "2026-11-18" };
    expect(planPages(dtfSite, { listings: [shop()], affiliates: [xtool], guides: [] }).some((p) => p.type === "shipToYou")).toBe(false);
  });

  it("keeps unapproved guides out of the index", () => {
    const draft = planPages(dtfSite, { listings: [], affiliates: [], guides: [{ slug: "best-heat-press-for-dtf", approved: false, approvedAt: null }] });
    expect(draft.find((p) => p.type === "guide")).toMatchObject({ indexable: false, lastmod: null });
    const ok = planPages(dtfSite, { listings: [], affiliates: [], guides: [{ slug: "best-heat-press-for-dtf", approved: true, approvedAt: "2026-12-01" }] });
    expect(ok.find((p) => p.type === "guide")).toMatchObject({ indexable: true, lastmod: "2026-12-01" });
  });

  it("puts only indexable pages in the sitemap", () => {
    const pages = planPages(dtfSite, { listings: [shop()], ...noExtras });
    const locs = sitemapEntries(dtfSite, pages).map((e) => e.loc);
    expect(locs).toContain("https://dtf.example.com/");
    expect(locs.some((l) => l.includes("/shop/"))).toBe(true);
    expect(locs).not.toContain("https://dtf.example.com/dtf/tampa-bay/"); // below the gate
    expect(() => sitemapEntries({ ...dtfSite, domain: null }, pages)).toThrow(/no domain/);
  });
});

describe("site config validation", () => {
  it("accepts a good config", () => {
    expect(validateSiteConfig(dtfSite, vocab)).toEqual([]);
  });

  it("catches mistakes", () => {
    const cases: [Partial<SiteConfig>, RegExp][] = [
      [{ slug: "Bad Slug" }, /slug/],
      [{ filter: { capabilities: ["screen-print"], metros: null } }, /filter\.capabilities: unknown "screen-print"/],
      [{ filter: { capabilities: ["dtf"], metros: ["orlando"] } }, /filter\.metros/],
      [{ angle: { ...dtfSite.angle, headline: "star_rating" } }, /angle\.headline/],
      [{ angle: { ...dtfSite.angle, factGroups: ["reviews"] } }, /angle\.factGroups/],
      [{ angle: { ...dtfSite.angle, minFacts: 0 } }, /minFacts/],
      [{ indexGate: 0 }, /indexGate/],
      [{ affiliates: { amazon: ["guides"] } }, /unknown program "amazon"/],
      [{ affiliates: { xtool: ["popups"] } }, /affiliates\.xtool/],
      [{ pages: { ...dtfSite.pages, capabilityMetro: ["laser"] } }, /outside filter\.capabilities/],
      [{ domain: null }, /required before a site can launch/],
      [{ domain: "https://dtf.example.com" }, /bare domain/],
    ];
    for (const [over, pattern] of cases) {
      const errs = validateSiteConfig({ ...dtfSite, ...over }, vocab);
      expect(errs.join("\n"), JSON.stringify(over)).toMatch(pattern);
    }
  });

  it("lets a planned site go without a domain", () => {
    expect(validateSiteConfig({ ...dtfSite, status: "planned", domain: null }, vocab)).toEqual([]);
  });
});
