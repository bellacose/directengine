// Public forms on the built pages (T11): /add-your-shop/ is planned, indexed and in the sitemap; its
// form and the shop page's report form post to the routed functions with the functions' own field
// names and length limits; fact inputs follow the site's angle; Turnstile renders only with a key;
// the page script shows the function's answer and field errors in place (happy-dom).

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Window } from "happy-dom";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { planPages } from "@directory-engine/core";
import { loadSite, type SiteData } from "../src/lib/load.ts";
import { CLAIM_ACTION, FIELD_LIMITS, HONEYPOT, MESSAGES, OUTCOMES, REPORT_ACTION, claimFactGroups, claimHref, turnstileSiteKey } from "../src/lib/forms.ts";
import { cloudflareWorker, netlifyRedirects } from "../src/lib/host-routing.ts";
import { root } from "./helpers.ts";

const web = join(root, "apps", "web");
const SITE_KEY = "1x00000000000000000000AA"; // Cloudflare's always-pass test site key
const outs: Record<string, string> = {};
const datas: Record<string, SiteData> = {};

const build = (site: string, env: Record<string, string> = {}) => {
  const out = mkdtempSync(join(tmpdir(), `astro-forms-${site}-`));
  execFileSync("npm", ["run", "build", "--", "--site", site, "--fixture", "--outDir", out], {
    cwd: web, shell: true, stdio: "pipe", env: { ...process.env, SITE: "", DATA_FIXTURE: "", TURNSTILE_SITE_KEY: "", ...env },
  });
  return out;
};

beforeAll(async () => {
  outs.dtf = build("dtf");
  outs.laser = build("laser");
  outs.keyed = build("dtf", { TURNSTILE_SITE_KEY: SITE_KEY });
  for (const s of ["dtf", "laser"]) datas[s] = await loadSite({ root, env: { SITE: s, DATA_FIXTURE: "fixtures/demo.json" } });
}, 600_000);

afterAll(() => {
  for (const o of Object.values(outs)) rmSync(o, { recursive: true, force: true });
});

const html = (out: string, path: string) => readFileSync(join(out, path.slice(1), "index.html"), "utf8");
const formOf = (page: string) => page.match(/<form[\s\S]*?<\/form>/)![0];
const attr = (tag: string, name: string) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1] ?? null;
/** Each named input/textarea/select tag in a form, by name. */
const fields = (form: string) => {
  const m = new Map<string, string[]>();
  for (const t of form.match(/<(input|textarea|select)\b[^>]*>/g) ?? []) {
    const n = attr(t, "name");
    if (n) m.set(n, [...(m.get(n) ?? []), t]);
  }
  return m;
};
const firstShop = (s: string) => planPages(datas[s].site, datas[s]).find((p) => p.type === "shop")!;

