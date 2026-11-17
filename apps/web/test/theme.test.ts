// Site themes from Tailwind files (D30): token mapping for v3 configs and v4 @theme CSS, color
// parsing for the contrast checks, and every site's theme resolving without errors.
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { contrast, parseColor, resolveTheme, resolveVars, rootVariables, tokensFromConfig, tokensFromCss } from "../src/lib/theme.ts";
import { root } from "./helpers.ts";

const tmp = mkdtempSync(join(tmpdir(), "theme-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const brand = { primary: "#1d4ed8", accent: "#b45309" };
function themeDir(name: string, files: Record<string, string>) {
  const dir = join(tmp, "sites", "themes", name);
  mkdirSync(join(dir, "fonts"), { recursive: true });
  for (const [f, body] of Object.entries(files)) writeFileSync(join(dir, f), body);
  return dir;
}

describe("tokens from a Tailwind v3 config", () => {
  it("reads semantic colors (DEFAULT, then shades), fonts and radius, extend winning over theme", () => {
    const t = tokensFromConfig({
      theme: {
        colors: { primary: "#000000" },
        fontFamily: { sans: ["Inter", "sans-serif"] },
        extend: {
          colors: {
            primary: { DEFAULT: "#0b0f14", foreground: "#ffffff" },
            accent: { 500: "#3355ff", 600: "#0072b5" },
            background: "#ffffff",
            foreground: "#111111",
            muted: { DEFAULT: "#f2f5f7", foreground: "#56606b" },
            border: "#dfe4e8",
          },
          fontFamily: { display: ["Space Grotesk", "system-ui"] },
          borderRadius: { lg: "0.5rem" },
        },
      },
    });
    expect(t).toMatchObject({
      primary: "#0b0f14", primaryForeground: "#ffffff", accent: "#0072b5", background: "#ffffff", foreground: "#111111",
      surface: "#f2f5f7", muted: "#56606b", border: "#dfe4e8", radius: "0.5rem",
      fontSans: '"inter", sans-serif', fontDisplay: '"space grotesk", system-ui',
    });
  });

  it("accepts a module namespace with a default export", () => {
    expect(tokensFromConfig({ default: { theme: { extend: { colors: { primary: "#123456" } } } } }).primary).toBe("#123456");
  });
});

describe("tokens from a Tailwind v4 stylesheet", () => {
  it("reads --color-*, --font-* and --radius from @theme blocks only", () => {
    const t = tokensFromCss(`
      @import "tailwindcss";
      :root { --color-primary: #ff0000; }
      @theme {
        --color-primary: oklch(0.2 0.02 250);
        --color-accent: #0072b5;
        --color-muted: #f2f5f7;
        --color-muted-foreground: #56606b;
        --font-sans: "Inter", ui-sans-serif, system-ui;
        --radius: 4px;
      }`);
    expect(t).toMatchObject({
      primary: "oklch(0.2 0.02 250)", accent: "#0072b5", surface: "#f2f5f7", muted: "#56606b",
      fontSans: '"inter", ui-sans-serif, system-ui', radius: "4px",
    });
  });
});

describe("colors", () => {
  it("parses hex, rgb, hsl and oklch, and refuses var()", () => {
    expect(parseColor("#fff")).toEqual([1, 1, 1]);
    expect(parseColor("rgb(0 0 0)")).toEqual([0, 0, 0]);
    expect(parseColor("hsl(0 100% 50%)")!.map((x) => Math.round(x * 255))).toEqual([255, 0, 0]);
    expect(parseColor("oklch(1 0 0)")!.map((x) => Math.round(x * 255))).toEqual([255, 255, 255]);
    expect(parseColor("hsl(var(--primary))")).toBeNull();
    expect(contrast([0, 0, 0], [1, 1, 1])).toBeCloseTo(21, 0);
  });
});

describe("resolveTheme", () => {
  it("uses brand colors when the site has no theme", async () => {
    const r = await resolveTheme(tmp, { slug: "x", brand });
    expect(r.errors).toEqual([]);
    expect(r.css).toContain("--brand:#1d4ed8");
    expect(r.themeColor).toBe("#1d4ed8");
  });

  it("lets the theme override brand colors, lowercases font names, and serves theme fonts", async () => {
    themeDir("good", {
      "tailwind.config.mjs": `export default { theme: { extend: { colors: { primary: "#0b0f14", accent: "#0072b5" }, fontFamily: { sans: ["Inter", "sans-serif"] } } } };`,
      "fonts/Inter.woff2": "x",
    });
    const r = await resolveTheme(tmp, { slug: "x", theme: "good", brand });
    expect(r.errors).toEqual([]);
    expect(r.css).toContain("--brand:#0b0f14");
    expect(r.css).toContain('--font:"inter", sans-serif');
    expect(r.css).toContain('@font-face{font-family:"inter";src:url(/brand/inter.woff2)');
    expect(r.css.startsWith("@font-face") || r.css.startsWith("html:root")).toBe(true);
    expect(r.fonts.map((f) => f.file)).toEqual(["inter.woff2"]);
  });

  it("reads theme.css when there is no config", async () => {
    themeDir("v4", { "theme.css": "@theme { --color-primary: #222222; }" });
    expect((await resolveTheme(tmp, { slug: "x", theme: "v4", brand })).css).toContain("--brand:#222222");
  });

  it("reports a missing theme, unreadable colors and poor contrast", async () => {
    expect((await resolveTheme(tmp, { slug: "x", theme: "nope", brand })).errors.join()).toMatch(/needs tailwind\.config\.js or theme\.css/);
    themeDir("bad", {
      "tailwind.config.mjs": `export default { theme: { colors: { primary: "#ffee00", accent: "hsl(var(--accent))", muted: { foreground: "#cccccc" } } } };`,
    });
    const errs = (await resolveTheme(tmp, { slug: "x", theme: "bad", brand })).errors.join("\n");
    expect(errs).toMatch(/primary #ffee00 needs 4\.5:1 contrast with white/);
    expect(errs).toMatch(/accent "hsl\(var\(--accent\)\)" isn't a color we can check/);
    expect(errs).toMatch(/muted foreground #cccccc needs 4\.5:1/);
  });
});

describe("configs whose colors are var() links (shadcn, themelab)", () => {
  it("reads :root variables, not .dark, and resolves var(), fallbacks and bare HSL channels", () => {
    const vars = rootVariables(`/* x */ :root { --primary: oklch(0.3 0.1 260); --muted: 210 40% 96%; --radius: 0.625rem; }
      .dark { --primary: #ffffff; }`);
    expect(vars.get("primary")).toBe("oklch(0.3 0.1 260)");
    expect(resolveVars("var(--primary)", vars)).toBe("oklch(0.3 0.1 260)");
    expect(resolveVars("hsl(var(--muted))", vars)).toBe("hsl(210 40% 96%)");
    expect(resolveVars("var(--muted)", vars)).toBe("hsl(210 40% 96%)");
    expect(resolveVars("var(--nope, #123456)", vars)).toBe("#123456");
  });

  it("builds a theme from the config plus globals.css, filling muted-foreground and using primary-foreground for button text", async () => {
    themeDir("lab", {
      "tailwind.config.mjs": `export default { theme: { extend: {
        colors: { background: "var(--background)", foreground: "var(--foreground)", primary: "var(--primary)", accent: "var(--accent)", muted: "var(--muted)", border: "var(--border)" },
        borderRadius: { lg: "var(--radius)" }, fontFamily: { sans: ["Manrope", "sans-serif"], heading: ["Playfair Display", "serif"] } } } };`,
      "globals.css": `:root { --background: #fbfaf7; --foreground: #1c1917; --primary: #f5f5f4; --primary-foreground: #1c1917;
        --accent: #f1efe9; --ring: #9a3412; --muted: #f1efe9; --muted-foreground: #57534e; --border: #e7e5e4; --radius: 0.5rem; }`,
    });
    const r = await resolveTheme(tmp, { slug: "x", theme: "lab", brand });
    expect(r.errors).toEqual([]);
    expect(r.css).toContain("--paper:#fbfaf7");
    expect(r.css).toContain("--on-brand:#1c1917");
    expect(r.css).toContain("--muted:#57534e");
    expect(r.css).toContain("--radius:0.5rem");
    expect(r.css).toContain("--accent:#9a3412"); // pale accent tint skipped for the readable ring color
    expect(r.css).toContain('--font-display:"playfair display", serif');
  });
});

describe("every site's theme and logo", () => {
  const sites = readdirSync(join(root, "sites")).filter((f) => f.endsWith(".json") && f !== "guides.json");
  it.each(sites)("%s resolves without errors", async (file) => {
    const site = JSON.parse(readFileSync(join(root, "sites", file), "utf8"));
    expect((await resolveTheme(root, site)).errors).toEqual([]);
    if (site.brand.logo) expect(() => readFileSync(join(root, "sites", site.brand.logo.file))).not.toThrow();
  });
});
