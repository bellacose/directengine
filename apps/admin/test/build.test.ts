// The built admin app: never indexed, and no service role key can reach it.

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const app = join(__dirname, "..");
const dist = join(app, "dist");
// The admin app's own vite, wherever npm hoisted it.
const viteBin = join(createRequire(join(app, "package.json")).resolve("vite/package.json"), "..", "bin", "vite.js");
const DUMMY_SERVICE_KEY = "dummy-service-role-key-must-never-ship";
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));

beforeAll(() => {
  // Build with a service role key present in the environment, as on a careless host.
  execFileSync(process.execPath, [viteBin, "build", "--logLevel", "error"], {
    cwd: app,
    env: {
      // A clean environment: vitest's own variables (NODE_ENV=test and others) would give a dev build.
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(NODE_ENV|VITE|VITEST|TEST)/i.test(k))),
      SUPABASE_SERVICE_ROLE_KEY: DUMMY_SERVICE_KEY,
      VITE_SUPABASE_URL: "https://example.supabase.co",
      VITE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_dummy",
    },
    stdio: "pipe",
  });
}, 120_000);

describe("admin build", () => {
  it("every page says noindex, and the host is told the same", () => {
    expect(readFileSync(join(dist, "index.html"), "utf8")).toMatch(/<meta name="robots" content="noindex, nofollow"/);
    expect(readFileSync(join(dist, "_headers"), "utf8")).toMatch(/X-Robots-Tag: noindex, nofollow/);
    expect(readFileSync(join(dist, "robots.txt"), "utf8")).toMatch(/Disallow: \//);
  });

  it("contains no service role key and only the publishable key", () => {
    const all = files(dist).map((f) => readFileSync(f, "utf8")).join("\n");
    expect(all).not.toContain(DUMMY_SERVICE_KEY);
    expect(all).not.toMatch(/service_role/i);
    expect(all).toContain("sb_publishable_dummy");
  });

  it("leaves out the demo mode and its in-browser database", () => {
    const names = files(dist).map((f) => f.toLowerCase());
    expect(names.filter((f) => /pglite|\.wasm$|\.data$/.test(f))).toEqual([]);
    const all = files(dist).map((f) => readFileSync(f, "utf8")).join("\n");
    expect(all).not.toContain("demo-admin@example.com");
    expect(all).not.toMatch(/Example DTF Tampa/);
  });

  it("bundles every site config for the coverage panel", () => {
    const js = files(dist).filter((f) => f.endsWith(".js")).map((f) => readFileSync(f, "utf8")).join("\n");
    const slugs = readdirSync(join(app, "..", "..", "sites")).filter((f) => f.endsWith(".json") && f !== "guides.json").map((f) => f.replace(".json", ""));
    const q = "[`\"']"; // minifiers quote strings with any of these
    for (const s of slugs) expect(js).toMatch(new RegExp(`slug:${q}${s}${q}`));
  });
});
