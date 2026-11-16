/**
 * Ship-to-you page (docs/SPEC.md): this site's approved suppliers placed on this capability and metro, each with the cutoff and price notes
 * read from the supplier's own site and the date they were read. Pure: everything comes from the plan,
 * the site config and the loaded affiliates (the loader's only source for supplier notes is
 * `affiliate_programs`; supplier notes are never listing facts).
 */

import { shipSuppliers, type Page, type SiteConfig } from "@directory-engine/core";
import { goHref } from "./affiliate.ts";
import { formatDate } from "./fact-format.ts";
import type { SiteAffiliate } from "./load.ts";

/** Shown for a note the supplier row has no checked value for. */
export const NOT_CHECKED = "Not checked yet";

export interface SupplierRow {
  slug: string;
  name: string;
  /** Always a /go/ path: suppliers are approved and placed on ship-to-you by construction. */
  href: string;
  cutoff: string;
  price: string;
  /** "Checked Nov 18, 2026 on the supplier's website". */
  checked: string;
}

export interface ShipView {
  lead: string;
  rows: SupplierRow[];
  /** The capability x metro list this page backs up, when the plan builds one. */
  list: { href: string; text: string } | null;
}

export interface ShipInput {
  site: SiteConfig;
  page: Page;
  affiliates: SiteAffiliate[];
  plan: Page[];
  capabilityName: (slug: string) => string;
  metroName: (slug: string) => string;
  titleOf: (page: Page) => string;
}

export function buildShipView(input: ShipInput): ShipView {
  const { site, page, affiliates, plan } = input;
  const scope = { capability: page.capability!, metro: page.metro! };
  const rows: SupplierRow[] = shipSuppliers(site, affiliates, scope)
    .map((a) => {
      const href = goHref(site, affiliates, a.slug, "ship-to-you", scope);
      if (!href) throw new Error(`ship-to-you: supplier "${a.slug}" has no /go/ link`);
      if (!a.factsCheckedAt) throw new Error(`ship-to-you: supplier "${a.slug}" has notes without a check date`);
      return {
        slug: a.slug, name: a.name, href,
        cutoff: a.cutoffNote ?? NOT_CHECKED,
        price: a.priceNote ?? NOT_CHECKED,
        checked: `Checked ${formatDate(a.factsCheckedAt)} on the supplier's website`,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const cap = input.capabilityName(page.capability!);
  const metro = input.metroName(page.metro!);
  const n = rows.length;
  const lead =
    `For when no shop in ${metro} can make it in time: ${n} ${n === 1 ? "supplier that ships" : "suppliers that ship"} ${cap}. ` +
    "Cutoffs and prices are as read from each supplier's own website on the date shown.";

  const listPage = plan.find((p) => p.type === "capabilityMetro" && p.capability === page.capability && p.metro === page.metro);
  return { lead, rows, list: listPage ? { href: listPage.path, text: input.titleOf(listPage) } : null };
}
