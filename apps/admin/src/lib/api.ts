/**
 * Everything the admin app reads and writes, as the signed-in user. Row level security (admins only)
 * decides what comes back; nothing here bypasses it, and no service role key is ever used.
 *
 * Facts are only ever written through `record_check()` (rule 9). Listings are never deleted.
 */
import { readThemeSource, THEME_TEXT_MAX, themeVariables, type Listing, type ThemeResult } from "@directory-engine/core";
import { eq, type Db, type Filter } from "./db.ts";
import { buildCheck, type CheckForm, type FactDef, type RecordCheckArgs } from "./facts.ts";
import type { ListingRow } from "./listing.ts";
import { verifiedFacts, type FactStatusRow } from "./sites.ts";
import type { ClickRow } from "./stats.ts";

/** Every table and view the app reads. The access test proves a non-admin gets nothing from each. */
export const READ_SOURCES = [
  "datasets", "capabilities", "metros", "fact_defs", "listings", "listing_capabilities", "listing_metros",
  "listing_fact_status", "listing_key_checks", "verification_events", "sites", "affiliate_programs",
  "site_affiliates", "clicks", "claims", "corrections", "candidates", "site_settings",
] as const;

// ------------------------------------------------------------------ access

/** True when the signed-in user has a row in `admins` (they may read only their own row). */
export async function isAdmin(db: Db, userId: string): Promise<boolean> {
  const rows = await db.select("admins", { columns: ["user_id"], where: [eq("user_id", userId)] });
  return rows.length === 1;
}

// ------------------------------------------------------------------ vocabulary

export interface Dataset { id: string; slug: string; name: string }
export interface Capability { id: string; dataset_id: string; slug: string; name: string }
export interface Metro { id: string; dataset_id: string; slug: string; name: string; state: string; cities: string[] }
export interface DatasetFactDef extends FactDef { dataset_id: string }

export interface Vocab {
  datasets: Dataset[];
  capabilities: Capability[];
  metros: Metro[];
  factDefs: DatasetFactDef[];
}

export async function loadVocab(db: Db): Promise<Vocab> {
  const [datasets, capabilities, metros, factDefs] = await Promise.all([
    db.select<Dataset>("datasets", { order: [{ col: "slug" }] }),
    db.select<Capability>("capabilities", { order: [{ col: "name" }] }),
    db.select<Metro>("metros", { order: [{ col: "name" }] }),
    db.select<DatasetFactDef>("fact_defs", { order: [{ col: "sort" }] }),
  ]);
  return { datasets, capabilities, metros, factDefs };
}

// ------------------------------------------------------------------ listings

export const LISTING_SUMMARY_COLUMNS = ["id", "dataset_id", "slug", "name", "status", "city", "state", "last_verified_at", "updated_at"];
export type ListingSummary = Pick<ListingRow, "id" | "dataset_id" | "slug" | "name" | "status" | "city" | "state" | "last_verified_at" | "updated_at">;

export async function searchListings(db: Db, term: string, status: ListingRow["status"] | "" = ""): Promise<ListingSummary[]> {
  const where: Filter[] = status ? [eq("status", status)] : [];
  return db.select<ListingSummary>("listings", {
    columns: LISTING_SUMMARY_COLUMNS,
    where,
    search: term.trim() ? { columns: ["name", "city", "slug"], term } : undefined,
    order: [{ col: "name" }],
    range: [0, 199],
  });
}

export interface CheckRow {
  id: string;
  checked_at: string;
  method: string;
  fact_keys: string[];
  note: string | null;
  evidence_url: string | null;
  checked_by: string;
  created_at: string;
}

export interface ListingDetail {
  listing: ListingRow;
  capabilityIds: string[];
  metros: { metro_id: string; is_primary: boolean }[];
  factStatus: (FactStatusRow & { value_changed_at: string })[];
  keyChecks: { key: string; checked_at: string; method: string }[];
  checks: CheckRow[];
}

