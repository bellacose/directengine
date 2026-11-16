// Database rule tests. Runs the migration and seed in an in-memory Postgres (PGlite), so no Docker
// or Supabase project is needed:   npm run test:db
//
// The setup block imitates what a Supabase project provides (roles, auth.uid(), default grants).

import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "migrations");
const db = new PGlite();

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await db.exec("reset role");
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`  FAIL ${name}\n       ${e.message}`);
  } finally {
    await db.exec("reset role");
  }
}

const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const one = async (sql, params = []) => (await q(sql, params))[0];

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function rejects(sql, pattern, params = []) {
  try {
    await db.query(sql, params);
  } catch (e) {
    if (!pattern.test(e.message)) throw new Error(`wrong error: "${e.message}" (wanted ${pattern})`);
    return;
  }
  throw new Error(`expected an error matching ${pattern}, but the statement succeeded`);
}

// ---------------------------------------------------------------- setup (what Supabase provides)

await db.exec(`
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create schema auth;
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema public, auth to anon, authenticated, service_role;
  grant execute on function auth.uid() to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
`);

for (const f of readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
  await db.exec(readFileSync(join(migrationsDir, f), "utf8"));
}
const seed = readFileSync(join(here, "..", "seed.sql"), "utf8");
await db.exec(seed);
await db.exec(seed); // must be safe to run twice

const ds = (await one(`select id from datasets where slug = 'makers'`)).id;
const cap = async (slug) => (await one(`select id from capabilities where slug = $1`, [slug])).id;
const metro = async (slug) => (await one(`select id from metros where slug = $1`, [slug])).id;

let n = 0;
async function draft(overrides = {}) {
  n++;
  const slug = overrides.slug ?? `example-shop-${n}`;
  const row = await one(
    `insert into listings (dataset_id, slug, name, city, state, zip, phone, website)
     values ($1, $2, $3, 'Tampa', 'FL', '33602', '(813) 555-0100', 'https://example.com') returning id`,
    [ds, slug, `Example Shop ${n}`],
  );
  if (overrides.bare) return row.id;
  await db.query(`insert into listing_capabilities values ($1, $2, $3)`, [row.id, await cap("dtf"), ds]);
  await db.query(`insert into listing_metros values ($1, $2, $3, true)`, [row.id, await metro("tampa-bay"), ds]);
  return row.id;
}
const check = (id, facts, confirmed = []) =>
  db.query(`select record_check($1, 'phone_call', 'chris', $2::jsonb, $3::text[])`, [id, JSON.stringify(facts), confirmed]);
const publish = (id) => db.query(`update listings set status = 'published' where id = $1`, [id]);
async function published(facts = { dtf_same_day_cutoff: "14:00", pickup_walk_in: true }) {
  const id = await draft();
  await check(id, facts, ["phone", "address"]);
  await publish(id);
  return id;
}
const publicFacts = async (id) =>
  Object.fromEntries((await q(`select key, value from public_listing_facts where listing_id = $1`, [id])).map((r) => [r.key, r.value]));

console.log("Database rules");

// ---------------------------------------------------------------- seed

await test("seed is idempotent and complete", async () => {
  const c = await one(`select
    (select count(*) from datasets)::int d, (select count(*) from capabilities)::int c,
    (select count(*) from metros)::int m, (select count(*) from fact_defs)::int f,
    (select count(*) from affiliate_programs)::int a, (select count(*) from listings)::int l`);
  assert(c.d === 1 && c.c === 7 && c.m === 5 && c.f === 20 && c.a === 6, `unexpected counts ${JSON.stringify(c)}`);
  assert(c.l === 0, "seed must not create listings");
});

await test("metro city lists include the suburbs added for small printers, without duplicates", async () => {
  const rows = (await db.query(`select slug, cities from metros order by slug`)).rows;
  const by = Object.fromEntries(rows.map((r) => [r.slug, r.cities]));
  assert(by.buffalo.includes("Elma") && by["tampa-bay"].includes("Lutz"), "suburbs missing");
  for (const [slug, cities] of Object.entries(by)) assert(new Set(cities).size === cities.length, `${slug} has duplicate cities`);
});

// ---------------------------------------------------------------- publishing

