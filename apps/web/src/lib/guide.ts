/**
 * Guide pages (T10). The Markdown in content/guides/ is rendered by Astro's content collection; this
 * file turns the rendered HTML into what a page may show:
 *
 * - Equipment links are written in Markdown as `/go/<program>/` (docs/SPEC.md "Guides"). Each becomes
 *   an affiliate link with rel="sponsored nofollow" when the program is approved for this site's
 *   `guides` placement, and plain text otherwise (rule 10). Any other /go/ path stops the build.
 *   A guide is about no metro or capability, so only unlimited `guides` placements match
 *   (validateSiteConfig refuses limited ones).
 * - `affiliateLinks` counts the links that survive; Base.astro shows the disclosure line on any page
 *   with a /go/ link.
 */

import type { SiteConfig } from "@directory-engine/core";
import { AFFILIATE_REL, goHref } from "./affiliate.ts";
import type { SiteAffiliate } from "./load.ts";

export interface GuideHtml {
  html: string;
  /** Affiliate links left in the HTML (Base.astro adds the disclosure line when there are any). */
  affiliateLinks: number;
}

/** What a guide page is about, for placement rules: no metro and no capability. */
const GUIDE_SCOPE = {};

const ANCHOR = /<a\s+([^>]*)>([\s\S]*?)<\/a>/g;
const GO_PATH = /^\/go\/([a-z0-9-]+)\/$/;

/** Program slugs a guide's Markdown links to through /go/, in order of first use. */
export function goPrograms(markdown: string): string[] {
  const found = [...markdown.matchAll(/\]\((\/go\/[^)\s]*)\)/g)].map((m) => m[1]);
  return [...new Set(found.map((p) => p.match(GO_PATH)?.[1] ?? p))];
}

export function guideHtml(html: string, site: SiteConfig, affiliates: SiteAffiliate[], slug: string): GuideHtml {
  let affiliateLinks = 0;
  const out = html.replace(ANCHOR, (whole, attrs: string, inner: string) => {
    const href = attrs.match(/\bhref="([^"]*)"/)?.[1] ?? "";
    if (!href.startsWith("/go/")) return whole;
    const program = href.match(GO_PATH)?.[1];
    if (!program) throw new Error(`content/guides/${slug}.md: affiliate links must be /go/<program>/, got "${href}"`);
    const go = goHref(site, affiliates, program, "guides", GUIDE_SCOPE);
    if (!go) return inner;
    affiliateLinks++;
    return `<a href="${go}" rel="${AFFILIATE_REL}">${inner}</a>`;
  });
  return { html: out, affiliateLinks };
}
