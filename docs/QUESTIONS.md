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
| 2026-11-15 | T13 | Google Cloud: create a project with billing, enable Places API (New), and make two keys. `GOOGLE_PLACES_API_KEY` (server, local shell only, restricted to Places API (New)) and `VITE_GOOGLE_MAPS_BROWSER_KEY` (admin deploy env, HTTP-referrer restricted to the admin URL and localhost, API-restricted to Places API (New)). Set daily quota caps. | |
| 2026-11-15 | T13 | First real run after H2: `npm run discover -- --dry-run --capability dtf --metro tampa-bay`, then without `--dry-run`. If the browser blocks Place Details (CORS or referrer), the fallback is a small Edge Function proxy. | |
| 2026-11-15 | T11 | Turnstile: create a widget covering each site's domain; set `TURNSTILE_SITE_KEY` in the host build and `TURNSTILE_SECRET_KEY` via `supabase secrets set`. Both or neither: a secret without the site key refuses every submission. | |
| 2026-11-15 | T11 | When Turnstile is on, the form functions send the visitor's IP to Cloudflare's check (not stored). The privacy page (T12) should say so before Turnstile is enabled. | |
| 2026-11-15 | T11 | Deploy after H2: `supabase functions deploy submit-claim report-change`. Review the form copy and the outcome messages in `MESSAGES` (`supabase/functions/_shared/forms.ts`). | |
| 2026-11-15 | T9 | Supplier rows say "Checked {date} on the supplier's website". Keep that wording? | |
| 2026-11-15 | T9 | Ship-to-you lead sentence (built from data): "For when no shop in {metro} can make it in time: {n} suppliers that ship {capability}. Cutoffs and prices are as read from each supplier's own website on the date shown." OK? | |
| 2026-11-15 | T10 | H7: review the "Claims to double-check" list in PR #14 (press settings, Geo Knight/Hotronix specs, Glowforge prices that conflict between its own pages, OMTech and LightBurn prices, Trotec vs Epilog on engraved acrylic), then set `approved`/`approvedAt` in `sites/guides.json`. | |
| 2026-11-15 | T10 | Keep or cut the uncited sentence "Heat Press Nation is one retailer that sells presses from several makers, including Geo Knight and Hotronix" in `best-heat-press-for-dtf`? | |
| 2026-11-15 | T10 | Unapproved guides build with `noindex` and a visible "Draft: this guide hasn't been reviewed yet." note, and are reachable by URL on a deployed site. OK, or leave drafts out of the build entirely? | |
| 2026-11-15 | T18 | Jiffy "on pages about blanks": dtf has no blanks pages, so limiting Jiffy to `blanks` there removes it from dtf. Should it instead be `{"placement": "list-pages", "capabilities": ["blanks"]}` on `tampa-makers` (needs approval for that site and the list-pages slot built)? Jiffy is unchanged for now. | |
| 2026-11-15 | T18 | Guides have no capability, so a `guides` placement can't be limited. Want a `capabilities` list per guide in `sites/guides.json` so a program shows only on, say, DTF guides? | |
| 2026-11-15 | T19 | Pick an email provider (D28 lists Resend, Postmark, Amazon SES, Brevo, Mailgun). Then set Supabase secrets `EMAIL_API_KEY` and `EMAIL_FROM`, and add the provider's SPF/DKIM DNS records for the sending domain. | |
| 2026-11-15 | T19 | Confirmation links need each site's `domain` (H3); without it the email is skipped with a warning. Review the email text in `confirmationEmail()` (`supabase/functions/_shared/claim-email.ts`) and the page text in `CONFIRM_MESSAGES`. | |
| 2026-11-15 | T19 | Deploy after H2: `supabase db push` (migrations 0002 and 0003), then `supabase functions deploy confirm-claim submit-claim`. | |
