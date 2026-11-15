/**
 * Helpers for the info and legal pages (about, disclosure, privacy, terms, contact). Pure: each takes
 * the site config or loaded data as arguments, so the text built from config is tested without a build.
 * Which of these pages exist, and their index state, comes from planPages() (INFO_PAGES).
 */

import type { InfoPage, Page, SiteConfig } from "@directory-engine/core";
import type { SiteAffiliate, Vocabulary } from "./load.ts";

export const INFO_TITLES: Record<InfoPage, string> = {
  about: "About",
  disclosure: "Affiliate disclosure",
  privacy: "Privacy policy",
  terms: "Terms of use",
  contact: "Contact",
};

/** "/privacy/" -> "privacy". */
export const infoSlug = (path: string) => path.replace(/\//g, "") as InfoPage;

/** Shown wherever the operator would be named while sites/<slug>.json has `"operator": null`. */
export const OPERATOR_PLACEHOLDER = "Operator not set yet";
/** Shown on the contact page while the operator has no email. */
export const EMAIL_PLACEHOLDER = "Contact email not set yet";

/** Who runs the site, as a name, or null while it isn't set (launch is refused until it is). */
export const operatorName = (site: SiteConfig): string | null => site.operator?.name ?? null;
export const operatorEmail = (site: SiteConfig): string | null => site.operator?.email ?? null;

/** "a", "a and b", "a, b and c". */
export function listText(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * What the site covers, as display names: the capabilities it builds list pages for, and its metros
 * (the config's metro filter, or else the metros that have a planned list page or hub).
 */
export function coverage(site: SiteConfig, pages: Page[], vocabulary: Vocabulary): { capabilities: string[]; metros: string[] } {
  const capName = new Map(vocabulary.capabilities.map((c) => [c.slug, c.name]));
  const metroName = new Map(vocabulary.metros.map((m) => [m.slug, m.name]));
  const planned = pages.filter((p) => p.type === "capabilityMetro" || p.type === "metroHub").map((p) => p.metro!);
  const metros = site.filter.metros ?? [...new Set(planned)].sort();
  return {
    capabilities: site.pages.capabilityMetro.map((c) => capName.get(c) ?? c),
    metros: metros.map((m) => metroName.get(m) ?? m),
  };
}

/** Label of the fact that leads this site's lists, or null when the site has none. */
export function headlineLabel(site: SiteConfig, vocabulary: Vocabulary): string | null {
  const key = site.angle.headline;
  if (!key) return null;
  return vocabulary.factDefs.find((d) => d.key === key)?.label ?? key;
}

/** Names of the affiliate programs approved for this site (the only ones that can carry a link). */
export const approvedPrograms = (affiliates: SiteAffiliate[]): string[] =>
  affiliates.filter((a) => a.status === "approved" && a.url).map((a) => a.name).sort((a, b) => a.localeCompare(b));

/** The disclosure line every page with an affiliate link shows (docs/SPEC.md, rule 10). */
export const DISCLOSURE_LINE =
  "Some links on this page earn us a commission. It doesn't change which shops we list or how we order them.";