export async function getListing(db: Db, id: string): Promise<ListingDetail | null> {
  const [listing] = await db.select<ListingRow>("listings", { where: [eq("id", id)] });
  if (!listing) return null;
  const by = [eq("listing_id", id)];
  const [caps, metros, factStatus, keyChecks, checks] = await Promise.all([
    db.select<{ capability_id: string }>("listing_capabilities", { columns: ["capability_id"], where: by }),
    db.select<{ metro_id: string; is_primary: boolean }>("listing_metros", { columns: ["metro_id", "is_primary"], where: by }),
    db.select<FactStatusRow & { value_changed_at: string }>("listing_fact_status", {
      columns: ["key", "value", "value_changed_at", "verified", "stale", "checked_at", "method"],
      where: by,
    }),
    db.select<{ key: string; checked_at: string; method: string }>("listing_key_checks", { columns: ["key", "checked_at", "method"], where: by }),
    db.select<CheckRow>("verification_events", {
      columns: ["id", "checked_at", "method", "fact_keys", "note", "evidence_url", "checked_by", "created_at"],
      where: by,
      order: [{ col: "checked_at", asc: false }, { col: "created_at", asc: false }],
      range: [0, 49],
    }),
  ]);
  return { listing, capabilityIds: caps.map((c) => c.capability_id), metros, factStatus, keyChecks, checks };
}

/** The listing as packages/core sees it, with verified facts only. */
export function asCoreListing(d: ListingDetail, vocab: Vocab): Listing {
  const capSlug = new Map(vocab.capabilities.map((c) => [c.id, c.slug]));
  const metroSlug = new Map(vocab.metros.map((m) => [m.id, m.slug]));
  const defs = vocab.factDefs.filter((f) => f.dataset_id === d.listing.dataset_id);
  return {
    id: d.listing.id,
    slug: d.listing.slug,
    name: d.listing.name,
    status: d.listing.status,
    capabilities: d.capabilityIds.map((id) => capSlug.get(id)!).filter(Boolean),
    metros: d.metros.map((m) => metroSlug.get(m.metro_id)!).filter(Boolean),
    updatedAt: d.listing.updated_at,
    facts: verifiedFacts(d.factStatus, defs),
  };
}

/** A new listing is always a draft (the database refuses anything else). */
export async function createDraft(db: Db, datasetId: string, core: Record<string, unknown>): Promise<ListingRow> {
  return db.insert<ListingRow>("listings", { ...core, dataset_id: datasetId, status: "draft" });
}

async function updateOne<T>(db: Db, table: string, patch: Record<string, unknown>, where: Filter[]): Promise<T> {
  const rows = await db.update<T>(table, patch, where);
  if (rows.length !== 1) throw new Error(`Nothing was saved: the ${table} row was not found or you have no access.`);
  return rows[0];
}

export function updateListing(db: Db, id: string, core: Record<string, unknown>): Promise<ListingRow> {
  const { status: _s, dataset_id: _d, id: _i, ...patch } = core;
  return updateOne<ListingRow>(db, "listings", patch, [eq("id", id)]);
}

/** draft -> published (the database checks for a check, a capability and a metro), back, or removed. */
export function setListingStatus(db: Db, id: string, status: ListingRow["status"]): Promise<ListingRow> {
  return updateOne<ListingRow>(db, "listings", { status }, [eq("id", id)]);
}

export async function setCapabilities(db: Db, listing: Pick<ListingRow, "id" | "dataset_id">, want: string[], have: string[]): Promise<void> {
  for (const id of have.filter((x) => !want.includes(x))) {
    await db.delete("listing_capabilities", [eq("listing_id", listing.id), eq("capability_id", id)]);
  }
  for (const id of want.filter((x) => !have.includes(x))) {
    await db.insert("listing_capabilities", { listing_id: listing.id, capability_id: id, dataset_id: listing.dataset_id });
  }
}

/** Metros a listing serves; at most one primary. */
export async function setMetros(
  db: Db,
  listing: Pick<ListingRow, "id" | "dataset_id">,
  want: string[],
  primary: string | null,
  have: { metro_id: string; is_primary: boolean }[],
): Promise<void> {
  if (primary && !want.includes(primary)) throw new Error("The primary metro must be one of the selected metros.");
  const haveIds = have.map((m) => m.metro_id);
  for (const id of haveIds.filter((x) => !want.includes(x))) {
    await db.delete("listing_metros", [eq("listing_id", listing.id), eq("metro_id", id)]);
  }
  // Clear the old primary first so the one-primary index never sees two.
  for (const m of have.filter((m) => m.is_primary && m.metro_id !== primary && want.includes(m.metro_id))) {
    await db.update("listing_metros", { is_primary: false }, [eq("listing_id", listing.id), eq("metro_id", m.metro_id)]);
  }
  for (const id of want.filter((x) => !haveIds.includes(x))) {
    await db.insert("listing_metros", { listing_id: listing.id, metro_id: id, dataset_id: listing.dataset_id, is_primary: id === primary });
  }
  for (const m of have.filter((m) => m.metro_id === primary && !m.is_primary)) {
    await db.update("listing_metros", { is_primary: true }, [eq("listing_id", listing.id), eq("metro_id", m.metro_id)]);
  }
}

