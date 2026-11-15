# Tasks

Status values: `todo`, `in review`, `done`. Agents take the lowest-numbered `todo` task whose
dependencies are `done`. **[HUMAN]** tasks are Chris's.

Everything through T6 can be built and tested with no accounts at all, using the fixture and the
in-memory database.

## Chris's tasks

| ID | Task | Needed before | Status |
|---|---|---|---|
| H1 | Check search volume for "dtf near me", "dtf transfers near me", "same day dtf [city]", "laser engraving near me", "laser cutting near me" in Keyword Planner. This is the go/no-go from the launch plan. Result: go; see `docs/KEYWORDS.md` and DECISIONS D20. | Spending on domains | done |
| H2 | Create the GitHub repo from this package, a Supabase project, and a host account (Cloudflare Pages or Netlify). Put keys in the host and Supabase dashboards only. | T1 remote steps, T15 | todo |
| H3 | Pick the name and domain for the `dtf` site. Put them in `sites/dtf.json` and set `"status": "launch"`. | T15 | todo |
| H4 | Add your Supabase user ID to `admins`. | T7 use | todo |
| H5 | Verify 20 to 40 shops by phone (docs/VERIFICATION.md) and publish them. | T15 | todo |
| H6 | Apply to affiliate programs once the site is live; enter approved links in the admin app. Read each supplier's cutoff and price off its site and record them with the date. | Ship-to-you pages appearing | todo |
| H7 | Review guide drafts; set `approved` and `approvedAt` in `sites/guides.json` for the ones you accept. | Guides being indexed | todo |
| H8 | Add each live site to Google Search Console and Bing Webmaster Tools; submit the sitemap. | 60-day test | todo |
| H9 | Name and domain for `laser`; set it to `launch`. | T17 | todo |
| H10 | Weeks 3 to 8 after launch: review the outreach email wording from T20 and send it to every listed shop (page link plus claim link). | 60-day test | todo |

## Agent tasks

