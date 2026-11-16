// Home and metro hub pages (T6): built HTML for every site from the fixture, with every count checked
// against the plan, and every piece of text in <main> checked against what the data allows (no prose
// beyond data-built sentences). Plus unit tests of buildHomeView and buildMetroHubView.

import { planPages, siteListings, type Page } from "@directory-engine/core";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Window } from "happy-dom";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildHomeView, buildMetroHubView, joinNames, shopCount } from "../src/lib/hub.ts";
import { loadSite, type SiteData } from "../src/lib/load.ts";
import { root } from "./helpers.ts";

const SITES = readdirSync(join(root, "sites")).filter((f) => f.endsWith(".json") && f !== "guides.json").map((f) => f.replace(/\.json$/, "")).sort();
const web = join(root, "apps", "web");

interface Built { out: string; data: SiteData; plan: Page[] }
const built = new Map<string, Built>();

beforeAll(async () => {
  for (const site of SITES) {
    const out = mkdtempSync(join(tmpdir(), `astro-hub-${site}-`));
    execFileSync("npm", ["run", "build", "--", "--site", site, "--fixture", "--outDir", out], {
      cwd: web, shell: true, stdio: "pipe", env: { ...process.env, SITE: "", DATA_FIXTURE: "" },
    });
    const data = await loadSite({ root, env: { SITE: site, DATA_FIXTURE: "fixtures/demo.json" } });
    built.set(site, { out, data, plan: planPages(data.site, data) });
  }
}, 600_000);

afterAll(() => {
  for (const b of built.values()) rmSync(b.out, { recursive: true, force: true });
});

const docFor = (b: Built, path: string) => {
  const html = readFileSync(join(b.out, path.slice(1), "index.html"), "utf8");
  const win = new Window();
  win.document.write(html);
  return win.document;
};
/** href -> count shown next to that link. */
const linkCounts = (doc: any, scope = "main") =>
  new Map<string, number>([...doc.querySelectorAll(`${scope} .hub-links li`)].map((li: any) => [
    li.querySelector("a").getAttribute("href"),
    Number(li.querySelector("[data-count]").getAttribute("data-count")),
  ]));
/** Every non-empty text node in <main>, trimmed, scripts left out. */
const mainTexts = (doc: any): string[] => {
  const out: string[] = [];
  const walk = (n: any) => {
    if (n.nodeName === "SCRIPT" || n.nodeName === "STYLE") return;
    if (n.nodeType === 3 && n.textContent.trim()) out.push(n.textContent.trim());
    for (const c of n.childNodes) walk(c);
  };
  walk(doc.querySelector("main"));
  return out;
};
const metroName = (b: Built, slug: string) => b.data.vocabulary.metros.find((m) => m.slug === slug)!.name;

describe.each(SITES)("home page of %s", (site) => {
  it("shows every list page in the plan, each with its plan listing count", () => {
    const b = built.get(site)!;
    const doc = docFor(b, "/");
    const lists = b.plan.filter((p) => p.type === "capabilityMetro");
    expect(lists.length).toBeGreaterThan(0);
    expect(linkCounts(doc)).toEqual(new Map(lists.map((p) => [p.path, p.listingIds!.length])));
  });

  it("shows each metro with its listing count (the hub's plan count when there is a hub) and its cities", () => {
    const b = built.get(site)!;
    const doc = docFor(b, "/");
    const mine = siteListings(b.data.site, b.data.listings);
    const metros = [...new Set(b.plan.filter((p) => p.metro).filter((p) => p.type !== "shipToYou").map((p) => p.metro!))];
    expect([...doc.querySelectorAll("section.metro")].map((s: any) => s.getAttribute("data-metro"))).toEqual(metros);
    for (const metro of metros) {
      const section = doc.querySelector(`section.metro[data-metro="${metro}"]`)!;
      const hub = b.plan.find((p) => p.type === "metroHub" && p.metro === metro);
      const inMetro = mine.filter((l) => l.metros.includes(metro));
      if (hub) expect(hub.listingIds!.length).toBe(inMetro.length);
      expect(Number(section.querySelector(".metro-count")!.getAttribute("data-count")), metro).toBe(inMetro.length);
      expect(section.querySelector("h2 a")?.getAttribute("href") ?? null).toBe(hub?.path ?? null);
      const cities = [...new Set(b.data.listings.filter((l) => inMetro.some((x) => x.id === l.id)).map((l) => l.city))].sort((a, c) => a.localeCompare(c));
      expect(section.querySelector(".cities")!.textContent).toBe(`Cities: ${cities.join(", ")}`);
    }
  });

  it("has only data-built text: the title, the lead, link names, counts, city names and labels", () => {
    const b = built.get(site)!;
    const doc = docFor(b, "/");
    const mine = siteListings(b.data.site, b.data.listings);
    const allowed = new Set<string>([b.data.site.name, "Cities:"]);
    for (const m of b.data.vocabulary.metros) allowed.add(m.name);
    for (const p of b.plan.filter((p) => p.listingIds)) allowed.add(shopCount(p.listingIds!.length));
    for (const m of b.data.vocabulary.metros) allowed.add(shopCount(mine.filter((l) => l.metros.includes(m.slug)).length));
    for (const a of doc.querySelectorAll("main .hub-links a")) allowed.add((a as any).textContent);
    const lead = doc.querySelector("main .lead")!.textContent!;
    expect(lead).toMatch(/^\d+ shops? listed in [^.]+\.( Last checked [A-Z][a-z]{2} \d{1,2}, \d{4}\.)?$/);
    allowed.add(lead);
    for (const t of mainTexts(doc)) {
      if (t.startsWith("Cities:")) continue; // checked above
      const cityList = doc.querySelectorAll("main .cities");
      if ([...cityList].some((c: any) => c.textContent.endsWith(t))) continue;
      expect(allowed.has(t), `unexpected text on ${site} home: "${t}"`).toBe(true);
    }
  });
});

