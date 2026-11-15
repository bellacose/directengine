// Capability x metro list pages (T4): built HTML for every site from the fixture, checked against
// the plan (order, index gate, sitemap), the structured data, and the client-side filters with
// JavaScript on (happy-dom) and off (plain HTML). Plus unit tests of buildListView and the formatters.

import { hasDetailPage, orderForList, planPages, siteListings, type Page } from "@directory-engine/core";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Window } from "happy-dom";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { formatHours, formatTime, formatValue, checkLine } from "../src/lib/fact-format.ts";
import { buildListView, jsonLdText } from "../src/lib/list.ts";
import { loadSite, type SiteData } from "../src/lib/load.ts";
import { root } from "./helpers.ts";

const SITES = readdirSync(join(root, "sites")).filter((f) => f.endsWith(".json") && f !== "guides.json").map((f) => f.replace(/\.json$/, "")).sort();
const web = join(root, "apps", "web");

interface Built { out: string; data: SiteData; plan: Page[]; host: string }
const built = new Map<string, Built>();

beforeAll(async () => {
  for (const site of SITES) {
    const out = mkdtempSync(join(tmpdir(), `astro-list-${site}-`));
    execFileSync("npm", ["run", "build", "--", "--site", site, "--fixture", "--outDir", out], {
      cwd: web, shell: true, stdio: "pipe", env: { ...process.env, SITE: "", DATA_FIXTURE: "" },
    });
    const data = await loadSite({ root, env: { SITE: site, DATA_FIXTURE: "fixtures/demo.json" } });
    built.set(site, { out, data, plan: planPages(data.site, data), host: data.site.domain ?? `${site}.preview.invalid` });
  }
}, 600_000);

afterAll(() => {
  for (const b of built.values()) rmSync(b.out, { recursive: true, force: true });
});

const htmlFor = (b: Built, path: string) => readFileSync(join(b.out, path.slice(1), "index.html"), "utf8");
const cardSlugs = (html: string) => [...html.matchAll(/<li class="card"[^>]*data-slug="([^"]+)"/g)].map((m) => m[1]);
const jsonLd = (html: string) =>
  [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]) as Record<string, any>);
const listPages = (b: Built) => b.plan.filter((p) => p.type === "capabilityMetro");

describe.each(SITES)("list pages of %s", (site) => {
  it("has at least one list page in the fixture", () => {
    expect(listPages(built.get(site)!).length).toBeGreaterThan(0);
  });

  it("renders cards in orderForList() order, with every listing of the capability and metro", () => {
    const b = built.get(site)!;
    for (const p of listPages(b)) {
      const expected = orderForList(b.data.site, siteListings(b.data.site, b.data.listings)
        .filter((l) => l.metros.includes(p.metro!) && l.capabilities.includes(p.capability!)));
      expect(cardSlugs(htmlFor(b, p.path)), p.path).toEqual(expected.map((l) => l.slug));
    }
  });

  it("links a card's name to the shop page exactly when hasDetailPage() is true", () => {
    const b = built.get(site)!;
    for (const p of listPages(b)) {
      const html = htmlFor(b, p.path);
      for (const id of p.listingIds!) {
        const l = b.data.listings.find((x) => x.id === id)!;
        const card = html.match(new RegExp(`<li class="card"[^>]*data-slug="${l.slug}"[\\s\\S]*?</li>\\s*(?=<li class="card"|</ol>)`))![0];
        expect(card.includes(`href="/shop/${l.slug}/"`), `${p.path} ${l.slug}`).toBe(hasDetailPage(b.data.site, l));
      }
    }
  });

  it("marks pages below the index gate noindex,follow and leaves them out of the sitemap", () => {
    const b = built.get(site)!;
    const sitemap = readFileSync(join(b.out, "sitemap.xml"), "utf8");
    for (const p of listPages(b)) {
      const atGate = p.listingIds!.length >= b.data.site.indexGate;
      const html = htmlFor(b, p.path);
      expect(html.includes('<meta name="robots" content="noindex,follow">'), p.path).toBe(!atGate);
      expect(sitemap.includes(`<loc>https://${b.host}${p.path}</loc>`), p.path).toBe(atGate);
    }
  });

  it("has ItemList and BreadcrumbList structured data matching the cards, and no ratings", () => {
    const b = built.get(site)!;
    for (const p of listPages(b)) {
      const html = htmlFor(b, p.path);
      const ld = jsonLd(html);
      const list = ld.find((d) => d["@type"] === "ItemList")!;
      const crumbs = ld.find((d) => d["@type"] === "BreadcrumbList")!;
      const names = p.listingIds!.map((id) => b.data.listings.find((l) => l.id === id)!.name);
      expect(list.itemListElement.map((e: any) => e.name)).toEqual(names);
      expect(list.itemListElement.map((e: any) => e.position)).toEqual(names.map((_, i) => i + 1));
      expect(list.numberOfItems).toBe(names.length);
      expect(crumbs.itemListElement.at(-1).item).toBe(`https://${b.host}${p.path}`);
      expect(html).not.toMatch(/aggregateRating|"review"/);
    }
  });

  it("shows the full list with JavaScript off: filters hidden, no card hidden", () => {
    const b = built.get(site)!;
    for (const p of listPages(b)) {
      const html = htmlFor(b, p.path);
      expect(html, p.path).not.toMatch(/<li class="card"[^>]*\shidden/);
      const form = html.match(/<form id="list-filters"[^>]*>/)?.[0];
      if (form) expect(form).toMatch(/\shidden[\s>]/);
    }
  });
});