describe("/add-your-shop/", () => {
  it("is in the plan, indexed, in the sitemap and linked from every footer", () => {
    const plan = planPages(datas.dtf.site, datas.dtf);
    expect(plan.find((p) => p.path === "/add-your-shop/")).toMatchObject({ type: "info", indexable: true, lastmod: null });
    const page = html(outs.dtf, "/add-your-shop/");
    expect(page).not.toContain('name="robots"');
    expect(page).toContain("<h1>Add your shop</h1>");
    expect(readFileSync(join(outs.dtf, "sitemap.xml"), "utf8")).toContain("/add-your-shop/</loc>");
    expect(html(outs.dtf, "/")).toContain('href="/add-your-shop/"');
  });

  it("posts the claim fields to /submit-claim/ with the function's length limits", () => {
    const form = formOf(html(outs.dtf, "/add-your-shop/"));
    expect(attr(form, "action")).toBe(CLAIM_ACTION);
    expect(attr(form, "method")).toBe("post");
    const f = fields(form);
    for (const name of ["name", "address", "city", "state", "zip", "phone", "website", "description", "notes", "contact_email"] as const) {
      expect(f.has(name), name).toBe(true);
      expect(Number(attr(f.get(name)![0], "maxlength")), name).toBe(FIELD_LIMITS[name]);
    }
    expect(f.get("contact_email")![0]).toMatch(/\srequired/);
    expect(attr(f.get("return")![0], "value")).toBe("/add-your-shop/");
    // Every listed shop on this site can be picked; a new shop is the default.
    const options = [...form.matchAll(/<option value="([^"]*)"/g)].map((m) => m[1]);
    expect(options[0]).toBe("");
    const siteShops = new Set(planPages(datas.dtf.site, datas.dtf).flatMap((p) => (p.type === "capabilityMetro" ? p.listingIds! : [])));
    for (const id of siteShops) expect(options, id).toContain(id);
  });

  it("offers inputs for this site's angle facts only, each matching its type", () => {
    for (const s of ["dtf", "laser"]) {
      const d = datas[s];
      const f = fields(formOf(html(outs[s], "/add-your-shop/")));
      const offered = [...f.keys()].filter((k) => k.startsWith("fact.")).map((k) => k.slice(5));
      if ([...f.keys()].some((k) => k.startsWith("hours."))) offered.push("hours");
      const expected = claimFactGroups(d.site, d.vocabulary).flatMap((g) => g.facts.map((x) => x.key));
      expect(offered.sort(), s).toEqual(expected.sort());
      const types = new Map(d.vocabulary.factDefs.map((x) => [x.key, x.type]));
      for (const k of offered.filter((k) => k !== "hours")) {
        const tag = f.get(`fact.${k}`)![0];
        const type = types.get(k);
        if (type === "boolean") expect(tag, k).toMatch(/^<select/);
        if (type === "time") expect(attr(tag, "type"), k).toBe("time");
        if (type === "url") expect(attr(tag, "type"), k).toBe("url");
        if (type === "number") expect(attr(tag, "inputmode"), k).toBe("decimal");
      }
    }
    const dtfFacts = [...fields(formOf(html(outs.dtf, "/add-your-shop/"))).keys()];
    expect(dtfFacts).toContain("fact.dtf_same_day_cutoff");
    expect(dtfFacts.some((k) => k.startsWith("fact.laser_"))).toBe(false);
  });

  it("shows each outcome's message for a post made without JavaScript", () => {
    const page = html(outs.dtf, "/add-your-shop/");
    for (const o of OUTCOMES) {
      expect(page, o).toContain(`id="form-${o}" class="form-outcome ${o === "sent" ? "ok" : "bad"}">${MESSAGES[o].replaceAll("'", "&#39;")}</p>`);
    }
  });
});

describe("shop page report form", () => {
  it("posts the shop's id and a report to /report-change/, and links the claim form with the shop picked", () => {
    const p = firstShop("dtf");
    const page = html(outs.dtf, p.path);
    const form = formOf(page);
    expect(attr(form, "action")).toBe(REPORT_ACTION);
    const f = fields(form);
    expect(attr(f.get("listing")![0], "value")).toBe(p.listingIds![0]);
    expect(attr(f.get("return")![0], "value")).toBe(p.path);
    expect(Number(attr(f.get("detail")![0], "maxlength"))).toBe(FIELD_LIMITS.detail);
    expect(page).toContain(`href="${claimHref(p.listingIds![0])}"`);
  });
});

describe("spam protection", () => {
  it("every form has the hidden honeypot field", () => {
    for (const page of [html(outs.dtf, "/add-your-shop/"), html(outs.dtf, firstShop("dtf").path)]) {
      const hp = fields(formOf(page)).get(HONEYPOT)![0];
      expect(attr(hp, "tabindex")).toBe("-1");
      expect(page).toMatch(/<div class="hp" aria-hidden="true">/);
    }
  });

  it("renders Turnstile only when the build has TURNSTILE_SITE_KEY", () => {
    expect(turnstileSiteKey({})).toBeNull();
    expect(turnstileSiteKey({ TURNSTILE_SITE_KEY: "  " })).toBeNull();
    for (const path of ["/add-your-shop/", firstShop("dtf").path]) {
      expect(html(outs.dtf, path), path).not.toContain("cf-turnstile");
      expect(html(outs.dtf, path), path).not.toContain("challenges.cloudflare.com");
      const keyed = html(outs.keyed, path);
      expect(formOf(keyed), path).toContain(`<div class="cf-turnstile" data-sitekey="${SITE_KEY}"></div>`);
      expect(keyed, path).toContain('src="https://challenges.cloudflare.com/turnstile/v0/api.js"');
    }
  });
});

