/**
 * What a shop page shows, as plain data: core fields with their checks, this site's angle facts
 * grouped by fact group (verified ones with their check line, the rest as "Not checked yet"), and the
 * LocalBusiness structured data. Pure functions so tests can call them without a build.
 *
 * Facts come only from `listing.facts`, which the loader fills from `public_listing_facts` (rule 1).
 * Which facts belong to the angle is decided by `angleFacts()` in packages/core.
 */

import { angleFacts, type Fact, type SiteConfig } from "@directory-engine/core";
import type { CoreKey, KeyCheck, Vocabulary, WebListing } from "./load.ts";

export const NOT_CHECKED = "Not checked yet";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-11-10" -> "Nov 10, 2026". Read as a calendar date, so the build machine's time zone never shifts it. */
export function formatDate(ymd: string): string {
  const [y, m, d] = ymd.slice(0, 10).split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

/** "14:00" -> "2:00 PM". */
export function formatTime(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

const METHODS: Record<string, string> = {
  phone_call: "by phone",
  website: "on the shop's website",
  site_visit: "in person",
  owner_submitted: "by the owner",
};
export const methodPhrase = (method: string) => METHODS[method] ?? `by ${method.replace(/_/g, " ")}`;

/** "Checked Nov 10, 2026 by phone." plus "May be out of date." when the check is over 180 days old. */
export function checkLine(check: { checkedAt: string; method: string; stale?: boolean }): string {
  const line = `Checked ${formatDate(check.checkedAt)} ${methodPhrase(check.method)}.`;
  return check.stale ? `${line} May be out of date.` : line;
}

export const DAYS = [
  ["mon", "Monday"], ["tue", "Tuesday"], ["wed", "Wednesday"], ["thu", "Thursday"],
  ["fri", "Friday"], ["sat", "Saturday"], ["sun", "Sunday"],
] as const;

type DayHours = { open: string; close: string } | null;
export type Hours = Partial<Record<(typeof DAYS)[number][0], DayHours>>;

/** One row per day: times, "Closed" for a day checked as closed, "Not checked yet" for a missing day. */
export function hoursRows(hours: Hours): { day: string; text: string }[] {
  return DAYS.map(([key, day]) => {
    if (!(key in hours)) return { day, text: NOT_CHECKED };
    const h = hours[key];
    return { day, text: h ? `${formatTime(h.open)} to ${formatTime(h.close)}` : "Closed" };
  });
}

export interface FactRow {
  key: string;
  label: string;
  type: string;
  /** Null when the shop has no verified value: shown as "Not checked yet". */
  fact: Fact | null;
  /** Display text for scalar types; hours and urls are rendered from `fact.value`. */
  text: string;
  check: string | null;
}

export interface FactGroup {
  group: string;
  label: string;
  rows: FactRow[];
}

function valueText(type: string, value: unknown): string {
  switch (type) {
    case "boolean":
      return value === true ? "Yes" : value === false ? "No" : String(value);
    case "time":
      return typeof value === "string" ? formatTime(value) : String(value);
    case "number":
      return typeof value === "number" ? value.toLocaleString("en-US") : String(value);
    case "hours":
      return "";
    default:
      return String(value);
  }
}

/** Fact groups have no name in the schema: a group named after a capability takes its name, others are capitalized. */
export function groupLabel(group: string, vocabulary: Vocabulary): string {
  const cap = vocabulary.capabilities.find((c) => c.slug === group);
  return cap ? cap.name : group.charAt(0).toUpperCase() + group.slice(1).replace(/[-_]/g, " ");
}

/**
 * Every fact in this site's angle, grouped, in fact-definition order with the headline's group first.
 * Facts outside the angle never appear.
 */
export function shopFactGroups(site: SiteConfig, vocabulary: Vocabulary, listing: WebListing): FactGroup[] {
  const shown = new Map(angleFacts(site, listing).map((f) => [f.key, f]));
  const inAngle = vocabulary.factDefs
    .filter((d) => site.angle.factGroups.includes(d.group) || site.angle.facts.includes(d.key))
    .sort((a, b) => a.sort - b.sort || a.key.localeCompare(b.key));
  const groups: FactGroup[] = [];
  for (const d of inAngle) {
    let g = groups.find((x) => x.group === d.group);
    if (!g) groups.push((g = { group: d.group, label: groupLabel(d.group, vocabulary), rows: [] }));
    const fact = shown.get(d.key) ?? null;
    g.rows.push({
      key: d.key, label: d.label, type: d.type, fact,
      text: fact ? valueText(d.type, fact.value) : NOT_CHECKED,
      check: fact ? checkLine(fact) : null,
    });
  }
  // The group holding the site's headline fact leads, as the headline leads cards and lists.
  const lead = groups.findIndex((g) => g.rows.some((r) => r.key === site.angle.headline));
  if (lead > 0) groups.unshift(...groups.splice(lead, 1));
  return groups;
}

/** Street address on one line, or null when there is none. */
export function streetAddress(l: WebListing): string | null {
  return [l.address1, l.address2].filter(Boolean).join(", ") || null;
}

export function fullAddress(l: WebListing): string {
  return [streetAddress(l), l.city, [l.state, l.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
}

/** A maps search for the address, opened in a new tab. Nothing from Google is embedded or stored. */
export const directionsUrl = (l: WebListing) =>
  `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${l.name}, ${fullAddress(l)}`)}`;

export const telHref = (phone: string) => `tel:${phone.replace(/[^\d+]/g, "")}`;

export const coreCheck = (l: WebListing, key: CoreKey): string | null => {
  const c: KeyCheck | undefined = l.keyChecks[key];
  return c ? checkLine(c) : null;
};

/** The verified opening-hours fact (type `hours`), if this site's angle includes it and the shop has it. */
export function verifiedHours(site: SiteConfig, vocabulary: Vocabulary, listing: WebListing): Fact | null {
  const hourKeys = new Set(vocabulary.factDefs.filter((d) => d.type === "hours").map((d) => d.key));
  return angleFacts(site, listing).find((f) => hourKeys.has(f.key)) ?? null;
}

/**
 * schema.org LocalBusiness for the shop: name, address, telephone, url, and opening hours only when
 * the hours fact is verified. Never ratings or reviews (rule 3).
 */
export function localBusinessJsonLd(site: SiteConfig, vocabulary: Vocabulary, listing: WebListing, pageUrl: string): Record<string, unknown> {
  const ld: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "LocalBusiness",
    "@id": `${pageUrl}#business`,
    name: listing.name,
    address: {
      "@type": "PostalAddress",
      ...(streetAddress(listing) ? { streetAddress: streetAddress(listing) } : {}),
      addressLocality: listing.city,
      addressRegion: listing.state,
      ...(listing.zip ? { postalCode: listing.zip } : {}),
    },
  };
  if (listing.phone) ld.telephone = listing.phone;
  if (listing.website) ld.url = listing.website;
  const hours = verifiedHours(site, vocabulary, listing);
  if (hours) {
    const spec = openingHoursSpecification(hours.value as Hours);
    if (spec.length) ld.openingHoursSpecification = spec;
  }
  return ld;
}

/** Days with the same times share one entry. Closed and unchecked days are left out. */
export function openingHoursSpecification(hours: Hours): Record<string, unknown>[] {
  const out: { dayOfWeek: string[]; opens: string; closes: string }[] = [];
  for (const [key, day] of DAYS) {
    const h = hours[key];
    if (!h) continue;
    const same = out.find((o) => o.opens === h.open && o.closes === h.close);
    if (same) same.dayOfWeek.push(day);
    else out.push({ dayOfWeek: [day], opens: h.open, closes: h.close });
  }
  return out.map((o) => ({ "@type": "OpeningHoursSpecification", ...o }));
}

/** JSON for a <script type="application/ld+json">, safe to inline: no "<" can close the script tag. */
export const jsonLdText = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c");
