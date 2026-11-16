/**
 * Affiliate links (rule 10): always /go/{program}/ on the site's own domain, rel="sponsored nofollow".
 * The stored network link never appears in a page; the `go` Edge Function holds it.
 * Pages render them with src/components/AffiliateLink.astro.
 */

import { isPlaced, type AffiliateState, type Placement, type PlacementScope, type SiteConfig } from "@directory-engine/core";

export const AFFILIATE_REL = "sponsored nofollow";
export type { Placement, PlacementScope };

/**
 * The /go/ path for a program, or null when this site can't link to it there: not approved (the
 * function would answer 404), no stored link, or not placed there in sites/<slug>.json. `scope` is
 * what the page is about (its metro and capability; nothing for a guide), matched by isPlaced().
 */
export function goHref(site: SiteConfig, affiliates: AffiliateState[], program: string, placement: Placement, scope: PlacementScope): string | null {
  if (!isPlaced(site, program, placement, scope)) return null;
  const a = affiliates.find((x) => x.slug === program);
  return a && a.status === "approved" && a.url ? `/go/${program}/` : null;
}

/** Whether rendered HTML contains a link through /go/, which means the page must show DISCLOSURE_LINE. */
export const hasGoLink = (html: string): boolean => /<a\b[^>]*\bhref=["']?\/go\//i.test(html);
