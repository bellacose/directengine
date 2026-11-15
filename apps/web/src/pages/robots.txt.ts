// robots.txt: affiliate redirects stay out of crawls; the sitemap is named with the site's own host.
import type { APIRoute } from "astro";
import { canonical } from "../lib/site.ts";

export const GET = (() =>
  new Response(`User-agent: *\nDisallow: /go/\n\nSitemap: ${canonical("/sitemap.xml")}\n`, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  })) satisfies APIRoute;
