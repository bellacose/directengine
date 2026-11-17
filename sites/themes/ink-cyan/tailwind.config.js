// Find DTF starter theme: ink and print-cyan. A plain Tailwind (v3) config; only the tokens listed in
// apps/web/src/lib/theme.ts are read. Replace this file (or add a theme.css with a v4 @theme block)
// to change the look.
/** @type {import('tailwindcss').Config} */
export default {
  theme: {
    extend: {
      colors: {
        primary: { DEFAULT: "#0b0f14", foreground: "#ffffff" },
        accent: { DEFAULT: "#0072b5" },
        background: "#ffffff",
        foreground: "#0b0f14",
        muted: { DEFAULT: "#f2f5f7", foreground: "#56606b" },
        border: "#dfe4e8",
        input: "#c3cbd2",
      },
      fontFamily: {
        sans: ["Archivo", "system-ui", "sans-serif"],
        display: ["Archivo", "system-ui", "sans-serif"],
      },
      borderRadius: { DEFAULT: "6px" },
    },
  },
};