### T1. Repo bootstrap and sync-sites
Status: done (PR #1). Depends on: nothing (remote steps need H2).

- npm workspaces for `apps/*` and `packages/*`. CI runs `npm test` on every PR.
- `scripts/sync-sites`: validates every `sites/*.json` with `validateSiteConfig()` against the live
  vocabulary, then upserts `sites` rows and a `site_affiliates` row per configured program. Never
  overwrites an existing `status` or `url`.
- Document applying migrations and the seed with the Supabase CLI in `README.md`.

Acceptance:
- `npm test` passes in CI.
- sync-sites has a test on in-memory Postgres: it creates rows, is safe to run twice, exits non-zero
  on an invalid config, and leaves an approved affiliate's status and link untouched.

### T2. Data loader and fixture
Status: done (PR #2). Depends on: T1.

- `apps/web/src/lib/load.ts` returns, for `SITE`, the validated config and data shaped as
  `packages/core` types: listings (published only) with capabilities, metros, core fields, facts from
  `public_listing_facts`, core-field checks from `listing_key_checks`, affiliates with this site's
  status, and guide states.
- `DATA_FIXTURE=fixtures/demo.json` loads the same shape from a file. The fixture has at least 12
  shops across both metros, all obviously fake: names starting "Example", `example.com` websites,
  555 phone numbers. It covers every case: both capabilities, a shop below `minFacts` in one angle,
  a stale fact, a metro below the gate and one at it.
- The loader stops the build on an invalid config or a missing key.

Acceptance:
- Tests cover the Supabase path (in-memory Postgres with the migration) and the fixture path, and
  both produce identical shapes.
- A test proves a fact that exists only in `listing_facts` without a check never reaches the output.
- The service role key appears nowhere outside the loader and Edge Functions (a test greps the web
  app's built output for it using a dummy key).

### T3. Astro app skeleton
Status: todo. Depends on: T2.

- `apps/web`: static output, base layout, header, footer (operator, GeoNames credit), 404.
- Routes are generated only from `planPages()`. Non-indexable pages get
  `<meta name="robots" content="noindex,follow">`. Every page has a self-canonical link using the
  site's domain.
- `sitemap.xml` from `sitemapEntries()`, with per-URL `lastmod`. `robots.txt` disallows `/go/` and
  names the sitemap.
- `npm run build -- --site <slug>` (or `SITE=<slug>`) and `npm run dev` work with the fixture.
- Styling: plain, fast, mobile-first, system fonts, no UI framework. Brand colors and name come from
  the site config (extend the schema with a `brand` block, validated and tested).

Acceptance:
- Building `dtf`, `laser` and `tampa-makers` from the fixture exits 0 for each, and each build's set
  of HTML files equals the paths from `planPages()` plus the static pages (a test compares them).
- A grep of `apps/web/src` finds no site slug literals.
- Lighthouse on the home page of a local build: performance and SEO 95 or higher on mobile.

### T4. List pages
Status: todo. Depends on: T3.

Capability x metro pages per `docs/SPEC.md`: H1, data-built lead, ordered cards, client-side filters,
fallback link, `ItemList` and `BreadcrumbList` structured data.

Acceptance:
- Card order equals `orderForList()` output (test on built HTML).
- A page below the gate has `noindex,follow` and is absent from the sitemap; at the gate it's indexed.
- Filters work with JavaScript on and the full list shows with it off.
- Desktop and mobile screenshots for `dtf` and `tampa-makers`.

### T5. Shop pages
Status: todo. Depends on: T3.

Per `docs/SPEC.md`: core fields, this site's angle facts grouped, a check line per fact, stale flag,
"Not checked yet" for angle facts the shop lacks, report-a-change and claim links, `LocalBusiness`
structured data.

Acceptance:
- For a fixture shop that does both DTF and laser, the `dtf` and `laser` builds produce pages whose
  fact lists differ and contain no facts outside their angle (test).
- A shop below `minFacts` for a site has no page there but appears in that site's list without a link.
- Built HTML contains no `aggregateRating` or `review` (test over all sites).
- `openingHoursSpecification` appears only when `hours` is verified.
- Structured data passes a schema.org validator (attach the result).

### T6. Home and metro hub pages
Status: todo. Depends on: T4.

Acceptance:
- Counts on the page equal the plan's listing counts (test).
- No prose beyond data-built sentences.
- Screenshots.

### T7. Admin app
Status: in review (PR #3). Depends on: T1.

`apps/admin`: React, Supabase Auth (email link), access only for users in `admins`.

- Listings: search, create draft, edit core fields, set capabilities and metros, publish, unpublish,
  mark removed.
- **Record a check:** pick method, enter or confirm facts with inputs matching each fact's type, note,
  evidence URL. Calls `record_check()`. Shows each fact's state from `listing_fact_status`.
- Per listing: which sites include it and whether each builds a shop page for it (using
  `packages/core`).
- Queues: claims (approve records an `owner_submitted` check, or reject) and corrections.
- Affiliates: per site status and link; supplier cutoff and price notes with their check date.
- Stats: clicks by site, program, listing and week.

Acceptance:
- A non-admin signed-in user sees no data (test with two users on in-memory Postgres or a test project).
- Recording a check, then publishing, makes the facts appear in `public_listing_facts` (test).
- The form rejects values of the wrong type before sending.
- Deployed behind its own URL with `noindex`.

### T8. Affiliate redirect and click tracking
Status: todo. Depends on: T3.

- Edge Function `go`: `/go/{program}/` on the site's domain logs a `clicks` row (site, program, page
  path) and redirects (302) to the site's approved link with a sub-ID naming the site and page. An
  unknown or unapproved program returns 404. The target is always the stored link, never taken from
  the request.
- Edge Function `track`: logs website, call and directions clicks. Accepts only known site and
  listing IDs and the allowed kinds.
- Host routing so `/go/*` reaches the function from each site's own domain.

Acceptance:
- Tests: approved program redirects and logs; unapproved returns 404 and logs nothing; a `url`
  parameter in the request is ignored; unknown kinds are rejected.
- Affiliate links in built pages all start with `/go/` and carry `rel="sponsored nofollow"` (test).

### T9. Ship-to-you pages and disclosure
Status: todo. Depends on: T8.

Acceptance:
- With no approved supplier facts the page is not built; with one it is, listing only suppliers this
  site placed on `ship-to-you` (test via fixture variants).
- Each supplier row shows its cutoff and price notes with "checked {date}".
- The disclosure line appears on every built page that contains a `/go/` link and on no page without
  one (test).

### T10. Guides
Status: todo. Depends on: T8.

- Markdown guides in `content/guides/`, rendered for sites that list them.
- Draft the four guides in `sites/guides.json`. Every spec and price cites its source with a link.
  No invented figures; if a number can't be sourced, leave it out.

Acceptance:
- Unapproved guides build with `noindex` and are absent from the sitemap (test).
- Each draft ends with a source list, and the PR flags every claim Chris should double-check.

### T11. Public forms
Status: todo. Depends on: T5.

- `/add-your-shop/` and the report-a-change form, posting to Edge Functions `submit-claim` and
  `report-change`. Cloudflare Turnstile when keys are set. A honeypot field. Server-side length limits.
- Database rate-limit errors (`rate_limited`) become a friendly message.

Acceptance:
- Tests: valid submissions land in `claims` and `corrections`; duplicates and floods are refused with
  the friendly message; oversize input is refused; a filled honeypot is dropped silently.
- No public form can change a listing or a fact directly.

### T12. Legal and info pages
Status: todo. Depends on: T3.

About, disclosure, privacy, terms, contact. Text is templated from the site config (name, domain,
operator). Mark anything that needs Chris's or a lawyer's review in the PR.

Acceptance: pages build for every site; no site slug literals; operator details come from config.

### T13. Discovery
Status: todo. Depends on: T7.

- `scripts/discover`: runs Places Text Search for a list of queries per capability and metro and
  stores **only** `place_id` and the query in `candidates`.
- Admin review screen: shows a candidate by fetching its details live from Google for display only,
  with "Add as draft" (creates a draft with the place ID and a blank form for the reviewer to fill
  from the shop's own website) and "Reject".

Acceptance:
- A test asserts the script's insert contains only place ID, query and dataset.
- Nothing fetched from Google is written to `listings` or `listing_facts` by code.

### T14. Rebuild trigger and IndexNow
Status: todo. Depends on: T3, H2.

- Migration `0002`: `site_builds` (site, last triggered, last data change seen).
- Scheduled Edge Function: for each `launch` site, if any listing in its dataset changed since the
  last trigger, call the site's deploy hook. At most one trigger per site per 15 minutes.
- After a deploy, send URLs whose `lastmod` changed in the last 48 hours to IndexNow. Serve the key
  file from the site.

Acceptance:
- Tests: no change means no call; a change means one call; two changes inside 15 minutes mean one call.
- Deploy hook URLs are read from secrets, never stored in the repo.

### T15. Launch `dtf`
Status: todo. Depends on: T4 to T12, H2, H3, H5.

- `scripts/check-build <slug>`: fails if any page lacks a canonical, an indexable page lacks a
  sitemap entry (or the reverse), a `noindex` page is in the sitemap, an affiliate link bypasses
  `/go/`, a page with a `/go/` link lacks the disclosure, any page contains `aggregateRating`, or any
  fixture marker ("Example", `example.com`, 555 numbers) appears in a production build.
- Production deploy with `SITE=dtf` reading the real database.

Acceptance:
- `check-build dtf` passes on the production build.
- Chris has reviewed the live site on a phone.

### T16. Build report
Status: todo. Depends on: T15.

Each build writes a report: pages built, indexed versus not and why, shops without a page on this
site and how many facts short they are, stale facts. The admin app shows the latest report per site.

Acceptance: the report matches `planPages()` output (test).

### T17. Launch `laser` with config only
Status: todo. Depends on: T15, H9.

Acceptance:
- The PR that launches `laser` changes only `sites/` and `content/`. No file under `apps/`,
  `packages/` or `supabase/` changes.
- `check-build laser` passes.
- A shop that does both DTF and laser has different pages on the two live sites.

If this task needs a code change, the engine has a gap: fix the engine in a separate PR first, then
redo this one.

### T18. Affiliate placements per metro and per capability
Status: todo. Depends on: T9.

The launch plan puts some programs on only part of a site: EazyDTF on the Tampa Bay ship-to-you page
only, and Jiffy on pages about the blanks capability. Today a placement applies to a whole site.

- Extend `SiteConfig.affiliates` so a placement can be limited to listed metros and/or capabilities,
  for example `{"eazydtf": [{"placement": "ship-to-you", "metros": ["tampa-bay"]}]}`. The current
  plain-list form stays valid and means "everywhere on this site".
- `validateSiteConfig()` checks the metro and capability slugs against the vocabulary.
- Pages show a program only where its placement matches. sync-sites stores the new shape.

Acceptance:
- Tests: the old form still validates and renders as before; a metro-limited program appears on that
  metro's ship-to-you page and on no other page (test on built HTML); unknown metro or capability
  slugs fail validation.
- No site slug literals in code.

### T19. Email confirmation for owner claims
Status: todo. Depends on: T11, T7.

The launch plan verifies "claimed by owner" by email confirmation. T11 only stores the claim.

- When a claim is submitted, email its contact address a single-use confirmation link (expires in
  7 days). Opening it marks the claim `email_confirmed` with a timestamp.
- The admin claims queue shows confirmed and unconfirmed claims; approving an unconfirmed claim needs
  an explicit override.
- The email provider is a choice for Chris (add a DECISIONS entry); its key lives in Supabase secrets.
  Until it is chosen, build behind an interface with a test double.
- New migration for the confirmation token and state. Tokens are stored hashed.

Acceptance:
- Tests: a valid link confirms once and only once; an expired or reused link does nothing; the token
  is never stored in plain text; a claim cannot be confirmed by guessing an ID.
- Confirmation never publishes a listing or changes a fact by itself.

### T20. Shop outreach emails
Status: todo. Depends on: T15.

Weeks 3 to 8 of the 60-day test: every listed shop gets a link to its page and the claim form.

- `scripts/outreach <site>`: for each published listing on the site with a contact email, writes one
  email (shop name, its page URL or the list page it appears on, the claim link, a one-line opt-out)
  to a CSV or `.eml` files for Chris to review and send (H10). No automatic sending.
- Skips listings already contacted (record the send in a new `outreach` table or a log file) and
  `removed` listings.
- Email text is a template Chris approves; no generated prose per shop.

Acceptance:
- Tests: one row per eligible listing; removed and already-contacted listings are skipped; links
  match the built site's URLs from `planPages()`.

## Found while building

Agents: add items here instead of doing work outside your task.

| Date | Task | Item |
|---|---|---|
| 2026-11-15 | T1 | `npm audit` shows 6 dev-only advisories (vitest 2.x, esbuild, tinypool); production has 0. Fix by upgrading vitest to 4.x in its own change. |
| 2026-11-15 | T1 | `sites` has no `status` column; `planned`/`launch` lives only in the JSON. T14 may need it in the database. |
| 2026-11-15 | T1 | Supabase CLI expects 14-digit timestamp migration names; ours is `0001_core.sql`. Confirm with `db push --dry-run` after H2 (README has a `psql` fallback). |
| 2026-11-15 | Plan | If Buffalo has fewer than five DTF or laser shops, the launch plan swaps in Columbus or Austin. That needs a new metro in a seed migration, not just a config edit. |
| 2026-11-15 | T2 | Supabase's newer `sb_secret_...` keys replace the legacy `service_role` JWT. The loader accepts either; the variable name `SUPABASE_SERVICE_ROLE_KEY` could be revisited at H2. |
| 2026-11-15 | T2 | `listing_key_checks` has no `dataset_id`, so the loader filters other datasets in code. Add `dataset_id` to the view once there are several datasets. |
| 2026-11-15 | T2 | The built-output key grep is written but skipped until T3 adds `apps/web`'s `build` script. T3 must confirm it runs. |
| 2026-11-15 | T7 | Approving a claim is two writes (`record_check()`, then the claim row). If the second fails, approving again records a second check. An `approve_claim()` SQL function in a new migration would make it one transaction. |
| 2026-11-15 | T7 | T11 should use the claim payload names the admin reads: `facts` (fact keys only), `name`, `address`/`address1`, `city`, `state`, `zip`, `phone`, `website`, `description`. |
| 2026-11-15 | T7 | `siteListings()` in `packages/core` doesn't check `site.dataset`; it trusts callers to pass one dataset's listings. Check it in core before a second dataset. |
| 2026-11-15 | T7 | Admin stats are summed in the browser, 1000 rows a page. Fine at launch; needs a grouped view at six-figure click counts. |
| 2026-11-15 | T7 | Site configs are bundled into the admin build, so the admin needs a rebuild after any `sites/*.json` change. |
