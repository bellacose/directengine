# Directory engine

One code base that builds many directory websites from shared, verified data. A dataset holds the
facts. Each site is a config file in `sites/` that filters the dataset and chooses which facts to show.

Start with `AGENTS.md` (rules and commands), then `docs/ARCHITECTURE.md`.

## What's here

| Path | What | State |
|---|---|---|
| `supabase/migrations/0001_core.sql` | Schema and rules | Written, 28 tests |
| `supabase/seed.sql` | Makers vocabulary, affiliate programs | Written |
| `packages/core` | Which pages each site builds and indexes | Written, 21 tests |
| `sites/` | `dtf`, `laser`, `tampa-makers` configs | Written, all `planned` |
| `scripts/sync-sites.ts` | Copies `sites/*.json` into the `sites` and `site_affiliates` tables | Written, 12 tests |
| `apps/web/src/lib/load.ts`, `fixtures/demo.json` | Build-time data loader and fake data for local builds | Written, 30 tests |
| `docs/` | Architecture, spec, decisions, data, verification script, tasks | Written |
| `apps/admin` | Admin app: listings, checks, claims, corrections, affiliates, stats (`apps/admin/README.md`) | Written, 60 tests |
| `apps/web` pages, Edge Functions | The Astro site, server logic | To build: `docs/TASKS.md` |

## Run the tests

```bash
npm install
npm test
```

No database, Docker or account is needed. The database tests run on an in-memory Postgres.

## Set up the database (Supabase CLI)

Do this once the Supabase project exists (H2). Nothing here needs Docker. Keys and the database
password stay in your shell, the Supabase dashboard and the host; never put them in the repo.

1. Install the [Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started)
   (or prefix each command with `npx`), then sign in and link this repo to the project. The project
   ref is in the dashboard URL, `https://supabase.com/dashboard/project/<project-ref>`.

   ```bash
   supabase login
   supabase init        # only if supabase/config.toml doesn't exist yet
   supabase link --project-ref <project-ref>   # asks for the database password
   ```

   `supabase init` writes `supabase/config.toml`. It contains no secrets and can be committed. Its
   `[db.seed]` section should point at the seed: `sql_paths = ["./seed.sql"]` (the default).

2. Apply the migrations and the seed. Check the dry run lists every file in `supabase/migrations/`
   (today just `0001_core.sql`) before applying.

   ```bash
   supabase db push --dry-run --include-seed
   supabase db push --include-seed
   ```

   The seed is safe to run more than once (the tests run it twice). New migrations are new numbered
   files; `db push` applies only the ones the project hasn't recorded yet. Never edit one that has
   been applied.

3. Create the site rows and their affiliate rows from `sites/*.json`:

   ```bash
   export DATABASE_URL='<connection string from dashboard > Connect>'
   npm run sync-sites -- --dry-run   # validates against the live vocabulary, writes nothing
   npm run sync-sites
   ```

   It stops with a list of errors if any config is invalid, and writes nothing in that case. It is
   safe to run again after every change to `sites/`: placements follow the config, but it never
   changes an affiliate's status or link (set those in the admin app), and a config that still says
   `"domain": null` never clears a domain already stored.

If the CLI refuses the migration file names (its docs show 14-digit timestamps), apply the same files
in order with `psql "$DATABASE_URL" -f supabase/migrations/0001_core.sql -f supabase/seed.sql` and
tell the lead agent, so later migrations can follow the CLI's naming.

## Handing this to agents

1. Create a private GitHub repo and push this folder to it.
2. Point the coding agent at the repo. It reads `AGENTS.md` automatically (`CLAUDE.md` imports it).
3. Tell it: "Do the next task in docs/TASKS.md." One task per session and pull request works best.
4. Review and merge each pull request, then mark the task `done`.

Chris's own tasks (accounts, domains, calls, approvals) are the H-rows at the top of `docs/TASKS.md`.
