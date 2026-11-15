# Decisions

Settled choices. Agents follow these. Changing one needs Chris's approval and a new dated entry.

| # | Date | Decision | Why |
|---|---|---|---|
| D1 | 2026-11-15 | **Astro (static) + Supabase.** Edge Functions for server logic. One static deploy per site. | Static pages can't be overloaded by a crawl. One live directory lost its Google index when a recrawl of about 900 uncached pages overloaded its database. |
| D2 | 2026-11-15 | **Datasets hold facts; sites are config-only views.** A new directory is a file in `sites/`. | Chris wants many directories from the same data, with no code change per directory. |
| D3 | 2026-11-15 | **Each site renders its own page for a shop, in its own angle** (different facts per site). | Chris's choice. Each directory is complete on its own, and the pages differ. |
| D4 | 2026-11-15 | **Minimum verified facts per angle (default 3) before a site builds its own shop page.** | Prevents near-empty, near-duplicate pages across domains. |
| D5 | 2026-11-15 | **Pages are self-canonical.** No cross-domain canonical tags. | The pages differ by design (D3). |
| D6 | 2026-11-15 | **Facts are rows with a declared type**, not columns. | A new niche needs new fact definitions, not a schema change. |
| D7 | 2026-11-15 | **A fact is public only when a check was logged after its current value was set.** The log is append-only. | Verified facts are the product. Enforced in the database, not by habit. |
| D8 | 2026-11-15 | **Google Places is for discovery only. Store place IDs, nothing else.** | Google's Places policies allow storing only the place ID indefinitely, coordinates for 30 days, and other fields not at all. |
| D9 | 2026-11-15 | **Coordinates come from ZIP centroids** (GeoNames, CC BY 4.0, credited in the footer). | Meets D8. Good enough for sorting by distance and a directions link. |
| D10 | 2026-11-15 | **No ratings, reviews or generated text.** | Copied ratings in structured data risk penalties, and generated FAQs are the thin content that gets directories demoted. |
| D11 | 2026-11-15 | **Index gate of 5 listings per list page**, set per site in config. | Thin list pages hurt the whole site. |
| D12 | 2026-11-15 | **Affiliate approval, links and click tracking are per site.** Every click carries a site and page tag. | Networks approve each website separately, and Chris needs to see which directory earned what. |
| D13 | 2026-11-15 | **Featured (paid) placement is not built for launch.** | Shops won't pay before they see referrals. Add it once click data exists; it can be sold per site or as a bundle. |
| D14 | 2026-11-15 | **Verification calls are made by a person at launch.** No automated or AI voice calls to shops. | 20 to 40 calls is a day or two of work. Check the calling rules before automating calls to businesses that didn't ask for them. |
| D15 | 2026-11-15 | **`anon` has no database access.** Public forms go through Edge Functions. | One small, auditable surface for public writes. Rate limits live in the database. |
| D16 | 2026-11-15 | **The DOT physical site stays where it is for now.** | It's live on a different stack. Moving it onto this engine as a second dataset is a later decision, after this engine has a site in production. |
| D17 | 2026-11-15 | **First site is `dtf`, second is `laser`, metros are Tampa Bay and Buffalo.** | From the business-value ranking in the launch plan. Chris can change the order by editing `status` in the site files. |
| D18 | 2026-11-15 | **`pg` (node-postgres) for scripts that write to the database** (`sync-sites` first). Connects with `DATABASE_URL`, set only in the shell or host that runs the script. | Upserts that must not touch Chris's affiliate approvals need real SQL in one transaction, which the REST client can't do. Its query interface matches PGlite's, so the same code is tested on in-memory Postgres. |
| D19 | 2026-11-15 | **Scripts are TypeScript run directly by Node (type stripping, Node 22.18 or newer), no build step or `tsx`.** `erasableSyntaxOnly` in `tsconfig.json` keeps them to syntax Node can strip. | One less dependency; scripts import `packages/core` source as is. |
| D20 | 2026-11-15 | **Go on the 60-day test.** The DTF near-me terms clear the launch plan's 1,000-a-month cutoff. | Keyword Planner results in `docs/KEYWORDS.md` (H1). |
| D21 | 2026-11-15 | **`@supabase/supabase-js` for the build-time loader** (`apps/web/src/lib/load.ts`), with `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` as in ARCHITECTURE. Read-only, paged table reads; no embedded joins. | The build environment has the API URL and key, not a Postgres connection string. Tests run the real client against the migration on PGlite through a small PostgREST stand-in, so the queries are checked, not mocked away. |
| D?? | 2026-11-15 | **Admin app is React + Vite, talking to Supabase with `@supabase/supabase-js` as the signed-in user** (publishable key, email-link sign-in with `shouldCreateUser: false`). No router or UI library: hash routes and plain CSS. | ARCHITECTURE names React and Supabase Auth. Vite is the standard React build; supabase-js is Supabase's own client and handles the magic-link session. Every query runs under RLS, so the browser never needs more than the publishable key. |
| D?? | 2026-11-15 | **Admin data calls go through a small `Db` interface** (`apps/admin/src/lib/db.ts`): supabase-js in the app, SQL on PGlite in tests and in the local demo mode (`npm run dev:admin:demo`). `@electric-sql/pglite` is an admin dev dependency for that demo; production builds leave it out (tested). | Lets tests run the app's real queries against the real migration with RLS on, with no Supabase project; the demo gives screenshots and a try-out with fake data only. |
