# Product spec

## What a site is for

Each site answers one question for someone with a deadline: **who near me can make this today, by what
time, and at what price?** The edge is facts other directories don't have and can't scrape, each
shown with the date and method of its last check.

**Reader:** people who make things for money: small apparel brands, Etsy sellers, event merch
organizers, and print and laser shops that outsource overflow. Not consumers buying one gift.

**Money, in order:** affiliate links on ship-to-you pages and guides, then claim-your-listing leads,
then paid Featured placement (not built yet; see DECISIONS D13).

## Launch scope

| Item | At launch |
|---|---|
| Dataset | `makers` |
| First site | `dtf`. Second, to prove the engine: `laser`. `tampa-makers` is configured but planned. |
| Metros | Tampa Bay and Buffalo |
| Listings | 20 to 40, each checked by phone before publishing |
| Out of scope | Public accounts, bookmarks, reviews, ratings, newsletters, chat, embedded Google maps, ordering or payments between buyers and shops |

## Pages

Paths and index rules come from `planPages()` in `packages/core`. This table describes them.

| Path | Page | Built when | Indexed when |
|---|---|---|---|
| `/` | Home | Always | Always |
| `/{metro}/` | Metro hub | Site has `metroHub` and the metro has a listing | Listings in metro ≥ index gate |
| `/{capability}/{metro}/` | Capability x metro list | At least one listing | Listings ≥ index gate (5) |
| `/shop/{slug}/` | Shop, in this site's angle | Shop has ≥ `minFacts` verified angle facts | Always |
| `/ship/{capability}-to-{metro}/` | Ship-to-you fallback | An approved supplier on this site has checked facts | Always |
| `/guides/{slug}/` | Guide | Listed in the site config | Chris approved it |
| `/add-your-shop/`, `/about/`, `/disclosure/`, `/privacy/`, `/terms/`, `/contact/` | Static pages | Always | Always |
| `/go/{program}/` | Affiliate redirect | Program approved for this site | Never; disallowed in robots.txt |

### Capability x metro list (`/dtf/tampa-bay/`)

The main page. A heading, one sentence built from data, then the list.

- **H1** from the capability and metro names, for example "DTF transfers in Tampa Bay".
- **Lead**, data only: "{n} shops in Tampa Bay print DTF. {m} confirmed a same-day cutoff. Last
  checked {date}."
- **Order** from `orderForList()`: shops with the site's headline fact first, then by name.
- **Card:** name, city, the angle's top facts (headline first), capability tags, "Checked {date} by
  {method}", and Website, Call and Directions buttons. The name links to the shop page when
  `hasDetailPage()` is true; otherwise the card stands alone.
- **Directions** opens a maps search for the address in a new tab. No embedded Google content.
- **Filters** are client-side and never change the URL: city, plus one toggle per boolean fact in the
  angle.
- **Fallback link** to the ship-to-you page when the site has one.
- **Structured data:** `ItemList` and `BreadcrumbList`.

### Shop page (`/shop/{slug}/`)

- Name, address, phone, website, capability tags, then the angle's facts grouped by fact group.
- Each fact shows its check: "Same-day cutoff 2:00 PM. Checked Nov 20, 2026 by phone." Stale facts
  (over 180 days) add "may be out of date".
- Facts in the angle that the shop lacks show "Not checked yet". Facts outside the angle don't appear.
- "Report a change" form and "Is this your shop?" claim link.
- **Structured data:** `LocalBusiness` with name, address, telephone and url, plus
  `openingHoursSpecification` only when hours are verified. Never ratings.
- Canonical is the page itself.

### Metro hub and home

Links to the site's list pages with listing counts, and the cities covered. Data-built text only.

### Ship-to-you (`/ship/dtf-to-tampa-bay/`)

For when no local shop can do it in time. Lists this site's approved suppliers with the cutoff and
price read from the supplier's own site and the date they were read. Links go through `/go/`. The
disclosure line is at the top.

### Guides

Markdown in `content/guides/`. Agents may draft them, citing a source for every spec and price.
A draft stays `approved: false` in `sites/guides.json`, which keeps it out of the index and the
sitemap. Equipment links go through `/go/`.

### Add your shop

One form for claiming a listed shop or submitting a new one: shop name, address, phone, website,
contact email, what they do, and any facts they want listed. It posts to an Edge Function and lands
in `claims` for review. Approving a claim records an `owner_submitted` check; publishing stays a
separate admin step.

## Content rules

- Facts only from `public_listing_facts`. Unknown is shown as unknown.
- No ratings, reviews, testimonials or "best" claims about shops.
- No generated paragraphs.
- Every page with an affiliate link shows: "Some links on this page earn us a commission. It doesn't
  change which shops we list or how we order them."
- The footer names the operator and credits GeoNames for ZIP data.

## What gets measured

| Measure | Where |
|---|---|
| Search impressions | Google Search Console, per site |
| Affiliate clicks by site, program and page | `clicks`, written by the `/go/` function |
| Website, call and directions clicks per listing and site | `clicks`, written by the track function |
| Claims and change reports | `claims`, `corrections` |