describe.each(SITES)("metro hubs of %s", (site) => {
  it("is built exactly when the config asks for hubs", () => {
    const b = built.get(site)!;
    expect(b.plan.some((p) => p.type === "metroHub")).toBe(b.data.site.pages.metroHub);
  });

  it("shows the metro's list pages with plan counts, its plan listing count and cities with counts", () => {
    const b = built.get(site)!;
    for (const hub of b.plan.filter((p) => p.type === "metroHub")) {
      const doc = docFor(b, hub.path);
      const lists = b.plan.filter((p) => p.type === "capabilityMetro" && p.metro === hub.metro);
      expect(linkCounts(doc)).toEqual(new Map(lists.map((p) => [p.path, p.listingIds!.length])));
      const n = hub.listingIds!.length;
      const inHub = b.data.listings.filter((l) => hub.listingIds!.includes(l.id));
      const cities = new Map<string, number>();
      for (const l of inHub) cities.set(l.city, (cities.get(l.city) ?? 0) + 1);
      const shown = new Map([...doc.querySelectorAll(".city-list li")].map((li: any) => [li.getAttribute("data-city"), Number(li.querySelector("[data-count]").getAttribute("data-count"))]));
      expect(shown).toEqual(new Map([...cities].sort((a, c) => a[0].localeCompare(c[0]))));
      expect([...shown.values()].reduce((a, c) => a + c, 0)).toBe(n);
      expect(doc.querySelector("main .lead")!.textContent).toMatch(
        new RegExp(`^${shopCount(n)} listed in ${metroName(b, hub.metro!)}, in ${cities.size} cit(y|ies)\\.( Last checked [A-Z][a-z]{2} \\d{1,2}, \\d{4}\\.)?$`),
      );
    }
  });

  it("has only data-built text and breadcrumb structured data", () => {
    const b = built.get(site)!;
    for (const hub of b.plan.filter((p) => p.type === "metroHub")) {
      const doc = docFor(b, hub.path);
      const allowed = new Set<string>([b.data.site.name, `Shops in ${metroName(b, hub.metro!)}`, "Cities covered", doc.querySelector("main .lead")!.textContent!]);
      for (const a of doc.querySelectorAll("main .hub-links a")) allowed.add((a as any).textContent);
      for (const l of b.data.listings) allowed.add(l.city);
      for (let i = 1; i <= hub.listingIds!.length; i++) allowed.add(shopCount(i));
      for (const t of mainTexts(doc)) expect(allowed.has(t), `unexpected text on ${site}${hub.path}: "${t}"`).toBe(true);
      const ld = [...doc.querySelectorAll('script[type="application/ld+json"]')].map((s: any) => JSON.parse(s.textContent));
      expect(ld.map((d) => d["@type"])).toEqual(["BreadcrumbList"]);
      expect(ld[0].itemListElement.map((x: any) => x.name)).toEqual([b.data.site.name, `Shops in ${metroName(b, hub.metro!)}`]);
    }
  });
});

describe("home and hub views", () => {
  it("counts a site's listing in its metro even when no list page includes it", () => {
    // In the fixture, a UV DTF-only shop in Buffalo is on the dtf site, which builds only /dtf/ lists.
    const b = built.get("dtf")!;
    const view = buildHomeView({ site: b.data.site, listings: b.data.listings, vocabulary: b.data.vocabulary, plan: b.plan, titleOf: (p) => p.path });
    const buffalo = view.metros.find((m) => m.slug === "buffalo")!;
    const list = b.plan.find((p) => p.path === "/dtf/buffalo/")!;
    expect(buffalo.count).toBeGreaterThan(list.listingIds!.length);
    expect(buffalo.lists).toEqual([{ href: "/dtf/buffalo/", text: "/dtf/buffalo/", count: list.listingIds!.length, countText: shopCount(list.listingIds!.length) }]);
  });

  it("says no shops are listed when the site has none, and shows no metros", () => {
    const b = built.get("dtf")!;
    const plan = planPages(b.data.site, { ...b.data, listings: [] });
    const view = buildHomeView({ site: b.data.site, listings: [], vocabulary: b.data.vocabulary, plan, titleOf: (p) => p.path });
    expect(view).toEqual({ lead: ["No shops are listed yet."], metros: [] });
  });

  it("builds a hub view whose counts sum to the hub's plan count", () => {
    const b = built.get("tampa-makers")!;
    const hub = b.plan.find((p) => p.type === "metroHub")!;
    const view = buildMetroHubView({ site: b.data.site, page: hub, listings: b.data.listings, vocabulary: b.data.vocabulary, plan: b.plan, titleOf: (p) => p.path, canonical: (p) => `https://x.test${p}` });
    expect(view.cities.reduce((a, c) => a + c.count, 0)).toBe(hub.listingIds!.length);
    expect(view.breadcrumbs).toEqual([{ name: "/", path: "/" }, { name: hub.path, path: hub.path }]);
  });

  it("joins names as plain English and counts shops with the right plural", () => {
    expect(joinNames([])).toBe("");
    expect(joinNames(["Tampa Bay"])).toBe("Tampa Bay");
    expect(joinNames(["Buffalo", "Tampa Bay"])).toBe("Buffalo and Tampa Bay");
    expect(joinNames(["A", "B", "C"])).toBe("A, B and C");
    expect(shopCount(1)).toBe("1 shop");
    expect(shopCount(0)).toBe("0 shops");
  });
});