await test("a listing cannot be created already published", async () => {
  await rejects(
    `insert into listings (dataset_id, slug, name, city, state, status) values ($1, 'x-live', 'X', 'Tampa', 'FL', 'published')`,
    /create the listing as a draft/, [ds]);
});

await test("publishing needs a verification event", async () => {
  const id = await draft();
  await rejects(`update listings set status = 'published' where id = $1`, /no verification event/, [id]);
});

await test("publishing needs a capability and a metro", async () => {
  const id = await draft({ bare: true });
  await check(id, {}, ["phone"]);
  await rejects(`update listings set status = 'published' where id = $1`, /no capabilities/, [id]);
  await db.query(`insert into listing_capabilities values ($1, $2, $3)`, [id, await cap("dtf"), ds]);
  await rejects(`update listings set status = 'published' where id = $1`, /no metro/, [id]);
});

await test("check then publish works and stamps dates", async () => {
  const id = await published();
  const l = await one(`select status, published_at, last_verified_at::text lv, current_date::text today from listings where id = $1`, [id]);
  assert(l.status === "published" && l.published_at, "not published");
  assert(l.lv === l.today, `last_verified_at ${l.lv} should be today ${l.today}`);
});

// ---------------------------------------------------------------- what pages may show

await test("only verified facts of published listings are public", async () => {
  const id = await published();
  // A fact typed in without any check must not appear.
  await db.query(`insert into listing_facts (listing_id, dataset_id, key, value) values ($1, $2, 'dtf_price_note', '"$6 a foot"')`, [id, ds]);
  const f = await publicFacts(id);
  assert(f.dtf_same_day_cutoff === "14:00" && f.pickup_walk_in === true, "verified facts missing");
  assert(!("dtf_price_note" in f), "unverified fact leaked into public view");
});

await test("draft and removed listings expose no facts", async () => {
  const d = await draft();
  await check(d, { dtf_same_day_cutoff: "15:00" });
  assert(Object.keys(await publicFacts(d)).length === 0, "draft facts are public");
  const p = await published();
  await db.query(`update listings set status = 'removed' where id = $1`, [p]);
  assert(Object.keys(await publicFacts(p)).length === 0, "removed listing facts are public");
});

await test("editing a verified value un-verifies it until re-checked", async () => {
  const id = await published();
  await db.query(`update listing_facts set value = '"16:30"' where listing_id = $1 and key = 'dtf_same_day_cutoff'`, [id]);
  assert(!("dtf_same_day_cutoff" in (await publicFacts(id))), "edited value still shown as verified");
  await check(id, {}, ["dtf_same_day_cutoff"]);
  assert((await publicFacts(id)).dtf_same_day_cutoff === "16:30", "re-check did not restore the fact");
});

await test("re-confirming an unchanged value keeps it verified", async () => {
  const id = await published();
  const before = await one(`select value_changed_at from listing_facts where listing_id = $1 and key = 'dtf_same_day_cutoff'`, [id]);
  await check(id, { dtf_same_day_cutoff: "14:00" });
  const after = await one(`select value_changed_at from listing_facts where listing_id = $1 and key = 'dtf_same_day_cutoff'`, [id]);
  assert(String(before.value_changed_at) === String(after.value_changed_at), "unchanged value restarted its clock");
  assert((await publicFacts(id)).dtf_same_day_cutoff === "14:00", "fact lost");
});

await test("a null in record_check deletes the fact (unknown)", async () => {
  const id = await published();
  await check(id, { pickup_walk_in: null }, ["phone"]);
  assert(!("pickup_walk_in" in (await publicFacts(id))), "fact not deleted");
});

await test("a check must confirm something", async () => {
  const id = await draft();
  await rejects(`select record_check($1, 'phone_call', 'chris')`, /at least one fact/, [id]);
});

await test("listing_key_checks returns the latest check per key", async () => {
  const id = await draft();
  await db.query(`select record_check($1, 'website', 'chris', '{}'::jsonb, array['phone'], current_date - 10)`, [id]);
  await db.query(`select record_check($1, 'phone_call', 'chris', '{}'::jsonb, array['phone','address'])`, [id]);
  const rows = await q(`select key, method from listing_key_checks where listing_id = $1 order by key`, [id]);
  assert(rows.length === 2 && rows.every((r) => r.method === "phone_call"), JSON.stringify(rows));
});

