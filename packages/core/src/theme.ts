/**
 * Site themes (D30, D31): turn a Tailwind theme into the CSS variables the web app's global.css uses,
 * and check it. Shared by the build (apps/web) and the admin app, which checks a pasted theme before
 * saving it. Nothing here runs the theme: a Tailwind config is read as text by a small parser that
 * accepts only plain values (strings, numbers, arrays, objects), so a pasted file can't execute.
 *
 * Tokens read (shadcn-style names, the common convention):
 *   colors.primary      -> --brand    buttons, theme-color (needs 4.5:1 with its foreground or white)
 *   colors.accent       -> --accent   logo mark, headline values, arrows (needs 4.5:1 with background)
 *   colors.background   -> --paper
 *   colors.foreground   -> --ink, --ink-2
 *   colors.muted        -> --surface  (DEFAULT) and --muted (foreground: secondary text)
 *   colors.border       -> --line;    colors.input -> --line-strong
 *   fontFamily.sans     -> --font;    fontFamily.display / heading -> --font-display
 *   borderRadius.DEFAULT (or lg) -> --radius
 * In v4 CSS the same tokens are --color-primary, --color-muted-foreground, --font-sans, --radius, ...
 * Colors given as var(--x) are looked up in the theme's `:root { --x: ... }` CSS (light mode only).
 */

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

/** A theme as text: a Tailwind v3 config, and/or CSS (:root variables, or a v4 @theme block). */
export interface ThemeSource {
  config?: string | null;
  css?: string | null;
}

/** Longest theme text we accept (the admin form and the database check use the same limit). */
export const THEME_TEXT_MAX = 50_000;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

// ---------------------------------------------------------------- reading a config without running it

export class ThemeParseError extends Error {}

/**
 * The object literal a Tailwind config exports, read as data. Accepts `export default {...}`,
 * `module.exports = {...}`, and `const config[: Config] = {...}; export default config`. Values may
 * be strings, numbers, booleans, arrays and objects; anything else (a function call, a spread, an
 * import used as a value) is refused with the line it's on.
 */
