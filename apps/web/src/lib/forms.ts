/**
 * Helpers for the public forms (T11): the add-your-shop form and the shop page's report-a-change form.
 * They post to /submit-claim/ and /report-change/ on the site's own domain, which the host routes to
 * the Edge Functions (host-routing.ts). Field names, length limits, the honeypot and the messages are
 * the functions' own (supabase/functions/_shared/forms.ts), so page and server can't drift apart.
 */

import { siteListings, type SiteConfig } from "@directory-engine/core";
import type { Vocabulary, WebListing } from "./load.ts";
import { groupLabel } from "./shop.ts";
import { DETAIL_MIN, FIELD_LIMITS, HONEYPOT, MESSAGES, type Outcome } from "../../../../supabase/functions/_shared/forms.ts";

export { DETAIL_MIN, FIELD_LIMITS, HONEYPOT, MESSAGES, type Outcome };

export const CLAIM_ACTION = "/submit-claim/";
export const REPORT_ACTION = "/report-change/";
export const OUTCOMES = Object.keys(MESSAGES) as Outcome[];

/**
 * Cloudflare Turnstile's public site key from the build environment, or null (no widget). The
 * matching secret is TURNSTILE_SECRET_KEY in the Edge Functions' secrets; set both or neither.
 */
export function turnstileSiteKey(env: Record<string, string | undefined>): string | null {
  return env.TURNSTILE_SITE_KEY?.trim() || null;
}

export interface FormFact {
  key: string;
  label: string;
  type: string;
}

/** The facts a shop owner can send on this site's form: the site's angle, grouped as on shop pages. */
export function claimFactGroups(site: SiteConfig, vocabulary: Vocabulary): { group: string; label: string; facts: FormFact[] }[] {
  const inAngle = vocabulary.factDefs
    .filter((d) => site.angle.factGroups.includes(d.group) || site.angle.facts.includes(d.key))
    .sort((a, b) => a.sort - b.sort || a.key.localeCompare(b.key));
  const groups: { group: string; label: string; facts: FormFact[] }[] = [];
  for (const d of inAngle) {
    let g = groups.find((x) => x.group === d.group);
    if (!g) groups.push((g = { group: d.group, label: groupLabel(d.group, vocabulary), facts: [] }));
    g.facts.push({ key: d.key, label: d.label, type: d.type });
  }
  return groups;
}

/** Shops on this site an owner can claim, by name. */
export function claimableShops(site: SiteConfig, listings: WebListing[]): { id: string; label: string }[] {
  const mine = new Set(siteListings(site, listings).map((l) => l.id));
  return listings
    .filter((l) => mine.has(l.id))
    .map((l) => ({ id: l.id, label: `${l.name}, ${l.city}` }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export const DAYS = [
  ["mon", "Monday"], ["tue", "Tuesday"], ["wed", "Wednesday"], ["thu", "Thursday"],
  ["fri", "Friday"], ["sat", "Saturday"], ["sun", "Sunday"],
] as const;

/** Link from a shop page to the claim form with that shop picked. */
export const claimHref = (listingId: string) => `/add-your-shop/?shop=${encodeURIComponent(listingId)}`;
