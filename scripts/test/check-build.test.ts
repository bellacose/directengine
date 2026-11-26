// check-build (T15): each rule on small synthetic HTML, then the real command on real fixture builds
// of dtf (the demo fixture, and a variant with approved affiliates so /go/ links and the disclosure appear).

import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DISCLOSURE_LINE } from "../../apps/web/src/lib/info.ts";
import { shipVariant, root } from "../../apps/web/test/helpers.ts";
import { loadSite, type Fixture } from "../../apps/web/src/lib/load.ts";
import { STATIC_HTML } from "../../apps/web/src/lib/static-pages.ts";
import { planPages } from "../../packages/core/src/index.ts";
import { parseArgs, readDist } from "../check-build.ts";
import { checkBuild, fixtureMarkers, type BuildInput, type PlannedPage } from "../lib/check-build.ts";

// ------------------------------------------------------------------ synthetic builds

const HOST = "site.test";

interface PageOpts {
  canonical?: string | string[] | null;
  noindex?: boolean;
  body?: string;
}
function page(path: string, o: PageOpts = {}): string {
  const canon = o.canonical === undefined ? [`https://${HOST}${path}`] : o.canonical === null ? [] : [o.canonical].flat();
  return `<!doctype html><html><head><title>t</title>${o.noindex ? '<meta name="robots" content="noindex,follow">' : ""}${canon
    .map((c) => `<link rel="canonical" href="${c}">`)
    .join("")}</head><body><main>${o.body ?? "<p>Shops in Tampa Bay.</p>"}</main></body></html>`;
}
const sitemap = (paths: string[], host = HOST) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${paths
    .map((p) => `  <url><loc>https://${host}${p}</loc></url>`)
    .join("\n")}\n</urlset>\n`;

const PLAN: PlannedPage[] = [
  { path: "/", indexable: true },
  { path: "/dtf/tampa-bay/", indexable: true },
  { path: "/dtf/buffalo/", indexable: false },
];
const STATIC = ["404.html", "confirm-email/index.html"];

/** A build that passes every check; `edit` changes it for one test. */
function input(edit: (files: Record<string, string>) => void = () => {}, extra: Partial<BuildInput> = {}): BuildInput {
  const files: Record<string, string> = {
    "index.html": page("/"),
    "dtf/tampa-bay/index.html": page("/dtf/tampa-bay/"),
    "dtf/buffalo/index.html": page("/dtf/buffalo/", { noindex: true }),
    "404.html": page("/404.html", { canonical: null, noindex: true }),
    "confirm-email/index.html": page("/confirm-email/", { noindex: true }),
    "sitemap.xml": sitemap(["/", "/dtf/tampa-bay/"]),
  };
  edit(files);
  return {
    host: HOST,
    plan: PLAN,
    staticHtml: STATIC,
    affiliates: [
      { slug: "transfer-express", status: "approved", url: "https://track.network.test/c/123/transfer-express?subId1={subid}" },
      { slug: "jiffy", status: "apply", url: null },
    ],
    files,
    production: false,
    ...extra,
  };
}
const reasons = (i: BuildInput) => checkBuild(i).map((f) => `${f.page}: ${f.reason}`);
const withBody = (body: string) => (f: Record<string, string>) => {
  f["dtf/tampa-bay/index.html"] = page("/dtf/tampa-bay/", { body });
};
const DISCLOSURE = `<p class="disclosure">${DISCLOSURE_LINE.replace("'", "&#39;")}</p>`;
const GO = '<a href="/go/transfer-express/" rel="sponsored nofollow">Transfer Express</a>';

describe("checkBuild on synthetic pages", () => {
  it("passes a clean build", () => {
    expect(reasons(input())).toEqual([]);
  });

  describe("canonical (rule 8)", () => {
    it("fails a page without one", () => {
      expect(reasons(input((f) => (f["index.html"] = page("/", { canonical: null }))))).toEqual(["/: no canonical link"]);
    });
    it("fails a static page without one, but not 404.html", () => {
      expect(reasons(input((f) => (f["confirm-email/index.html"] = page("/confirm-email/", { canonical: null, noindex: true }))))).toEqual([
        "/confirm-email/: no canonical link",
      ]);
    });
    it("fails two canonicals", () => {
      expect(reasons(input((f) => (f["index.html"] = page("/", { canonical: [`https://${HOST}/`, `https://${HOST}/`] }))))).toEqual([
        "/: 2 canonical links (expected one)",
      ]);
    });
    it("fails a canonical on another domain", () => {
      expect(reasons(input((f) => (f["dtf/tampa-bay/index.html"] = page("/dtf/tampa-bay/", { canonical: "https://other.test/dtf/tampa-bay/" }))))).toEqual([
        `/dtf/tampa-bay/: canonical https://other.test/dtf/tampa-bay/ points at another domain (expected https://${HOST}/dtf/tampa-bay/)`,
      ]);
    });
    it("fails a canonical pointing at another page of the site", () => {
      expect(reasons(input((f) => (f["dtf/tampa-bay/index.html"] = page("/dtf/tampa-bay/", { canonical: `https://${HOST}/` }))))).toEqual([
        `/dtf/tampa-bay/: canonical https://${HOST}/ is not this page (expected https://${HOST}/dtf/tampa-bay/)`,
      ]);
    });
  });

  describe("plan and sitemap (rule 7)", () => {
    it("fails an indexable page missing from the sitemap", () => {
      expect(reasons(input((f) => (f["sitemap.xml"] = sitemap(["/"]))))).toEqual(["/dtf/tampa-bay/: is indexable but not in the sitemap"]);
    });
    it("fails a sitemap entry with no page", () => {
      expect(reasons(input((f) => (f["sitemap.xml"] = sitemap(["/", "/dtf/tampa-bay/", "/shop/gone/"]))))).toEqual([
        "/shop/gone/: is in the sitemap but has no page",
      ]);
    });
    it("fails a noindex page in the sitemap", () => {
      expect(reasons(input((f) => (f["sitemap.xml"] = sitemap(["/", "/dtf/tampa-bay/", "/dtf/buffalo/"]))))).toEqual([
        "/dtf/buffalo/: is noindex but in the sitemap",
      ]);
    });
    it("fails a sitemap entry for a page the plan doesn't index, even without noindex", () => {
      const i = input((f) => {
        f["dtf/buffalo/index.html"] = page("/dtf/buffalo/");
        f["sitemap.xml"] = sitemap(["/", "/dtf/tampa-bay/", "/dtf/buffalo/"]);
      });
      expect(reasons(i)).toEqual([
        "/dtf/buffalo/: is indexable but the plan says noindex (or it is outside the plan)",
        "/dtf/buffalo/: is in the sitemap but the plan says it is not indexable",
      ]);
    });
    it("fails sitemap entries on another host, duplicated, or a missing sitemap", () => {
      expect(reasons(input((f) => (f["sitemap.xml"] = sitemap(["/", "/dtf/tampa-bay/", "/dtf/tampa-bay/"]))))).toEqual([
        `sitemap.xml: lists https://${HOST}/dtf/tampa-bay/ more than once`,
      ]);
      expect(reasons(input((f) => (f["sitemap.xml"] = sitemap(["/", "/dtf/tampa-bay/"], "other.test"))))).toEqual([
        "sitemap.xml: entry https://other.test/ is not on https://site.test",
        "sitemap.xml: entry https://other.test/dtf/tampa-bay/ is not on https://site.test",
        "/: is indexable but not in the sitemap",
        "/dtf/tampa-bay/: is indexable but not in the sitemap",
      ]);
      expect(reasons(input((f) => delete f["sitemap.xml"]))).toEqual(["sitemap.xml: missing"]);
    });
    it("fails index states that disagree with the plan", () => {
      expect(reasons(input((f) => (f["dtf/tampa-bay/index.html"] = page("/dtf/tampa-bay/", { noindex: true }))))).toEqual([
        "/dtf/tampa-bay/: has noindex but the plan says indexable",
        "/dtf/tampa-bay/: is noindex but in the sitemap",
      ]);
      expect(reasons(input((f) => (f["404.html"] = page("/404.html", { canonical: null }))))).toEqual([
        "404.html: is indexable but the plan says noindex (or it is outside the plan)",
      ]);
    });
    it("fails a planned page that wasn't built and a page outside the plan", () => {
      expect(reasons(input((f) => delete f["dtf/buffalo/index.html"]))).toEqual(["/dtf/buffalo/: is in the plan but was not built"]);
      expect(reasons(input((f) => (f["extra/index.html"] = page("/extra/", { noindex: true }))))).toEqual(["/extra/: is not in the plan (extra/index.html)"]);
    });
  });

  describe("affiliate links (rule 10)", () => {
    it("passes a /go/ link with rel and the disclosure line (apostrophe as an entity)", () => {
      expect(reasons(input(withBody(DISCLOSURE + GO)))).toEqual([]);
    });
    it("fails a /go/ link without the disclosure line", () => {
      expect(reasons(input(withBody(GO)))).toEqual(["/dtf/tampa-bay/: has a /go/ link but no disclosure line"]);
    });
    it("fails a /go/ link without rel=\"sponsored nofollow\", to an unapproved program, or not /go/<program>/", () => {
      expect(reasons(input(withBody(DISCLOSURE + '<a href="/go/transfer-express/" rel="nofollow">x</a>')))).toEqual([
        '/dtf/tampa-bay/: affiliate link /go/transfer-express/ lacks rel="sponsored nofollow"',
      ]);
      expect(reasons(input(withBody(DISCLOSURE + '<a href="/go/jiffy/" rel="sponsored nofollow">x</a>')))).toEqual([
        "/dtf/tampa-bay/: affiliate link /go/jiffy/: jiffy is not approved for this site",
      ]);
      expect(reasons(input(withBody(DISCLOSURE + '<a href="/go/transfer-express" rel="sponsored nofollow">x</a>')))).toEqual([
        "/dtf/tampa-bay/: affiliate link /go/transfer-express is not /go/<program>/",
      ]);
    });
    it("fails a sponsored link that isn't /go/", () => {
      expect(reasons(input(withBody('<a href="https://supplier.test/" rel="sponsored nofollow">x</a>')))).toEqual([
        "/dtf/tampa-bay/: sponsored link https://supplier.test/ bypasses /go/",
      ]);
    });
    it("fails a link to an affiliate network, with an affiliate parameter, or to the stored network link", () => {
      expect(reasons(input(withBody('<a href="https://www.awin1.com/cread.php?awinmid=1">x</a>')))).toEqual([
        "/dtf/tampa-bay/: affiliate link https://www.awin1.com/cread.php?awinmid=1 bypasses /go/: it links to the affiliate network www.awin1.com",
      ]);
      expect(reasons(input(withBody('<a href="https://supplier.test/?clickref=dtf">x</a>')))).toEqual([
        '/dtf/tampa-bay/: affiliate link https://supplier.test/?clickref=dtf bypasses /go/: it carries the affiliate parameter "clickref"',
      ]);
      expect(reasons(input(withBody('<a href="https://www.amazon.com/dp/B0?tag=me-20">x</a>')))).toEqual([
        "/dtf/tampa-bay/: affiliate link https://www.amazon.com/dp/B0?tag=me-20 bypasses /go/: it links to Amazon with an affiliate tag",
      ]);
      expect(reasons(input(withBody('<a href="https://track.network.test/c/123/transfer-express?subId1=x">x</a>')))).toEqual([
        "/dtf/tampa-bay/: affiliate link https://track.network.test/c/123/transfer-express?subId1=x bypasses /go/: it is the stored network link for transfer-express",
      ]);
    });
    it("fails the stored network link written anywhere in the page", () => {
      expect(reasons(input(withBody("<p>https://track.network.test/c/123/transfer-express</p>")))).toEqual([
        "/dtf/tampa-bay/: contains the stored network link for transfer-express",
      ]);
    });
    it("leaves ordinary outbound links alone (shop websites, guide sources)", () => {
      expect(reasons(input(withBody('<a href="https://heatpress.com/dk20">DK20</a><a href="https://shop.test/?utm_source=x">site</a><a href="tel:+18135550199">call</a>')))).toEqual([]);
    });
  });

  describe("ratings and reviews (rule 3)", () => {
    const ld = (o: unknown) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`;
    it("fails aggregateRating anywhere", () => {
      expect(reasons(input(withBody(ld({ "@type": "LocalBusiness", aggregateRating: { ratingValue: 5 } }))))).toEqual(["/dtf/tampa-bay/: contains aggregateRating"]);
      expect(reasons(input(withBody('<div itemprop="aggregateRating"></div>')))).toEqual(["/dtf/tampa-bay/: contains aggregateRating"]);
    });
    it("fails a review in structured data or microdata", () => {
      expect(reasons(input(withBody(ld({ "@type": "LocalBusiness", review: [{ "@type": "Review" }] }))))).toEqual([
        '/dtf/tampa-bay/: structured data has "review", @type Review',
      ]);
      expect(reasons(input(withBody('<div itemprop="review">x</div>')))).toEqual(['/dtf/tampa-bay/: microdata has itemprop "review"']);
    });
    it("fails structured data that isn't JSON", () => {
      expect(reasons(input(withBody('<script type="application/ld+json">{nope}</script>')))[0]).toMatch(/structured data is not valid JSON/);
    });
    it("passes LocalBusiness without ratings", () => {
      expect(reasons(input(withBody(ld({ "@type": "LocalBusiness", name: "Shop", telephone: "(813) 222-0101" }))))).toEqual([]);
    });
  });

  describe("fixture markers", () => {
    const fake = '<h2><a href="https://example.com/x">Example DTF Tampa</a></h2><a href="tel:+18135550101">(813) 555-0101</a>';
    it("fail a production build", () => {
      expect(reasons(input(withBody(fake), { production: true }))).toEqual([
        '/dtf/tampa-bay/: fixture marker: "Example" fixture text ("Example D")',
        '/dtf/tampa-bay/: fixture marker: example.com address ("example.com")',
        '/dtf/tampa-bay/: fixture marker: 555 phone number ("+18135550101")',
      ]);
    });
    it("are allowed in a fixture build", () => {
      expect(reasons(input(withBody(fake)))).toEqual([]);
    });
    it("leave real text alone", () => {
      const real = '<h2>Example presses</h2><p>For example, a 16x20 press.</p><a href="tel:+18132220101">(813) 222-0101</a><p>Order #1555-2024</p>';
      expect(reasons(input(withBody(real), { production: true }))).toEqual([]);
    });
    it("cover every fake value in fixtures/demo.json", () => {
      const strings: string[] = [];
      const walk = (v: unknown): void => {
        if (typeof v === "string") strings.push(v);
        else if (v && typeof v === "object") Object.values(v).forEach(walk);
      };
      walk(JSON.parse(readFileSync(join(root, "fixtures", "demo.json"), "utf8")));
      const fake = strings.filter((s) => /Example|example\.|555/.test(s));
      expect(fake.length).toBeGreaterThan(20);
      expect(fake.filter((s) => fixtureMarkers(s).length === 0)).toEqual([]);
    });
  });
});

describe("parseArgs", () => {
  it("takes the slug, --fixture with an optional .json path, and --dist", () => {
    expect(parseArgs(["dtf"])).toEqual({ slug: "dtf", fixture: null, dist: null });
    expect(parseArgs(["dtf", "--fixture"])).toEqual({ slug: "dtf", fixture: "fixtures/demo.json", dist: null });
    expect(parseArgs(["--fixture", "dtf"])).toEqual({ slug: "dtf", fixture: "fixtures/demo.json", dist: null });
    expect(parseArgs(["dtf", "--fixture", "x/y.json", "--dist", "out"])).toEqual({ slug: "dtf", fixture: "x/y.json", dist: "out" });
    expect(() => parseArgs([])).toThrow(/usage/);
    expect(() => parseArgs(["dtf", "--bogus"])).toThrow(/unknown option/);
  });
});

// ------------------------------------------------------------------ the real command on real builds

describe("check-build on fixture builds of dtf", () => {
  const tmp = mkdtempSync(join(tmpdir(), "check-build-"));
  const demoOut = join(tmp, "demo");
  const affOut = join(tmp, "affiliates");
  const affFixture = join(tmp, "affiliates.json");

  const build = (fixture: string, out: string) =>
    execFileSync("npm", ["run", "build", "--", "--site", "dtf", "--fixture", fixture, "--outDir", out], {
      cwd: root, shell: true, stdio: "pipe", env: { ...process.env, SITE: "", DATA_FIXTURE: "", SUPABASE_URL: "" },
    });
  const check = (...args: string[]) =>
    spawnSync(process.execPath, [join(root, "scripts", "check-build.ts"), "dtf", ...args], {
      cwd: root, encoding: "utf8", env: { ...process.env, SUPABASE_URL: "", SUPABASE_SERVICE_ROLE_KEY: "" },
    });

  beforeAll(() => {
    build("fixtures/demo.json", demoOut);
    const demo = JSON.parse(readFileSync(join(root, "fixtures", "demo.json"), "utf8")) as Fixture;
    writeFileSync(affFixture, JSON.stringify(shipVariant(demo, "dtf", ["transfer-express"])));
    build(affFixture, affOut);
  }, 600_000);
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it("passes the demo fixture build", () => {
    const r = check("--fixture", "--dist", demoOut);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/all checks passed/);
  });

  it("passes a build with approved affiliates, whose pages carry /go/ links and the disclosure", () => {
    const files = readDist(affOut);
    expect(Object.entries(files).filter(([, h]) => h.includes('href="/go/')).map(([f]) => f).sort()).toEqual([
      "guides/best-heat-press-for-dtf/index.html",
      "ship/dtf-to-buffalo/index.html",
      "ship/dtf-to-tampa-bay/index.html",
    ]);
    const r = check("--fixture", affFixture, "--dist", affOut);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  it("reports each broken page and exits 1", () => {
    const broken = join(tmp, "broken");
    cpSync(affOut, broken, { recursive: true });
    const ship = join(broken, "ship", "dtf-to-tampa-bay", "index.html");
    writeFileSync(ship, readFileSync(ship, "utf8").replace(/<p class="disclosure"[^>]*>[^<]*<\/p>/, "").replace(/<link rel="canonical"[^>]*>/, ""));
    const r = check("--fixture", affFixture, "--dist", broken);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("FAIL /ship/dtf-to-tampa-bay/: no canonical link");
    expect(r.stderr).toContain("FAIL /ship/dtf-to-tampa-bay/: has a /go/ link but no disclosure line");
    expect(r.stderr).toMatch(/2 failures/);
  });

  it("finds the fixture's fake shops when the same build is checked as production", async () => {
    const data = await loadSite({ root, env: { SITE: "dtf", DATA_FIXTURE: "fixtures/demo.json" } });
    const plan = planPages(data.site, data);
    const failures = checkBuild({ host: data.site.domain!, plan, staticHtml: STATIC_HTML, affiliates: [], files: readDist(demoOut), production: true });
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.filter((f) => !f.reason.startsWith("fixture marker: "))).toEqual([]);
    const flagged = new Set(failures.map((f) => f.page));
    for (const p of plan.filter((p) => p.type === "shop")) expect(flagged.has(p.path), p.path).toBe(true);
    expect(failures.some((f) => f.reason.includes("555 phone number"))).toBe(true);
  });

  it("can't run without a build or, in production, without Supabase keys", () => {
    expect(check("--fixture", "--dist", join(tmp, "nothing")).status).toBe(2);
    const r = check("--dist", demoOut);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/SUPABASE_URL/);
  });
});