export function parseConfigText(text: string): Obj {
  const src = text.replace(/\r\n?/g, "\n");
  const start = /(?:export\s+default|module\.exports\s*=|(?:const|let|var)\s+[\w$]+(?:\s*:\s*[\w$.<>]+)?\s*=)\s*\{/.exec(stripComments(src));
  if (!start) throw new ThemeParseError("no config object found (expected `export default {` or `const config = {`)");
  const p = new Parser(src, stripComments(src).indexOf("{", start.index));
  const value = p.value();
  if (!isObj(value)) throw new ThemeParseError("the config must be an object");
  return value;
}

/** Comments replaced by spaces, so positions (and line numbers) stay the same. */
function stripComments(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; ) {
    const c = s[i];
    if (c === '"' || c === "'" || c === "`") {
      const end = skipString(s, i);
      out += s.slice(i, end);
      i = end;
    } else if (s.startsWith("//", i)) {
      const end = s.indexOf("\n", i);
      const stop = end < 0 ? s.length : end;
      out += " ".repeat(stop - i);
      i = stop;
    } else if (s.startsWith("/*", i)) {
      const end = s.indexOf("*/", i + 2);
      const stop = end < 0 ? s.length : end + 2;
      out += s.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

function skipString(s: string, i: number): number {
  const q = s[i];
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === "\\") j++;
    else if (s[j] === q) return j + 1;
    else if (s[j] === "\n" && q !== "`") break;
  }
  return s.length;
}

class Parser {
  private s: string;
  private i: number;
  constructor(src: string, start: number) {
    this.s = stripComments(src);
    this.i = start;
  }
  private fail(msg: string): never {
    const line = this.s.slice(0, this.i).split("\n").length;
    throw new ThemeParseError(`line ${line}: ${msg}`);
  }
  private ws() {
    while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++;
  }
  private peek() {
    this.ws();
    return this.s[this.i];
  }
  value(): unknown {
    const c = this.peek();
    if (c === "{") return this.object();
    if (c === "[") return this.array();
    if (c === '"' || c === "'" || c === "`") return this.string();
    const m = /^(-?\d+(?:\.\d+)?|true|false|null)\b/.exec(this.s.slice(this.i));
    if (m) {
      this.i += m[0].length;
      return m[0] === "true" ? true : m[0] === "false" ? false : m[0] === "null" ? null : Number(m[0]);
    }
    const word = /^[^\s,}\]]{1,40}/.exec(this.s.slice(this.i))?.[0] ?? c;
    this.fail(`only plain values are allowed (strings, numbers, arrays, objects), found \`${word}\``);
  }
  private string(): string {
    const q = this.s[this.i];
    const end = skipString(this.s, this.i);
    if (this.s[end - 1] !== q || end - this.i < 2) this.fail("unterminated string");
    const body = this.s.slice(this.i + 1, end - 1);
    if (q === "`" && body.includes("${")) this.fail("template strings with ${...} aren't allowed");
    this.i = end;
    return body.replace(/\\(.)/g, "$1");
  }
  private key(): string {
    const c = this.peek();
    if (c === '"' || c === "'") return this.string();
    const m = /^[A-Za-z_$0-9][\w$-]*/.exec(this.s.slice(this.i));
    if (!m) this.fail(c === "." ? "spreads (...) aren't allowed" : c === "[" ? "computed keys aren't allowed" : `unexpected \`${c ?? "end of file"}\``);
    this.i += m[0].length;
    return m[0];
  }
  private object(): Obj {
    this.i++; // {
    const out: Obj = {};
    for (;;) {
      if (this.peek() === "}") { this.i++; return out; }
      const k = this.key();
      if (this.peek() !== ":") this.fail(`expected \`:\` after ${k} (shorthand and methods aren't allowed)`);
      this.i++;
      if (k === "__proto__" || k === "constructor" || k === "prototype") this.fail(`key ${k} isn't allowed`);
      out[k] = this.value();
      const n = this.peek();
      if (n === ",") { this.i++; continue; }
      if (n === "}") { this.i++; return out; }
      this.fail(`expected \`,\` or \`}\`, found \`${n ?? "end of file"}\``);
    }
  }
  private array(): unknown[] {
    this.i++; // [
    const out: unknown[] = [];
    for (;;) {
      if (this.peek() === "]") { this.i++; return out; }
      out.push(this.value());
      const n = this.peek();
      if (n === ",") { this.i++; continue; }
      if (n === "]") { this.i++; return out; }
      this.fail(`expected \`,\` or \`]\`, found \`${n ?? "end of file"}\``);
    }
  }
}

// ---------------------------------------------------------------- tokens

/** A Tailwind color entry: a string, or { DEFAULT, 600, ... }. */
function pickColor(v: unknown, shades = ["DEFAULT", "600", "700", "500"]): string | undefined {
  if (typeof v === "string") return v;
  if (isObj(v)) for (const k of shades) if (typeof v[k] === "string") return v[k] as string;
  return undefined;
}

const GENERIC = new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-sans-serif", "ui-serif", "ui-monospace", "-apple-system", "emoji", "math"]);

/** Family names are case-insensitive in CSS; lowercase them so minified CSS never reads like prose. */
function quoteFamily(f: string): string | null {
  const bare = f.replace(/^["']|["']$/g, "").trim().toLowerCase();
  if (!/^[a-z0-9 -]{1,60}$/.test(bare)) return null;
  return GENERIC.has(bare) ? bare : `"${bare}"`;
}

const fontList = (v: unknown): string | undefined => {
  const list = Array.isArray(v) ? (Array.isArray(v[0]) ? v[0] : v) : typeof v === "string" ? v.split(",") : null;
  if (!list?.length) return undefined;
  const out = list.map((f) => quoteFamily(String(f))).filter((f): f is string => !!f);
  return out.length ? out.join(", ") : undefined;
};

/** The named (non-generic) families in a font stack, lowercased: `"inter", system-ui` -> ["inter"]. */
export const fontFamilies = (stack?: string): string[] => [...(stack ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);

const clean = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

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
    primaryForeground: isObj(primary) && typeof primary.foreground === "string" ? primary.foreground : pickColor(colors["primary-foreground"]),
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
    fontSans: fontList(vars.get("font-sans")),
    fontDisplay: fontList(vars.get("font-display") ?? vars.get("font-heading")),
    radius: vars.get("radius") ?? vars.get("radius-lg"),
  });
}

