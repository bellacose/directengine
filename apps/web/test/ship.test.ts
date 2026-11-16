// T9: ship-to-you pages and the disclosure line, on built HTML from fixture variants.
//  - no approved supplier with checked notes: no ship-to-you page; with one: built, listing only the
//    suppliers this site placed on ship-to-you
//  - each supplier row shows its cutoff and price notes with "Checked {date}"
//  - the disclosure line is on every built page with a /go/ link and on no other page
//  - T18: a program placed on ship-to-you for some metros only appears on those metros' ship pages
//    and on no other page; plain placements still apply everywhere

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { planPages, placementRules, type SiteConfig } from "@directory-engine/core";
import { hasGoLink } from "../src/lib/affiliate.ts";
import { formatDate } from "../src/lib/fact-format.ts";
import { DISCLOSURE_LINE } from "../src/lib/info.ts";
import { loadSite, type Fixture, type SiteData } from "../src/lib/load.ts";
import { buildShipView, NOT_CHECKED } from "../src/lib/ship.ts";
import { root, shipVariant } from "./helpers.ts";

const web = join(root, "apps", "web");
const demo = JSON.parse(readFileSync(join(root, "fixtures", "demo.json"), "utf8")) as Fixture;
const SITES = readdirSync(join(root, "sites")).filter((f) => f.endsWith(".json") && f !== "guides.json").map((f) => f.replace(/\.json$/, "")).sort();

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]));
const htmlPages = (out: string) =>
  files(out)
    .filter((f) => f.endsWith(".html"))
    .map((f) => ({ path: "/" + relative(out, f).split(sep).join("/").replace(/index\.html$/, ""), html: readFileSync(f, "utf8") }));
const decode = (s: string) => s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
/** The rendered disclosure element (the disclosure page also quotes the line in its own text). */
const disclosureEl = (html: string) => html.match(/<p class="disclosure"[^>]*data-disclosure[^>]*>([^<]*)<\/p>/);

const tmp = mkdtempSync(join(tmpdir(), "ship-"));
interface Build { out: string; data: SiteData }
const builds = new Map<string, Build>();

async function build(name: string, site: string, fx: Fixture): Promise<void> {
  const fixture = join(tmp, `${name}.json`);
  writeFileSync(fixture, JSON.stringify(fx));
  const out = join(tmp, `out-${name}`);
  execFileSync("npm", ["run", "build", "--", "--site", site, "--fixture", fixture, "--outDir", out], {
    cwd: web, shell: true, stdio: "pipe", env: { ...process.env, SITE: "", DATA_FIXTURE: "", SUPABASE_URL: "" },
  });
  builds.set(name, { out, data: await loadSite({ root, env: { SITE: site, DATA_FIXTURE: fixture } }) });
}

beforeAll(async () => {
  await build("none", "dtf", demo);
  await build("one", "dtf", shipVariant(demo, "dtf", ["transfer-express"]));
  await build("two", "dtf", shipVariant(demo, "dtf", ["transfer-express", "dtfsheet"]));
  const { program } = metroLimited();
  await build("limited", "dtf", shipVariant(demo, "dtf", ["transfer-express", program]));
  await build("limited-only", "dtf", shipVariant(demo, "dtf", [program]));
  for (const s of SITES.filter((s) => s !== "dtf")) await build(`demo-${s}`, s, shipVariant(demo, s, []));
}, 600_000);

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** The program sites/dtf.json places on ship-to-you for some metros only, and those metros. */
function metroLimited(): { program: string; metros: string[] } {
  const site = JSON.parse(readFileSync(join(root, "sites", "dtf.json"), "utf8")) as SiteConfig;
  for (const program of Object.keys(site.affiliates)) {
    const rules = placementRules(site, program).filter((r) => r.placement === "ship-to-you");
    if (rules.length && rules.every((r) => r.metros && !r.capabilities)) return { program, metros: rules.flatMap((r) => r.metros!) };
  }
  throw new Error("sites/dtf.json has no metro-limited ship-to-you placement to test");
}

const shipPages = (b: Build) => htmlPages(b.out).filter((p) => p.path.startsWith("/ship/"));
const suppliersOn = (html: string) => [...html.matchAll(/data-supplier="([^"]+)"/g)].map((m) => m[1]);