await test("facts older than 180 days are flagged stale", async () => {
  const id = await draft();
  await db.query(`select record_check($1, 'phone_call', 'chris', '{"ships": true}'::jsonb, '{}', current_date - 200)`, [id]);
  await publish(id);
  const r = await one(`select stale from public_listing_facts where listing_id = $1 and key = 'ships'`, [id]);
  assert(r.stale === true, "old fact not stale");
});

// ---------------------------------------------------------------- fact validation

await test("fact values must match their type", async () => {
  const id = await draft();
  const bad = [
    ["dtf_same_day_cutoff", '"2pm"', /HH:MM/],
    ["pickup_walk_in", '"yes"', /true or false/],
    ["dtf_price_per_foot_usd", '"6"', /must be a number/],
    ["dtf_price_note", '"  "', /must not be empty/],
    ["hours", '{"funday": null}', /unknown day/],
    ["hours", '{"mon": {"open": "17:00", "close": "09:00"}}', /open before close/],
  ];
  for (const [key, value, pattern] of bad) {
    await rejects(`insert into listing_facts (listing_id, dataset_id, key, value) values ($1, $2, $3, $4::jsonb)`, pattern, [id, ds, key, value]);
  }
  await db.query(`insert into listing_facts (listing_id, dataset_id, key, value) values ($1, $2, 'hours', $3::jsonb)`,
    [id, ds, '{"mon": {"open": "09:00", "close": "17:00"}, "sun": null}']);
});

await test("unknown fact keys are rejected", async () => {
  const id = await draft();
  await rejects(`insert into listing_facts (listing_id, dataset_id, key, value) values ($1, $2, 'star_rating', '5')`, /unknown fact key|foreign key/, [id, ds]);
  await rejects(`select record_check($1, 'phone_call', 'chris', '{}'::jsonb, array['star_rating'])`, /not a fact key/, [id]);
});

// ---------------------------------------------------------------- verification log

await test("verification events cannot be changed, deleted or truncated", async () => {
  const id = await published();
  await rejects(`update verification_events set note = 'edited' where listing_id = $1`, /append-only/, [id]);
  await rejects(`delete from verification_events where listing_id = $1`, /append-only/, [id]);
  await rejects(`truncate verification_events`, /append-only/);
});

await test("a check cannot be dated in the future", async () => {
  const id = await draft();
  await rejects(`select record_check($1, 'phone_call', 'chris', '{}'::jsonb, array['phone'], current_date + 1)`, /future/, [id]);
});

await test("a listing with history cannot be deleted", async () => {
  const id = await published();
  await rejects(`delete from listings where id = $1`, /foreign key|violates/, [id]);
});

// ---------------------------------------------------------------- listing integrity

await test("slug is frozen once published", async () => {
  const d = await draft();
  await db.query(`update listings set slug = 'renamed-before-publish' where id = $1`, [d]);
  const p = await published();
  await rejects(`update listings set slug = 'renamed-after-publish' where id = $1`, /slug cannot change/, [p]);
  await db.query(`update listings set status = 'draft' where id = $1`, [p]);
  await rejects(`update listings set slug = 'renamed-after-unpublish' where id = $1`, /slug cannot change/, [p]);
});

await test("a fact change bumps the listing's updated_at (sitemap lastmod)", async () => {
  const id = await published();
  // The guard resets updated_at on every update, so switch it off to plant an old value.
  await db.exec(`alter table listings disable trigger listings_guard`);
  await db.query(`update listings set updated_at = now() - interval '1 day' where id = $1`, [id]);
  await db.exec(`alter table listings enable trigger listings_guard`);
  await check(id, { ships: true });
  const r = await one(`select updated_at > now() - interval '1 minute' as fresh from listings where id = $1`, [id]);
  assert(r.fresh, "updated_at not bumped by a fact change");
});

await test("tags and metros must belong to the listing's dataset", async () => {
  const other = (await one(`insert into datasets (slug, name) values ('other', 'Other') returning id`)).id;
  const otherCap = (await one(`insert into capabilities (dataset_id, slug, name) values ($1, 'thing', 'Thing') returning id`, [other])).id;
  const id = await draft();
  await rejects(`insert into listing_capabilities values ($1, $2, $3)`, /foreign key/, [id, otherCap, ds]);
  await rejects(`insert into listing_capabilities values ($1, $2, $3)`, /foreign key/, [id, otherCap, other]);
});

