// Claim email confirmation (T19): submit-claim sending the link through the mailer test double, and
// the `confirm-claim` function opening it. Real supabase-js client, real migrations, seed, synced sites
// and fixture shops on in-memory Postgres (through the PostgREST stand-in).

import type { PGlite } from "@electric-sql/pglite";
import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { freshDb, root, seedFixture } from "../../../apps/web/test/helpers.ts";
import type { Fixture } from "../../../apps/web/src/lib/load.ts";
import { syncSites } from "../../../scripts/sync-sites.ts";
const DTF_NAME = (JSON.parse(readFileSync(join(root, "sites", "dtf.json"), "utf8")) as { name: string }).name;
import {
  CONFIRM_MESSAGES, confirmationEmail, handleConfirmClaim, hashToken, newToken, sendClaimConfirmation,
} from "../_shared/claim-email.ts";
import { formEnv, handleSubmitClaim, MESSAGES, type FormEnv } from "../_shared/forms.ts";
import { mailerFromEnv, memoryMailer } from "../_shared/mail.ts";
import { restFetch } from "./rest.ts";

const KEY = "dummy-service-key-for-function-tests";
const FN = "https://ref.supabase.co";
const SHOP = "00000000-0000-4000-8000-000000000001";
const SHOP_NAME = "Example DTF Tampa";

let db: PGlite;
let client: ReturnType<typeof createClient>;

const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
const claimRows = () => q<{ id: string; status: string; email_confirmed: boolean; email_confirmed_at: Date | null }>(
  `select id, status, email_confirmed, email_confirmed_at from claims order by created_at`);
const tokenRows = () => q<{ claim_id: string; token_hash: string; used_at: Date | null; days: number }>(
  `select claim_id, token_hash, used_at, extract(epoch from expires_at - created_at) / 86400 as days from claim_email_tokens`);

/** Everything a listing is made of; confirming may change none of it. */
const listingState = async () => JSON.stringify({
  listings: await q(`select * from listings order by id`),
  facts: await q(`select * from listing_facts order by listing_id, key`),
  checks: await q(`select * from verification_events order by id`),
  caps: await q(`select * from listing_capabilities order by 1, 2`),
  metros: await q(`select * from listing_metros order by 1, 2`),
});

const submit = (fields: Record<string, string>, env: FormEnv, site = "dtf") => {
  const body = new URLSearchParams(fields).toString();
  return handleSubmitClaim(new Request(`${FN}/submit-claim/${site}/`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body,
  }), client, env);
};
const open = (query: string, method = "GET", site = "dtf") =>
  handleConfirmClaim(new Request(`${FN}/confirm-claim/${site}/${query}`, { method }), client);
const tokenFrom = (link: string) => new URL(link).searchParams.get("token")!;
const linkIn = (text: string) => text.match(/https:\/\/\S+/)![0];

const NEW_SHOP = { name: "Example New Prints", city: "Tampa", state: "FL", contact_email: "owner@example.com" };

beforeAll(async () => {
  db = await freshDb();
  await syncSites(db, join(root, "sites"));
  await seedFixture(db, JSON.parse(readFileSync(join(root, "fixtures", "demo.json"), "utf8")) as Fixture);
  // Pin dtf's domain so the link assertions don't depend on sites/dtf.json; laser stays without one.
  await q(`update sites set domain = 'dtf.example' where slug = 'dtf'`);
  client = createClient("http://supabase.test", KEY, { auth: { persistSession: false }, global: { fetch: restFetch(db, KEY) } });
}, 120_000);

beforeEach(async () => {
  await q(`delete from claim_email_tokens`);
  await q(`delete from claims`);
});
afterEach(() => vi.restoreAllMocks());

/** Submit a claim through the form with the test double and return the link it emailed. */
async function claimAndLink(fields: Record<string, string> = { listing: SHOP, contact_email: "owner@example.com" }) {
  const mailer = memoryMailer();
  const res = await submit(fields, { mailer });
  expect(res.status).toBe(200);
  expect(mailer.sent).toHaveLength(1);
  return { mail: mailer.sent[0], link: linkIn(mailer.sent[0].text) };
}