describe("ship-to-you pages", () => {
  it("are not built when no approved supplier has checked notes", () => {
    const none = builds.get("none")!;
    expect(shipPages(none)).toEqual([]);
    expect(planPages(none.data.site, none.data).some((p) => p.type === "shipToYou")).toBe(false);
  });

  it("are built with one approved supplier, listing only suppliers placed on ship-to-you", () => {
    const pages = shipPages(builds.get("one")!);
    expect(pages.map((p) => p.path).sort()).toEqual(["/ship/dtf-to-buffalo/", "/ship/dtf-to-tampa-bay/"]);
    for (const p of pages) {
      // heat-press-nation (guides only), dtfsheet (no notes) and eazydtf (applied) stay off.
      expect(suppliersOn(p.html), p.path).toEqual(["transfer-express"]);
      expect(p.html).not.toMatch(/heat-press-nation|Heat Press Nation|DTFSheet|EazyDTF/);
    }
    for (const p of shipPages(builds.get("two")!)) expect(suppliersOn(p.html), p.path).toEqual(["dtfsheet", "transfer-express"]);
  });

  it("shows each supplier's cutoff and price notes with the date they were checked", () => {
    const { data } = builds.get("two")!;
    const pages = shipPages(builds.get("two")!);
    expect(pages.length).toBeGreaterThan(0);
    for (const p of pages) {
      const text = decode(p.html);
      for (const slug of ["transfer-express", "dtfsheet"]) {
        const a = data.affiliates.find((x) => x.slug === slug)!;
        const row = text.match(new RegExp(`data-supplier="${slug}"[\\s\\S]*?</li>`))![0];
        expect(row).toContain(`href="/go/${slug}/"`);
        expect(row).toContain('rel="sponsored nofollow"');
        expect(row).toContain(a.cutoffNote!);
        expect(row).toContain(a.priceNote!);
        expect(row).toContain(`Checked ${formatDate(a.factsCheckedAt!)}`);
      }
      // The stored network link never reaches the page.
      expect(p.html).not.toContain("example.com/aff/");
    }
  });

  it("links back to the list page for the same capability and metro", () => {
    const tampa = shipPages(builds.get("one")!).find((p) => p.path === "/ship/dtf-to-tampa-bay/")!;
    expect(tampa.html).toContain('href="/dtf/tampa-bay/"');
  });
});

describe("metro-limited placements", () => {
  const { program, metros } = metroLimited();
  const mentions = (html: string) => html.includes(`/go/${program}/`) || html.includes(`data-supplier="${program}"`);

  it("show the program on its metros' ship-to-you pages and on no other page", () => {
    const b = builds.get("limited")!;
    const pages = htmlPages(b.out);
    const want = metros.map((m) => `/ship/dtf-to-${m}/`).sort();
    // No link or supplier row anywhere else. (The disclosure page still names every approved
    // program: it discloses the relationship and links to none of them.)
    expect(pages.filter((p) => mentions(p.html)).map((p) => p.path).sort()).toEqual(want);
    for (const path of want) expect(suppliersOn(pages.find((p) => p.path === path)!.html)).toEqual([program, "transfer-express"].sort());
    // The plain placement still applies on every ship-to-you page, including the other metros'.
    const others = shipPages(b).filter((p) => !want.includes(p.path));
    expect(others.length).toBeGreaterThan(0);
    for (const p of others) expect(suppliersOn(p.html), p.path).toEqual(["transfer-express"]);
  });

  it("build no ship-to-you page for a metro where no supplier is placed", () => {
    const b = builds.get("limited-only")!;
    expect(shipPages(b).map((p) => p.path).sort()).toEqual(metros.map((m) => `/ship/dtf-to-${m}/`).sort());
    expect(planPages(b.data.site, b.data).filter((p) => p.type === "shipToYou").map((p) => p.metro).sort()).toEqual([...metros].sort());
  });
});

describe("disclosure line", () => {
  it("is on every built page with a /go/ link and on no page without one", () => {
    let withGo = 0;
    let without = 0;
    for (const [name, b] of builds) {
      for (const p of htmlPages(b.out)) {
        const el = disclosureEl(p.html);
        if (hasGoLink(p.html)) {
          withGo++;
          expect(el, `${name} ${p.path}`).not.toBeNull();
          expect(decode(el![1])).toBe(DISCLOSURE_LINE);
          // At the top: before the page's heading.
          expect(p.html.indexOf("data-disclosure"), `${name} ${p.path}`).toBeLessThan(p.html.indexOf("<h1"));
        } else {
          without++;
          expect(el, `${name} ${p.path}`).toBeNull();
        }
      }
    }
    expect(withGo).toBeGreaterThan(0);
    expect(without).toBeGreaterThan(0);
  });
});

describe("hasGoLink", () => {
  it("finds /go/ links only in href", () => {
    expect(hasGoLink('<a href="/go/transfer-express/" rel="sponsored nofollow">x</a>')).toBe(true);
    expect(hasGoLink('<a class="x" href=/go/x/>x</a>')).toBe(true);
    expect(hasGoLink("<p>Every affiliate link starts with <code>/go/</code></p>")).toBe(false);
    expect(hasGoLink('<a href="/guides/go/">x</a>')).toBe(false);
  });
});

describe("buildShipView", () => {
  it("shows Not checked yet for a missing note and refuses notes without a date", async () => {
    const data = await loadSite({ root, env: { SITE: "dtf", DATA_FIXTURE: join(tmp, "one.json") } });
    const page = planPages(data.site, data).find((p) => p.type === "shipToYou")!;
    const args = { site: data.site, page, plan: [], capabilityName: (s: string) => s, metroName: (s: string) => s, titleOf: () => "" };
    const view = buildShipView({ ...args, affiliates: data.affiliates.map((a) => (a.slug === "transfer-express" ? { ...a, priceNote: null } : a)) });
    expect(view.rows).toHaveLength(1);
    expect(view.rows[0].price).toBe(NOT_CHECKED);
    expect(view.list).toBeNull();
    expect(view.lead).toContain("1 supplier that ships");
    const undated = data.affiliates.map((a) => (a.slug === "transfer-express" ? { ...a, factsCheckedAt: null } : a));
    expect(() => buildShipView({ ...args, affiliates: undated })).toThrow(/check date/);
  });
});
