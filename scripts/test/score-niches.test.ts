// score-niches with recorded-shape DataForSEO responses and a stubbed fetch. No network.

import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  API_BASE, assessBeatable, cacheKey, collectKeywords, DEMAND_MIN, DfsClient, ENDPOINTS, isExcluded, main,
  normalizeKeyword, parseSerp, REAL_TRAFFIC_MIN, stableJson, summarizeDemand, validateCandidates, WEAK_MAX_DOMAIN_ETV,
  WEAK_MAX_RANK, type DomainStats, type Fetch, type Idea,
} from "../score-niches.ts";

const LOGIN = "chris-login-do-not-print@example.test";
const PASSWORD = "pw-secret-do-not-print-91";
const B64 = Buffer.from(`${LOGIN}:${PASSWORD}`).toString("base64");
const ENV = { DATAFORSEO_LOGIN: LOGIN, DATAFORSEO_PASSWORD: PASSWORD };

const IDEA: Idea = {
  slug: "knife-sharpening",
  name: "Knife sharpening",
  seeds: ["knife sharpening near me", "knife sharpening service"],
  core: ["knife sharpening near me"],
  exclude: ["stone", "how to"],
};

// ---------------------------------------------------------------- recorded-shape responses

const envelope = (tasks: unknown[], cost: number) => ({
  version: "0.1.20261101", status_code: 20000, status_message: "Ok.", time: "0.5 sec.", cost, tasks_count: tasks.length, tasks_error: 0, tasks,
});
const task = (path: string, cost: number, result: unknown[], status = 20000) => ({
  id: "11251200-1535-0216-0000-a0b1c2d3e4f5", status_code: status, status_message: status === 20000 ? "Ok." : "Access denied.",
  time: "0.4 sec.", cost, result_count: result.length, path: path.split("/"), data: { api: path.split("/")[0] }, result,
});

function responses(opts: { volume?: number; ranksStatus?: number; smallEtv?: number } = {}) {
  const v = opts.volume ?? 60_500;
  return {
    [ENDPOINTS.searchVolume]: envelope([task(ENDPOINTS.searchVolume, 0.09, [
      { keyword: "knife sharpening near me", spell: null, location_code: 2840, language_code: "en", search_partners: false, competition: "LOW", competition_index: 12, search_volume: v, low_top_of_page_bid: 0.8, high_top_of_page_bid: 2.9, cpc: 1.5, monthly_searches: [] },
      { keyword: "knife sharpening service", spell: null, location_code: 2840, language_code: "en", search_partners: false, competition: "LOW", competition_index: 20, search_volume: 4_400, low_top_of_page_bid: 1.1, high_top_of_page_bid: 4.2, cpc: 3.0, monthly_searches: [] },
    ])], 0.09),
    [ENDPOINTS.keywordSuggestions]: envelope([task(ENDPOINTS.keywordSuggestions, 0.0132, [{
      se_type: "google", seed_keyword: "knife sharpening near me", seed_keyword_data: null, location_code: 2840, language_code: "en", total_count: 6, items_count: 6, offset: 0, offset_token: "x",
      items: [
        { se_type: "google", keyword: "knife sharpening near me", keyword_info: { search_volume: 60_500, cpc: 1.4 } },
        { se_type: "google", keyword: "knife sharpenings near me", keyword_info: { search_volume: 60_500, cpc: 1.4 } },
        { se_type: "google", keyword: "knife sharpening stone near me", keyword_info: { search_volume: 9_900, cpc: 0.7 } },
        { se_type: "google", keyword: "knife sharpening near me open now", keyword_info: { search_volume: 2_900, cpc: 1.2 } },
        { se_type: "google", keyword: "mobile knife sharpening near me", keyword_info: { search_volume: 1_600, cpc: null } },
        { se_type: "google", keyword: "zero volume knife sharpening", keyword_info: { search_volume: 0, cpc: 0.5 } },
      ],
    }])], 0.0132),
    [ENDPOINTS.serpOrganic]: envelope([task(ENDPOINTS.serpOrganic, 0.002, [{
      keyword: "knife sharpening near me", type: "organic", se_domain: "google.com", location_code: 2840, language_code: "en", items_count: 4,
      items: [
        { type: "organic", rank_group: 1, rank_absolute: 1, domain: "www.yelp.com", url: "https://www.yelp.com/search?find_desc=knife+sharpening", title: "Top 10 Best Knife Sharpening Near Me" },
        { type: "paid", rank_group: 1, rank_absolute: 2, domain: "ads.example.com", url: "https://ads.example.com/", title: "Ad" },
        { type: "organic", rank_group: 2, rank_absolute: 3, domain: "sharpeningdirectory.example", url: "https://sharpeningdirectory.example/", title: "Find a sharpener" },
        { type: "organic", rank_group: 9, rank_absolute: 10, domain: "tinyblog.example", url: "https://tinyblog.example/post", title: "A post" },
      ],
    }])], 0.002),
    [ENDPOINTS.bulkTraffic]: envelope([task(ENDPOINTS.bulkTraffic, 0.01236, [{
      se_type: "google", location_code: 2840, language_code: "en", total_count: 2, items_count: 2,
      items: [
        { se_type: "google", target: "yelp.com", metrics: { organic: { etv: 151_000_000.5, count: 9_800_000 }, paid: null, local_pack: null, featured_snippet: null } },
        { se_type: "google", target: "sharpeningdirectory.example", metrics: { organic: { etv: opts.smallEtv ?? 4_200.2, count: 860 }, paid: null, local_pack: null, featured_snippet: null } },
      ],
    }])], 0.01236),
    [ENDPOINTS.bulkRanks]: envelope([task(ENDPOINTS.bulkRanks, 0.024108, opts.ranksStatus && opts.ranksStatus !== 20000 ? [] : [{
      total_count: 3, items_count: 3,
      items: [{ target: "yelp.com", rank: 712 }, { target: "sharpeningdirectory.example", rank: 141 }, { target: "tinyblog.example", rank: 40 }],
    }], opts.ranksStatus ?? 20000)], 0.024108),
  } as Record<string, unknown>;
}