await test("bad listing fields are rejected", async () => {
  const bad = [
    [`zip`, `'3360'`], [`state`, `'Florida'`], [`website`, `'example.com'`], [`slug`, `'Has Spaces'`],
    [`description`, `repeat('x', 501)`],
  ];
  for (const [col, val] of bad) {
    const cols = { slug: `'ok-${col}'`, name: `'X'`, city: `'Tampa'`, state: `'FL'` };
    cols[col] = val;
    await rejects(
      `insert into listings (dataset_id, ${Object.keys(cols).join(", ")}) values ('${ds}', ${Object.values(cols).join(", ")})`,
      /check constraint/);
  }
});

// ---------------------------------------------------------------- public submissions

await test("corrections: duplicates and floods are blocked", async () => {
  const id = await published();
  await rejects(`insert into corrections (listing_id, detail) values ($1, 'hi')`, /check constraint/, [id]);
  await db.query(`insert into corrections (listing_id, detail) values ($1, 'Cutoff is now 3pm')`, [id]);
  await rejects(`insert into corrections (listing_id, detail) values ($1, '  cutoff is NOW 3pm ')`, /rate_limited: duplicate/, [id]);
  for (let i = 0; i < 29; i++) {
    await db.query(`insert into corrections (listing_id, detail) values ($1, $2)`, [id, `Different report number ${i}`]);
  }
  await rejects(`insert into corrections (listing_id, detail) values ($1, 'One too many this hour')`, /rate_limited: too many/, [id]);
});

await test("claims: bad email and repeat pending claims are blocked", async () => {
  const id = await published();
  await rejects(`insert into claims (dataset_id, listing_id, contact_email, payload) values ($1, $2, 'not-an-email', '{}')`, /check constraint/, [ds, id]);
  await db.query(`insert into claims (dataset_id, listing_id, contact_email, payload) values ($1, $2, 'owner@example.com', '{}')`, [ds, id]);
  await rejects(`insert into claims (dataset_id, listing_id, contact_email, payload) values ($1, $2, 'OWNER@example.com', '{}')`, /already waiting/, [ds, id]);
});

// ---------------------------------------------------------------- affiliates

await test("an approved affiliate needs an https link; supplier facts need a date", async () => {
  const site = (await one(`insert into sites (slug, name, dataset_id) values ('test-site', 'Test', $1) returning id`, [ds])).id;
  const prog = (await one(`select id from affiliate_programs where slug = 'transfer-express'`)).id;
  await db.query(`insert into site_affiliates (site_id, program_id) values ($1, $2)`, [site, prog]);
  await rejects(`update site_affiliates set status = 'approved' where site_id = $1`, /check constraint/, [site]);
  await rejects(`update site_affiliates set status = 'approved', url = 'http://insecure.example' where site_id = $1`, /check constraint/, [site]);
  await db.query(`update site_affiliates set status = 'approved', url = 'https://example.com/?ref=1' where site_id = $1`, [site]);
  await rejects(`update affiliate_programs set price_note = '$0.50 an inch' where id = $1`, /check constraint/, [prog]);
  await db.query(`update affiliate_programs set price_note = '$0.50 an inch', facts_checked_at = current_date where id = $1`, [prog]);
});

// ---------------------------------------------------------------- claim email confirmation (T19)

let claimN = 0;
async function newClaim(listingId = null) {
  claimN++;
  return (await one(`insert into claims (dataset_id, listing_id, contact_email, payload) values ($1, $2, $3, '{}') returning id`,
    [ds, listingId, `owner${claimN}@example.com`])).id;
}
const hashOf = async (token) => (await one(`select encode(sha256(convert_to($1, 'UTF8')), 'hex') h`, [token])).h;
const confirm = async (hash) => (await one(`select confirm_claim_email($1) ok`, [hash])).ok;
const claimState = (id) => one(`select email_confirmed, email_confirmed_at, status from claims where id = $1`, [id]);