// ------------------------------------------------------------------ checks

/** Validate the check form and call `record_check()`. Returns the new event id, or the form errors. */
export async function recordCheck(
  db: Db,
  listingId: string,
  form: CheckForm,
  defs: FactDef[],
  existing: Set<string>,
  today: string,
): Promise<{ ok: true; id: string } | { ok: false; errors: Record<string, string> }> {
  const built = buildCheck(listingId, form, defs, existing, today);
  if (!built.ok) return built;
  const id = await sendCheck(db, built.args);
  return { ok: true, id };
}

export function sendCheck(db: Db, args: RecordCheckArgs): Promise<string> {
  return db.rpc<string>("record_check", { ...args });
}

// ------------------------------------------------------------------ queues

export interface ClaimRow {
  id: string;
  dataset_id: string;
  site_id: string | null;
  listing_id: string | null;
  contact_email: string;
  payload: Record<string, unknown>;
  status: "pending" | "approved" | "rejected";
  created_at: string;
  decided_at: string | null;
  /** Set once the owner opened the emailed link (T19); null = not confirmed. */
  email_confirmed_at: string | null;
  /** True when the claim was approved with the unconfirmed-email override. */
  approved_without_email: boolean;
}

export function listClaims(db: Db, status: ClaimRow["status"] = "pending"): Promise<ClaimRow[]> {
  return db.select<ClaimRow>("claims", { where: [eq("status", status)], order: [{ col: "created_at" }], range: [0, 199] });
}

export const UNCONFIRMED_EMAIL = "The owner hasn't confirmed this email address. Tick the override to approve it anyway.";

/**
 * Approve a claim: record the owner's facts as an `owner_submitted` check on the listing, mark the
 * listing claimed, and close the claim. Publishing stays a separate step.
 * A claim for a shop we don't list yet needs `listingId` (a draft created for it).
 * A claim whose email isn't confirmed needs `overrideUnconfirmed` (the database refuses it otherwise,
 * and keeps approved_without_email on the claim as the record of the override).
 */
export async function approveClaim(
  db: Db,
  claim: ClaimRow,
  listingId: string,
  form: CheckForm,
  defs: FactDef[],
  existing: Set<string>,
  today: string,
  opts: { overrideUnconfirmed?: boolean } = {},
): Promise<{ ok: true } | { ok: false; errors: Record<string, string> }> {
  if (claim.status !== "pending") return { ok: false, errors: { form: "This claim has already been decided." } };
  const confirmed = claim.email_confirmed_at !== null;
  if (!confirmed && !opts.overrideUnconfirmed) return { ok: false, errors: { form: UNCONFIRMED_EMAIL } };
  if (claim.listing_id && claim.listing_id !== listingId) return { ok: false, errors: { form: "This claim is for a different listing." } };
  const built = buildCheck(listingId, { ...form, method: "owner_submitted" }, defs, existing, today);
  if (!built.ok) return built;
  await sendCheck(db, built.args);
  await updateOne(db, "listings", { claimed_email: claim.contact_email, claimed_at: new Date().toISOString() }, [eq("id", listingId)]);
  await updateOne(db, "claims", { status: "approved", decided_at: new Date().toISOString(), listing_id: listingId, approved_without_email: !confirmed }, [eq("id", claim.id)]);
  return { ok: true };
}

export async function rejectClaim(db: Db, claimId: string): Promise<void> {
  await updateOne(db, "claims", { status: "rejected", decided_at: new Date().toISOString() }, [eq("id", claimId), eq("status", "pending")]);
}

// ------------------------------------------------------------------ discovery candidates

/** A place ID found by scripts/discover. The row holds nothing from Google but the ID (D8). */
export interface CandidateRow {
  id: string;
  dataset_id: string;
  place_id: string;
  query: string | null;
  status: "new" | "added" | "rejected";
  discovered_at: string;
}

export function listCandidates(db: Db, status: CandidateRow["status"] = "new"): Promise<CandidateRow[]> {
  return db.select<CandidateRow>("candidates", { where: [eq("status", status)], order: [{ col: "discovered_at" }], range: [0, 99] });
}

/**
 * "Add as draft": a draft listing from what the reviewer typed (from the shop's own website) plus the
 * candidate's place ID, then the candidate is marked added. Takes no Google details: nothing shown
 * in the review panel can reach `listings` or `listing_facts` through here.
 */