describe("dtf list pages from the fixture", () => {
  it("indexes /dtf/tampa-bay/ (5, at the gate) and not /dtf/buffalo/ (3)", () => {
    const b = built.get("dtf")!;
    const sitemap = readFileSync(join(b.out, "sitemap.xml"), "utf8");
    expect(htmlFor(b, "/dtf/tampa-bay/")).not.toContain('name="robots"');
    expect(sitemap).toContain("/dtf/tampa-bay/</loc>");
    expect(htmlFor(b, "/dtf/buffalo/")).toContain('<meta name="robots" content="noindex,follow">');
    expect(sitemap).not.toContain("/dtf/buffalo/</loc>");
  });

  it("writes a data-built lead", () => {
    const html = htmlFor(built.get("dtf")!, "/dtf/tampa-bay/");
    expect(html).toContain("5 shops in Tampa Bay offer DTF transfers. Same-day DTF order cutoff: confirmed for 5 of 5. Last checked Nov 10, 2026.");
  });

  it("never shows a value typed in without a check", () => {
    const html = htmlFor(built.get("dtf")!, "/dtf/tampa-bay/");
    expect(html).not.toContain("DTF price per linear foot");
  });

  it("shows a stale fact with its flag", () => {
    const html = htmlFor(built.get("dtf")!, "/dtf/buffalo/");
    expect(html).toContain("(may be out of date)");
  });
});

/** Loads built HTML into happy-dom and runs the page's inline filter script. */
function withScript(html: string) {
  const window = new Window({ url: "https://test.invalid/" });
  const document = window.document;
  document.write(html.replace(/<script[\s\S]*?<\/script>/g, ""));
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  if (!script) throw new Error("no inline filter script");
  new Function("document", "setTimeout", script)(document, (fn: () => void) => fn());
  const cards = () => [...document.querySelectorAll("[data-card]")];
  const visible = () => cards().filter((c) => !(c as any).hidden).map((c) => c.getAttribute("data-slug"));
  const change = (el: any) => el.form.dispatchEvent(new window.Event("change", { bubbles: true }));
  return { window, document, cards, visible, change };
}

describe("filters with JavaScript on", () => {
  it("show the form, filter by city and by boolean fact, and reset", () => {
    const html = htmlFor(built.get("dtf")!, "/dtf/tampa-bay/");
    const { document, visible, change } = withScript(html);
    const form = document.getElementById("list-filters") as any;
    const count = document.getElementById("list-count")!;
    expect(form.hidden).toBe(false);
    expect(visible()).toEqual(cardSlugs(html));
    expect(count.textContent).toBe("");

    const city = form.querySelector('select[name="city"]') as any;
    city.value = "Tampa";
    change(city);
    expect(visible()).toEqual(["example-dtf-tampa"]);
    expect(count.textContent).toBe("Showing 1 of 5 shops.");

    city.value = "";
    const walkIn = form.querySelector('input[value="pickup_walk_in"]') as any;
    walkIn.checked = true;
    change(walkIn);
    const data = built.get("dtf")!.data;
    const withWalkIn = cardSlugs(html).filter((s) =>
      data.listings.find((l) => l.slug === s)!.facts.some((f) => f.key === "pickup_walk_in" && f.value === true));
    expect(withWalkIn.length).toBeGreaterThan(0);
    expect(withWalkIn.length).toBeLessThan(5);
    expect(visible()).toEqual(withWalkIn);

    city.value = "Brandon"; // Brandon's shop has no verified walk-in pickup
    change(city);
    expect(visible()).toEqual([]);
    expect(count.textContent).toBe("No shops here match these filters.");

    city.value = "";
    walkIn.checked = false;
    change(walkIn);
    expect(visible()).toEqual(cardSlugs(html));
  });

  it("never change the URL", () => {
    const { window, document, change } = withScript(htmlFor(built.get("dtf")!, "/dtf/tampa-bay/"));
    const city = document.querySelector('select[name="city"]') as any;
    city.value = "Tampa";
    change(city);
    expect(window.location.href).toBe("https://test.invalid/");
  });
});

