import { describe, expect, it } from "vitest";
import {
  INFO_PAGES, angleFacts, contrastWithWhite, hasDetailPage, isPlaced, orderForList, placementNames, placementRules, planPages, shipSuppliers, siteListings,
  sitemapEntries, validateSiteConfig,
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
  brand: { primary: "#1d4ed8", accent: "#b45309" },
  operator: { name: "Test Operator", email: "hello@dtf.example.com" },
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
    expect(pages.filter((p) => p.type !== "info").map((p) => p.type)).toEqual(["home"]);
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

  it("lists as suppliers only approved programs with checked facts that this site placed on ship-to-you", () => {
    const a = (slug: string, over: Partial<AffiliateState> = {}): AffiliateState =>
      ({ slug, status: "approved", url: "https://x.example/?r=1", hasSupplierFacts: true, factsCheckedAt: "2026-11-18", ...over });
    const site: SiteConfig = { ...dtfSite, affiliates: { "transfer-express": ["ship-to-you"], dtfsheet: ["ship-to-you"], jiffy: ["guides"], eazydtf: ["ship-to-you"] } };
    const page = { capability: "dtf", metro: "tampa-bay" };
    const got = shipSuppliers(site, [
      a("transfer-express"), a("dtfsheet"),
      a("jiffy"), // placed on guides only
      a("eazydtf", { hasSupplierFacts: false, factsCheckedAt: null }),
      a("xtool"), // not on this site
    ], page);
    expect(got.map((x) => x.slug)).toEqual(["dtfsheet", "transfer-express"]);
    expect(shipSuppliers(site, [a("dtfsheet", { status: "paused" }), a("transfer-express", { url: null })], page)).toEqual([]);
  });

  describe("placements limited to metros or capabilities", () => {
    const a = (slug: string): AffiliateState =>
      ({ slug, status: "approved", url: "https://x.example/?r=1", hasSupplierFacts: true, factsCheckedAt: "2026-11-18" });
    const site: SiteConfig = {
      ...dtfSite,
      pages: { ...dtfSite.pages, shipToYou: ["dtf", "uv-dtf"] },
      affiliates: {
        "transfer-express": ["ship-to-you", "guides"],
        eazydtf: [{ placement: "ship-to-you", metros: ["tampa-bay"] }],
        jiffy: [{ placement: "ship-to-you", capabilities: ["uv-dtf"] }, "guides"],
        dtfsheet: [{ placement: "ship-to-you", metros: ["buffalo"], capabilities: ["dtf"] }],
      },
    };
    const listings = [shop({ capabilities: ["dtf", "uv-dtf"], metros: ["tampa-bay", "buffalo"] })];

    it("a plain placement name still means everywhere on the site", () => {
      for (const metro of ["tampa-bay", "buffalo"]) {
        for (const capability of ["dtf", "uv-dtf"]) expect(isPlaced(site, "transfer-express", "ship-to-you", { metro, capability })).toBe(true);
      }
      expect(isPlaced(site, "transfer-express", "guides", {})).toBe(true);
      expect(isPlaced(site, "transfer-express", "list-pages", { metro: "tampa-bay", capability: "dtf" })).toBe(false);
    });

    it("a limited placement matches only pages about a listed metro and capability", () => {
      expect(isPlaced(site, "eazydtf", "ship-to-you", { metro: "tampa-bay", capability: "dtf" })).toBe(true);
      expect(isPlaced(site, "eazydtf", "ship-to-you", { metro: "buffalo", capability: "dtf" })).toBe(false);
      expect(isPlaced(site, "eazydtf", "ship-to-you", { capability: "dtf" })).toBe(false); // a page about no metro
      expect(isPlaced(site, "jiffy", "ship-to-you", { metro: "buffalo", capability: "uv-dtf" })).toBe(true);
      expect(isPlaced(site, "jiffy", "ship-to-you", { metro: "buffalo", capability: "dtf" })).toBe(false);
      expect(isPlaced(site, "jiffy", "guides", {})).toBe(true);
      expect(isPlaced(site, "dtfsheet", "ship-to-you", { metro: "buffalo", capability: "dtf" })).toBe(true);
      expect(isPlaced(site, "dtfsheet", "ship-to-you", { metro: "buffalo", capability: "uv-dtf" })).toBe(false);
      expect(isPlaced(site, "dtfsheet", "ship-to-you", { metro: "tampa-bay", capability: "dtf" })).toBe(false);
    });

    it("each ship-to-you page lists only the suppliers placed on it", () => {
      const all = [a("dtfsheet"), a("eazydtf"), a("jiffy"), a("transfer-express")];
      const on = (capability: string, metro: string) => shipSuppliers(site, all, { capability, metro }).map((x) => x.slug);
      expect(on("dtf", "tampa-bay")).toEqual(["eazydtf", "transfer-express"]);
      expect(on("dtf", "buffalo")).toEqual(["dtfsheet", "transfer-express"]);
      expect(on("uv-dtf", "tampa-bay")).toEqual(["eazydtf", "jiffy", "transfer-express"]);
      expect(on("uv-dtf", "buffalo")).toEqual(["jiffy", "transfer-express"]);
    });

    it("builds a ship-to-you page only where a supplier is placed, dated from its own suppliers", () => {
      const only = planPages(site, { listings, affiliates: [{ ...a("eazydtf"), factsCheckedAt: "2026-11-02" }, { ...a("dtfsheet"), factsCheckedAt: "2026-11-05" }], guides: [] })
        .filter((p) => p.type === "shipToYou");
      expect(only.map((p) => [p.path, p.lastmod])).toEqual([
        ["/ship/dtf-to-buffalo/", "2026-11-05"],
        ["/ship/dtf-to-tampa-bay/", "2026-11-02"],
        ["/ship/uv-dtf-to-tampa-bay/", "2026-11-02"],
      ]);
    });

    it("turns entries into rules and names", () => {
      expect(placementRules(site, "jiffy")).toEqual([{ placement: "ship-to-you", capabilities: ["uv-dtf"] }, { placement: "guides" }]);
      expect(placementRules(site, "xtool")).toEqual([]);
      expect(placementNames(site.affiliates.jiffy)).toEqual(["ship-to-you", "guides"]);
      expect(placementNames([{ placement: "ship-to-you", metros: ["tampa-bay"] }, "ship-to-you"])).toEqual(["ship-to-you"]);
    });
  });

  it("keeps unapproved guides out of the index", () => {
    const draft = planPages(dtfSite, { listings: [], affiliates: [], guides: [{ slug: "best-heat-press-for-dtf", approved: false, approvedAt: null }] });
    expect(draft.find((p) => p.type === "guide")).toMatchObject({ indexable: false, lastmod: null });
    const ok = planPages(dtfSite, { listings: [], affiliates: [], guides: [{ slug: "best-heat-press-for-dtf", approved: true, approvedAt: "2026-12-01" }] });
    expect(ok.find((p) => p.type === "guide")).toMatchObject({ indexable: true, lastmod: "2026-12-01" });
  });

  it("builds the add-your-shop, info and legal pages on every site, indexed, with no lastmod", () => {
    for (const site of [dtfSite, laserSite, tampaSite]) {
      const info = planPages(site, { listings: [], ...noExtras }).filter((p) => p.type === "info");
      expect(info.map((p) => p.path)).toEqual(["/add-your-shop/", "/about/", "/disclosure/", "/privacy/", "/terms/", "/contact/"]);
      expect(info.every((p) => p.indexable && p.lastmod === null)).toBe(true);
    }
    expect([...INFO_PAGES]).toEqual(["add-your-shop", "about", "disclosure", "privacy", "terms", "contact"]);
    const locs = sitemapEntries(dtfSite, planPages(dtfSite, { listings: [], ...noExtras }));
    expect(locs).toContainEqual({ loc: "https://dtf.example.com/privacy/", lastmod: null });
    expect(locs).toContainEqual({ loc: "https://dtf.example.com/add-your-shop/", lastmod: null });
  });

  it("refuses to plan two pages at one path", () => {
    expect(() => planPages({ ...tampaSite, filter: { capabilities: null, metros: null } }, { listings: [shop({ metros: ["about"] })], ...noExtras })).toThrow(/two pages at \/about\//);
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
      [{ affiliates: { xtool: [{ placement: "ship-to-you", metros: ["orlando"] }] } }, /affiliates\.xtool\.metros: unknown "orlando"/],
      [{ affiliates: { xtool: [{ placement: "ship-to-you", capabilities: ["vinyl"] }] } }, /affiliates\.xtool\.capabilities: unknown "vinyl"/],
      [{ affiliates: { xtool: [{ placement: "popups", metros: ["buffalo"] }] } }, /affiliates\.xtool: unknown placement "popups"/],
      [{ affiliates: { xtool: [{ placement: "ship-to-you", metros: [] }] } }, /affiliates\.xtool\.metros: must be a non-empty list/],
      [{ affiliates: { xtool: [{ placement: "ship-to-you", metro: ["buffalo"] } as never] } }, /affiliates\.xtool: unknown key "metro"/],
      [{ affiliates: { xtool: [{ placement: "guides", capabilities: ["laser"] }] } }, /guides placement can't be limited/],
      [{ affiliates: { xtool: [42 as never] } }, /affiliates\.xtool: each placement must be/],
      [{ affiliates: { xtool: "guides" as never } }, /affiliates\.xtool: must be a list/],
      [{ pages: { ...dtfSite.pages, capabilityMetro: ["laser"] } }, /outside filter\.capabilities/],
      [{ domain: null }, /required before a site can launch/],
      [{ domain: "https://dtf.example.com" }, /bare domain/],
      [{ brand: { primary: "#1D4ED8", accent: "#b45309" } }, /brand\.primary: must be/],
      [{ brand: { primary: "blue", accent: "#b45309" } }, /brand\.primary: must be/],
      [{ brand: { primary: "#1d4ed8", accent: "#fde047" } }, /brand\.accent: #fde047 is too light/],
      [{ brand: undefined as unknown as SiteConfig["brand"] }, /brand\.primary/],
      [{ operator: null }, /operator: required before a site can launch/],
      [{ operator: { name: " " } }, /operator: must be null/],
      [{ operator: { name: "Test Operator" } }, /operator\.email: required before a site can launch/],
      [{ operator: { name: "Test Operator", email: "not an email" } }, /operator\.email: must be an email/],
    ];
    for (const [over, pattern] of cases) {
      const errs = validateSiteConfig({ ...dtfSite, ...over }, vocab);
      expect(errs.join("\n"), JSON.stringify(over)).toMatch(pattern);
    }
  });

  it("accepts plain placements and placements limited to known metros and capabilities", () => {
    const site: SiteConfig = {
      ...dtfSite,
      affiliates: {
        "transfer-express": ["ship-to-you", "guides"],
        xtool: [{ placement: "ship-to-you", metros: ["tampa-bay"] }, { placement: "list-pages", metros: ["buffalo"], capabilities: ["blanks"] }, "guides"],
      },
    };
    expect(validateSiteConfig(site, vocab)).toEqual([]);
  });

  it("lets a planned site go without a domain", () => {
    expect(validateSiteConfig({ ...dtfSite, status: "planned", domain: null }, vocab)).toEqual([]);
  });

  it("lets a planned site go without an operator", () => {
    expect(validateSiteConfig({ ...dtfSite, status: "planned", operator: null }, vocab)).toEqual([]);
  });

  it("lets a planned site name an operator without an email", () => {
    expect(validateSiteConfig({ ...dtfSite, status: "planned", operator: { name: "Test Operator" } }, vocab)).toEqual([]);
  });

  it("measures contrast against white", () => {
    expect(contrastWithWhite("#000000")).toBeCloseTo(21, 1);
    expect(contrastWithWhite("#ffffff")).toBeCloseTo(1, 5);
    expect(contrastWithWhite("#767676")).toBeGreaterThanOrEqual(4.5); // the lightest gray that passes
    expect(contrastWithWhite("#777777")).toBeLessThan(4.5);
  });
});
