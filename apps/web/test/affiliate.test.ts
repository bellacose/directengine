// T8 in the web app: affiliate links in built pages only ever point at /go/ with rel="sponsored
// nofollow", stored network links never reach a page, and every build writes the host routing that
// sends /go/* and /track/ on the site's own domain to the Edge Functions.

import type { SiteConfig } from "@directory-engine/core";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AFFILIATE_REL, goHref } from "../src/lib/affiliate.ts";
import { cloudflareWorker, functionsBase, hostRoutingFiles, netlifyRedirects, PREVIEW_FUNCTIONS } from "../src/lib/host-routing.ts";
import { loadSite, type SiteData } from "../src/lib/load.ts";
import { root } from "./helpers.ts";

const SITES = readdirSync(join(root, "sites")).filter((f) => f.endsWith(".json") && f !== "guides.json").map((f) => f.replace(/\.json$/, "")).sort();
const web = join(root, "apps", "web");
const SUPABASE = "https://ref.supabase.co";
const FUNCTIONS = `${SUPABASE}/functions/v1`;
const seed = readFileSync(join(root, "supabase", "seed.sql"), "utf8");
/** Hosts of every program's own site in the seed: a page must never link to these directly. */
const programHosts = [...seed.matchAll(/'(https:\/\/[^']+)'/g)].map((m) => new URL(m[1]).hostname.replace(/^www\./, ""));

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]));
const anchors = (html: string) =>
  [...html.matchAll(/<a\b([^>]*)>/g)].map((m) => ({
    href: m[1].match(/\bhref="([^"]*)"/)?.[1] ?? null,
    rel: m[1].match(/\brel="([^"]*)"/)?.[1] ?? null,
  }));

const built = new Map<string, { out: string; data: SiteData }>();

beforeAll(async () => {
  for (const site of SITES) {
    const out = mkdtempSync(join(tmpdir(), `astro-go-${site}-`));
    execFileSync("npm", ["run", "build", "--", "--site", site, "--fixture", "--outDir", out], {
      cwd: web, shell: true, stdio: "pipe",
      env: { ...process.env, SITE: "", DATA_FIXTURE: "", SUPABASE_URL: SUPABASE, NETLIFY: "", CF_PAGES: "" },
    });
    built.set(site, { out, data: await loadSite({ root, env: { SITE: site, DATA_FIXTURE: "fixtures/demo.json" } }) });
  }
}, 600_000);

afterAll(() => {
  for (const b of built.values()) rmSync(b.out, { recursive: true, force: true });
});