interface Sent { url: string; headers: Record<string, string>; body: unknown[] }

function stubFetch(table: Record<string, unknown>) {
  const sent: Sent[] = [];
  const fetchFn: Fetch = async (url, init) => {
    sent.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const endpoint = url.slice(API_BASE.length + 1);
    const res = table[endpoint];
    if (!res) return { ok: false, status: 404, text: async () => JSON.stringify({ status_code: 40400, status_message: "Not Found." }) };
    return { ok: true, status: 200, text: async () => JSON.stringify(res) };
  };
  return { fetchFn, sent };
}

let root: string;
const logs: string[] = [];
const errors: string[] = [];

function writeCandidates(ideas: Idea[]) {
  mkdirSync(join(root, "niches"), { recursive: true });
  writeFileSync(join(root, "niches", "candidates.json"), JSON.stringify({ ideas }));
}

const deps = (fetchFn: Fetch) => ({
  fetch: fetchFn, root, log: (m: string) => logs.push(m), error: (m: string) => errors.push(m), now: () => new Date("2026-11-25T12:00:00Z"),
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "score-niches-"));
  logs.length = 0;
  errors.length = 0;
  writeCandidates([IDEA]);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

// ---------------------------------------------------------------- pure parts

describe("candidates", () => {
  it("the committed candidates.json is valid and has the seed ideas", () => {
    const raw = JSON.parse(readFileSync(join(__dirname, "..", "..", "niches", "candidates.json"), "utf8"));
    const v = validateCandidates(raw);
    expect(v.errors).toEqual([]);
    for (const s of ["laser-engraving", "dtf-transfers", "24-hour-laundromat", "scrap-yards", "knife-sharpening", "sewing-machine-repair", "kiln-firing", "e-waste-recycling", "paper-shredding"]) {
      expect(v.ideas.map((i) => i.slug)).toContain(s);
    }
  });

  it("rejects bad slugs, duplicates, missing seeds and too many core terms", () => {
    const v = validateCandidates({ ideas: [
      { slug: "Bad Slug", name: "x", seeds: ["a"], core: ["a"] },
      { slug: "ok", name: "x", seeds: [], core: ["a"] },
      { slug: "ok", name: "x", seeds: ["a"], core: ["a", "b", "c", "d"] },
    ] });
    expect(v.errors.join("\n")).toMatch(/slug must be/);
    expect(v.errors.join("\n")).toMatch(/seeds must be/);
    expect(v.errors.join("\n")).toMatch(/duplicate slug/);
    expect(v.errors.join("\n")).toMatch(/core must be/);
    expect(validateCandidates({}).errors).toHaveLength(1);
  });
});

