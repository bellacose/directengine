/**
 * The public forms (T11): `submit-claim` (/add-your-shop/) and `report-change` (the shop page form).
 *
 * The host rewrites POST /submit-claim/ and /report-change/ on each site's domain to these functions
 * as /submit-claim/{site}/ and /report-change/{site}/ (apps/web/src/lib/host-routing.ts), so the site
 * comes from the host's routing, not from the form.
 *
 * - The only writes are one insert into `claims` or `corrections`. Neither function can change a
 *   listing or a fact: a claim is reviewed in the admin app, which records an owner_submitted check.
 * - Bodies are form-encoded (a plain HTML form, or the page script sending the same fields). Every
 *   field has a length limit (FIELD_LIMITS, also the inputs' maxlength) and the body has a total cap.
 * - A filled honeypot field gets the normal "sent" answer and nothing is stored.
 * - Cloudflare Turnstile is checked only when TURNSTILE_SECRET_KEY is set in the function's secrets
 *   (the site build shows the widget when TURNSTILE_SITE_KEY is set; set both or neither).
 * - The database's flood and duplicate guards raise "rate_limited: ..."; those become a friendly
 *   message (429), never the raw error.
 * - A script that asks for JSON (Accept: application/json) gets {ok, outcome, message}. A plain form
 *   post (JavaScript off) gets a 303 back to the page it came from with #form-{outcome}, which the
 *   page shows with CSS (:target), so no HTML is ever served from the function.
 */

import { cleanPagePath, type Db, oneRow, SLUG, text } from "./db.ts";

export const HONEYPOT = "fax";
export const TURNSTILE_FIELD = "cf-turnstile-response";
export const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** Most characters each field takes. The page uses the same numbers as maxlength. */
export const FIELD_LIMITS = {
  name: 200,
  address: 200,
  city: 100,
  state: 2,
  zip: 10,
  phone: 30,
  website: 300,
  contact_email: 320,
  description: 500,
  notes: 1000,
  fact: 500,
  detail: 2000,
} as const;
/** Fewest characters a change report takes (the database refuses shorter). */
export const DETAIL_MIN = 5;
/** Whole request body, in bytes. Well under the claims payload cap (16000) once JSON-encoded. */
export const MAX_BODY = 12_000;
const TOKEN_MAX = 2048;
const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const ZIP = /^\d{5}(-\d{4})?$/;
const NUMBER = /^-?\d+(\.\d+)?$/;

export type Outcome = "sent" | "invalid" | "duplicate" | "busy" | "check-failed" | "error";

export const MESSAGES: Record<Outcome, string> = {
  sent: "Thanks, we've got it. We review every submission by hand before anything changes on the site.",
  invalid: "Some of the details need fixing. Check the form and send it again.",
  duplicate: "We already have this from you and it's waiting for review. There's no need to send it again.",
  busy: "We're getting a lot of submissions right now. Please try again in an hour.",
  "check-failed": "We couldn't confirm you're a person. Please try the check again, then send the form.",
  error: "Something went wrong on our side. Please try again later.",
};

const STATUS: Record<Outcome, number> = { sent: 200, invalid: 400, duplicate: 429, busy: 429, "check-failed": 403, error: 500 };

export interface FormEnv {
  /** Cloudflare Turnstile secret. Unset = no Turnstile check. */
  turnstileSecret?: string;
  /** For the Turnstile call; the tests pass a stand-in. */
  fetch?: typeof fetch;
}

/** The function's environment as FormEnv (Deno.env in the deployed function). */
export const formEnv = (get: (name: string) => string | undefined): FormEnv => ({ turnstileSecret: get("TURNSTILE_SECRET_KEY")?.trim() || undefined });

function reply(req: Request, outcome: Outcome, back: string | null, errors?: Record<string, string>): Response {
  const wantsJson = (req.headers.get("accept") ?? "").includes("application/json");
  if (!wantsJson && back) {
    return new Response(null, { status: 303, headers: { Location: `${back}#form-${outcome}`, "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" } });
  }
  const body = JSON.stringify({ ok: outcome === "sent", outcome, message: MESSAGES[outcome], ...(errors ? { errors } : {}) });
  return new Response(body, {
    status: STATUS[outcome],
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" },
  });
}

/** "rate_limited: duplicate report" -> duplicate; "rate_limited: too many ..." -> busy; else null. */
export function rateLimitOutcome(message: string | undefined): Outcome | null {
  if (!message || !message.includes("rate_limited")) return null;
  return /duplicate|already waiting/i.test(message) ? "duplicate" : "busy";
}

/** Read the form body; null when it isn't a form post or is too big. */
async function readForm(req: Request): Promise<URLSearchParams | "too-large" | null> {
  const type = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "application/x-www-form-urlencoded") return null;
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY) return "too-large";
  const raw = await req.text();
  if (new TextEncoder().encode(raw).length > MAX_BODY) return "too-large";
  return new URLSearchParams(raw);
}