describe("submit-claim sends the confirmation link", () => {
  it("emails the contact address a link on the site's own domain, and stores only the token's hash", async () => {
    const { mail, link } = await claimAndLink();
    expect(mail.to).toBe("owner@example.com");
    expect(mail.subject).toBe(`Confirm your email for ${DTF_NAME}`);
    expect(link).toMatch(/^https:\/\/dtf\.example\/confirm-claim\/\?token=[A-Za-z0-9_-]{43}$/);
    const token = tokenFrom(link);

    const [claim] = await claimRows();
    expect(claim).toMatchObject({ status: "pending", email_confirmed: false, email_confirmed_at: null });
    const [t] = await tokenRows();
    expect(t.claim_id).toBe(claim.id);
    expect(t.token_hash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(Number(t.days)).toBe(7);
    // The token appears nowhere in the database, in any column of any table.
    const dump = JSON.stringify(await q(`select to_jsonb(c) c, to_jsonb(t) t from claims c left join claim_email_tokens t on t.claim_id = c.id`));
    expect(dump).not.toContain(token);
  });

  it("names a listed shop from our database, and never puts form text in the email", async () => {
    const listed = await claimAndLink({ listing: SHOP, contact_email: "owner@example.com", name: "Visit cheap-pills.example now" });
    expect(listed.mail.text).toContain(`details about ${SHOP_NAME} to ${DTF_NAME}`);
    expect(listed.mail.text).not.toContain("cheap-pills");
    await q(`delete from claim_email_tokens`);
    await q(`delete from claims`);
    const fresh = await claimAndLink({ ...NEW_SHOP, name: "Visit cheap-pills.example now", notes: "Call 555-0100" });
    expect(fresh.mail.text).toContain(`details about a shop to ${DTF_NAME}`);
    expect(fresh.mail.text).not.toMatch(/cheap-pills|555-0100/);
    expect(fresh.mail.text).toContain("within 7 days");
  });

  it("without a mailer (no provider chosen) or a site domain, stores the claim and no token", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(mailerFromEnv(() => "set")).toBeUndefined();
    expect(formEnv(() => undefined).mailer).toBeUndefined();
    const res = await submit(NEW_SHOP, {});
    expect((await res.json()).message).toBe(MESSAGES.sent);
    const mailer = memoryMailer();
    await submit({ ...NEW_SHOP, contact_email: "other@example.com" }, { mailer }, "laser"); // laser has no domain
    expect(mailer.sent).toEqual([]);
    expect(await claimRows()).toHaveLength(2);
    expect(await tokenRows()).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("when the send fails, still answers sent and keeps the claim, and never logs the token", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a) => void logs.push(a.join(" ")));
    const res = await submit(NEW_SHOP, { mailer: memoryMailer({ fail: true }) });
    expect(res.status).toBe(200);
    expect((await res.json()).outcome).toBe("sent");
    expect(await claimRows()).toHaveLength(1);
    expect(logs.join("\n")).toMatch(/told to fail/);
    expect(logs.join("\n")).not.toMatch(/token=|[A-Za-z0-9_-]{43}/);
  });

  it("sends nothing for a refused or duplicate claim", async () => {
    const mailer = memoryMailer();
    await submit({ contact_email: "not-an-email" }, { mailer });
    await submit({ listing: SHOP, contact_email: "owner@example.com" }, { mailer });
    await submit({ listing: SHOP, contact_email: "owner@example.com" }, { mailer }); // already waiting
    expect(mailer.sent).toHaveLength(1);
    expect(await tokenRows()).toHaveLength(1);
  });
});

