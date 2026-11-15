# Data

Schema: `supabase/migrations/0001_core.sql`. Vocabulary: `supabase/seed.sql`. Rules are enforced in
the database and tested in `supabase/tests/run.mjs`.

## Tables

| Table | Holds |
|---|---|
| `datasets` | A pool of listings and its vocabulary. `makers` is the first. |
| `capabilities`, `metros` | What listings do and where, per dataset. |
| `fact_defs` | What can be known about a listing: key, label, type, group. |
| `listings` | Identity: name, address, phone, website, status, slug, place ID. |
| `listing_capabilities`, `listing_metros` | Tags and service areas, many-to-many. |
| `listing_facts` | One row per listing and fact key, with a typed JSON value. |
| `verification_events` | The check log. Append-only. |
| `sites` | Site identity (slug, domain, dataset), synced from `sites/*.json`. |
| `affiliate_programs`, `site_affiliates` | Programs, and each site's approval status and link. |
| `clicks` | Outbound and affiliate clicks, per site. |
| `claims`, `corrections` | Public submissions, rate-limited by trigger. |
| `candidates` | Place IDs found by discovery, awaiting review. |
| `admins` | Supabase user IDs allowed into the admin app. |

## Views pages may read

| View | Returns |
|---|---|
| `public_listing_facts` | Verified facts of published listings, with check date, method and stale flag. **The only fact source for pages.** |
| `listing_key_checks` | Latest check per listing and key, including core keys (`name`, `address`, `phone`, `website`, `capabilities`, `metros`). |
| `listing_fact_status` | Every fact with its verification state. For the admin app. |

## Listings

- `status`: `draft`, `published` or `removed`. Listings are never deleted; a shop that asks to be
  delisted becomes `removed` and disappears from every site.
- A listing is created as a draft. Publishing needs a check, a capability and a metro.
- `slug` freezes once the listing has been published.
- `place_id` is the only value from Google ever stored.
- `lat`, `lng` come from the ZIP centroid.
- `description` is owner-written, at most 500 characters.
- `updated_at` moves whenever the listing, its facts, tags or metros change. It is the sitemap date.

## Facts

Value types: `text`, `boolean`, `number`, `time` (`"14:00"`), `url`, `hours`
(`{"mon": {"open": "09:00", "close": "17:00"}, "sun": null}`; a missing day means not checked).

Makers fact groups from the seed:

| Group | Keys |
|---|---|
| `general` | `hours`, `ships` |
| `pickup` | `pickup_walk_in`, `pickup_after_hours`, `pickup_locker_24_7` |
| `dtf` | `dtf_same_day_cutoff`, `dtf_price_per_foot_usd`, `dtf_price_note`, `dtf_max_width_in`, `dtf_file_requirements` |
| `laser` | `laser_types`, `laser_materials`, `laser_customer_items`, `laser_turnaround_note`, `laser_price_note`, `laser_min_order_note` |
| `sublimation` | `sublimation_products_note` |
| `blanks` | `blanks_on_site`, `blanks_brands_note` |

An unknown fact has no row. Never store a guess or a placeholder.

## Recording a check

Always through the function, which writes the facts and the log entry together:

```sql
select record_check(
  p_listing    => '<listing uuid>',
  p_method     => 'phone_call',            -- website | phone_call | site_visit | owner_submitted
  p_checked_by => 'chris',
  p_facts      => '{"dtf_same_day_cutoff": "14:00", "pickup_walk_in": true, "dtf_price_note": "$6 per foot, 22 in wide"}',
  p_confirmed  => array['phone', 'address', 'capabilities'],   -- confirmed without a new value
  p_note       => 'Spoke to the owner. Saturday orders are next-day.'
);
```

- A JSON `null` in `p_facts` deletes that fact (now unknown).
- Changing a fact any other way hides it from pages until a later check covers it.
- Facts checked more than 180 days ago are flagged `stale`.

## Site config (`sites/<slug>.json`)

Typed as `SiteConfig` in `packages/core/src/index.ts` and checked by `validateSiteConfig()`.

```json
{
  "slug": "dtf",
  "status": "planned",
  "name": "DTF directory (working name)",
  "domain": null,
  "dataset": "makers",
  "filter": { "capabilities": ["dtf", "uv-dtf"], "metros": null },
  "pages": { "capabilityMetro": ["dtf"], "metroHub": false, "shipToYou": ["dtf"], "guides": ["best-heat-press-for-dtf"] },
  "angle": { "factGroups": ["dtf", "pickup"], "facts": ["hours", "ships", "blanks_on_site"], "headline": "dtf_same_day_cutoff", "minFacts": 3 },
  "indexGate": 5,
  "affiliates": { "transfer-express": ["ship-to-you"] }
}
```

| Field | Meaning |
|---|---|
| `status` | `planned` (not built) or `launch` (built and deployed; needs a domain). |
| `filter` | A listing belongs to the site if it has any listed capability and any listed metro. `null` means no limit. |
| `pages` | Which page types the site builds. |
| `angle` | Which facts the site's pages show, the fact that leads cards and ordering, and the minimum for a shop page. |
| `indexGate` | Listings needed before a list page is indexed. |
| `affiliates` | Program slug to placements: `ship-to-you`, `guides`, `list-pages`. |

`sites/guides.json` holds each guide's title and approval state.
