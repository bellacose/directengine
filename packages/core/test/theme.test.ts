// Reading a Tailwind config as data (D31): the admin app stores pasted configs, so nothing may run them.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfigText, readThemeSource, themeVariables, tokensFromConfig } from "../src/index.ts";

const root = join(__dirname, "..", "..", "..");
const brand = { primary: "#1d4ed8", accent: "#b45309" };

describe("parseConfigText", () => {
  it("reads a themelab config (TypeScript, import type, const + export default)", () => {
    const cfg = parseConfigText(readFileSync(join(root, "sites", "themes", "themelab", "tailwind.config.ts"), "utf8"));
    const t = tokensFromConfig(cfg);
    expect(t.primary).toBe("var(--primary)");
    expect(t.fontSans).toBe('"inter", system-ui, sans-serif');
    expect(t.fontDisplay).toBe('"space grotesk", system-ui, sans-serif');
    expect(t.radius).toBe("var(--radius)");
  });

  it("reads export default and module.exports, with comments, quoted keys and trailing commas", () => {
    expect(parseConfigText(`/** @type {import('tailwindcss').Config} */\nexport default { theme: { colors: { "primary": '#000', }, }, };`))
      .toEqual({ theme: { colors: { primary: "#000" } } });
    expect(parseConfigText(`// x\nmodule.exports = { theme: { borderRadius: { DEFAULT: "6px" /* y */ }, n: 1.5, ok: true } }`))
      .toEqual({ theme: { borderRadius: { DEFAULT: "6px" }, n: 1.5, ok: true } });
  });

  it("refuses anything that isn't a plain value, naming the line", () => {
    expect(() => parseConfigText(`export default {\n  theme: require("x") }`)).toThrow(/line 2: only plain values.*require/);
    expect(() => parseConfigText(`export default { ...other }`)).toThrow(/spreads/);
    expect(() => parseConfigText(`export default { theme() { return {} } }`)).toThrow(/shorthand and methods/);
    expect(() => parseConfigText("export default { a: `${process.env.X}` }")).toThrow(/template strings/);
    expect(() => parseConfigText(`export default { plugins: [x => x] }`)).toThrow(/only plain values/);
    expect(() => parseConfigText(`export default { ["a" + "b"]: 1 }`)).toThrow(/computed keys/);
    expect(() => parseConfigText(`export default { __proto__: { polluted: 1 } }`)).toThrow(/__proto__/);
    expect(() => parseConfigText(`const x = 1;`)).toThrow(/no config object/);
  });
});

describe("readThemeSource + themeVariables", () => {
  it("builds variables from a pasted config and CSS, reports bad input instead of throwing", () => {
    const ok = themeVariables(readThemeSource({
      config: `export default { theme: { extend: { colors: { primary: "var(--primary)" }, fontFamily: { sans: ["Inter", "sans-serif"] } } } }`,
      css: `:root { --primary: #0b0f14; --primary-foreground: #fff; } .dark { --primary: #fff; }`,
    }), brand, "saved");
    expect(ok.errors).toEqual([]);
    expect(ok.variables).toMatchObject({ brand: "#0b0f14", "on-brand": "#fff", font: '"inter", sans-serif' });
    expect(ok.families).toEqual(["inter"]);

    const bad = themeVariables(readThemeSource({ config: "export default { a: foo() }", css: "" }), brand, "saved");
    expect(bad.errors.join()).toMatch(/saved: Tailwind config: line 1/);
    expect(themeVariables(readThemeSource({ config: "", css: "" }), brand, "saved").errors.join()).toMatch(/empty theme/);
  });

  it("drops font names that could break out of the CSS", () => {
    const r = themeVariables(readThemeSource({ config: `export default { theme: { fontFamily: { sans: ["x\\"}body{color:red", "Inter"] } } }` }), brand, "t");
    expect(r.variables.font).toBe('"inter"');
  });
});
