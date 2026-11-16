/**
 * Core listing fields (identity, not facts): form input -> a row for `listings`, with the same rules
 * as the table's check constraints, so the reviewer sees errors before saving.
 */

export const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export interface ListingRow {
  id: string;
  dataset_id: string;
  slug: string;
  name: string;
  status: "draft" | "published" | "removed";
  place_id: string | null;
  address1: string | null;
  address2: string | null;
  city: string;
  state: string;
  zip: string | null;
  phone: string | null;
  website: string | null;
  lat: number | string | null;
  lng: number | string | null;
  description: string | null;
  claimed_email: string | null;
  claimed_at: string | null;
  last_verified_at: string | null;
  published_at: string | null;
  updated_at: string;
}

export const CORE_FIELDS = [
  "name", "slug", "address1", "address2", "city", "state", "zip", "phone", "website", "lat", "lng", "place_id", "description",
] as const;
export type CoreField = (typeof CORE_FIELDS)[number];
export type CoreInput = Record<CoreField, string>;

export const CORE_LABELS: Record<CoreField, string> = {
  name: "Name",
  slug: "URL slug",
  address1: "Address",
  address2: "Address line 2",
  city: "City",
  state: "State (2 letters)",
  zip: "ZIP",
  phone: "Phone",
  website: "Website",
  lat: "Latitude (ZIP centroid)",
  lng: "Longitude (ZIP centroid)",
  place_id: "Google place ID",
  description: "Owner-written description",
};

export function emptyCore(): CoreInput {
  return Object.fromEntries(CORE_FIELDS.map((f) => [f, ""])) as CoreInput;
}

/** A candidate's draft form: blank except the place ID. Nothing from Google is prefilled (D8). */
export function draftStart(placeId: string): CoreInput {
  return { ...emptyCore(), place_id: placeId };
}

export function coreFromRow(r: ListingRow): CoreInput {
  return Object.fromEntries(CORE_FIELDS.map((f) => [f, r[f] === null || r[f] === undefined ? "" : String(r[f])])) as CoreInput;
}

/** A slug from a name: lowercase, hyphenated. */
export function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export type CorePatch = Record<CoreField, string | number | null>;
export type BuiltCore = { ok: true; row: CorePatch } | { ok: false; errors: Partial<Record<CoreField, string>> };

/** Validate core fields. Blank optional fields become null. */
export function buildCore(input: CoreInput): BuiltCore {
  const errors: Partial<Record<CoreField, string>> = {};
  const t = (f: CoreField) => (input[f] ?? "").trim();
  const opt = (f: CoreField) => t(f) || null;

  if (!t("name")) errors.name = "Required.";
  if (!SLUG_RE.test(t("slug"))) errors.slug = "Lowercase letters, numbers and single hyphens, like example-print-shop.";
  if (!t("city")) errors.city = "Required.";
  if (!/^[A-Z]{2}$/.test(t("state"))) errors.state = "Two capital letters, like FL.";
  if (t("zip") && !/^[0-9]{5}$/.test(t("zip"))) errors.zip = "Five digits.";
  if (t("website") && !/^https?:\/\//.test(t("website"))) errors.website = "A full URL starting with http:// or https://.";
  if (t("description").length > 500) errors.description = "500 characters at most.";

  const coord = (f: "lat" | "lng", max: number): number | null => {
    if (!t(f)) return null;
    const n = Number(t(f));
    if (!/^-?\d+(\.\d+)?$/.test(t(f)) || Math.abs(n) > max) {
      errors[f] = `A number between -${max} and ${max}.`;
      return null;
    }
    return n;
  };
  const lat = coord("lat", 90);
  const lng = coord("lng", 180);

  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    row: {
      name: t("name"),
      slug: t("slug"),
      address1: opt("address1"),
      address2: opt("address2"),
      city: t("city"),
      state: t("state"),
      zip: opt("zip"),
      phone: opt("phone"),
      website: opt("website"),
      lat,
      lng,
      place_id: opt("place_id"),
      description: opt("description"),
    },
  };
}