/** Cloudflare's siteverify answer for this token; true when Turnstile is off. */
export async function turnstileOk(req: Request, form: URLSearchParams, env: FormEnv): Promise<boolean> {
  if (!env.turnstileSecret) return true;
  const token = form.get(TURNSTILE_FIELD) ?? "";
  if (!token || token.length > TOKEN_MAX) return false;
  const body = new URLSearchParams({ secret: env.turnstileSecret, response: token });
  const ip = req.headers.get("cf-connecting-ip") ?? req.headers.get("x-nf-client-connection-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0].trim();
  if (ip) body.set("remoteip", ip);
  try {
    const res = await (env.fetch ?? fetch)(SITEVERIFY, { method: "POST", body });
    const out = (await res.json()) as { success?: unknown };
    return out.success === true;
  } catch (e) {
    console.error(`turnstile: ${(e as Error).message}`);
    return false;
  }
}

type Errors = Record<string, string>;

/** Where a plain form post is sent back to: a path on this site only ("//host" would leave it). */
export const backPath = (p: unknown): string | null => {
  const path = cleanPagePath(p);
  return path && !path.startsWith("//") ? path : null;
};

/** One trimmed field, checked against its limit. Empty = undefined. */
function field(form: URLSearchParams, name: string, limit: number, errors: Errors, key = name): string | undefined {
  const v = (form.get(name) ?? "").trim();
  if (v.length > limit) errors[key] = `Too long: at most ${limit} characters.`;
  return v || undefined;
}

const isHttpUrl = (s: string) => {
  try {
    const u = new URL(s);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
};

interface Common {
  site: { id: string; slug: string; dataset_id: string };
  form: URLSearchParams;
  back: string | null;
}

/** Method, site, body, honeypot and Turnstile: the steps both forms share. A Response = stop here. */
async function common(req: Request, db: Db, env: FormEnv, fn: string, defaultBack: (form: URLSearchParams) => string | null): Promise<Common | Response> {
  if (req.method !== "POST") return text(405, "Method not allowed", { Allow: "POST" });
  const m = new URL(req.url).pathname.match(new RegExp(`^/${fn}/([^/]+)/?$`));
  if (!m || !SLUG.test(m[1])) return text(404, "Not found");
  const form = await readForm(req);
  if (form === "too-large") return reply(req, "invalid", null, { form: `Too long: the whole form takes at most ${MAX_BODY} characters.` });
  if (!form) return text(415, "Send the form as application/x-www-form-urlencoded");
  const back = backPath(form.get("return")) ?? defaultBack(form);

  // A bot filled the hidden field: answer as if it worked, store nothing.
  if ((form.get(HONEYPOT) ?? "") !== "") return reply(req, "sent", back);
  if (!(await turnstileOk(req, form, env))) return reply(req, "check-failed", back);

  const site = await oneRow<Common["site"]>(db, "sites", "id,slug,dataset_id", "slug", m[1]);
  if (!site) return text(404, "Unknown site");
  return { site, form, back };
}

/** A published listing in this dataset, or null. */
async function publishedListing(db: Db, id: string, datasetId: string): Promise<{ id: string } | null> {
  if (!UUID.test(id)) return null;
  const l = await oneRow<{ id: string; dataset_id: string; status: string }>(db, "listings", "id,dataset_id,status", "id", id);
  return l && l.status === "published" && l.dataset_id === datasetId ? { id: l.id } : null;
}

async function insert(req: Request, db: Db, table: "claims" | "corrections", row: Record<string, unknown>, back: string | null): Promise<Response> {
  const { error } = await db.from(table).insert(row);
  if (error) {
    const limited = rateLimitOutcome(error.message);
    if (limited) return reply(req, limited, back);
    console.error(`${table} insert failed: ${error.message}`);
    return reply(req, "error", back);
  }
  return reply(req, "sent", back);
}

// ------------------------------------------------------------------ report-change

/** Fields: listing (uuid), detail (5 to 2000 characters), return, fax (honeypot), cf-turnstile-response. */
export async function handleReportChange(req: Request, db: Db, env: FormEnv = {}): Promise<Response> {
  const c = await common(req, db, env, "report-change", () => null);
  if (c instanceof Response) return c;
  const { site, form, back } = c;
  const errors: Errors = {};
  const detail = field(form, "detail", FIELD_LIMITS.detail, errors);
  if (!errors.detail && (!detail || detail.length < DETAIL_MIN)) errors.detail = `Tell us what changed (at least ${DETAIL_MIN} characters).`;
  const listing = await publishedListing(db, form.get("listing") ?? "", site.dataset_id);
  if (!listing) errors.listing = "This shop isn't on the site.";
  if (Object.keys(errors).length) return reply(req, "invalid", back, errors);
  return insert(req, db, "corrections", { listing_id: listing!.id, site_id: site.id, detail }, back);
}

// ------------------------------------------------------------------ submit-claim

export interface FactDefRow {
  key: string;
  value_type: string;
}

/** One fact from the form as the JSON value its type takes, undefined when left blank, or an error. */
export function factValue(form: URLSearchParams, def: FactDefRow): { value?: unknown; error?: string } {
  if (def.value_type === "hours") {
    const out: Record<string, { open: string; close: string } | null> = {};
    for (const d of DAYS) {
      if (form.get(`hours.${d}.closed`)) {
        out[d] = null;
        continue;
      }
      const open = (form.get(`hours.${d}.open`) ?? "").trim();
      const close = (form.get(`hours.${d}.close`) ?? "").trim();
      if (!open && !close) continue; // not given: stays unknown
      if (!TIME.test(open) || !TIME.test(close)) return { error: `${d}: enter both opening and closing times.` };
      if (open >= close) return { error: `${d}: opening time must be before closing time.` };
      out[d] = { open, close };
    }
    return Object.keys(out).length ? { value: out } : {};
  }
  const raw = (form.get(`fact.${def.key}`) ?? "").trim();
  if (!raw) return {};
  if (raw.length > FIELD_LIMITS.fact) return { error: `Too long: at most ${FIELD_LIMITS.fact} characters.` };
  switch (def.value_type) {
    case "text":
      return { value: raw };
    case "boolean":
      return raw === "true" ? { value: true } : raw === "false" ? { value: false } : { error: "Choose yes or no." };
    case "number":
      return NUMBER.test(raw) ? { value: Number(raw) } : { error: "Enter a number, like 6 or 6.5." };
    case "time":
      return TIME.test(raw) ? { value: raw } : { error: "Enter a time like 14:00." };
    case "url":
      return isHttpUrl(raw) ? { value: raw } : { error: "Enter a full web address starting with https://." };
    default:
      return {};
  }
}

/**
 * Fields: listing (uuid of a listed shop, or empty for a new one), name, address, city, state, zip,
 * phone, website, description, contact_email, capabilities (repeatable), fact.{key}, hours.{day}.open /
 * .close / .closed, notes, return, fax (honeypot), cf-turnstile-response.
 *
 * Stored as a `claims` row whose payload uses the names the admin app reads: name, address, city,
 * state, zip, phone, website, description, facts (fact keys only, values in their database types),
 * plus capabilities (slugs) and notes.
 */
export async function handleSubmitClaim(req: Request, db: Db, env: FormEnv = {}): Promise<Response> {
  const c = await common(req, db, env, "submit-claim", () => "/add-your-shop/");
  if (c instanceof Response) return c;
  const { site, form, back } = c;
  const errors: Errors = {};

  const payload: Record<string, unknown> = {};
  for (const k of ["name", "address", "city", "state", "zip", "phone", "website", "description", "notes"] as const) {
    const v = field(form, k, FIELD_LIMITS[k], errors);
    if (v !== undefined) payload[k] = v;
  }
  if (typeof payload.state === "string") payload.state = payload.state.toUpperCase();
  if (typeof payload.state === "string" && !errors.state && !/^[A-Z]{2}$/.test(payload.state)) errors.state = "Use the two-letter state code, like FL.";
  if (typeof payload.zip === "string" && !errors.zip && !ZIP.test(payload.zip)) errors.zip = "Enter a 5-digit ZIP code.";
  if (typeof payload.website === "string" && !errors.website && !isHttpUrl(payload.website)) errors.website = "Enter a full web address starting with https://.";

  const email = field(form, "contact_email", FIELD_LIMITS.contact_email, errors);
  if (!errors.contact_email && (!email || !EMAIL.test(email))) errors.contact_email = "Enter an email address we can reach you at.";

  let listingId: string | null = null;
  const listingRaw = (form.get("listing") ?? "").trim();
  if (listingRaw) {
    const l = await publishedListing(db, listingRaw, site.dataset_id);
    if (!l) errors.listing = "That shop isn't on the site. Leave it blank to add a new shop.";
    else listingId = l.id;
  } else if (!payload.name) {
    errors.name = "Enter the shop's name.";
  }

  // What they do: only this dataset's capabilities.
  const capRows = await rows<{ slug: string }>(db, "capabilities", "slug", site.dataset_id);
  const known = new Set(capRows.map((r) => r.slug));
  const caps = [...new Set(form.getAll("capabilities"))];
  if (caps.some((s) => !known.has(s))) errors.capabilities = "Unknown service.";
  else if (caps.length) payload.capabilities = caps.sort();

  // Facts: only this dataset's fact keys, each in its type. Fields for unknown keys are ignored.
  const defs = await rows<FactDefRow>(db, "fact_defs", "key,value_type", site.dataset_id);
  const facts: Record<string, unknown> = {};
  for (const def of defs) {
    const r = factValue(form, def);
    if (r.error) errors[def.value_type === "hours" ? "hours" : `fact.${def.key}`] = r.error;
    else if (r.value !== undefined) facts[def.key] = r.value;
  }
  if (Object.keys(facts).length) payload.facts = facts;

  if (Object.keys(errors).length) return reply(req, "invalid", back, errors);
  return insert(req, db, "claims", { dataset_id: site.dataset_id, site_id: site.id, listing_id: listingId, contact_email: email, payload }, back);
}

async function rows<T>(db: Db, table: string, columns: string, datasetId: string): Promise<T[]> {
  const { data, error } = await db.from(table).select(columns).eq("dataset_id", datasetId).limit(1000);
  if (error) throw new Error(`${table}: ${error.message}`);
  return (data ?? []) as T[];
}
