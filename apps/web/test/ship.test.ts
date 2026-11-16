// T9: ship-to-you pages and the disclosure line, on built HTML from fixture variants.
//  - no approved supplier with checked notes: no ship-to-you page; with one: built, listing only the
//    suppliers this site placed on ship-to-you
//  - each supplier row shows its cutoff and price notes with "Checked {date}"
//  - the disclosure line is on every built page with a /go/ link and on no other page

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { planPages } from "@directory-engine/core";
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
  for (const s of SITES.filter((s) => s !== "dtf")) await build(`demo-${s}`, s, shipVariant(demo, s, []));
}, 600_000);

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

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
