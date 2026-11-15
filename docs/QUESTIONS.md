# Questions for Chris

Agents: add a question here when a task is blocked or unclear, then move on to another task.

| Date | Task | Question | Answer |
|---|---|---|---|
| 2026-11-15 | T1 | After H2, run the README's "Set up the database" steps (link, `db push --include-seed`, `sync-sites`). Nothing has run against a real Supabase database yet. | |
| 2026-11-15 | T1 | `sync-sites` connects with a Postgres connection string (`DATABASE_URL`), not the service role key. Run it from your machine, or later from the host build or CI (secret in that dashboard)? | |
| 2026-11-15 | T7 | Admin deploy (after H2): a second host deploy, build `npm run build:admin`, output `apps/admin/dist`, env `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`. Which URL (for example `admin.<dtf domain>`)? Add it to Supabase Auth redirect URLs. | |
| 2026-11-15 | T7 | Sign-in never creates accounts: invite yourself under Supabase Authentication > Users, then H4 (`insert into admins (user_id) values ('<id>');`). | |
| 2026-11-15 | T7 | "Checked by" defaults to the signed-in email; examples use `chris`. Keep the email or default to a short name? | |