describe("Demand", () => {
  const ads = (responses()[ENDPOINTS.searchVolume] as { tasks: { result: never[] }[] }).tasks[0].result;
  const sugg = ((responses()[ENDPOINTS.keywordSuggestions] as { tasks: { result: { items: never[] }[] }[] }).tasks[0].result[0]).items;

  it("counts seeds from Google Ads, adds variants, drops excluded and zero-volume terms, merges plurals", () => {
    const rows = collectKeywords(IDEA, ads, sugg);
    expect(rows.map((r) => [r.keyword, r.volume, r.source])).toEqual([
      ["knife sharpening near me", 60_500, "seed"],
      ["knife sharpening service", 4_400, "seed"],
      ["knife sharpening near me open now", 2_900, "variant"],
      ["mobile knife sharpening near me", 1_600, "variant"],
    ]);
    const d = summarizeDemand(rows);
    expect(d.total).toBe(69_400);
    expect(d.pass).toBe(false);
    expect(d.cpcMax).toBe(3.0);
    // weighted by searches, only over keywords with a CPC
    expect(d.cpcAvg).toBeCloseTo((60_500 * 1.5 + 4_400 * 3.0 + 2_900 * 1.2) / (60_500 + 4_400 + 2_900), 6);
  });

  it("passes at exactly the threshold and fails one below", () => {
    expect(summarizeDemand([{ keyword: "a", volume: DEMAND_MIN, cpc: null, source: "seed" }]).pass).toBe(true);
    expect(summarizeDemand([{ keyword: "a", volume: DEMAND_MIN - 1, cpc: null, source: "seed" }]).pass).toBe(false);
    expect(summarizeDemand([]).cpcAvg).toBeNull();
  });

  it("matches exclusions on whole words and folds singular and plural", () => {
    expect(isExcluded("knife sharpening stone near me", ["stone"])).toBe(true);
    expect(isExcluded("knife sharpening stoneware", ["stone"])).toBe(false);
    expect(isExcluded("How to sharpen", ["how to"])).toBe(true);
    expect(normalizeKeyword("Laser Engravers near me")).toBe(normalizeKeyword("laser engraver near me"));
    expect(normalizeKeyword("glass near me")).not.toBe(normalizeKeyword("glas near me"));
  });
});

describe("Beatable", () => {
  const serp = (results: [number, string][], volume = 10_000) => ({ term: "t", volume, results: results.map(([position, domain]) => ({ position, domain, url: "" })) });
  const stats = (o: Record<string, Partial<DomainStats>>) => new Map(Object.entries(o).map(([k, v]) => [k, { etv: 0, keywords: 0, rank: null, ...v }]));

  it("passes when a small site gets real traffic from a core term", () => {
    const b = assessBeatable([serp([[1, "yelp.com"], [2, "small.example"]])], stats({ "yelp.com": { etv: 1e8, rank: 700 }, "small.example": { etv: 3_000, rank: 120 } }));
    expect(b.pass).toBe(true);
    expect(b.weakest?.domain).toBe("small.example");
    expect(b.weakest?.termVisits).toBe(1_500); // 10,000 x 15%
  });

  it("fails when the only small site gets too little traffic from the term", () => {
    // position 10 at 2%: 4,000 x 0.02 = 80 visits, under REAL_TRAFFIC_MIN
    const b = assessBeatable([serp([[1, "yelp.com"], [10, "small.example"]], 4_000)], stats({ "yelp.com": { etv: 1e8 }, "small.example": { etv: 10 } }));
    expect(80).toBeLessThan(REAL_TRAFFIC_MIN);
    expect(b.pass).toBe(false);
    expect(b.weakest?.domain).toBe("yelp.com");
  });

  it("fails when every site with real traffic is big by traffic or by rank", () => {
    const b = assessBeatable([serp([[1, "big.example"], [2, "linked.example"]])], stats({
      "big.example": { etv: WEAK_MAX_DOMAIN_ETV + 1, rank: 100 },
      "linked.example": { etv: 500, rank: WEAK_MAX_RANK + 1 },
    }));
    expect(b.pass).toBe(false);
  });

  it("uses traffic alone when no rank is known, and treats a domain Labs doesn't know as small", () => {
    expect(assessBeatable([serp([[1, "norank.example"]])], stats({ "norank.example": { etv: WEAK_MAX_DOMAIN_ETV } })).pass).toBe(true);
    expect(assessBeatable([serp([[1, "unknown.example"]])], new Map()).pass).toBe(true);
  });

  it("reads only organic results from a SERP and strips www.", () => {
    const t = (responses()[ENDPOINTS.serpOrganic] as { tasks: never[] }).tasks[0];
    const s = parseSerp("knife sharpening near me", 60_500, t);
    expect(s.results.map((r) => [r.position, r.domain])).toEqual([[1, "yelp.com"], [2, "sharpeningdirectory.example"], [9, "tinyblog.example"]]);
  });
});

