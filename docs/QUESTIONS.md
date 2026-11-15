# Questions for Chris

Agents: add a question here when a task is blocked or unclear, then move on to another task.

| Date | Task | Question | Answer |
|---|---|---|---|
| 2026-11-15 | T1 | After H2, run the README's "Set up the database" steps (link, `db push --include-seed`, `sync-sites`). Nothing has run against a real Supabase database yet. | |
| 2026-11-15 | T1 | `sync-sites` connects with a Postgres connection string (`DATABASE_URL`), not the service role key. Run it from your machine, or later from the host build or CI (secret in that dashboard)? | |
| 2026-11-15 | T7 | Admin deploy (after H2): a second host deploy, build `npm run build:admin`, output `apps/admin/dist`, env `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`. Which URL (for example `admin.<dtf domain>`)? Add it to Supabase Auth redirect URLs. | |
| 2026-11-15 | T7 | Sign-in never creates accounts: invite yourself under Supabase Authentication > Users, then H4 (`insert into admins (user_id) values ('<id>');`). | |
| 2026-11-15 | T7 | "Checked by" defaults to the signed-in email; examples use `chris`. Keep the email or default to a short name? | |
| 2026-11-15 | T3 | Lighthouse (mobile, home page, performance and SEO >= 95) hasn't run: agents are blocked from downloading it. Run `npm run build -- --site dtf --fixture`, then `npx astro preview` in `apps/web`, then Lighthouse on `http://localhost:4321/`. | |
| 2026-11-15 | T3 | Operator name for the footer (you, or a business)? Every site has `"operator": null`, and `launch` is refused until it's set. | |
| 2026-11-15 | T3 | Brand colors are placeholders (dtf `#1d4ed8`, laser `#b91c1c`, tampa-makers `#0f766e`). Change them in `sites/*.json` any time. | |
| 2026-11-15 | T12 | Operator name **and contact email** per site: `"operator": { "name": "...", "email": "..." }` in `sites/<slug>.json`. Launch requires both. | |
| 2026-11-15 | T12 | Legal entity and state for a governing-law clause in the terms. Lawyer review of the terms and privacy pages before `dtf` launches? | |
| 2026-11-15 | T12 | Add a "Last updated" date to the info pages? It needs a config date (for example `legalUpdatedAt`), which would also give them a sitemap `lastmod`. | |
| 2026-11-15 | T5 | Stale hours (over 180 days) still go into `openingHoursSpecification`. Leave stale hours out of structured data so Google doesn't show possibly-wrong hours? | |
| 2026-11-15 | T5 | PostalAddress has no `addressCountry` (no country field). Default to "US" for the makers dataset? | |
| 2026-11-15 | T8 | After H2 picks a host: live-check that `/go/<program>/` returns a 302 (Netlify proxy passing the function's 302 through; Cloudflare `_routes.json` applying to `_worker.js`). Deploy with `supabase functions deploy go track` and set `SUPABASE_URL` in each site's build environment. | |
| 2026-11-15 | T8 | H6: when entering a network link in the admin, put `{subid}` where the network takes a sub-ID (for example Awin `&clickref={subid}`). | |
