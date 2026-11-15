/**
 * Which sites include a listing, and whether each builds its own shop page for it. The rules are
 * `siteListings()` and `hasDetailPage()` from packages/core, the same functions the build uses.
 */
import { angleFacts, hasDetailPage, siteListings, type Fact, type Listing, type SiteConfig } from "@directory-engine/core";

export interface SiteCoverage {
  slug: string;
  name: string;
  status: string;
  /** On this site's lists now. */
  included: boolean;
  /** Would be on its lists if it were published (same dataset, capability and metro match). */
  matchesFilter: boolean;
  /** Builds /shop/{slug}/ on this site now (or would, once published). */
  detailPage: boolean;
  angleFactCount: number;
  minFacts: number;
}

/**
 * `listing.facts` must be verified facts only (the `verified` rows of `listing_fact_status`), the
 * same set `public_listing_facts` returns once the listing is published.
 */
export function siteCoverage(sites: SiteConfig[], datasetSlug: string, listing: Listing): SiteCoverage[] {
  return sites
    .filter((s) => s.dataset === datasetSlug)
    .map((site) => {
      const asPublished: Listing = { ...listing, status: "published" };
      const matchesFilter = siteListings(site, [asPublished]).length === 1;
      return {
        slug: site.slug,
        name: site.name,
        status: site.status,
        included: matchesFilter && listing.status === "published",
        matchesFilter,
        detailPage: matchesFilter && hasDetailPage(site, asPublished),
        angleFactCount: angleFacts(site, asPublished).length,
        minFacts: site.angle.minFacts,
      };
    })
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

export interface FactStatusRow {
  key: string;
  value: unknown;
  verified: boolean;
  stale: boolean;
  checked_at: string | null;
  method: string | null;
}

/** Verified `listing_fact_status` rows as packages/core facts. */
export function verifiedFacts(rows: FactStatusRow[], defs: { key: string; fact_group: string; sort: number }[]): Fact[] {
  const byKey = new Map(defs.map((d) => [d.key, d]));
  return rows
    .filter((r) => r.verified && byKey.has(r.key))
    .map((r) => ({
      key: r.key,
      group: byKey.get(r.key)!.fact_group,
      sort: byKey.get(r.key)!.sort,
      value: r.value,
      checkedAt: String(r.checked_at),
      method: String(r.method),
      stale: r.stale,
    }));
}
