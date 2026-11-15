// Shop pages (T5): each site shows only its angle's facts, grouped, with a check line each and "Not
// checked yet" for the rest; a shop below minFacts gets no page and no link; structured data is
// LocalBusiness without ratings, with opening hours only when hours are verified.

import { planPages, type Page, type SiteConfig } from "@directory-engine/core";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadFromFixture, loadSite, type Fixture, type SiteData, type WebListing } from "../src/lib/load.ts";
import {
  NOT_CHECKED, checkLine, formatDate, formatTime, hoursRows, jsonLdText, localBusinessJsonLd,
  openingHoursSpecification, shopFactGroups,
} from "../src/lib/shop.ts";
import { root } from "./helpers.ts";

const SITES = readdirSync(join(root, "sites")).filter((f) => f.endsWith(".json") && f !== "guides.json").map((f) => f.replace(/\.json$/, "")).sort();
const web = join(root, "apps", "web");
const TODAY = "2026-11-15";
const fixture = (): Fixture => JSON.parse(readFileSync(join(root, "fixtures", "demo.json"), "utf8"));
const siteConfig = (slug: string): SiteConfig => JSON.parse(readFileSync(join(root, "sites", `${slug}.json`), "utf8"));
const guides = Object.keys(JSON.parse(readFileSync(join(root, "sites", "guides.json"), "utf8")))
  .map((slug) => ({ slug, approved: false, approvedAt: null }));
const load = (slug: string, fx = fixture(), site = siteConfig(slug)) => loadFromFixture(site, fx, guides, { today: TODAY });
const shop = (d: SiteData, slug: string) => d.listings.find((l) => l.slug === slug)!;

/** Fact keys in a site's angle, from the vocabulary. */
const angleKeys = (d: SiteData) =>
  d.vocabulary.factDefs.filter((f) => d.site.angle.factGroups.includes(f.group) || d.site.angle.facts.includes(f.key)).map((f) => f.key).sort();

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]));

describe("formatting", () => {
  it("formats times, dates and check lines", () => {
    expect(formatTime("14:00")).toBe("2:00 PM");
    expect(formatTime("00:30")).toBe("12:30 AM");
    expect(formatTime("12:00")).toBe("12:00 PM");
    expect(formatDate("2026-11-20")).toBe("Nov 20, 2026");
    expect(checkLine({ checkedAt: "2026-11-20", method: "phone_call", stale: false })).toBe("Checked Nov 20, 2026 by phone.");
    expect(checkLine({ checkedAt: "2026-04-01", method: "website", stale: true })).toBe("Checked Apr 1, 2026 on the shop's website. May be out of date.");
  });

  it("shows hours per day: times, Closed for a closed day, Not checked yet for a missing day", () => {
    const rows = hoursRows({ mon: { open: "09:00", close: "17:30" }, sun: null });
    expect(rows[0]).toEqual({ day: "Monday", text: "9:00 AM to 5:30 PM" });
    expect(rows[1]).toEqual({ day: "Tuesday", text: NOT_CHECKED });
    expect(rows[6]).toEqual({ day: "Sunday", text: "Closed" });
  });

  it("keeps inlined JSON-LD from closing its script tag", () => {
    expect(jsonLdText({ name: "</script><b>" })).not.toContain("<");
    expect(JSON.parse(jsonLdText({ name: "</script>" }))).toEqual({ name: "</script>" });
  });
});

describe("shopFactGroups", () => {
  it("lists every angle fact exactly once and nothing outside the angle", () => {
    for (const slug of SITES) {
      const d = load(slug);
      for (const l of d.listings) {
        const keys = shopFactGroups(d.site, d.vocabulary, l).flatMap((g) => g.rows.map((r) => r.key)).sort();
        expect(keys, `${slug} ${l.slug}`).toEqual(angleKeys(d));
      }
    }
  });

  it("shows verified facts with their check and the rest as Not checked yet", () => {
    const d = load("dtf");
    const rows = shopFactGroups(d.site, d.vocabulary, shop(d, "example-dtf-tampa")).flatMap((g) => g.rows);
    const row = (k: string) => rows.find((r) => r.key === k)!;
    expect(row("dtf_same_day_cutoff")).toMatchObject({ text: "2:00 PM", check: "Checked Nov 10, 2026 by phone." });
    expect(row("pickup_walk_in")).toMatchObject({ text: "Yes" });
    // typed in without a check: never shown
    expect(row("dtf_price_per_foot_usd")).toMatchObject({ fact: null, text: NOT_CHECKED, check: null });
    expect(row("ships")).toMatchObject({ fact: null, text: NOT_CHECKED });
  });

  it("flags a stale fact", () => {
    const d = load("dtf");
    const hours = shopFactGroups(d.site, d.vocabulary, shop(d, "example-dtf-buffalo")).flatMap((g) => g.rows).find((r) => r.key === "hours")!;
    expect(hours.check).toBe("Checked Apr 1, 2026 on the shop's website. May be out of date.");
  });

  it("puts the group of the site's headline fact first", () => {
    const dtf = load("dtf");
    const laser = load("laser");
    expect(shopFactGroups(dtf.site, dtf.vocabulary, shop(dtf, "example-makers-st-pete"))[0].group).toBe("dtf");
    expect(shopFactGroups(laser.site, laser.vocabulary, shop(laser, "example-makers-st-pete"))[0].group).toBe("laser");
  });
});

