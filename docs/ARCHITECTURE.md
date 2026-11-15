# Architecture

## The model

```
dataset "makers"                      sites (config files)
  listings ─┬─ capabilities             sites/dtf.json           filter: capability dtf, uv-dtf
            ├─ metros                   sites/laser.json         filter: capability laser
            ├─ facts (typed, per key)   sites/tampa-makers.json  filter: metro tampa-bay
            └─ verification log
```

- A **dataset** is a pool of listings plus its vocabulary: capabilities, metros and fact definitions.
  Facts are rows, not columns, so a new niche adds `fact_defs` rows and needs no schema change.
- A **site** is a view over one dataset. Its file in `sites/` sets the filter (which listings), the
  pages (which page types), the angle (which facts its pages show), the index gate and its affiliate
  programs.
- **Shared, done once:** listing facts, verification, claims, change reports, removals.
- **Per site:** angle, branding, domain, affiliate links and approvals, click stats, index decisions.

## Same shop on several sites

A shop that fits several sites appears on each. Each site renders its own page for the shop using only
its angle's facts, so the pages differ:

| Site | Shows for a shop that does DTF and laser |
|---|---|
| `dtf` | DTF cutoff, DTF price, file rules, pickup, hours |
| `laser` | Laser types, materials, laser pricing, pickup, hours |
| `tampa-makers` | Everything verified |

Two rules keep this safe for search:

1. **Minimum facts.** A site builds its own page for a shop only when the shop has at least
   `angle.minFacts` verified facts in that site's angle (3 by default). Below that the shop still
   appears in the site's lists, without a detail page there. `hasDetailPage()` decides.
2. **Self-canonical.** Every page's canonical URL is itself. Sites never point at each other.

## Stack

| Layer | Choice |
|---|---|
| Public pages | Astro, TypeScript, fully static output. Small client-side scripts for filters. |
| Data | One Supabase Postgres project for all datasets and sites. |
| Server logic | Supabase Edge Functions: affiliate redirect, click tracking, claim and change-report forms, rebuild trigger. |
| Admin | One React app for all sites, Supabase Auth, access through the `admins` table. |
| Hosting | One static deploy per site from this repo (Cloudflare Pages or Netlify). `SITE=<slug>` picks the config. |

## Repo layout

```
apps/web/          Astro app. Built once per site.                      (T2 onward)
apps/admin/        React admin app.                                     (T7)
packages/core/     Page planning and config validation. Pure, tested.   (exists)
supabase/
  migrations/      Schema and rules.                                    (0001 exists)
  seed.sql         Makers vocabulary and affiliate programs.            (exists)
  tests/           Database rule tests on in-memory Postgres.           (exists)
  functions/       Edge Functions.                                      (T8, T11, T14)
sites/             One JSON file per site, plus guides.json.            (exists)
content/guides/    Guide text in Markdown.                              (T10)
fixtures/          Fake data for local development.                     (T2)
scripts/           sync-sites, discover, check-build.                   (T1, T13, T16)
docs/
```

## How a build works

1. The host runs the build with `SITE=dtf`, `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.
2. The loader reads `sites/dtf.json`, validates it with `validateSiteConfig()`, and stops on any error.
3. It loads the dataset: published listings with capabilities and metros, verified facts from
   `public_listing_facts`, latest checks for core fields from `listing_key_checks`, this site's
   affiliates, and guide states.
4. `planPages()` returns every page with its `indexable` flag and `lastmod`.
5. Astro renders exactly those pages. Non-indexable pages get `noindex,follow`.
6. `sitemapEntries()` writes the sitemap. `robots.txt` disallows `/go/`.

No public page or script talks to Supabase with a database key. Forms post to Edge Functions.

## Why pages can't show unverified facts

- Facts live in `listing_facts`. Checks live in `verification_events`, which is append-only.
- `public_listing_facts` returns a fact only if the listing is published **and** a check was logged
  at or after the moment the fact's current value was set. Editing a value hides it until someone
  checks it again.
- `record_check()` writes facts and their check in one transaction, so the normal path never trips
  that rule.
- Publishing needs at least one check, one capability and one metro. Slugs freeze after publishing.

## Access

- Row level security is on for every table. `anon` has no access to anything.
- Signed-in users listed in `admins` have full access (the admin app).
- The service role (build, Edge Functions) bypasses RLS. Treat its key like a password.

## Keeping sites current

A scheduled Edge Function checks whether any listing in a site's dataset changed since that site's
last build and, if so, calls the site's deploy hook. A nightly build catches everything else. After a
deploy, changed URLs are sent to IndexNow.

## Adding a directory

1. Add `sites/<slug>.json`. For a new niche, also add a dataset, capabilities, metros and fact
   definitions in a seed or migration.
2. `npm test` validates the config against the database vocabulary.
3. Run `sync-sites` to create the site row and its affiliate rows.
4. Create a deploy on the host with `SITE=<slug>` and point the domain at it.

No application code changes. T17 proves this by launching the second site.