describe("cache keys", () => {
  it("ignore key order and differ by endpoint and payload", () => {
    expect(stableJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe('{"a":[{"c":3,"d":2}],"b":1}');
    expect(cacheKey("x/y", { a: 1, b: 2 })).toBe(cacheKey("x/y", { b: 2, a: 1 }));
    expect(cacheKey("x/y", { a: 1 })).not.toBe(cacheKey("x/z", { a: 1 }));
    expect(cacheKey("x/y", { a: 1 })).not.toBe(cacheKey("x/y", { a: 2 }));
  });
});

// ---------------------------------------------------------------- the run

describe("main", () => {
  it("scores an idea end to end and writes scores.md with the gates and blank human columns", async () => {
    const { fetchFn, sent } = stubFetch(responses({ volume: 96_000 }));
    expect(await main([], ENV, deps(fetchFn))).toBe(0);
    expect(sent.map((s) => s.url.slice(API_BASE.length + 1))).toEqual([
      ENDPOINTS.searchVolume, ENDPOINTS.keywordSuggestions, ENDPOINTS.serpOrganic, ENDPOINTS.bulkTraffic, ENDPOINTS.bulkRanks,
    ]);
    // one task per POST, US English, basic auth
    expect(sent[0].body).toEqual([{ keywords: IDEA.seeds, location_code: 2840, language_code: "en" }]);
    expect(sent[0].headers.Authorization).toBe(`Basic ${B64}`);
    expect(sent[3].body).toEqual([{ targets: ["sharpeningdirectory.example", "tinyblog.example", "yelp.com"], location_code: 2840, language_code: "en", item_types: ["organic"] }]);

    const md = readFileSync(join(root, "niches", "scores.md"), "utf8");
    // 96,000 + 4,400 + 2,900 + 1,600 = 104,900: passes
    expect(md).toMatch(/\| Knife sharpening \| 104,900 \| pass \| \$1\.\d\d \(\$3\.00\) \| tinyblog\.example \(#9 for "knife sharpening near me", ~2,400\/mo from it; site ~0\/mo, rank 40\) \| pass \| {2}\| {2}\| {2}\|/);
    expect(md).toContain("DataForSEO spend this run: $0.1417");
    expect(logs.at(-1)).toMatch(/Scored 1 of 1 idea\. 5 calls sent, 0 from cache\. Spent \$0\.1417/);
  });

  it("falls back to Labs traffic when the Backlinks task is refused", async () => {
    const { fetchFn } = stubFetch(responses({ ranksStatus: 40204 }));
    expect(await main([], ENV, deps(fetchFn))).toBe(0);
    const md = readFileSync(join(root, "niches", "scores.md"), "utf8");
    expect(md).toMatch(/Backlinks rank unavailable \(task status 40204 Access denied\.\)/);
    expect(md).toMatch(/Beatable pass \(Labs traffic only\)/);
  });

  it("uses the newest Labs SERP snapshot when the live SERP API refuses the account, and says so", async () => {
    const table = responses({ volume: 96_000 });
    const live = (table[ENDPOINTS.serpOrganic] as { tasks: { result: { items: unknown[] }[] }[] }).tasks[0].result[0].items;
    delete table[ENDPOINTS.serpOrganic];
    table[ENDPOINTS.historicalSerps] = envelope([task(ENDPOINTS.historicalSerps, 0.00024, [{
      se_type: "google", keyword: "knife sharpening near me", location_code: 2840, language_code: "en", total_count: 2, items_count: 2,
      items: [
        { type: "google_serp", datetime: "2026-09-14 03:00:00 +00:00", items: [{ type: "organic", rank_group: 1, domain: "old.example", url: "https://old.example/" }] },
        { type: "google_serp", datetime: "2026-10-14 03:00:00 +00:00", items: live },
      ],
    }])], 0.00024);
    const { fetchFn: base, sent } = stubFetch(table);
    const fetchFn: Fetch = async (url, init) => url.endsWith(ENDPOINTS.serpOrganic)
      ? (sent.push({ url, headers: init.headers, body: JSON.parse(init.body) }), { ok: false, status: 403, text: async () => JSON.stringify({ status_code: 40104, status_message: "Please verify your account before using the API.", cost: 0, tasks: [] }) })
      : base(url, init);
    expect(await main([], ENV, deps(fetchFn))).toBe(0);
    expect(sent.map((s) => s.url.slice(API_BASE.length + 1))).toEqual([
      ENDPOINTS.searchVolume, ENDPOINTS.keywordSuggestions, ENDPOINTS.serpOrganic, ENDPOINTS.historicalSerps, ENDPOINTS.bulkTraffic, ENDPOINTS.bulkRanks,
    ]);
    expect(sent[3].body).toEqual([{ keyword: "knife sharpening near me", location_code: 2840, language_code: "en" }]);
    const md = readFileSync(join(root, "niches", "scores.md"), "utf8");
    expect(md).toMatch(/\| Knife sharpening \| 104,900 \| pass \| .* \| tinyblog\.example \(#9/);
    expect(md).not.toContain("old.example");
    expect(md).toContain("Labs snapshot of 2026-10-14");
    expect(md).toContain("40104");
  });

  it("the cache makes a second run free: no request is sent", async () => {
    const first = stubFetch(responses());
    expect(await main([], ENV, deps(first.fetchFn))).toBe(0);
    expect(first.sent).toHaveLength(5);
    const firstMd = readFileSync(join(root, "niches", "scores.md"), "utf8");

    const second = stubFetch({}); // any request would 404
    expect(await main([], ENV, deps(second.fetchFn))).toBe(0);
    expect(second.sent).toHaveLength(0);
    expect(logs.at(-1)).toMatch(/0 calls sent, 5 from cache\. Spent \$0\.0000/);
    expect(readFileSync(join(root, "niches", "scores.md"), "utf8").replace(/spend this run: \$[\d.]+/, "")).toBe(firstMd.replace(/spend this run: \$[\d.]+/, ""));
  });

  it("does not cache a refused task, so it is retried next time", async () => {
    const t = stubFetch(responses({ ranksStatus: 40204 }));
    await main([], ENV, deps(t.fetchFn));
    const files = readdirSync(join(root, "niches", ".cache"));
    expect(files).toHaveLength(4);
    expect(files.some((f) => f.startsWith("backlinks_"))).toBe(false);
  });

  it("the budget stops the run before a call that could pass it, and says so", async () => {
    writeCandidates([IDEA, { ...IDEA, slug: "second-idea", name: "Second", seeds: ["second near me"], core: ["second near me"] }]);
    const { fetchFn, sent } = stubFetch(responses());
    // first idea costs about $0.14; the second idea's first call ($0.09 worst case) would pass $0.20
    expect(await main(["--budget", "0.2"], ENV, deps(fetchFn))).toBe(1);
    expect(sent).toHaveLength(5);
    expect(errors.join("\n")).toMatch(/second-idea: budget stop: \$0\.1417 spent, next call .* could cost up to \$0\.0900, budget is \$0\.20/);
    const md = readFileSync(join(root, "niches", "scores.md"), "utf8");
    expect(md).toContain("| Knife sharpening |");
    expect(md).toMatch(/\| second-idea \| \| not scored \| \| \| \|/);
    expect(md).toContain("- **second-idea:** budget reached");
  });

  it("counts the cost each response reports, not the estimate", async () => {
    const client = new DfsClient({ fetch: stubFetch(responses()).fetchFn, creds: { login: LOGIN, password: PASSWORD }, cacheDir: join(root, "c"), budget: 1, dryRun: false });
    await client.call("x", ENDPOINTS.searchVolume, { keywords: ["a"] }, 0.5);
    expect(client.spent).toBe(0.09);
  });

  it("--dry-run lists the planned calls with costs and makes no request", async () => {
    let fetched = 0;
    const fetchFn: Fetch = async () => { fetched++; throw new Error("no network in a dry run"); };
    expect(await main(["--dry-run"], {}, deps(fetchFn))).toBe(0);
    expect(fetched).toBe(0);
    expect(existsSync(join(root, "niches", "scores.md"))).toBe(false);
    const out = logs.join("\n");
    expect(out).toMatch(/Dry run: 5 calls for 1 idea, 5 not cached\. Nothing sent\./);
    expect(out).toContain(`$0.0900  ${ENDPOINTS.searchVolume}`);
    expect(out).toContain(`$0.0240  ${ENDPOINTS.keywordSuggestions}`);
    expect(out).toContain(`$0.0020  ${ENDPOINTS.serpOrganic}`);
    expect(out).toContain(`$0.0132  ${ENDPOINTS.bulkTraffic}  knife-sharpening: traffic for up to 10 domains`);
    expect(out).toContain(`$0.0244  ${ENDPOINTS.bulkRanks}`);
    expect(out).toMatch(/Estimated cost \(worst case\): \$0\.1536; budget \$5\.00\./);
  });

  it("--dry-run after a real run shows everything cached at no cost", async () => {
    await main([], ENV, deps(stubFetch(responses()).fetchFn));
    logs.length = 0;
    const fetchFn: Fetch = async () => { throw new Error("no network"); };
    expect(await main(["--dry-run"], {}, deps(fetchFn))).toBe(0);
    expect(logs.join("\n")).toMatch(/5 calls for 1 idea, 0 not cached/);
    expect(logs.join("\n")).toMatch(/Estimated cost \(worst case\): \$0\.0000/);
  });

  it("--only picks ideas and rejects unknown slugs", async () => {
    writeCandidates([IDEA, { ...IDEA, slug: "other", name: "Other", seeds: ["other near me"], core: ["other near me"] }]);
    expect(await main(["--dry-run", "--only", "other"], {}, deps(async () => { throw new Error(); }))).toBe(0);
    expect(logs.join("\n")).toContain("for 1 idea");
    expect(logs.join("\n")).not.toContain("knife-sharpening:");
    expect(await main(["--dry-run", "--only", "nope"], {}, deps(async () => { throw new Error(); }))).toBe(1);
    expect(errors.at(-1)).toMatch(/unknown idea "nope"/);
  });

  it("missing credentials without --dry-run is a clear error, and nothing is fetched", async () => {
    let fetched = 0;
    const fetchFn: Fetch = async () => { fetched++; throw new Error(); };
    expect(await main([], {}, deps(fetchFn))).toBe(2);
    expect(await main([], { DATAFORSEO_LOGIN: LOGIN }, deps(fetchFn))).toBe(2);
    expect(errors.at(-1)).toMatch(/DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD must be set/);
    expect(errors.join("\n")).not.toContain(LOGIN);
    expect(fetched).toBe(0);
    expect(await main(["--budget", "-1", "--dry-run"], {}, deps(fetchFn))).toBe(2);
  });

  it("credentials never reach scores.md, the cache or the log, even if the API echoes them", async () => {
    const table = responses({ volume: 96_000 });
    // A hostile or buggy response carrying the credentials in every place we keep.
    const serp = table[ENDPOINTS.serpOrganic] as { tasks: { result: { items: { domain: string; url: string; title: string }[] }[] }[] };
    serp.tasks[0].result[0].items[2].url = `https://x.example/?u=${LOGIN}&p=${PASSWORD}&a=${B64}`;
    serp.tasks[0].result[0].items[2].domain = `${PASSWORD}.example`;
    const { fetchFn } = stubFetch(table);
    expect(await main([], ENV, deps(fetchFn))).toBe(0);
    const scoresMd = readFileSync(join(root, "niches", "scores.md"), "utf8");
    expect(scoresMd).toContain("[redacted]");
    // and an error path that would quote the response
    const failing: Fetch = async () => ({ ok: false, status: 401, text: async () => `{"status_code":40100,"status_message":"bad login ${LOGIN} ${PASSWORD}"}` });
    writeCandidates([{ ...IDEA, slug: "fresh", seeds: ["fresh near me"], core: ["fresh near me"] }]);
    expect(await main([], ENV, deps(failing))).toBe(1);

    const outputs = [
      scoresMd,
      readFileSync(join(root, "niches", "scores.md"), "utf8"),
      ...readdirSync(join(root, "niches", ".cache")).map((f) => readFileSync(join(root, "niches", ".cache", f), "utf8")),
      logs.join("\n"),
      errors.join("\n"),
    ];
    expect(outputs.length).toBeGreaterThan(5);
    for (const o of outputs) {
      expect(o).not.toContain(LOGIN);
      expect(o).not.toContain(PASSWORD);
      expect(o).not.toContain(B64);
    }
    expect(errors.join("\n")).toMatch(/status 40100 bad login \[redacted\] \[redacted\]/);
  });
});