describe("confirm-claim", () => {
  it("a valid link confirms once and only once", async () => {
    const { link } = await claimAndLink();
    const token = tokenFrom(link);
    const first = await open(`?token=${token}`);
    expect(first.status).toBe(303);
    expect(first.headers.get("location")).toBe("/confirm-email/#confirm-confirmed");
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(first.headers.get("referrer-policy")).toBe("no-referrer");
    const [claim] = await claimRows();
    expect(claim.email_confirmed).toBe(true);
    expect(claim.email_confirmed_at).not.toBeNull();

    const again = await open(`?token=${token}`);
    expect(again.headers.get("location")).toBe("/confirm-email/#confirm-invalid");
    const [after] = await claimRows();
    expect(after.email_confirmed_at).toEqual(claim.email_confirmed_at);
    expect((await tokenRows())[0].used_at).not.toBeNull();
  });

  it("an expired link does nothing", async () => {
    const { link } = await claimAndLink();
    await q(`update claim_email_tokens set created_at = now() - interval '8 days', expires_at = now() - interval '1 day'`);
    const res = await open(`?token=${tokenFrom(link)}`);
    expect(res.headers.get("location")).toBe("/confirm-email/#confirm-invalid");
    expect((await claimRows())[0].email_confirmed).toBe(false);
    expect((await tokenRows())[0].used_at).toBeNull();
  });

  it("a claim cannot be confirmed by guessing an ID, a hash or a token", async () => {
    const { link } = await claimAndLink();
    const [claim] = await claimRows();
    const [t] = await tokenRows();
    const guesses = [
      `?token=${claim.id}`, `?claim=${claim.id}`, `?id=${claim.id}&token=`, `?token=${t.token_hash}`,
      `?token=${(await newToken()).token}`, `?token=${tokenFrom(link).slice(0, 42)}`, `?token=${tokenFrom(link)}x`, "",
    ];
    for (const g of guesses) expect((await open(g)).headers.get("location"), g).toBe("/confirm-email/#confirm-invalid");
    expect((await open(`${claim.id}/?token=${claim.id}`)).status).toBe(404);
    expect((await claimRows())[0].email_confirmed).toBe(false);
  });

  it("confirms only on GET: a HEAD from a link checker or a POST changes nothing", async () => {
    const { link } = await claimAndLink();
    for (const method of ["HEAD", "POST"]) expect((await open(`?token=${tokenFrom(link)}`, method)).status, method).toBe(405);
    expect((await claimRows())[0].email_confirmed).toBe(false);
    expect((await open(`?token=${tokenFrom(link)}`, "GET", "Not_A_Slug")).status).toBe(404);
  });

  it("never publishes a listing or changes a fact, a check, a tag or a metro", async () => {
    const before = await listingState();
    const { link } = await claimAndLink();
    await open(`?token=${tokenFrom(link)}`);
    expect((await claimRows())[0]).toMatchObject({ email_confirmed: true, status: "pending" });
    expect(await listingState()).toBe(before);
  });

  it("the confirm code writes only claim_email_tokens and calls only confirm_claim_email", () => {
    const src = readFileSync(join(__dirname, "..", "_shared", "claim-email.ts"), "utf8");
    expect(src).not.toMatch(/\.(update|upsert|delete)\(/);
    expect([...src.matchAll(/\.from\("([a-z_]+)"\)/g)].map((m) => m[1])).toEqual(["claim_email_tokens"]);
    expect([...src.matchAll(/\.rpc\("([a-z_]+)"/g)].map((m) => m[1])).toEqual(["confirm_claim_email"]);
  });
});

describe("helpers", () => {
  it("hashes tokens as lowercase hex SHA-256, and makes 43-character random tokens", async () => {
    expect(await hashToken("abc")).toBe(createHash("sha256").update("abc").digest("hex"));
    const a = await newToken();
    const b = await newToken();
    expect(a.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.token).not.toBe(b.token);
    expect(a.hash).toBe(await hashToken(a.token));
  });

  it("writes the email from a fixed template", () => {
    const m = confirmationEmail("a@example.com", "Site", null, "https://x.example/confirm-claim/?token=t");
    expect(m.text).toContain("https://x.example/confirm-claim/?token=t");
    expect(m.text).toMatch(/If it wasn't you, ignore this email/);
    expect(Object.keys(CONFIRM_MESSAGES).sort()).toEqual(["confirmed", "error", "invalid"]);
  });

  it("sendClaimConfirmation refuses to store a token it can't send", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await sendClaimConfirmation(client, undefined, { claimId: "x", to: "a@example.com", site: { name: "S", domain: "s.example" }, shopName: null });
    expect(r).toBe("no-mailer");
    expect(await tokenRows()).toEqual([]);
  });
});
