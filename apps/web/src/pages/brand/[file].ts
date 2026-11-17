// Files the site's look needs, written as static files: the logo (also the favicon) and any theme fonts.
import { readFileSync } from "node:fs";
import type { APIRoute } from "astro";
import { logo, theme } from "../../lib/site.ts";

export function getStaticPaths() {
  const out: { params: { file: string } }[] = theme.fonts.map((f) => ({ params: { file: f.file } }));
  if (logo) out.push({ params: { file: logo.kind === "png" ? "logo.png" : "logo.svg" } });
  return out;
}

export const GET: APIRoute = ({ params }) => {
  if (logo && params.file === "logo.svg" && logo.kind === "svg") {
    // Standalone (favicon), currentColor has no page to inherit from: use the theme's primary.
    return new Response(logo.svg.replace(/currentColor/g, theme.themeColor), { headers: { "Content-Type": "image/svg+xml" } });
  }
  if (logo && params.file === "logo.png" && logo.kind === "png") {
    return new Response(readFileSync(logo.path), { headers: { "Content-Type": "image/png" } });
  }
  const font = theme.fonts.find((f) => f.file === params.file)!;
  return new Response(readFileSync(font.path), { headers: { "Content-Type": "font/woff2" } });
};
