/**
 * Site themes from Tailwind files (D30). A site picks a folder in sites/themes/ with `"theme"`; the
 * folder holds either a Tailwind v3 config (tailwind.config.js / .mjs / .ts) or a Tailwind v4
 * stylesheet with an `@theme` block (theme.css). We read a small set of semantic tokens from it and
 * turn them into the CSS variables global.css already uses. Tailwind itself is never run: the site
 * doesn't use utility classes, only the theme's values.
 *
 * Tokens read (shadcn-style names, the common convention):
 *   colors.primary      -> --brand    buttons, links on hover, theme-color (needs 4.5:1 with white)
 *   colors.accent       -> --accent   logo mark, headline values, arrows (needs 4.5:1 with background)
 *   colors.background   -> --paper
 *   colors.foreground   -> --ink, --ink-2
 *   colors.muted        -> --surface  (DEFAULT) and --muted (foreground: secondary text)
 *   colors.border       -> --line;    colors.input -> --line-strong
 *   fontFamily.sans     -> --font;    fontFamily.display / heading -> --font-display
 *   borderRadius.DEFAULT (or lg) -> --radius
 * In v4 the same tokens are --color-primary, --color-muted-foreground, --font-sans, --radius, ...
 *
 * Font files: any `<Family>.woff2` in the theme's fonts/ folder is served from /brand/ and declared
 * with @font-face (variable fonts, weights 100-900).
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export interface ThemeTokens {
  primary?: string;
  primaryForeground?: string;
  accent?: string;
  background?: string;
  foreground?: string;
  surface?: string;
  muted?: string;
  border?: string;
  input?: string;
  fontSans?: string;
  fontDisplay?: string;
  radius?: string;
}

export interface ResolvedTheme {
  /** CSS variables for the page, ready for a <style> tag (html:root, so it wins over global.css defaults). */
  css: string;
  /** For <meta name="theme-color">. */
  themeColor: string;
  /** Font files to serve from /brand/<file>. */
  fonts: { file: string; path: string; family: string }[];
  /** Problems that should stop a build (unreadable colors, poor contrast). */
  errors: string[];
}

const CONFIG_NAMES = ["tailwind.config.js", "tailwind.config.mjs", "tailwind.config.ts", "tailwind.config.cjs"];

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

/** A Tailwind color entry: a string, or { DEFAULT, 600, ... }. */
function pickColor(v: unknown, shades = ["DEFAULT", "600", "700", "500"]): string | undefined {
  if (typeof v === "string") return v;
  if (isObj(v)) for (const k of shades) if (typeof v[k] === "string") return v[k] as string;
  return undefined;
}

const fontList = (v: unknown): string | undefined => {
  const list = Array.isArray(v) ? (Array.isArray(v[0]) ? v[0] : v) : typeof v === "string" ? [v] : null;
  if (!list?.length) return undefined;
  return list.map((f) => String(f).trim()).filter(Boolean).map(quoteFamily).join(", ");
};

