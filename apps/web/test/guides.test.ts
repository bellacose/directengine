// T10 guides: the Markdown drafts in content/guides/, their affiliate links, and how they build.
// Unapproved guides build with noindex and stay out of the sitemap; equipment links become /go/ links
// with rel="sponsored nofollow" only for programs approved for the site's `guides` placement, and the
// disclosure line appears exactly when one does.

import type { SiteConfig } from "@directory-engine/core";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { goPrograms, guideHtml } from "../src/lib/guide.ts";
import { DISCLOSURE_LINE } from "../src/lib/info.ts";
import type { SiteAffiliate } from "../src/lib/load.ts";
import { root } from "./helpers.ts";

const web = join(root, "apps", "web");
const guidesJson = JSON.parse(readFileSync(join(root, "sites", "guides.json"), "utf8")) as Record<string, { title: string; approved: boolean }>;
const GUIDES = Object.keys(guidesJson).sort();
const SITES = readdirSync(join(root, "sites")).filter((f) => f.endsWith(".json") && f !== "guides.json").map((f) => f.replace(/\.json$/, "")).sort();
const siteConfig = (slug: string) => JSON.parse(readFileSync(join(root, "sites", `${slug}.json`), "utf8")) as SiteConfig;
const seed = readFileSync(join(root, "supabase", "seed.sql"), "utf8");
const programSlugs = [...seed.matchAll(/^\s*\('([a-z0-9-]+)',\s*'[^']*',\s*'https:/gm)].map((m) => m[1]);
/** Hosts of every affiliate program's own site: a guide must never link to these directly (rule 10). */
const programHosts = [...seed.matchAll(/'(https:\/\/[^']+)'/g)].map((m) => new URL(m[1]).hostname.replace(/^www\./, "").split(".").slice(-2).join("."));
const markdown = (slug: string) => readFileSync(join(root, "content", "guides", `${slug}.md`), "utf8").replace(/\r\n/g, "\n");

const DTF = siteConfig(SITES.find((s) => siteConfig(s).pages.guides.length && Object.values(siteConfig(s).affiliates).some((p) => p.includes("guides")))!);
const aff = (slug: string, status: string, url: string | null = "https://network.example/x"): SiteAffiliate =>
  ({ slug, name: slug, status, url, placements: DTF.affiliates[slug] ?? [] }) as unknown as SiteAffiliate;

describe("guideHtml", () => {
  const program = Object.keys(DTF.affiliates).find((p) => DTF.affiliates[p].includes("guides"))!;
  const other = Object.keys(DTF.affiliates).find((p) => !DTF.affiliates[p].includes("guides"))!;
  const html = `<p>Try <a href="/go/${program}/">this press</a> or <a href="https://maker.example/spec">the spec sheet</a>.</p>`;

  it("makes an approved program's link a sponsored /go/ link and counts it", () => {
    const out = guideHtml(html, DTF, [aff(program, "approved")], "g");
    expect(out.html).toBe(`<p>Try <a href="/go/${program}/" rel="sponsored nofollow">this press</a> or <a href="https://maker.example/spec">the spec sheet</a>.</p>`);
    expect(out.affiliateLinks).toBe(1);
  });

  it("leaves the text alone when the program isn't approved, has no link, or isn't placed in guides", () => {
    for (const a of [aff(program, "pending"), aff(program, "approved", null)]) {
      const out = guideHtml(html, DTF, [a], "g");
      expect(out.html).toBe(`<p>Try this press or <a href="https://maker.example/spec">the spec sheet</a>.</p>`);
      expect(out.affiliateLinks).toBe(0);
    }
    const notPlaced = guideHtml(`<a href="/go/${other}/">x</a>`, DTF, [aff(other, "approved")], "g");
    expect(notPlaced).toEqual({ html: "x", affiliateLinks: 0 });
  });

  it("refuses any other /go/ path", () => {
    expect(() => guideHtml(`<a href="/go/${program}/deep/link">x</a>`, DTF, [], "g")).toThrow(/must be \/go\/<program>\//);
    expect(() => guideHtml(`<a href="/go/${program}">x</a>`, DTF, [], "g")).toThrow(/must be \/go\/<program>\//);
  });
});

describe.each(GUIDES)("content/guides/%s.md", (slug) => {
  const exists = existsSync(join(root, "content", "guides", `${slug}.md`));

  it("exists for a guide in sites/guides.json, which keeps it unapproved until Chris reviews it", () => {
    expect(exists).toBe(true);
    expect(typeof guidesJson[slug].approved).toBe("boolean");
  });

  it("has no frontmatter, no H1 (the page supplies it) and no HTML", () => {
    const md = markdown(slug);
    expect(md.startsWith("---")).toBe(false);
    expect(md).not.toMatch(/^# /m);
    expect(md).not.toMatch(/<[a-z][^>]*>/i);
  });

  it("ends with a source list that holds every outside link in the text, all https", () => {
    const md = markdown(slug);
    const at = md.lastIndexOf("\n## Sources\n");
    expect(at, "missing ## Sources").toBeGreaterThan(0);
    const body = md.slice(0, at);
    const list = md.slice(at + "\n## Sources\n".length).trim().split("\n").filter((l) => l.trim());
    expect(list.length).toBeGreaterThan(0);
    for (const line of list) expect(line, "every line under Sources is a linked item").toMatch(/^- \[[^\]]+\]\(https:\/\/[^)\s]+\)/);
    const sources = new Set(list.map((l) => l.match(/\]\((https:\/\/[^)\s]+)\)/)![1]));
    const inline = [...body.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]).filter((u) => !u.startsWith("/go/") && !u.startsWith("#"));
    expect(inline.length, "the text cites its sources inline").toBeGreaterThan(0);
    for (const u of inline) {
      expect(u, "only https links").toMatch(/^https:\/\//);
      expect(sources.has(u), `${u} is cited but not in Sources`).toBe(true);
    }
  });

  it("links to affiliate programs only through /go/<program>/, for programs that exist", () => {
    const md = markdown(slug);
    for (const p of goPrograms(md)) expect(programSlugs, `/go/ link to "${p}"`).toContain(p);
    for (const u of [...md.matchAll(/\]\((https:\/\/[^)\s]+)\)/g)].map((m) => m[1])) {
      const host = new URL(u).hostname.replace(/^www\./, "").split(".").slice(-2).join(".");
      expect(programHosts, `${u} links straight to an affiliate program's site`).not.toContain(host);
    }
  });
});