await test("claim email: the token is stored only as a SHA-256 hash", async () => {
  const id = await newClaim();
  await rejects(`insert into claim_email_tokens (claim_id, token_hash) values ($1, 'kJ3x9_raw-token-from-the-link-AAAAAAAAAAAAAAA')`, /check constraint/, [id]);
  await rejects(`insert into claim_email_tokens (claim_id, token_hash) values ($1, $2)`, /check constraint/, [id, "A".repeat(64)]);
  await db.query(`insert into claim_email_tokens (claim_id, token_hash) values ($1, $2)`, [id, await hashOf("t-hash-only")]);
  const t = await one(`select (expires_at - created_at) = interval '7 days' seven from claim_email_tokens where claim_id = $1`, [id]);
  assert(t.seven, "a link must expire 7 days after it is made");
  await rejects(`insert into claim_email_tokens (claim_id, token_hash, expires_at) values ($1, $2, now() + interval '30 days')`, /check constraint|unique/, [id, await hashOf("x")]);
});

await test("claim email: a valid link confirms once and only once, and changes nothing else", async () => {
  const listing = await published();
  const id = await newClaim(listing);
  const before = JSON.stringify({
    l: await q(`select * from listings where id = $1`, [listing]),
    f: await q(`select * from listing_facts where listing_id = $1 order by key`, [listing]),
    e: await q(`select count(*)::int n from verification_events`),
  });
  await db.query(`insert into claim_email_tokens (claim_id, token_hash) values ($1, $2)`, [id, await hashOf("t-valid")]);
  assert((await claimState(id)).email_confirmed === false, "a new claim is unconfirmed");
  assert((await confirm(await hashOf("t-valid"))) === true, "the first open should confirm");
  const s = await claimState(id);
  assert(s.email_confirmed === true && s.email_confirmed_at && s.status === "pending", `claim after confirm: ${JSON.stringify(s)}`);
  assert((await confirm(await hashOf("t-valid"))) === false, "a reused link must do nothing");
  assert(String((await claimState(id)).email_confirmed_at) === String(s.email_confirmed_at), "the timestamp must not move");
  const after = JSON.stringify({
    l: await q(`select * from listings where id = $1`, [listing]),
    f: await q(`select * from listing_facts where listing_id = $1 order by key`, [listing]),
    e: await q(`select count(*)::int n from verification_events`),
  });
  assert(before === after, "confirming changed a listing, a fact or the check log");
});

await test("claim email: an expired link does nothing", async () => {
  const id = await newClaim();
  await db.query(`insert into claim_email_tokens (claim_id, token_hash, created_at, expires_at) values ($1, $2, now() - interval '8 days', now() - interval '1 day')`,
    [id, await hashOf("t-expired")]);
  assert((await confirm(await hashOf("t-expired"))) === false, "an expired link confirmed");
  assert((await claimState(id)).email_confirmed === false, "claim confirmed by an expired link");
  const t = await one(`select used_at from claim_email_tokens where claim_id = $1`, [id]);
  assert(t.used_at === null, "an expired link was marked used");
});

await test("claim email: a claim cannot be confirmed by guessing an ID or a hash", async () => {
  const id = await newClaim();
  const tok = (await one(`insert into claim_email_tokens (claim_id, token_hash) values ($1, $2) returning id`, [id, await hashOf("t-guess")])).id;
  for (const guess of [id, tok, await hashOf(id), "0".repeat(64), "", null, "t-guess"]) {
    assert((await confirm(guess)) === false, `confirmed by guessing ${guess}`);
  }
  assert((await claimState(id)).email_confirmed === false, "claim confirmed by a guess");
});

await test("claim email: only confirm_claim_email sets the state, and only the service role may call it", async () => {
  const uid = "33333333-3333-3333-3333-333333333333";
  await db.query(`insert into admins (user_id) values ($1)`, [uid]);
  const id = await newClaim();
  await db.query(`insert into claim_email_tokens (claim_id, token_hash) values ($1, $2)`, [id, await hashOf("t-roles")]);
  await rejects(`update claims set email_confirmed_at = now() where id = $1`, /only by confirm_claim_email/, [id]);
  await rejects(`insert into claims (dataset_id, contact_email, payload, email_confirmed_at) values ($1, 'pre@example.com', '{}', now())`, /already be email-confirmed/, [ds]);
  for (const role of ["anon", "authenticated"]) {
    await db.exec(`set role ${role}; select set_config('request.jwt.claim.sub', '${role === "authenticated" ? uid : ""}', false)`);
    await rejects(`select confirm_claim_email($1)`, /permission denied/, [await hashOf("t-roles")]);
    await rejects(`select * from claim_email_tokens`, /permission denied/);
    await db.exec("reset role");
  }
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${uid}', false)`);
  await rejects(`update claims set email_confirmed_at = now() where id = $1`, /only by confirm_claim_email/, [id]);
  await db.exec("reset role; set role service_role");
  assert((await confirm(await hashOf("t-roles"))) === true, "the service role should confirm");
  await db.exec("reset role");
  await rejects(`update claims set email_confirmed_at = null where id = $1`, /cannot be changed/, [id]);
});