/**
 * Custom properties declared in `:root { ... }` blocks (light mode; `.dark` and other selectors are
 * ignored). Theme generators (shadcn, themelab, tweakcn) export these next to a config whose colors
 * are only `var(--primary)` links.
 */
export function rootVariables(css: string): Map<string, string> {
  const vars = new Map<string, string>();
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const block of noComments.matchAll(/(?:^|[}\s;])(?::root|html)\s*\{([^}]*)\}/g)) {
    for (const d of block[1].matchAll(/--([\w-]+)\s*:\s*([^;]+);?/g)) vars.set(d[1], d[2].trim());
  }
  return vars;
}

/** Bare HSL channels ("222 47% 11%"), the shadcn v0 convention for values used as hsl(var(--x)). */
const BARE_HSL = /^-?[\d.]+(deg)?\s+[\d.]+%\s+[\d.]+%$/;

/** Replaces var(--x) and var(--x, fallback) with values from `vars`, recursively. */
export function resolveVars(value: string, vars: Map<string, string>, depth = 0): string {
  if (depth > 8) return value;
  const out = value.replace(/var\(\s*--([\w-]+)\s*(?:,\s*([^()]*))?\)/g, (m, name: string, fallback?: string) => vars.get(name) ?? fallback?.trim() ?? m);
  if (out !== value && out.includes("var(")) return resolveVars(out, vars, depth + 1);
  return BARE_HSL.test(out) ? `hsl(${out})` : out;
}

/** Applies resolveVars to every token, and fills tokens the config left out from well-known variable names. */
export function withVariables(tokens: ThemeTokens, vars: Map<string, string>): ThemeTokens {
  const fill: Partial<Record<keyof ThemeTokens, string>> = {
    primary: "primary", primaryForeground: "primary-foreground", accent: "accent", background: "background",
    foreground: "foreground", surface: "muted", muted: "muted-foreground", border: "border", input: "input", radius: "radius",
  };
  const out: ThemeTokens = { ...tokens };
  for (const [k, name] of Object.entries(fill) as [keyof ThemeTokens, string][]) {
    if (out[k] === undefined && vars.has(name)) out[k] = `var(--${name})`;
  }
  for (const k of Object.keys(out) as (keyof ThemeTokens)[]) {
    if (k === "fontSans" || k === "fontDisplay") continue;
    out[k] = resolveVars(out[k]!, vars);
  }
  return out;
}

/** Tokens and :root variables from a theme's text. A config wins over v4 @theme CSS. */
export function readThemeSource(src: ThemeSource): { tokens: ThemeTokens; vars: Map<string, string>; errors: string[] } {
  const errors: string[] = [];
  const css = src.css ?? "";
  const vars = rootVariables(css);
  let tokens: ThemeTokens = {};
  if (src.config?.trim()) {
    try {
      tokens = tokensFromConfig(parseConfigText(src.config));
    } catch (e) {
      if (!(e instanceof ThemeParseError)) throw e;
      errors.push(`Tailwind config: ${e.message}`);
    }
  } else if (css.trim()) {
    tokens = tokensFromCss(css);
  }
  if (!src.config?.trim() && !css.trim()) errors.push("empty theme: add a Tailwind config or CSS");
  return { tokens: withVariables(tokens, vars), vars, errors };
}

// ---------------------------------------------------------------- colors and contrast

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

// ---------------------------------------------------------------- the page's variables