describe("host routing", () => {
  it("sends /submit-claim/ and /report-change/ to their functions with this site's slug", async () => {
    const base = "https://ref.supabase.co/functions/v1";
    const rules = netlifyRedirects("dtf", base);
    expect(rules).toContain(`/submit-claim/*   ${base}/submit-claim/dtf/:splat   200!`);
    expect(rules).toContain(`/report-change/*  ${base}/report-change/dtf/:splat  200!`);
    const worker = (await import(`data:text/javascript;base64,${Buffer.from(cloudflareWorker("dtf", base)).toString("base64")}`)).default;
    const calls: { url: string; init: RequestInit }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => (calls.push({ url, init }), new Response("{}"))) as typeof fetch;
    try {
      for (const fn of ["submit-claim", "report-change"]) {
        await worker.fetch(new Request(`https://dtf.example/${fn}/`, {
          method: "POST", body: "a=1", headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded", cookie: "x=1" },
        }), { ASSETS: { fetch: () => new Response("static") } });
      }
      expect(calls.map((c) => c.url)).toEqual([`${base}/submit-claim/dtf/`, `${base}/report-change/dtf/`]);
      const h = calls[0].init.headers as Headers;
      expect(h.get("accept")).toBe("application/json");
      expect(h.get("content-type")).toBe("application/x-www-form-urlencoded");
      expect(h.get("cookie")).toBeNull();
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("page script (JavaScript on)", () => {
  /** Loads built HTML into happy-dom and runs the form script with a stand-in for the function. */
  function load(page: string, answer: { status: number; body: unknown }) {
    const window = new Window({ url: "https://dtf.example/add-your-shop/" });
    const document = window.document;
    document.write(page.replace(/<script[\s\S]*?<\/script>/g, ""));
    const script = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).find((s) => s.includes("data-public-form"));
    if (!script) throw new Error("no form script");
    const sent: { url: string; init: RequestInit }[] = [];
    const fetch = async (url: string, init: RequestInit) => {
      sent.push({ url, init });
      return { json: async () => answer.body, status: answer.status };
    };
    new Function("document", "fetch", "URLSearchParams", "FormData", "window", script)(
      document, fetch, URLSearchParams, window.FormData, {},
    );
    return { document, sent };
  }
  const flush = () => new Promise((r) => setTimeout(r, 10));

  it("sends the form as JSON-accepting form post and shows the answer, hiding the form on success", async () => {
    const { document, sent } = load(html(outs.dtf, "/add-your-shop/"), { status: 200, body: { ok: true, outcome: "sent", message: MESSAGES.sent } });
    const form = document.querySelector("form[data-public-form]") as any;
    (document.getElementById("name") as any).value = "Example New Prints";
    (document.getElementById("contact_email") as any).value = "owner@example.com";
    form.dispatchEvent(new (document.defaultView as any).Event("submit", { cancelable: true }));
    await flush();
    expect(sent[0].url).toContain(CLAIM_ACTION);
    expect((sent[0].init.headers as Record<string, string>).Accept).toBe("application/json");
    const body = new URLSearchParams(String(sent[0].init.body));
    expect(body.get("name")).toBe("Example New Prints");
    expect(body.get("contact_email")).toBe("owner@example.com");
    expect(document.querySelector("[data-form-status]")!.textContent).toBe(MESSAGES.sent);
    expect(form.hidden).toBe(true);
  });

  it("shows each field's error next to it and keeps the form", async () => {
    const { document } = load(html(outs.dtf, "/add-your-shop/"), {
      status: 400, body: { ok: false, outcome: "invalid", message: MESSAGES.invalid, errors: { contact_email: "Enter an email address we can reach you at.", "fact.dtf_same_day_cutoff": "Enter a time like 14:00." } },
    });
    const form = document.querySelector("form[data-public-form]") as any;
    form.dispatchEvent(new (document.defaultView as any).Event("submit", { cancelable: true }));
    await flush();
    expect(document.querySelector("[data-form-status]")!.textContent).toBe(MESSAGES.invalid);
    expect(document.querySelector('[data-error-for="contact_email"]')!.textContent).toBe("Enter an email address we can reach you at.");
    expect(document.querySelector('[data-error-for="fact.dtf_same_day_cutoff"]')!.textContent).toBe("Enter a time like 14:00.");
    expect(form.hidden).toBe(false);
  });
});
