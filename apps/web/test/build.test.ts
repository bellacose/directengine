// The Astro build: every site in sites/ builds from the fixture, writes exactly the pages planPages()
// returns plus the static pages, marks each page's index state and canonical from the plan, and writes
// sitemap.xml and robots.txt from the same plan. Also: no site slug literals in the web app's source.

import { planPages, sitemapEntries, type Page } from "@directory-engine/core";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseArgs } from "../run.ts";
import { loadSite, type SiteData } from "../src/lib/load.ts";
import { STATIC_HTML } from "../src/lib/static-pages.ts";
import { root } from "./helpers.ts";

const SITES = readdirSync(join(root, "sites")).filter((f) => f.endsWith(".json") && f !== "guides.json").map((f) => f.replace(/\.json$/, "")).sort();
const web = join(root, "apps", "web");

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]));

interface Built {
  out: string;
  data: SiteData;
  plan: Page[];
  host: string;
}
const built = new Map<string, Built>();

beforeAll(async () => {
  for (const site of SITES) {
    const out = mkdtempSync(join(tmpdir(), `astro-${site}-`));
    // The real command, with the slug passed the documented way.
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
const robotsMeta = (html: string) => html.match(/<meta name="robots" content="([^"]*)"/)?.[1] ?? null;
const canonicals = (html: string) => [...html.matchAll(/<link rel="canonical" href="([^"]*)"/g)].map((m) => m[1]);

describe.each(SITES)("site %s built from the fixture", (site) => {
  it("writes exactly the planned pages plus the static pages", () => {
    const b = built.get(site)!;
    const html = files(b.out).filter((f) => f.endsWith(".html")).map((f) => relative(b.out, f).replaceAll("\\", "/")).sort();
    const expected = [...b.plan.map((p) => `${p.path.slice(1)}index.html`), ...STATIC_HTML].sort();
    expect(b.plan.length).toBeGreaterThan(1);
    expect(html).toEqual(expected);
  });

  it("gives every planned page one self-canonical link and noindex,follow exactly when the plan says", () => {
    const b = built.get(site)!;
    for (const p of b.plan) {
      const html = htmlFor(b, p.path);
      expect(canonicals(html), p.path).toEqual([`https://${b.host}${p.path}`]);
      expect(robotsMeta(html), p.path).toBe(p.indexable ? null : "noindex,follow");
    }
  });

  it("covers both index states in the fixture", () => {
    const b = built.get(site)!;
    expect(b.plan.some((p) => p.indexable)).toBe(true);
    expect(b.plan.some((p) => !p.indexable)).toBe(true);
  });

  it("writes sitemap.xml from sitemapEntries() with per-URL lastmod", () => {
    const b = built.get(site)!;
    const xml = readFileSync(join(b.out, "sitemap.xml"), "utf8");
    const rows = [...xml.matchAll(/<url><loc>([^<]*)<\/loc>(?:<lastmod>([^<]*)<\/lastmod>)?<\/url>/g)].map((m) => ({ loc: m[1], lastmod: m[2] ?? null }));
    expect(rows).toEqual(sitemapEntries({ ...b.data.site, domain: b.host }, b.plan));
    expect(rows.length).toBe(b.plan.filter((p) => p.indexable).length);
  });

  it("writes robots.txt that disallows /go/ and names the sitemap", () => {
    const b = built.get(site)!;
    const txt = readFileSync(join(b.out, "robots.txt"), "utf8");
    expect(txt).toMatch(/^Disallow: \/go\/$/m);
    expect(txt).toMatch(new RegExp(`^Sitemap: https://${b.host.replace(/\./g, "\\.")}/sitemap\\.xml$`, "m"));
  });

  it("uses the site's name and brand colors from config, with the operator and GeoNames credit in the footer", () => {
    const b = built.get(site)!;
    const html = htmlFor(b, "/");
    const { name, brand, operator } = b.data.site;
    expect(html).toContain(`<a class="site-name" href="/">${name}</a>`);
    expect(html).toContain(`--brand:${brand.primary}`);
    expect(html).toContain(`--accent:${brand.accent}`);
    expect(html).toContain(operator ? `run by ${operator.name}` : "Operator not set yet");
    expect(html).toMatch(/geonames\.org[\s\S]*CC BY 4\.0/);
  });

  it("has a 404 page that is not indexed and has no canonical", () => {
    const html = readFileSync(join(built.get(site)!.out, "404.html"), "utf8");
    expect(robotsMeta(html)).toBe("noindex,follow");
    expect(canonicals(html)).toEqual([]);
  });

  it("ships no client JavaScript and no external stylesheet", () => {
    const b = built.get(site)!;
    // _worker.js is the Cloudflare host routing (T8): run by the host, never served to browsers.
    expect(files(b.out).filter((f) => /\.(js|css)$/.test(f) && f !== join(b.out, "_worker.js"))).toEqual([]);
  });
});

describe("apps/web/src", () => {
  it("contains no site slug literals", () => {
    const src = join(web, "src");
    const hits: string[] = [];
    for (const f of files(src)) {
      const text = readFileSync(f, "utf8");
      for (const slug of SITES) {
        if (new RegExp(`(["'\`])${slug.replace(/-/g, "\\-")}\\1`).test(text)) hits.push(`${relative(root, f)}: "${slug}"`);
      }
    }
    expect(hits).toEqual([]);
  });
});

describe("run.ts arguments", () => {
  it("takes --site and --fixture and passes everything else to Astro", () => {
    expect(parseArgs(["build", "--site", "laser", "--fixture", "--outDir", "x"], {})).toEqual({
      command: "build", env: { SITE: "laser", DATA_FIXTURE: "fixtures/demo.json" }, astroArgs: ["--outDir", "x"],
    });
    expect(parseArgs(["build", "--site=laser", "--fixture=fixtures/other.json"], {}).env).toEqual({ SITE: "laser", DATA_FIXTURE: "fixtures/other.json" });
    expect(parseArgs(["build", "--outDir", "x"], {})).toEqual({ command: "build", env: {}, astroArgs: ["--outDir", "x"] });
  });

  it("never falls back to the fixture for a build, but does for the dev server", () => {
    expect(parseArgs(["build", "--site", "laser"], {}).env.DATA_FIXTURE).toBeUndefined();
    expect(parseArgs(["dev", "--site", "laser"], {}).env.DATA_FIXTURE).toBe("fixtures/demo.json");
    expect(parseArgs(["dev"], { SUPABASE_URL: "http://x" }).env.DATA_FIXTURE).toBeUndefined();
  });

  it("refuses --site without a slug", () => {
    expect(() => parseArgs(["build", "--site"], {})).toThrow(/needs a site slug/);
    expect(() => parseArgs(["build", "--site", "--outDir"], {})).toThrow(/needs a site slug/);
  });
});