describe("LocalBusiness structured data", () => {
  const url = "https://x.invalid/shop/s/";

  it("has name, address, telephone and url, and opening hours from verified hours", () => {
    const d = load("dtf");
    const l = shop(d, "example-makers-st-pete");
    const ld = localBusinessJsonLd(d.site, d.vocabulary, l, url);
    expect(ld).toMatchObject({
      "@context": "https://schema.org", "@type": "LocalBusiness", name: l.name, telephone: l.phone, url: l.website,
      address: { "@type": "PostalAddress", streetAddress: l.address1, addressLocality: l.city, addressRegion: l.state, postalCode: l.zip },
    });
    expect(ld.openingHoursSpecification).toEqual([
      { "@type": "OpeningHoursSpecification", dayOfWeek: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"], opens: "10:00", closes: "18:00" },
      { "@type": "OpeningHoursSpecification", dayOfWeek: ["Saturday"], opens: "10:00", closes: "14:00" },
    ]);
  });

  it("leaves out opening hours when hours are not verified", () => {
    const fx = fixture();
    const raw = fx.listings.find((l) => l.slug === "example-makers-st-pete")!;
    for (const f of raw.facts) if (f.key === "hours") Object.assign(f, { checkedAt: null, method: null });
    const d = load("dtf", fx);
    expect(localBusinessJsonLd(d.site, d.vocabulary, shop(d, "example-makers-st-pete"), url)).not.toHaveProperty("openingHoursSpecification");
    // and when the shop has no hours at all
    expect(localBusinessJsonLd(d.site, d.vocabulary, shop(d, "example-print-lab-brandon"), url)).not.toHaveProperty("openingHoursSpecification");
  });

  it("leaves out opening hours when the site's angle doesn't include hours", () => {
    const fx = fixture();
    const site = { ...siteConfig("dtf"), angle: { ...siteConfig("dtf").angle, facts: ["ships"] } };
    const d = load("dtf", fx, site);
    expect(localBusinessJsonLd(d.site, d.vocabulary, shop(d, "example-makers-st-pete"), url)).not.toHaveProperty("openingHoursSpecification");
  });

  it("skips closed and unchecked days", () => {
    expect(openingHoursSpecification({ mon: { open: "09:00", close: "17:00" }, sat: null })).toEqual([
      { "@type": "OpeningHoursSpecification", dayOfWeek: ["Monday"], opens: "09:00", closes: "17:00" },
    ]);
    expect(openingHoursSpecification({ sun: null })).toEqual([]);
  });
});

// ------------------------------------------------------------------ built HTML

interface Built { out: string; data: SiteData; plan: Page[] }
const built = new Map<string, Built>();

beforeAll(async () => {
  for (const site of SITES) {
    const out = mkdtempSync(join(tmpdir(), `astro-shop-${site}-`));
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

const html = (site: string, path: string) => readFileSync(join(built.get(site)!.out, path.slice(1), "index.html"), "utf8");
const renderedFacts = (page: string) => [...page.matchAll(/data-fact="([^"]+)"/g)].map((m) => m[1]).sort();
const shownFacts = (page: string) => [...page.matchAll(/data-fact="([^"]+)"(?! class="unknown")/g)].map((m) => m[1]).sort();
const jsonLd = (page: string) => [...page.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
const shopPages = (site: string) => built.get(site)!.plan.filter((p) => p.type === "shop");
const listingOf = (site: string, p: Page): WebListing => built.get(site)!.data.listings.find((l) => l.id === p.listingIds![0])!;

describe("shop pages in the built sites", () => {
  it("renders a shop that does DTF and laser differently on dtf and laser, each within its angle", () => {
    for (const slug of ["example-makers-st-pete", "example-makers-hamburg"]) {
      const path = `/shop/${slug}/`;
      const dtf = html("dtf", path);
      const laser = html("laser", path);
      expect(renderedFacts(dtf)).toEqual(angleKeys(built.get("dtf")!.data));
      expect(renderedFacts(laser)).toEqual(angleKeys(built.get("laser")!.data));
      expect(shownFacts(dtf)).not.toEqual(shownFacts(laser));
      expect(shownFacts(dtf)).toContain("dtf_same_day_cutoff");
      expect(shownFacts(dtf).some((k) => k.startsWith("laser_"))).toBe(false);
      expect(shownFacts(laser).some((k) => k.startsWith("dtf_"))).toBe(false);
      expect(dtf).not.toContain("Laser types");
      expect(laser).not.toContain("Same-day DTF order cutoff");
    }
  });

  it("gives a shop below minFacts no page on that site, and lists it there without a link", () => {
    const slug = "example-laser-and-print-largo";
    expect(shopPages("dtf").map((p) => p.path)).toContain(`/shop/${slug}/`);
    expect(shopPages("laser").map((p) => p.path)).not.toContain(`/shop/${slug}/`);
    expect(() => html("laser", `/shop/${slug}/`)).toThrow();
    const list = html("laser", "/laser/tampa-bay/");
    expect(list).toContain("Example Laser and Print Largo");
    expect(list).not.toContain(`/shop/${slug}/`);
    // below minFacts everywhere: no page on any site, no link anywhere
    for (const site of SITES) {
      const b = built.get(site)!;
      expect(existsHtml(b.out, "/shop/example-transfer-house-clearwater/")).toBe(false);
      for (const f of files(b.out).filter((f) => f.endsWith(".html"))) {
        expect(readFileSync(f, "utf8"), f).not.toContain("/shop/example-transfer-house-clearwater/");
      }
    }
  });

  it("has no ratings or reviews in any built page of any site", () => {
    const hasKey = (v: unknown, keys: string[]): boolean =>
      Array.isArray(v) ? v.some((x) => hasKey(x, keys)) :
      v !== null && typeof v === "object" ? Object.entries(v).some(([k, x]) => keys.includes(k) || hasKey(x, keys)) : false;
    for (const site of SITES) {
      for (const f of files(built.get(site)!.out).filter((f) => f.endsWith(".html"))) {
        const page = readFileSync(f, "utf8");
        expect(page, f).not.toMatch(/aggregateRating|"review"|itemprop="review|ratingValue|reviewRating/i);
        for (const ld of jsonLd(page)) expect(hasKey(ld, ["aggregateRating", "review", "reviews", "ratingValue"]), f).toBe(false);
      }
    }
  });

  it("puts one LocalBusiness on each shop page, with opening hours exactly when hours are verified", () => {
    let withHours = 0;
    let without = 0;
    for (const site of SITES) {
      const d = built.get(site)!.data;
      const hoursInAngle = angleKeys(d).includes("hours");
      for (const p of shopPages(site)) {
        const l = listingOf(site, p);
        const ld = jsonLd(html(site, p.path));
        expect(ld, `${site} ${p.path}`).toHaveLength(1);
        expect(ld[0]["@type"]).toBe("LocalBusiness");
        expect(ld[0].name).toBe(l.name);
        expect(ld[0].address.addressLocality).toBe(l.city);
        const verified = hoursInAngle && l.facts.some((f) => f.key === "hours");
        expect("openingHoursSpecification" in ld[0], `${site} ${p.path}`).toBe(verified);
        verified ? withHours++ : without++;
      }
    }
    expect(withHours).toBeGreaterThan(0);
    expect(without).toBeGreaterThan(0);
  });

  it("shows check lines, the stale flag, Not checked yet, and the report and claim links", () => {
    const page = html("dtf", "/shop/example-dtf-buffalo/");
    expect(page).toContain("Checked Nov 10, 2026 by phone.");
    expect(page).toContain("May be out of date.");
    expect(page).toContain(NOT_CHECKED);
    // The report form and claim link (T11; their fields are tested in forms.test.ts).
    expect(page).toMatch(/<form method="post" action="\/report-change\/"[^>]*>[\s\S]*>Report a change<\/label>/);
    expect(page).toMatch(/<a href="\/add-your-shop\/\?shop=00000000-0000-4000-8000-000000000009"[^>]*>Is this your shop\?<\/a>/);
    expect(page).toContain('href="tel:7165550109"');
  });

  it("never shows a value typed in without a check", () => {
    const page = html("dtf", "/shop/example-dtf-tampa/");
    expect(page).toMatch(/data-fact="dtf_price_per_foot_usd" class="unknown"/);
  });
});

function existsHtml(out: string, path: string): boolean {
  try {
    statSync(join(out, path.slice(1), "index.html"));
    return true;
  } catch {
    return false;
  }
}