const GENERIC = new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-sans-serif", "ui-serif", "ui-monospace", "-apple-system", "emoji", "math"]);
/** Family names are case-insensitive in CSS; lowercase them so minified CSS never reads like prose. */
function quoteFamily(f: string): string {
  const bare = f.replace(/^["']|["']$/g, "").trim();
  return GENERIC.has(bare.toLowerCase()) ? bare.toLowerCase() : `"${bare.toLowerCase()}"`;
}

/** Tokens from a Tailwind v3 config object (theme.extend wins over theme). */
export function tokensFromConfig(config: unknown): ThemeTokens {
  const c = isObj(config) && isObj(config.default) && !isObj(config.theme) ? config.default : config;
  const theme = isObj(c) && isObj(c.theme) ? c.theme : {};
  const ext = isObj(theme.extend) ? theme.extend : {};
  const colors: Obj = { ...(isObj(theme.colors) ? theme.colors : {}), ...(isObj(ext.colors) ? ext.colors : {}) };
  const fonts: Obj = { ...(isObj(theme.fontFamily) ? theme.fontFamily : {}), ...(isObj(ext.fontFamily) ? ext.fontFamily : {}) };
  const radii: Obj = { ...(isObj(theme.borderRadius) ? theme.borderRadius : {}), ...(isObj(ext.borderRadius) ? ext.borderRadius : {}) };
  const muted = colors.muted;
  const primary = colors.primary;
  return clean({
    primary: pickColor(primary),
    primaryForeground: isObj(primary) && typeof primary.foreground === "string" ? primary.foreground : undefined,
    accent: pickColor(colors.accent),
    background: pickColor(colors.background),
    foreground: pickColor(colors.foreground),
    surface: pickColor(muted, ["DEFAULT", "100", "50"]),
    muted: isObj(muted) && typeof muted.foreground === "string" ? muted.foreground : pickColor(colors["muted-foreground"] ?? colors.mutedForeground),
    border: pickColor(colors.border, ["DEFAULT", "200", "300"]),
    input: pickColor(colors.input, ["DEFAULT", "300", "400"]),
    fontSans: fontList(fonts.sans),
    fontDisplay: fontList(fonts.display ?? fonts.heading),
    radius: typeof radii.DEFAULT === "string" ? radii.DEFAULT : typeof radii.lg === "string" ? radii.lg : undefined,
  });
}

/** Tokens from a Tailwind v4 stylesheet: the declarations inside @theme { ... } blocks. */
export function tokensFromCss(css: string): ThemeTokens {
  const vars = new Map<string, string>();
  for (const block of css.matchAll(/@theme(?:\s+[a-z\s]+)?\s*\{([\s\S]*?)\}/g)) {
    for (const d of block[1].matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) vars.set(d[1], d[2].trim());
  }
  const font = (v?: string) => (v ? fontList(v.split(",")) : undefined);
  return clean({
    primary: vars.get("color-primary"),
    primaryForeground: vars.get("color-primary-foreground"),
    accent: vars.get("color-accent"),
    background: vars.get("color-background"),
    foreground: vars.get("color-foreground"),
    surface: vars.get("color-muted"),
    muted: vars.get("color-muted-foreground"),
    border: vars.get("color-border"),
    input: vars.get("color-input"),
    fontSans: font(vars.get("font-sans")),
    fontDisplay: font(vars.get("font-display") ?? vars.get("font-heading")),
    radius: vars.get("radius") ?? vars.get("radius-lg"),
  });
}

const clean = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

// ---- Colors: parse enough CSS color syntax to check contrast. ----

type RGB = [number, number, number];

/** sRGB 0-1 from #rgb/#rrggbb, rgb(), hsl() or oklch(). null = can't read it (e.g. var(--x)). */
export function parseColor(input: string): RGB | null {
  const s = input.trim().toLowerCase();
  let m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(s);
  if (m) {
    const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as RGB;
  }
  const nums = (body: string) => body.replace(/\/.*$/, "").split(/[\s,]+/).filter(Boolean);
  m = /^rgba?\((.*)\)$/.exec(s);
  if (m) {
    const p = nums(m[1]).map((x) => (x.endsWith("%") ? parseFloat(x) / 100 : parseFloat(x) / 255));
    return p.length >= 3 && p.slice(0, 3).every(Number.isFinite) ? (p.slice(0, 3) as RGB) : null;
  }
  m = /^hsla?\((.*)\)$/.exec(s);
  if (m) {
    const [h, sat, l] = nums(m[1]).map((x) => parseFloat(x));
    if (![h, sat, l].every(Number.isFinite)) return null;
    const S = sat / 100, L = l / 100;
    const k = (n: number) => (n + h / 30) % 12;
    const a = S * Math.min(L, 1 - L);
    const f = (n: number) => L - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return [f(0), f(8), f(4)];
  }
  m = /^oklch\((.*)\)$/.exec(s);
  if (m) {
    const parts = nums(m[1]);
    const L = parts[0]?.endsWith("%") ? parseFloat(parts[0]) / 100 : parseFloat(parts[0]);
    const C = parseFloat(parts[1]);
    const H = (parseFloat(parts[2]) * Math.PI) / 180;
    if (![L, C, H].every(Number.isFinite)) return null;
    const a = C * Math.cos(H), b = C * Math.sin(H);
    const l_ = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m_ = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s_ = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
    const lin = [
      4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
      -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
      -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
    ];
    const enc = (x: number) => { const c = Math.min(1, Math.max(0, x)); return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055; };
    return lin.map(enc) as RGB;
  }
  return null;
}

const luminance = ([r, g, b]: RGB) => {
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};
export const contrast = (a: RGB, b: RGB) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

/** The theme folder's tokens, or null when the folder has no Tailwind file. */
export async function readThemeTokens(dir: string): Promise<{ tokens: ThemeTokens; source: string } | null> {
  for (const name of CONFIG_NAMES) {
    const file = join(dir, name);
    if (existsSync(file)) {
      const mod = await import(/* @vite-ignore */ pathToFileURL(file).href);
      return { tokens: tokensFromConfig(mod.default ?? mod), source: name };
    }
  }
  const css = join(dir, "theme.css");
  if (existsSync(css)) return { tokens: tokensFromCss(readFileSync(css, "utf8")), source: "theme.css" };
  return null;
}

/**
 * Everything the layout needs: CSS variables (theme over brand colors over global.css defaults),
 * the theme-color, font files, and errors. Pure apart from reading the theme folder.
 */
export async function resolveTheme(root: string, site: { slug: string; theme?: string; brand: { primary: string; accent: string } }): Promise<ResolvedTheme> {
  const errors: string[] = [];
  let tokens: ThemeTokens = {};
  const fonts: ResolvedTheme["fonts"] = [];
  if (site.theme) {
    const dir = join(root, "sites", "themes", site.theme);
    const read = existsSync(dir) ? await readThemeTokens(dir) : null;
    if (!read) errors.push(`theme "${site.theme}": sites/themes/${site.theme}/ needs tailwind.config.js or theme.css`);
    else tokens = read.tokens;
    const fontDir = join(dir, "fonts");
    if (existsSync(fontDir)) {
      for (const file of readdirSync(fontDir).filter((f) => /^[\w -]+\.woff2$/i.test(f)).sort()) {
        fonts.push({ file: file.toLowerCase().replace(/\s+/g, "-"), path: join(fontDir, file), family: file.replace(/\.woff2$/i, "").toLowerCase() });
      }
    }
  }

  const v = {
    brand: tokens.primary ?? site.brand.primary,
    accent: tokens.accent ?? site.brand.accent,
    paper: tokens.background,
    ink: tokens.foreground,
    surface: tokens.surface,
    muted: tokens.muted,
    line: tokens.border,
    "line-strong": tokens.input,
    font: tokens.fontSans,
    "font-display": tokens.fontDisplay,
    radius: tokens.radius,
  };

  const who = site.theme ? `theme "${site.theme}"` : `sites/${site.slug}.json brand`;
  const white: RGB = [1, 1, 1];
  const bg = parseColor(v.paper ?? "#ffffff");
  const need = (name: string, value: string | undefined, against: RGB | null, againstName: string, min = 4.5) => {
    if (value === undefined) return;
    const c = parseColor(value);
    if (!c) return errors.push(`${who}: ${name} "${value}" isn't a color we can check (use hex, rgb(), hsl() or oklch(), not var())`);
    if (against && contrast(c, against) < min) errors.push(`${who}: ${name} ${value} needs ${min}:1 contrast with ${againstName}, has ${contrast(c, against).toFixed(2)}:1`);
  };
  if (!bg) errors.push(`${who}: background "${v.paper}" isn't a color we can check`);
  need("primary", v.brand, white, "white button text");
  need("accent", v.accent, bg, "the background");
  need("foreground", v.ink, bg, "the background");
  need("muted foreground", v.muted, bg, "the background");
  for (const [name, value] of [["muted", v.surface], ["border", v.line], ["input", v["line-strong"]]] as const) {
    if (value !== undefined && !parseColor(value)) errors.push(`${who}: ${name} "${value}" isn't a color we can check`);
  }
  if (v.radius !== undefined && !/^\d*\.?\d+(px|rem|em)$|^0$/.test(v.radius)) errors.push(`${who}: radius "${v.radius}" must be a length like 6px or 0.5rem`);

  const decls = Object.entries(v)
    .filter(([, val]) => val !== undefined)
    .map(([k, val]) => `--${k}:${String(val).replace(/[;{}<>]/g, "")}`);
  if (v.ink) decls.push(`--ink-2:${v.ink}`);
  const faces = fonts.map((f) => `@font-face{font-family:"${f.family}";src:url(/brand/${f.file}) format("woff2");font-weight:100 900;font-display:swap}`);
  return { css: `${faces.join("")}html:root{${decls.join(";")}}`, themeColor: v.brand, fonts, errors };
}