export async function addCandidateAsDraft(db: Db, candidate: CandidateRow, core: Record<string, unknown>): Promise<ListingRow> {
  if (candidate.status !== "new") throw new Error("This candidate has already been reviewed.");
  const listing = await createDraft(db, candidate.dataset_id, { ...core, place_id: candidate.place_id });
  await updateOne(db, "candidates", { status: "added" }, [eq("id", candidate.id), eq("status", "new")]);
  return listing;
}

export async function rejectCandidate(db: Db, candidateId: string): Promise<void> {
  await updateOne(db, "candidates", { status: "rejected" }, [eq("id", candidateId), eq("status", "new")]);
}

export interface CorrectionRow {
  id: string;
  listing_id: string;
  site_id: string | null;
  detail: string;
  status: "open" | "done" | "dismissed";
  created_at: string;
}

export function listCorrections(db: Db, status: CorrectionRow["status"] = "open"): Promise<CorrectionRow[]> {
  return db.select<CorrectionRow>("corrections", { where: [eq("status", status)], order: [{ col: "created_at" }], range: [0, 199] });
}

export async function setCorrectionStatus(db: Db, id: string, status: CorrectionRow["status"]): Promise<void> {
  await updateOne(db, "corrections", { status }, [eq("id", id)]);
}

/** Names for a set of listing ids (queues and stats show names, not uuids). */
export async function listingNames(db: Db, ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  if (!unique.length) return new Map();
  const rows = await db.select<{ id: string; name: string }>("listings", { columns: ["id", "name"], where: [{ col: "id", op: "in", value: unique }] });
  return new Map(rows.map((r) => [r.id, r.name]));
}

// ------------------------------------------------------------------ affiliates

export interface SiteRow { id: string; slug: string; name: string; domain: string | null; dataset_id: string }
export interface ProgramRow {
  id: string;
  slug: string;
  name: string;
  program_url: string | null;
  commission_note: string | null;
  cutoff_note: string | null;
  price_note: string | null;
  facts_checked_at: string | null;
}
export const AFFILIATE_STATUSES = ["apply", "applied", "approved", "rejected", "paused"] as const;
export interface SiteAffiliateRow {
  site_id: string;
  program_id: string;
  status: (typeof AFFILIATE_STATUSES)[number];
  url: string | null;
  placements: string[];
}

export async function loadAffiliates(db: Db): Promise<{ sites: SiteRow[]; programs: ProgramRow[]; links: SiteAffiliateRow[] }> {
  const [sites, programs, links] = await Promise.all([
    db.select<SiteRow>("sites", { order: [{ col: "slug" }] }),
    db.select<ProgramRow>("affiliate_programs", { order: [{ col: "name" }] }),
    db.select<SiteAffiliateRow>("site_affiliates"),
  ]);
  return { sites, programs, links };
}

