# Fixtures

Fake data for building sites without a database:

```bash
SITE=dtf DATA_FIXTURE=fixtures/demo.json   # instead of SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
```

Everything in here is made up. Names start with "Example", websites are on `example.com`, phone numbers
are 555-01xx. `scripts/check-build` (T15) fails a production build that contains any of these markers.

## `demo.json`

| Case | Where |
|---|---|
| 12 published shops, both metros | all `"status": "published"` |
| A draft and a removed shop (never loaded) | `example-draft-shop-tampa`, `example-closed-shop-tampa` |
| DTF and laser in one shop, with a page on both sites | `example-makers-st-pete`, `example-makers-hamburg` |
| Below `minFacts` in one angle (page on `dtf`, list only on `laser`) | `example-laser-and-print-largo` |
| Below `minFacts` everywhere (list only) | `example-transfer-house-clearwater` |
| A stale fact (checked over 180 days ago) | `example-dtf-buffalo`, `hours` |
| A value typed in without a check (never shown) | `example-dtf-tampa`, `dtf_price_per_foot_usd` |
| A list page at the index gate (5) and one below it | `/dtf/tampa-bay/` (5), `/dtf/buffalo/` (3) |
| UV DTF | `example-print-lab-brandon`, `example-uv-print-tonawanda` |

No affiliate is approved and no supplier has facts, so ship-to-you pages are not built from this file.
Tests make variants of it for those cases.

## Format

The loader applies the same rules to a fixture as the database views do: only `published` listings,
only facts with a `checkedAt` (a `null` one is a value typed in without a check), `stale` when
`checkedAt` is more than 180 days old. `vocabulary` and `affiliatePrograms` must match
`supabase/seed.sql` (a test checks). `siteAffiliates` maps a site slug to each program's `status` and
`url` on that site; a missing entry means `apply` with no link.

The test in `apps/web/test/load.test.ts` writes this file into the real schema through
`record_check()` and checks that the Supabase path returns exactly what the fixture path returns.
