/**
 * Everything a capability x metro list page shows, built from the plan and loaded data only.
 * Pure (no loading), so it is tested directly as well as through the built HTML.
 *
 * Card order is the order of `page.listingIds`, which planPages() set from orderForList() (rule 7):
 * this module never sorts listings itself.
 */

import { angleFacts, cardFactKeys, type Page, type SiteConfig } from "@directory-engine/core";
import { checkLine, formatDate, formatValue, latestCheck } from "./fact-format.ts";
import type { Vocabulary, WebListing } from "./load.ts";

/** What a card shows for a slot the shop hasn't had verified (rule 1). */
export const NOT_CHECKED = "Not checked yet";

/** Short values (a time, yes/no, a number) sit in the card's strip; longer ones get a row each. */
const SHORT_TYPES = new Set(["time", "boolean", "number"]);

/** One card slot. Every card on a page has the same slots in the same order (cardFactKeys). */
export interface CardFact {
  key: string;
  label: string;
  /** The formatted value, or NOT_CHECKED when the shop has no verified value. */
  text: string;
  known: boolean;
  stale: boolean;
  /** "strip" for short values, "row" for hours and text. */
  layout: "strip" | "row";
  /** The site's headline fact. */
  headline: boolean;
}

export interface ListCard {
  id: string;
  slug: string;
  name: string;
  city: string;
  /** Shop page path when the plan builds one on this site, else null (the card stands alone). */
  href: string | null;
  facts: CardFact[];
  capabilities: { slug: string; name: string }[];
  /** "Checked Nov 20, 2026 by phone", from the listing's latest check. */
  check: string | null;
  website: string | null;
  tel: string | null;
  phone: string | null;
  directions: string | null;
  /** Boolean angle facts verified true, for the client-side toggles. */
  trueFacts: string[];
}

export interface ListView {
  lead: string[];
  cards: ListCard[];
  /** City filter options; empty when the page has only one city. */
  cities: string[];
  /** One toggle per boolean angle fact that at least one shop here has verified true. */
  toggles: { key: string; label: string }[];
  fallback: { href: string; text: string } | null;
  breadcrumbs: { name: string; path: string }[];
  jsonLd: Record<string, unknown>[];
}

export interface ListInput {
  site: SiteConfig;
  page: Page;
  /** The page's listings, in plan order. */
  listings: WebListing[];
  vocabulary: Vocabulary;
  plan: Page[];
  canonical: (path: string) => string;
  titleOf: (page: Page) => string;
}

const lowerFirst = (s: string) => (/^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s);

export function directionsUrl(l: Pick<WebListing, "address1" | "city" | "state" | "zip">): string | null {
  if (!l.address1) return null;
  const q = [l.address1, l.city, [l.state, l.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
}

export function buildListView(input: ListInput): ListView {
  const { site, page, listings, vocabulary, plan, canonical, titleOf } = input;
  const defs = new Map(vocabulary.factDefs.map((d) => [d.key, d]));
  const capNames = new Map(vocabulary.capabilities.map((c) => [c.slug, c.name]));
  const metroName = vocabulary.metros.find((m) => m.slug === page.metro)?.name ?? page.metro!;
  const capName = capNames.get(page.capability!) ?? page.capability!;
  const shopPaths = new Set(plan.filter((p) => p.type === "shop").map((p) => p.path));
  const title = titleOf(page);

  const booleanAngle = vocabulary.factDefs
    .filter((d) => d.type === "boolean" && (site.angle.factGroups.includes(d.group) || site.angle.facts.includes(d.key)))
    .sort((a, b) => a.sort - b.sort);

  const slots = cardFactKeys(site, vocabulary.factDefs).map((key) => defs.get(key)).filter((d) => d !== undefined);

  const cards: ListCard[] = listings.map((l) => {
    const facts = angleFacts(site, l);
    const check = latestCheck([...facts, ...Object.values(l.keyChecks)]);
    return {
      id: l.id,
      slug: l.slug,
      name: l.name,
      city: l.city,
      href: shopPaths.has(`/shop/${l.slug}/`) ? `/shop/${l.slug}/` : null,
      facts: slots.map((d) => {
        const f = l.facts.find((x) => x.key === d.key);
        return {
          key: d.key,
          label: d.label,
          text: f ? formatValue(d.type, f.value) : NOT_CHECKED,
          known: !!f,
          stale: f?.stale ?? false,
          layout: SHORT_TYPES.has(d.type) ? "strip" : "row",
          headline: d.key === site.angle.headline,
        };
      }),
      capabilities: l.capabilities.map((slug) => ({ slug, name: capNames.get(slug) ?? slug })),
      check: check ? checkLine(check) : null,
      website: l.website,
      phone: l.phone,
      tel: l.phone ? `tel:${l.phone.replace(/[^\d+]/g, "")}` : null,
      directions: directionsUrl(l),
      trueFacts: booleanAngle.filter((d) => facts.some((f) => f.key === d.key && f.value === true)).map((d) => d.key),
    };
  });

  // Lead: data-built sentences only (rule 4).
  const n = listings.length;
  const lead = [`${n} ${n === 1 ? "shop" : "shops"} in ${metroName} ${n === 1 ? "offers" : "offer"} ${lowerFirst(capName)}.`];
  const headline = site.angle.headline ? defs.get(site.angle.headline) : undefined;
  if (headline) {
    const has = listings.filter((l) => {
      const f = l.facts.find((x) => x.key === headline.key);
      return f !== undefined && (headline.type !== "boolean" || f.value === true);
    }).length;
    lead.push(`${headline.label}: confirmed for ${has} of ${n}.`);
  }
  const last = latestCheck(listings.flatMap((l) => [...l.facts, ...Object.values(l.keyChecks)]));
  if (last) lead.push(`Last checked ${formatDate(last.checkedAt)}.`);

  const ship = plan.find((p) => p.type === "shipToYou" && p.capability === page.capability && p.metro === page.metro);
  const hub = plan.find((p) => p.type === "metroHub" && p.metro === page.metro);
  const home = plan.find((p) => p.type === "home");
  const breadcrumbs = [
    ...(home ? [{ name: titleOf(home), path: home.path }] : []),
    ...(hub ? [{ name: titleOf(hub), path: hub.path }] : []),
    { name: title, path: page.path },
  ];

  const jsonLd: Record<string, unknown>[] = [
    {
      "@context": "https://schema.org",
      "@type": "ItemList",
      name: title,
      url: canonical(page.path),
      numberOfItems: cards.length,
      itemListElement: cards.map((c, i) => ({
        "@type": "ListItem",
        position: i + 1,
        name: c.name,
        ...(c.href ? { url: canonical(c.href) } : {}),
      })),
    },
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: breadcrumbs.map((b, i) => ({ "@type": "ListItem", position: i + 1, name: b.name, item: canonical(b.path) })),
    },
  ];

  return {
    lead,
    cards,
    cities: [...new Set(cards.map((c) => c.city))].sort((a, b) => a.localeCompare(b)).filter((_, __, all) => all.length > 1),
    toggles: booleanAngle.filter((d) => cards.some((c) => c.trueFacts.includes(d.key))).map((d) => ({ key: d.key, label: d.label })),
    fallback: ship ? { href: ship.path, text: titleOf(ship) } : null,
    breadcrumbs,
    jsonLd,
  };
}

/** JSON for a <script type="application/ld+json"> body, safe against "</script>" in data. */
export const jsonLdText = (data: unknown) => JSON.stringify(data).replace(/</g, "\\u003c");
