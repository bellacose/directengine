/**
 * The site's theme for the build (D30, D31). It comes from the admin app's site settings when one is
 * saved there (stored as text in `site_settings`), otherwise from the folder `"theme"` names in
 * sites/themes/. Either way it is read as text by @directory-engine/core, never run.
 *
 * Fonts: the theme names its families; each family with a `<Family>.woff2` in any sites/themes/*\/fonts/
 * folder is served from /brand/ and declared with @font-face (variable fonts, weights 100-900). A
 * family with no file falls back to the next font in the stack.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readThemeSource, themeVariables, type ThemeSource } from "@directory-engine/core";

export { contrast, parseColor, resolveVars, rootVariables, tokensFromConfig, tokensFromCss } from "@directory-engine/core";

export interface ResolvedTheme {
  /** CSS variables for the page, ready for a <style> tag (html:root, so it wins over global.css defaults). */
  css: string;
  /** For <meta name="theme-color">. */
  themeColor: string;
  /** Font files to serve from /brand/<file>. */
  fonts: { file: string; path: string; family: string }[];
  /** Families the theme names that have no font file (they fall back to the next font in the stack). */
  missingFonts: string[];
  /** Problems that should stop a build (unreadable colors, poor contrast). */
  errors: string[];
  /** Where the theme came from, for messages. */
  source: string;
}

/** Families global.css already declares (D29), so they need no theme font file. */
const BUILT_IN_FONTS = new Set(["archivo"]);

const CONFIG_NAMES = ["tailwind.config.js", "tailwind.config.mjs", "tailwind.config.ts", "tailwind.config.cjs"];

/** A theme folder's text: its Tailwind config (if any) and all its CSS files, joined. */
export function readThemeFolder(dir: string): ThemeSource | null {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir);
  const configName = CONFIG_NAMES.find((n) => files.includes(n));
  const css = files.filter((f) => f.endsWith(".css")).sort().map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
  if (!configName && !css.includes("@theme")) return null;
  return { config: configName ? readFileSync(join(dir, configName), "utf8") : null, css };
}

/** Every font file in sites/themes/*\/fonts/, by lowercased family name (the file name without .woff2). */
export function fontLibrary(root: string): Map<string, string> {
  const lib = new Map<string, string>();
  const themes = join(root, "sites", "themes");
  if (!existsSync(themes)) return lib;
  for (const t of readdirSync(themes).sort()) {
    const dir = join(themes, t, "fonts");
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((f) => /^[\w -]+\.woff2$/i.test(f)).sort()) {
      const family = f.replace(/\.woff2$/i, "").toLowerCase();
      if (!lib.has(family)) lib.set(family, join(dir, f));
    }
  }
  return lib;
}

/**
 * Everything the layout needs: CSS variables (theme over brand colors over global.css defaults),
 * the theme-color, font files, and errors. `saved` is the admin app's theme, which wins over the folder.
 */
export function resolveTheme(
  root: string,
  site: { slug: string; theme?: string; brand: { primary: string; accent: string } },
  saved?: ThemeSource | null,
): ResolvedTheme {
  const errors: string[] = [];
  let src: ThemeSource | null = null;
  let who = `sites/${site.slug}.json brand`;
  if (saved && (saved.config?.trim() || saved.css?.trim())) {
    src = saved;
    who = "theme saved in the admin app";
  } else if (site.theme) {
    who = `theme "${site.theme}"`;
    src = readThemeFolder(join(root, "sites", "themes", site.theme));
    if (!src) errors.push(`${who}: sites/themes/${site.theme}/ needs tailwind.config.js or theme.css`);
  }
  const result = themeVariables(src ? readThemeSource(src) : { tokens: {}, vars: new Map() }, site.brand, who);
  errors.push(...result.errors);

  const lib = fontLibrary(root);
  const fonts = result.families.filter((f) => lib.has(f)).map((family) => ({ family, path: lib.get(family)!, file: `${family.replace(/\s+/g, "-")}.woff2` }));
  const missingFonts = result.families.filter((f) => !lib.has(f) && !BUILT_IN_FONTS.has(f));
  const decls = Object.entries(result.variables).map(([k, v]) => `--${k}:${v}`);
  const faces = fonts.map((f) => `@font-face{font-family:"${f.family}";src:url(/brand/${f.file}) format("woff2");font-weight:100 900;font-display:swap}`);
  return { css: `${faces.join("")}html:root{${decls.join(";")}}`, themeColor: result.themeColor, fonts, missingFonts, errors, source: who };
}
