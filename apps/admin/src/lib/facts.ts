/**
 * The "Record a check" form, without React: what the reviewer typed, checked against each fact's
 * declared type, turned into the arguments of `record_check()`.
 *
 * The rules mirror the `listing_facts_guard` and `verification_events` triggers in
 * supabase/migrations/0001_core.sql, so a bad value is refused here, before anything is sent.
 * The database still enforces them; this only gives the reviewer the error next to the input.
 */

export type ValueType = "text" | "boolean" | "number" | "time" | "hours" | "url";
export const METHODS = ["phone_call", "website", "site_visit", "owner_submitted"] as const;
export type Method = (typeof METHODS)[number];
export const METHOD_LABELS: Record<Method, string> = {
  phone_call: "Phone call",
  website: "Shop's website",
  site_visit: "Site visit",
  owner_submitted: "Owner submitted",
};
/** Keys every listing has outside fact_defs (`core_fact_keys()` in the migration). */
export const CORE_KEYS = ["name", "address", "phone", "website", "capabilities", "metros"] as const;
export const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Day = (typeof DAYS)[number];

export interface FactDef {
  key: string;
  label: string;
  value_type: ValueType;
  fact_group: string;
  sort: number;
}

/** One day of an hours input. `unknown` leaves the day out (not checked). */
export interface DayInput {
  state: "unknown" | "closed" | "open";
  open: string;
  close: string;
}

/** Raw input for one fact. Text-like types use `text`; boolean uses "true"/"false"; hours uses `days`. */
export interface FactInput {
  /** keep: not part of this check. confirm: checked, value unchanged. set: new value. clear: now unknown. */
  action: "keep" | "confirm" | "set" | "clear";
  text?: string;
  days?: Record<Day, DayInput>;
}

export type Parsed = { ok: true; value: unknown } | { ok: false; error: string };

const TIME_RE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const URL_RE = /^https?:\/\//;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Turn one raw input into the JSON value the database expects for this type, or an error. */
export function parseFactValue(type: ValueType, input: FactInput): Parsed {
  const raw = (input.text ?? "").trim();
  switch (type) {
    case "text":
      return raw ? { ok: true, value: raw } : { ok: false, error: "Enter a value, or choose \"Now unknown\"." };
    case "url":
      return URL_RE.test(raw) ? { ok: true, value: raw } : { ok: false, error: "Enter a full URL starting with http:// or https://." };
    case "time":
      return TIME_RE.test(raw) ? { ok: true, value: raw } : { ok: false, error: "Enter a time as HH:MM in 24-hour time, like 14:00." };
    case "number": {
      if (raw === "" || !/^-?\d+(\.\d+)?$/.test(raw)) return { ok: false, error: "Enter a number, like 6 or 6.5." };
      return { ok: true, value: Number(raw) };
    }
    case "boolean":
      if (raw === "true") return { ok: true, value: true };
      if (raw === "false") return { ok: true, value: false };
      return { ok: false, error: "Choose yes or no." };
    case "hours": {
      const days = input.days;
      if (!days) return { ok: false, error: "Enter at least one day." };
      const out: Record<string, { open: string; close: string } | null> = {};
      for (const d of DAYS) {
        const x = days[d];
        if (!x || x.state === "unknown") continue;
        if (x.state === "closed") {
          out[d] = null;
          continue;
        }
        if (!TIME_RE.test(x.open) || !TIME_RE.test(x.close)) return { ok: false, error: `${d}: enter open and close as HH:MM.` };
        if (x.open >= x.close) return { ok: false, error: `${d}: open must be before close.` };
        out[d] = { open: x.open, close: x.close };
      }
      if (!Object.keys(out).length) return { ok: false, error: "Enter at least one day, or choose \"Now unknown\"." };
      return { ok: true, value: out };
    }
  }
}

/** The form's starting input for a fact, from its current stored value (if any). */
export function inputFromValue(type: ValueType, value: unknown): FactInput {
  if (type === "hours") {
    const v = (value && typeof value === "object" ? value : {}) as Record<string, { open: string; close: string } | null>;
    const days = Object.fromEntries(
      DAYS.map((d) => {
        if (!(d in v)) return [d, { state: "unknown", open: "", close: "" }];
        const x = v[d];
        return [d, x ? { state: "open", open: x.open, close: x.close } : { state: "closed", open: "", close: "" }];
      }),
    ) as Record<Day, DayInput>;
    return { action: "keep", days };
  }
  return { action: "keep", text: value === undefined || value === null ? "" : String(value) };
}

