# Agent instructions: directory engine

One engine that builds many directory websites from shared data. A **dataset** holds verified facts
about listings. A **site** is a config file that filters a dataset and picks an angle on it. Adding a
directory means adding a file in `sites/`, never changing code.

First dataset: `makers` (local DTF, laser and related shops). First site: `dtf`.

Read before any work, in this order:

1. `docs/ARCHITECTURE.md`: the model, the stack, how a build works.
2. `docs/SPEC.md`: every page type and what it shows.
3. `docs/DECISIONS.md`: choices already made. Do not reopen them in code.
4. `docs/DATA.md`: tables, facts, verification, site config.
5. `docs/TASKS.md`: the build plan. Work only from here.

## Commands

```bash
npm install
npm test              # typecheck + database rule tests + page-planning tests; must pass before any PR
npm run test:db       # migration and seed against in-memory Postgres (no Docker needed)
npm run test:core     # packages/core and every sites/*.json
npm run test:scripts  # scripts/ (sync-sites against in-memory Postgres)
npm run test:functions  # supabase/functions (go, track, submit-claim, report-change) with supabase-js against in-memory Postgres
npm run test:web      # apps/web (data loader on both paths; builds every site from the fixture and checks the output)
npm run build -- --site dtf --fixture   # build one site from fixtures/demo.json into apps/web/dist
npm run build -- --site dtf             # build one site from Supabase (SUPABASE_URL and key in the environment)
npm run dev -- --site dtf               # dev server on localhost:4321; uses the fixture unless SUPABASE_URL is set
npm run sync-sites    # write sites/*.json to the database; needs DATABASE_URL (add -- --dry-run to check only)
npm run test:admin    # apps/admin: form rules, RLS access and workflows on in-memory Postgres, build output
npm run build:admin   # build the admin app to apps/admin/dist; needs VITE_SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY
npm run dev:admin     # admin app against a real Supabase project (same two variables)
npm run dev:admin:demo  # admin app on an in-browser Postgres with fake data; no account needed
```

CI (`.github/workflows/ci.yml`) runs `npm test` on every pull request and on pushes to `main`.
npm workspaces cover `apps/*` and `packages/*`; scripts in `scripts/` are TypeScript run directly by
Node 22.18+ (see D19).

Tasks add more commands (build, dev). Keep this list current when they do.

## What already exists and is tested

- `supabase/migrations/0001_core.sql`, `supabase/seed.sql`: schema, rules and the makers vocabulary.
- `supabase/tests/run.mjs`: 28 tests of the database rules.
- `packages/core`: which listings a site includes, each site's angle, which pages get built and
  indexed, sitemap dates, brand and operator checks. 23 tests.
- `sites/*.json`: three site configs, validated against the seed by the tests.
- `apps/web/src/lib/load.ts`: the build-time data loader (Supabase or `DATA_FIXTURE`), and
  `fixtures/demo.json`, fake data covering every page case.
- `apps/web`: the Astro app (T3). One route, `src/pages/[...path].astro`, renders exactly the pages
  `planPages()` returns, each page type in its own file under `src/components/pages/`. Layout,
  header and footer in `src/layouts/` and `src/components/`; `sitemap.xml` and `robots.txt` in
  `src/pages/`. Static pages outside the plan are listed in `src/lib/static-pages.ts`.
- List pages (T4): `src/lib/list.ts` builds each capability x metro page from the plan; `src/lib/fact-format.ts` formats fact values and check lines for any page.
- Home and metro hubs (T6): `src/lib/hub.ts` builds both from the plan (list links with plan counts, metro counts, cities covered).
- Guides (T10): Markdown in `content/guides/` (an Astro content collection, `src/content.config.ts`), rendered by `src/components/pages/Guide.astro`; `src/lib/guide.ts` turns `/go/<program>/` links into affiliate links or plain text.

Build on these. If a rule needs to change, change it there with a test, in its own PR.

## How to work

- Take the lowest-numbered task in `docs/TASKS.md` with status `todo` whose dependencies are `done`.
  Tasks marked **[HUMAN]** are Chris's. Never fake their output (no made-up shops, links or approvals).
- One task per branch (`task/T4-list-pages`) and pull request. Several agents work in parallel, each
  in its own git worktree, so **do not edit `docs/TASKS.md` or `docs/QUESTIONS.md`**. The lead agent
  updates task status (`in review`, and `done` after Chris merges) and copies notes into those files.
- In the PR, list each acceptance criterion with how you checked it: the command and its result, or
  desktop and mobile screenshots for anything visual.
- Stay inside the task. Other work you notice goes under a "Found while building" heading in the PR
  description.
- Blocked or unclear: put the question under a "Questions for Chris" heading in the PR description,
  or report it to the lead agent, then continue with whatever part of the task doesn't depend on it.
- Check current Astro and Supabase documentation before using an API. Do not rely on memory for
  version-specific behavior.
- A new dependency needs a line in `docs/DECISIONS.md` saying why. Number it `D??`: parallel branches
  would collide on numbers, so the lead assigns the real number at merge.
- Schema changes are new numbered files in `supabase/migrations/`. Never edit a migration that has
  been applied.

## Rules that never bend

1. **No invented facts.** Pages read listing facts only from the `public_listing_facts` view. Never
   read `listing_facts` directly in page code, and never write a price, hour, cutoff, capability or
   claim that isn't in the database. Unknown shows as "Not checked yet".
2. **Only place IDs from Google.** Never store a name, address, phone, hours, rating or coordinate
   fetched from Google Maps. Coordinates come from ZIP centroids.
3. **No ratings, reviews or stars**, ours or copied. No `aggregateRating` or `review` in structured data.
4. **No generated filler.** No machine-written FAQs, intros or city blurbs. Sentences built from data
   are fine. Guides stay `approved: false` until Chris approves them.
5. **No page reads the database at request time.** Public pages are static files. The service role
   key exists only in the build environment and Edge Functions, never in client code or page HTML.
6. **Zero site-specific code.** No `if (site.slug === ...)`. Differences between sites come from
   `sites/<slug>.json`. If config can't express something, extend the config schema and
   `validateSiteConfig`, with tests.
7. **Pages come from the plan.** The build renders exactly what `planPages()` returns, with its
   `indexable` flag and `lastmod`. Don't compute those anywhere else.
8. **Each page is its own canonical.** Sites never point canonical tags at each other.
9. **The verification log is append-only.** Write checks through `record_check()`. Don't work around
   the triggers.
10. **Affiliate links** go through `/go/<program>/` on the site's own domain, carry
    `rel="sponsored nofollow"`, and every page with one shows the disclosure line.
11. **Secrets live in the host and Supabase dashboards**, never in the repo, config files or logs.
12. **Don't touch `bellacose/findadotphysical`.** It's a separate live site on a different stack.

## Definition of done (every task)

- `npm test` passes.
- The build for every site with `"status": "launch"` exits 0.
- New behavior has tests; visual changes have desktop and mobile screenshots in the PR.
- None of the rules above are broken.