describe.each(SITES)("site %s", (site) => {
  it("has affiliate links only as /go/ with rel=\"sponsored nofollow\", to programs approved here", () => {
    const { out, data } = built.get(site)!;
    const stored = data.affiliates.map((a) => a.url).filter((u): u is string => !!u);
    let seen = 0;
    for (const f of files(out).filter((f) => f.endsWith(".html"))) {
      const html = readFileSync(f, "utf8");
      for (const u of stored) expect(html, f).not.toContain(u);
      for (const a of anchors(html)) {
        seen++;
        const rel = (a.rel ?? "").split(/\s+/);
        if (a.href?.startsWith("/go/") || a.href?.includes("/go/")) {
          expect(a.href, f).toMatch(/^\/go\/[a-z0-9-]+\/$/);
          expect(rel, `${f} ${a.href}`).toEqual(expect.arrayContaining(["sponsored", "nofollow"]));
          const program = a.href!.split("/")[2];
          expect(data.affiliates.find((x) => x.slug === program)?.status, `${f} ${a.href}`).toBe("approved");
        }
        if (rel.includes("sponsored")) expect(a.href, f).toMatch(/^\/go\//);
        if (a.href && /^https?:\/\//.test(a.href)) {
          const host = new URL(a.href).hostname.replace(/^www\./, "");
          expect(programHosts, `${f} links straight to ${a.href}`).not.toContain(host);
        }
      }
    }
    // The scan really reads links (no page has an affiliate link until T9 and T10 add them).
    expect(seen).toBeGreaterThan(0);
  });

  it("writes host routing that sends /go/* and /track/* to the functions with this site's slug", () => {
    const { out } = built.get(site)!;
    expect(readFileSync(join(out, "_redirects"), "utf8")).toBe(netlifyRedirects(site, FUNCTIONS));
    expect(readFileSync(join(out, "_worker.js"), "utf8")).toBe(cloudflareWorker(site, FUNCTIONS));
    expect(JSON.parse(readFileSync(join(out, "_routes.json"), "utf8"))).toEqual({ version: 1, include: ["/go/*", "/track/*"], exclude: [] });
    expect(readFileSync(join(out, "_redirects"), "utf8")).toContain(`/go/*     ${FUNCTIONS}/go/${site}/:splat     200!`);
  });

  it("still disallows /go/ in robots.txt", () => {
    expect(readFileSync(join(built.get(site)!.out, "robots.txt"), "utf8")).toMatch(/^Disallow: \/go\/$/m);
  });
});

describe("goHref", () => {
  const site = { affiliates: { "transfer-express": ["ship-to-you"], dtfsheet: ["guides"] } } as unknown as SiteConfig;
  const state = (slug: string, status: string, url: string | null) => ({ slug, status, url, hasSupplierFacts: false, factsCheckedAt: null });

  it("links an approved program placed here, through /go/ only", () => {
    expect(goHref(site, [state("transfer-express", "approved", "https://x.example/a")], "transfer-express", "ship-to-you")).toBe("/go/transfer-express/");
    expect(AFFILIATE_REL).toBe("sponsored nofollow");
  });

  it("gives no link when not approved, no stored link, or not placed here", () => {
    expect(goHref(site, [state("transfer-express", "applied", "https://x.example/a")], "transfer-express", "ship-to-you")).toBeNull();
    expect(goHref(site, [state("transfer-express", "approved", null)], "transfer-express", "ship-to-you")).toBeNull();
    expect(goHref(site, [state("transfer-express", "approved", "https://x.example/a")], "transfer-express", "guides")).toBeNull();
    expect(goHref(site, [state("xtool", "approved", "https://x.example/a")], "xtool", "guides")).toBeNull();
  });
});

describe("host routing", () => {
  it("uses SUPABASE_URL's origin, or a host that can never resolve", () => {
    expect(functionsBase({ SUPABASE_URL: "https://ref.supabase.co/" })).toBe(FUNCTIONS);
    expect(functionsBase({})).toBe(PREVIEW_FUNCTIONS);
  });

  it("writes only the files of the host it builds on", () => {
    expect(Object.keys(hostRoutingFiles("dtf", { NETLIFY: "true" }))).toEqual(["_redirects"]);
    expect(Object.keys(hostRoutingFiles("dtf", { CF_PAGES: "1" })).sort()).toEqual(["_routes.json", "_worker.js"]);
    expect(Object.keys(hostRoutingFiles("dtf", {})).sort()).toEqual(["_redirects", "_routes.json", "_worker.js"]);
  });

  it("the Cloudflare worker forwards /go/ and /track/ with the site slug and serves the rest as static files", async () => {
    const src = cloudflareWorker("dtf", FUNCTIONS);
    const worker = (await import(`data:text/javascript;base64,${Buffer.from(src).toString("base64")}`)).default;
    const calls: { url: string; init: RequestInit }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(null, { status: 302, headers: { Location: "https://merchant.example/" } });
    }) as typeof fetch;
    const assets: string[] = [];
    const env = { ASSETS: { fetch: async (r: Request) => (assets.push(new URL(r.url).pathname), new Response("static")) } };
    try {
      const res = await worker.fetch(new Request("https://dtf.example/go/transfer-express/?url=https://evil.example/", {
        headers: { referer: "https://dtf.example/ship/dtf-to-tampa-bay/", cookie: "secret=1" },
      }), env);
      expect(res.status).toBe(302);
      expect(calls[0].url).toBe(`${FUNCTIONS}/go/dtf/transfer-express/`);
      expect(calls[0].init.redirect).toBe("manual");
      const sent = calls[0].init.headers as Headers;
      expect(sent.get("referer")).toBe("https://dtf.example/ship/dtf-to-tampa-bay/");
      expect(sent.get("cookie")).toBeNull();

      await worker.fetch(new Request("https://dtf.example/track/", { method: "POST", body: "{}" }), env);
      expect(calls[1].url).toBe(`${FUNCTIONS}/track/dtf/`);
      expect(calls[1].init.method).toBe("POST");

      expect(await (await worker.fetch(new Request("https://dtf.example/dtf/tampa-bay/"), env)).text()).toBe("static");
      expect(assets).toEqual(["/dtf/tampa-bay/"]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