await test("claim email: approving an unconfirmed claim needs the explicit override", async () => {
  const id = await newClaim();
  await rejects(`update claims set status = 'approved', decided_at = now() where id = $1`, /email_not_confirmed/, [id]);
  await db.query(`update claims set status = 'approved', decided_at = now(), approved_without_email = true where id = $1`, [id]);
  const ok = await newClaim();
  await db.query(`insert into claim_email_tokens (claim_id, token_hash) values ($1, $2)`, [ok, await hashOf("t-approve")]);
  await confirm(await hashOf("t-approve"));
  await db.query(`update claims set status = 'approved', decided_at = now() where id = $1`, [ok]);
  const rejected = await newClaim();
  await db.query(`update claims set status = 'rejected', decided_at = now() where id = $1`, [rejected]);
});

// ---------------------------------------------------------------- access

await test("anon can read and write nothing", async () => {
  await published();
  await db.exec(`set role anon`);
  for (const rel of ["listings", "listing_facts", "verification_events", "claims", "clicks", "public_listing_facts", "listing_fact_status"]) {
    await rejects(`select * from ${rel} limit 1`, /permission denied/);
  }
  await rejects(`insert into corrections (listing_id, detail) values (gen_random_uuid(), 'anon write attempt')`, /permission denied/);
  await rejects(`select record_check(gen_random_uuid(), 'phone_call', 'anon')`, /permission denied/);
});

await test("a signed-in non-admin sees nothing and cannot write", async () => {
  const id = await published();
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false)`);
  const c = await one(`select (select count(*) from listings)::int l, (select count(*) from public_listing_facts)::int f, (select count(*) from verification_events)::int e`);
  assert(c.l === 0 && c.f === 0 && c.e === 0, `non-admin can read: ${JSON.stringify(c)}`);
  await rejects(`insert into listings (dataset_id, slug, name, city, state) values ('${ds}', 'sneaky', 'S', 'Tampa', 'FL')`, /row-level security/);
  await rejects(`select record_check('${id}', 'phone_call', 'sneaky', '{"ships": true}'::jsonb)`, /not found|row-level security/);
});

await test("an admin has full access", async () => {
  const uid = "22222222-2222-2222-2222-222222222222";
  await db.query(`insert into admins (user_id) values ($1)`, [uid]);
  const id = await draft();
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${uid}', false)`);
  await db.query(`select record_check($1, 'phone_call', 'admin', '{"ships": true}'::jsonb, array['phone'])`, [id]);
  await db.query(`update listings set status = 'published' where id = $1`, [id]);
  const f = await one(`select count(*)::int n from public_listing_facts where listing_id = $1`, [id]);
  assert(f.n === 1, "admin cannot see the fact just verified");
  await rejects(`update verification_events set note = 'x' where listing_id = $1`, /append-only/, [id]);
});

await test("site affiliate placement rules are a JSON list, empty by default", async () => {
  const site = await one(`insert into sites (slug, name, dataset_id) values ('rules-test', 'Rules test', $1) returning id`, [ds]);
  const prog = await one(`select id from affiliate_programs order by slug limit 1`);
  await db.query(`insert into site_affiliates (site_id, program_id, placements) values ($1, $2, '{ship-to-you}')`, [site.id, prog.id]);
  const row = await one(`select placement_rules from site_affiliates where site_id = $1`, [site.id]);
  assert(Array.isArray(row.placement_rules) && row.placement_rules.length === 0, "placement_rules should default to []");
  await rejects(`update site_affiliates set placement_rules = '{"placement": "guides"}' where site_id = $1`, /check/, [site.id]);
  await db.query(`update site_affiliates set placement_rules = '[{"placement": "ship-to-you", "metros": ["tampa-bay"]}]' where site_id = $1`, [site.id]);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("Failed:\n  " + failures.join("\n  "));
  process.exit(1);
}