// ------------------------------------------------------------------ builds

const withGuides = SITES.filter((s) => siteConfig(s).pages.guides.length > 0);
const built = new Map<string, string>();
let approvedOut = "";
let approvedProgram = "";
let scratch = "";

const build = (site: string, out: string, fixture = "fixtures/demo.json") =>
  execFileSync("npm", ["run", "build", "--", "--site", site, "--fixture", fixture, "--outDir", out], {
    cwd: web, shell: true, stdio: "pipe", env: { ...process.env, SITE: "", DATA_FIXTURE: "" },
  });

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "astro-guides-"));
  for (const site of withGuides) {
    const out = join(scratch, site);
    build(site, out);
    built.set(site, out);
  }
  // The same fixture with one guides program approved for the site, to see the link and disclosure.
  const linked = DTF.pages.guides.flatMap((s) => goPrograms(markdown(s)));
  approvedProgram = Object.keys(DTF.affiliates).find((p) => DTF.affiliates[p].includes("guides") && linked.includes(p))!;
  const fx = JSON.parse(readFileSync(join(root, "fixtures", "demo.json"), "utf8"));
  fx.siteAffiliates = { ...fx.siteAffiliates, [DTF.slug]: { ...(fx.siteAffiliates?.[DTF.slug] ?? {}), [approvedProgram]: { status: "approved", url: "https://network.example/x" } } };
  const fixture = join(scratch, "fixture.json");
  writeFileSync(fixture, JSON.stringify(fx));
  approvedOut = join(scratch, `${DTF.slug}-approved`);
  build(DTF.slug, approvedOut, fixture);
}, 600_000);

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

const page = (out: string, slug: string) => readFileSync(join(out, "guides", slug, "index.html"), "utf8");
/** Text of every data-disclosure element (Base.astro writes the line; rule 10). */
const disclosures = (html: string) =>
  [...html.matchAll(/<(\w+)\b[^>]*\bdata-disclosure\b[^>]*>([\s\S]*?)<\/\1>/g)].map((m) => m[2].replace(/&#39;/g, "'").trim());
const robots = (html: string) => html.match(/<meta name="robots" content="([^"]*)"/)?.[1] ?? null;

describe.each(withGuides)("site %s guide pages", (site) => {
  it("builds every guide the site lists; unapproved ones get noindex, a draft note, and stay out of the sitemap", () => {
    const out = built.get(site)!;
    const sitemap = readFileSync(join(out, "sitemap.xml"), "utf8");
    for (const slug of siteConfig(site).pages.guides) {
      const html = page(out, slug);
      expect(html, slug).toContain(`<h1>${guidesJson[slug].title}</h1>`);
      expect(html, slug).toContain('<h2 id="sources">Sources</h2>');
      if (guidesJson[slug].approved) {
        expect(robots(html), slug).toBeNull();
        expect(sitemap, slug).toContain(`/guides/${slug}/</loc>`);
      } else {
        expect(robots(html), slug).toBe("noindex,follow");
        expect(html, slug).toContain("Draft: this guide hasn't been reviewed yet.");
        expect(sitemap, slug).not.toContain(`/guides/${slug}/`);
      }
    }
  });

  it("builds no guide the site doesn't list", () => {
    const out = built.get(site)!;
    const listed = siteConfig(site).pages.guides.sort();
    expect(readdirSync(join(out, "guides")).sort()).toEqual(listed);
  });

  it("shows no affiliate link or disclosure line while no program is approved", () => {
    for (const slug of siteConfig(site).pages.guides) {
      const html = page(built.get(site)!, slug);
      expect(html).not.toContain('href="/go/');
      expect(disclosures(html), slug).toEqual([]);
      expect(html).not.toContain(DISCLOSURE_LINE);
    }
  });
});

describe("a guide whose program is approved for the site", () => {
  it("links it through /go/ with rel=\"sponsored nofollow\" and shows the disclosure line once, above the H1", () => {
    const slugs = DTF.pages.guides.filter((s) => goPrograms(markdown(s)).includes(approvedProgram));
    expect(slugs.length, `no ${DTF.slug} guide links /go/${approvedProgram}/`).toBeGreaterThan(0);
    for (const slug of slugs) {
      const html = page(approvedOut, slug);
      expect(html).toContain(`<a href="/go/${approvedProgram}/" rel="sponsored nofollow">`);
      expect(disclosures(html), slug).toEqual([DISCLOSURE_LINE]);
      expect(html.indexOf("data-disclosure"), slug).toBeLessThan(html.indexOf("<h1"));
    }
  });

  it("shows no disclosure line on the site's guides that don't link that program", () => {
    for (const slug of DTF.pages.guides.filter((s) => !goPrograms(markdown(s)).includes(approvedProgram))) {
      const html = page(approvedOut, slug);
      expect(html).not.toContain('href="/go/');
      expect(disclosures(html), slug).toEqual([]);
    }
  });
});