describe("buildListView", () => {
  const view = async (site: string, path: string, extraPages: Page[] = []) => {
    const data = await loadSite({ root, today: "2026-11-15", env: { SITE: site, DATA_FIXTURE: "fixtures/demo.json" } });
    const plan = [...planPages(data.site, data), ...extraPages];
    const page = plan.find((p) => p.path === path)!;
    const byId = new Map(data.listings.map((l) => [l.id, l]));
    return buildListView({
      site: data.site, page, listings: page.listingIds!.map((id) => byId.get(id)!), vocabulary: data.vocabulary, plan,
      canonical: (p) => `https://x.invalid${p}`, titleOf: (p) => `title of ${p.path}`,
    });
  };

  it("adds the fallback link only when the plan has a ship-to-you page for the same capability and metro", async () => {
    expect((await view("dtf", "/dtf/tampa-bay/")).fallback).toBeNull();
    const ship: Page = { type: "shipToYou", path: "/ship/dtf-to-tampa-bay/", capability: "dtf", metro: "tampa-bay", indexable: true, lastmod: null };
    const other: Page = { ...ship, path: "/ship/dtf-to-buffalo/", metro: "buffalo" };
    expect((await view("dtf", "/dtf/tampa-bay/", [other])).fallback).toBeNull();
    expect((await view("dtf", "/dtf/tampa-bay/", [ship, other])).fallback).toEqual({ href: "/ship/dtf-to-tampa-bay/", text: "title of /ship/dtf-to-tampa-bay/" });
  });

  it("puts the metro hub in the breadcrumbs when the site builds one", async () => {
    expect((await view("dtf", "/dtf/tampa-bay/")).breadcrumbs.map((b) => b.path)).toEqual(["/", "/dtf/tampa-bay/"]);
    expect((await view("tampa-makers", "/dtf/tampa-bay/")).breadcrumbs.map((b) => b.path)).toEqual(["/", "/tampa-bay/", "/dtf/tampa-bay/"]);
  });

  it("leads each card with the headline fact and shows only angle facts", async () => {
    const v = await view("laser", "/laser/tampa-bay/");
    for (const c of v.cards) {
      const keys = c.facts.map((f) => f.key);
      if (keys.includes("laser_customer_items")) expect(keys[0]).toBe("laser_customer_items");
      expect(keys.filter((k) => k.startsWith("dtf_"))).toEqual([]);
    }
  });

  it("skips the headline sentence for a site without a headline fact", async () => {
    const v = await view("tampa-makers", "/dtf/tampa-bay/");
    expect(v.lead.join(" ")).not.toContain("confirmed");
    expect(v.lead[0]).toBe("5 shops in Tampa Bay offer DTF transfers.");
  });

  it("offers toggles only for boolean angle facts some shop here has verified true", async () => {
    const v = await view("dtf", "/dtf/tampa-bay/");
    expect(v.toggles.map((t) => t.key)).toEqual(["ships", "pickup_walk_in"]);
    expect(v.cities).toEqual(["Brandon", "Clearwater", "Largo", "St. Petersburg", "Tampa"]);
  });
});

describe("formatters", () => {
  it("format times, hours, values and check lines", () => {
    expect(formatTime("14:00")).toBe("2:00 PM");
    expect(formatTime("00:30")).toBe("12:30 AM");
    expect(formatTime("12:00")).toBe("12:00 PM");
    expect(formatHours({ mon: { open: "09:00", close: "17:00" }, tue: { open: "09:00", close: "17:00" }, sat: null }))
      .toBe("Mon–Tue 9:00 AM–5:00 PM, Sat closed");
    // A day missing from the value is unknown, not closed, and breaks a run.
    expect(formatHours({ mon: { open: "09:00", close: "17:00" }, wed: { open: "09:00", close: "17:00" } }))
      .toBe("Mon 9:00 AM–5:00 PM, Wed 9:00 AM–5:00 PM");
    expect(formatValue("boolean", true)).toBe("Yes");
    expect(formatValue("boolean", false)).toBe("No");
    expect(formatValue("number", 1234.5)).toBe("1,234.5");
    expect(checkLine({ checkedAt: "2026-11-20", method: "phone_call" })).toBe("Checked Nov 20, 2026 by phone");
  });

  it("escapes </script> in structured data", () => {
    expect(jsonLdText({ name: "</script><b>" })).not.toContain("</script>");
    expect(JSON.parse(jsonLdText({ name: "</script>" })).name).toBe("</script>");
  });
});