/** The CSS variables a theme sets (names without `--`), in output order. */
export type ThemeVariables = Partial<Record<"brand" | "on-brand" | "accent" | "paper" | "ink" | "ink-2" | "surface" | "muted" | "line" | "line-strong" | "font" | "font-display" | "radius", string>>;

export interface ThemeResult {
  variables: ThemeVariables;
  /** For <meta name="theme-color">. */
  themeColor: string;
  /** Named font families the theme asks for, lowercased (the build serves a file for each it has). */
  families: string[];
  /** Problems that should stop a build or a save (unreadable colors, poor contrast). */
  errors: string[];
}

/**
 * Theme tokens over the site's brand colors, checked: every text color needs 4.5:1 with what it sits
 * on. `who` names the source in error messages.
 */
export function themeVariables(
  read: { tokens: ThemeTokens; vars: Map<string, string>; errors?: string[] },
  brand: { primary: string; accent: string },
  who: string,
): ThemeResult {
  const { tokens, vars } = read;
  const errors = (read.errors ?? []).map((e) => `${who}: ${e}`);

  // Our accent colors text (cutoff times, the logo mark), so it must read on the background. In
  // shadcn-style themes "accent" is often a pale hover tint instead; then the first strong color
  // among ring, chart-1 and primary takes its place.
  const bgRgb = parseColor(tokens.background ?? "#ffffff");
  const readable = (c?: string) => { const rgb = c ? parseColor(c) : null; return !!rgb && !!bgRgb && contrast(rgb, bgRgb) >= 4.5; };
  const candidates = [tokens.accent, vars.get("ring"), vars.get("chart-1"), tokens.primary].filter((c): c is string => !!c).map((c) => resolveVars(c, vars));
  const accent = candidates.find(readable) ?? tokens.accent;
  const v: ThemeVariables = {
    brand: tokens.primary ?? brand.primary,
    "on-brand": tokens.primaryForeground,
    accent: accent ?? brand.accent,
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

  const white: RGB = [1, 1, 1];
  const bg = parseColor(v.paper ?? "#ffffff");
  const need = (name: string, value: string | undefined, against: RGB | null, againstName: string) => {
    if (value === undefined) return;
    const c = parseColor(value);
    if (!c) return errors.push(`${who}: ${name} "${value}" isn't a color we can check (use hex, rgb(), hsl() or oklch(), not var())`);
    if (against && contrast(c, against) < 4.5) errors.push(`${who}: ${name} ${value} needs 4.5:1 contrast with ${againstName}, has ${contrast(c, against).toFixed(2)}:1`);
  };
  if (!bg) errors.push(`${who}: background "${v.paper}" isn't a color we can check`);
  need("primary", v.brand, parseColor(v["on-brand"] ?? "#ffffff") ?? white, v["on-brand"] ? "its foreground (button text)" : "white button text");
  if (v["on-brand"] !== undefined && !parseColor(v["on-brand"])) errors.push(`${who}: primary foreground "${v["on-brand"]}" isn't a color we can check`);
  need("accent", v.accent, bg, "the background");
  need("foreground", v.ink, bg, "the background");
  need("muted foreground", v.muted, bg, "the background");
  for (const [name, value] of [["muted", v.surface], ["border", v.line], ["input", v["line-strong"]]] as const) {
    if (value !== undefined && !parseColor(value)) errors.push(`${who}: ${name} "${value}" isn't a color we can check`);
  }
  if (v.radius !== undefined && !/^\d*\.?\d+(px|rem|em)$|^0$/.test(v.radius)) errors.push(`${who}: radius "${v.radius}" must be a length like 6px or 0.5rem`);
  if (v.ink) v["ink-2"] = v.ink;

  const variables = Object.fromEntries(
    Object.entries(v).filter(([, val]) => val !== undefined).map(([k, val]) => [k, String(val).replace(/[;{}<>\\]/g, "")]),
  ) as ThemeVariables;
  const families = [...new Set([...fontFamilies(v.font), ...fontFamilies(v["font-display"])])];
  return { variables, themeColor: variables.brand!, families, errors };
}