/** Errors for a site's status and tracking link (mirrors the table's checks). Empty = valid. */
export function siteAffiliateErrors(status: string, url: string): string[] {
  const errs: string[] = [];
  if (!(AFFILIATE_STATUSES as readonly string[]).includes(status)) errs.push("Unknown status.");
  if (url.trim() && !/^https:\/\//.test(url.trim())) errs.push("The link must start with https://.");
  if (status === "approved" && !url.trim()) errs.push("An approved program needs its tracking link.");
  return errs;
}

export async function updateSiteAffiliate(db: Db, siteId: string, programId: string, status: string, url: string): Promise<void> {
  const errs = siteAffiliateErrors(status, url);
  if (errs.length) throw new Error(errs.join(" "));
  await updateOne(db, "site_affiliates", { status, url: url.trim() || null }, [eq("site_id", siteId), eq("program_id", programId)]);
}

/** Errors for a supplier's cutoff and price notes (read off its own site) and their check date. */
export function supplierNoteErrors(cutoff: string, price: string, checkedAt: string, today: string): string[] {
  const errs: string[] = [];
  const any = cutoff.trim() || price.trim();
  if (checkedAt && !/^\d{4}-\d{2}-\d{2}$/.test(checkedAt)) errs.push("Enter the date as YYYY-MM-DD.");
  else if (checkedAt > today) errs.push("The check date can't be in the future.");
  if (any && !checkedAt) errs.push("Enter the date you read these off the supplier's site.");
  return errs;
}

export async function updateSupplierNotes(db: Db, programId: string, cutoff: string, price: string, checkedAt: string, today: string): Promise<void> {
  const errs = supplierNoteErrors(cutoff, price, checkedAt, today);
  if (errs.length) throw new Error(errs.join(" "));
  await updateOne(db, "affiliate_programs", {
    cutoff_note: cutoff.trim() || null,
    price_note: price.trim() || null,
    facts_checked_at: checkedAt || null,
  }, [eq("id", programId)]);
}

// ------------------------------------------------------------------ stats

/** Every click since a date, fetched a page at a time. */
export async function loadClicks(db: Db, sinceIso: string, pageSize = 1000): Promise<ClickRow[]> {
  const out: ClickRow[] = [];
  for (let from = 0; ; from += pageSize) {
    const page = await db.select<ClickRow>("clicks", {
      columns: ["id", "site_id", "kind", "listing_id", "program_id", "created_at"],
      where: [{ col: "created_at", op: "gte", value: sinceIso }],
      order: [{ col: "id" }],
      range: [from, from + pageSize - 1],
    });
    out.push(...page);
    if (page.length < pageSize) return out;
  }
}

// ------------------------------------------------------------------ site settings (D31)

export interface SiteSettingsRow {
  site_id: string;
  name: string | null;
  operator_name: string | null;
  operator_email: string | null;
  theme_config: string | null;
  theme_css: string | null;
  updated_at: string;
}

export interface SettingsForm {
  name: string;
  operatorName: string;
  operatorEmail: string;
  themeConfig: string;
  themeCss: string;
}

export const settingsForm = (row: SiteSettingsRow | undefined): SettingsForm => ({
  name: row?.name ?? "",
  operatorName: row?.operator_name ?? "",
  operatorEmail: row?.operator_email ?? "",
  themeConfig: row?.theme_config ?? "",
  themeCss: row?.theme_css ?? "",
});

export async function loadSiteSettings(db: Db): Promise<{ sites: SiteRow[]; settings: SiteSettingsRow[] }> {
  const [sites, settings] = await Promise.all([
    db.select<SiteRow>("sites", { order: [{ col: "slug" }] }),
    db.select<SiteSettingsRow>("site_settings"),
  ]);
  return { sites, settings };
}

/**
 * Errors for a site settings form (mirrors the table's checks), plus the theme's own checks: it is
 * read as text and every text color must read on its background. `brand` is the site file's colors,
 * used for anything the theme leaves out.
 */
export function siteSettingsErrors(f: SettingsForm, brand: { primary: string; accent: string }): { errors: string[]; theme: ThemeResult | null } {
  const errors: string[] = [];
  if (f.name.trim().length > 80) errors.push("The name can be at most 80 characters.");
  if (f.operatorName.trim().length > 120) errors.push("The operator name can be at most 120 characters.");
  if (f.operatorEmail.trim() && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.operatorEmail.trim())) errors.push("The operator email isn't an email address.");
  if (f.operatorEmail.trim() && !f.operatorName.trim()) errors.push("Enter the operator's name with their email.");
  for (const [label, text] of [["Tailwind config", f.themeConfig], ["Theme CSS", f.themeCss]] as const) {
    if (text.length > THEME_TEXT_MAX) errors.push(`${label} can be at most ${THEME_TEXT_MAX.toLocaleString("en-US")} characters.`);
  }
  let theme: ThemeResult | null = null;
  if (f.themeConfig.trim() || f.themeCss.trim()) {
    theme = themeVariables(readThemeSource({ config: f.themeConfig, css: f.themeCss }), brand, "Theme");
    errors.push(...theme.errors);
  }
  return { errors, theme };
}

/** Saves a site's settings (inserts the row the first time). Blank fields are stored as null: the site file's value. */
export async function saveSiteSettings(db: Db, siteId: string, f: SettingsForm, brand: { primary: string; accent: string }, exists: boolean): Promise<void> {
  const { errors } = siteSettingsErrors(f, brand);
  if (errors.length) throw new Error(errors.join(" "));
  const blank = (s: string) => (s.trim() ? s.trim() : null);
  const row = {
    name: blank(f.name),
    operator_name: blank(f.operatorName),
    operator_email: blank(f.operatorEmail),
    theme_config: f.themeConfig.trim() ? f.themeConfig : null,
    theme_css: f.themeCss.trim() ? f.themeCss : null,
  };
  if (exists) await updateOne(db, "site_settings", row, [eq("site_id", siteId)]);
  else await db.insert("site_settings", { site_id: siteId, ...row });
}