export interface CheckForm {
  method: string;
  checkedBy: string;
  /** YYYY-MM-DD */
  checkedAt: string;
  note: string;
  evidenceUrl: string;
  /** Core keys confirmed in this check. */
  core: string[];
  facts: Record<string, FactInput>;
}

export interface RecordCheckArgs {
  p_listing: string;
  p_method: string;
  p_checked_by: string;
  p_facts: Record<string, unknown>;
  p_confirmed: string[];
  p_checked_at: string;
  p_note: string | null;
  p_evidence_url: string | null;
}

export type BuiltCheck = { ok: true; args: RecordCheckArgs } | { ok: false; errors: Record<string, string> };

/**
 * Validate the whole form and build `record_check()` arguments.
 * `existing` is the set of fact keys the listing has a row for (a missing fact can't be "confirmed").
 * Errors are keyed by fact key, or by form field name (`method`, `checkedBy`, `checkedAt`,
 * `evidenceUrl`, `form`).
 */
export function buildCheck(listingId: string, form: CheckForm, defs: FactDef[], existing: Set<string>, today: string): BuiltCheck {
  const errors: Record<string, string> = {};
  const facts: Record<string, unknown> = {};
  const confirmed: string[] = [];

  if (!(METHODS as readonly string[]).includes(form.method)) errors.method = "Choose how the facts were checked.";
  if (!form.checkedBy.trim()) errors.checkedBy = "Enter who checked.";
  if (!DATE_RE.test(form.checkedAt) || Number.isNaN(Date.parse(form.checkedAt))) errors.checkedAt = "Enter a date.";
  else if (form.checkedAt > today) errors.checkedAt = "The check date can't be in the future.";
  const evidence = form.evidenceUrl.trim();
  if (evidence && !URL_RE.test(evidence)) errors.evidenceUrl = "Enter a full URL starting with http:// or https://.";

  for (const k of form.core) {
    if (!(CORE_KEYS as readonly string[]).includes(k)) errors.form = `"${k}" is not a core field.`;
    else confirmed.push(k);
  }

  const byKey = new Map(defs.map((d) => [d.key, d]));
  for (const [key, input] of Object.entries(form.facts)) {
    if (input.action === "keep") continue;
    const def = byKey.get(key);
    if (!def) {
      errors[key] = "Unknown fact for this dataset.";
      continue;
    }
    if (input.action === "confirm") {
      if (!existing.has(key)) errors[key] = "There is no value to confirm. Enter one instead.";
      else confirmed.push(key);
    } else if (input.action === "clear") {
      if (existing.has(key)) facts[key] = null;
    } else {
      const p = parseFactValue(def.value_type, input);
      if (p.ok) facts[key] = p.value;
      else errors[key] = p.error;
    }
  }

  const covered = confirmed.length + Object.values(facts).filter((v) => v !== null).length;
  if (!Object.keys(errors).length && covered === 0) {
    errors.form = "A check must confirm or set at least one fact or core field.";
  }
  if (Object.keys(errors).length) return { ok: false, errors };

  return {
    ok: true,
    args: {
      p_listing: listingId,
      p_method: form.method,
      p_checked_by: form.checkedBy.trim(),
      p_facts: facts,
      p_confirmed: confirmed,
      p_checked_at: form.checkedAt,
      p_note: form.note.trim() || null,
      p_evidence_url: evidence || null,
    },
  };
}

/** A fact's state for display, from a `listing_fact_status` row (or none). */
export type FactState = "not_checked" | "verified" | "stale" | "unverified";
export function factState(row: { verified: boolean; stale: boolean } | undefined): FactState {
  if (!row) return "not_checked";
  if (!row.verified) return "unverified";
  return row.stale ? "stale" : "verified";
}
export const FACT_STATE_LABELS: Record<FactState, string> = {
  not_checked: "Not checked yet",
  verified: "Verified",
  stale: "Verified, may be out of date",
  unverified: "Changed since last check (hidden from pages)",
};

/** Show a stored value as text. */
export function formatValue(type: ValueType, value: unknown): string {
  if (value === null || value === undefined) return "";
  if (type === "boolean") return value ? "Yes" : "No";
  if (type === "hours" && typeof value === "object") {
    const v = value as Record<string, { open: string; close: string } | null>;
    return DAYS.filter((d) => d in v)
      .map((d) => `${d} ${v[d] ? `${v[d]!.open}-${v[d]!.close}` : "closed"}`)
      .join(", ");
  }
  return String(value);
}
