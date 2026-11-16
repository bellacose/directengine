# Admin app

One React app for every site. Sign-in is an emailed link (Supabase Auth); only users listed in the
`admins` table see anything. Row level security enforces that in the database, so the app only ever
holds the project URL and the publishable key, never the service role key.

| Screen | Does |
|---|---|
| Listings | Search; create a draft; edit core fields; capabilities and metros; publish, unpublish, mark removed |
| Listing | Each fact's state (`listing_fact_status`); **Record a check** (`record_check()`); which sites include the shop and whether each builds its page (`packages/core`); check history |
| Claims | Approve (records an `owner_submitted` check; publishing stays separate) or reject |
| Corrections | Close change reports as done or dismissed |
| Candidates | Place IDs from `npm run discover`: Google details shown live for review only (never saved); **Add as draft** (blank form plus the place ID, filled from the shop's own website) or **Reject** |
| Affiliates | Per-site status and tracking link; supplier cutoff and price notes with the date read |
| Stats | Clicks by site and week, by program, by listing |

## Run it

```bash
npm run dev:admin:demo   # fake data in an in-browser Postgres, signed in as a demo admin
npm run test:admin
```

Against a real project (after H2), set in your shell or `apps/admin/.env.local` (git-ignored):

```bash
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
VITE_GOOGLE_MAPS_BROWSER_KEY=...   # optional: live details on Candidates
npm run dev:admin
```

`VITE_GOOGLE_MAPS_BROWSER_KEY` ends up in the page, so it must be a separate Google Cloud key with
**application restriction: HTTP referrers** (the admin URL and `http://localhost:5173/*`) and **API
restriction: Places API (New)** only. It is never the Supabase service key and never
`GOOGLE_PLACES_API_KEY` (the discover script's server key). Without it the screen shows the place
ID and a Google Maps link.

Site configs are bundled at build time: rebuild the admin app after changing `sites/*.json`.

## Deploy (needs H2 and H4)

1. Supabase dashboard > Authentication > URL Configuration: add the admin URL (for example
   `https://admin.<domain>/`) to the redirect URLs. Users are created in the dashboard (Authentication
   > Users > Invite); the sign-in form never creates accounts.
2. Add your user ID to `admins` (H4): `insert into admins (user_id) values ('<auth user id>');`
3. Create a separate deploy on the host: build command `npm run build:admin`, output directory
   `apps/admin/dist`, environment variables `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`.
   Never add the service role key to this deploy.
4. `public/_headers` sends `X-Robots-Tag: noindex, nofollow` on Cloudflare Pages and Netlify; the
   page also has a robots meta tag and `robots.txt` disallows everything.
