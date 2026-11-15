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
| `docs/` | Architecture, spec, decisions, data, verification script, tasks | Written |
| `apps/web`, `apps/admin`, Edge Functions | The Astro site, admin app, server logic | To build: `docs/TASKS.md` |

## Run the tests

```bash
npm install
npm test
```

No database, Docker or account is needed. The database tests run on an in-memory Postgres.

## Handing this to agents

1. Create a private GitHub repo and push this folder to it.
2. Point the coding agent at the repo. It reads `AGENTS.md` automatically (`CLAUDE.md` imports it).
3. Tell it: "Do the next task in docs/TASKS.md." One task per session and pull request works best.
4. Review and merge each pull request, then mark the task `done`.

Chris's own tasks (accounts, domains, calls, approvals) are the H-rows at the top of `docs/TASKS.md`.
