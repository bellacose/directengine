# Factory plan: from niche idea to revenue

Approved by Chris 2026-11-25 (D32 to D35). The engine builds local-business directories for any
niche. This plan covers the steps around the engine: choosing a niche, getting data, getting traffic
and earning money. Every traffic and revenue figure here is an estimate, not a measurement.

**In one line:** pick niches with proven demand and beatable competition, launch one national site
per niche, get traffic, turn on ads early to break even, then sell to buyers once traffic exists.

## The math

| Goal | Needs |
|---|---|
| Cover running costs (about $48/mo) | About 5K sessions/mo at $10 per 1,000 |
| $1,000/mo from ads | About 83K sessions/mo at $12 per 1,000 |
| $10,000/mo from ads alone | About 830K sessions/mo |

Ads get a site to break-even; buyers (sponsors, featured spots, quote requests) get it to real
money. One $199/mo sponsor is worth about 17K sessions of ads.

Ad networks as of 2026-11-25:
- **AdSense:** first. It rejects thin sites, so our quality rules help.
- **Journey by Mediavine:** 5,000 sessions/mo from the US and six other countries, and a domain at
  least 4 months old. Buy domains early to start that clock.
- **Ezoic:** 250,000 monthly users for new sites; not a fit.

## Stage 1: Choose the niche (week 1, about $50)

Score about 20 ideas with the niche scorecard (T23, DataForSEO). All five must pass:

1. **Demand:** 100K+ monthly US searches across the niche's keywords.
2. **Beatable:** a weak site (low authority) already gets real traffic for the core terms.
3. **Hard on Maps:** Google Maps doesn't answer the question cleanly.
4. **Data:** 1,000+ listings from sources we may store (D32).
5. **Hook:** one useful fact others lack (DTF's is the same-day cutoff).

Ties are broken on return visits, ad value (CPC), searcher turnover (people who don't already know
whom to call) and future buyers.

Ideas to score first: laser engraving, 24-hour laundromats, scrap yards, knife sharpening, sewing
machine repair, kiln firing, e-waste drop-off, shredding drop-off.

DTF: its near-me terms total about 3K to 30K searches a month, too few to live on ads. It stays an
affiliate pilot and the proving ground for the launch checks.

## Stage 2: Data (weeks 2 to 4)

1. **Backbone:** licensed open place data and public records (D32), after a licence check per
   source. Google stays discovery-only (D8).
2. **Facts:** an agent reads each business's own website and proposes facts with the page URL
   (D33).
3. **Approval:** Chris approves batches; nothing goes public until then. Anything uncertain stays
   "Not checked yet".
4. **Hook fact:** calls or owner claims, busiest metros first.

## Stage 3: Build and launch (weeks 3 to 6)

Pages: national home, state pages, metros, listings, a ZIP finder, and one data page worth linking
to. Launch the 25 to 50 fullest metros, then widen as Google indexes them.

No near-copy sites. Google's doorway policy names multiple similar sites; `tampa-makers` stays
`planned`.

## Stage 4: Traffic (ongoing)

- Search Console and Bing on launch day.
- Free links: trade associations, suppliers, local resource pages, journalists using our data.
- Owner outreach ("your listing is live, check it"), which also improves the data (T20).
- Answer real questions in communities (Reddit, Facebook groups) by hand.
- No paid links. Buying links for ranking breaks Google's spam policies.
- Monthly: expand pages that get impressions; fix or remove the rest.

## Stage 5: Money (D34)

| When | Turn on |
|---|---|
| Launch | Affiliates, and an "advertise here" page |
| About 1K sessions/mo | AdSense |
| 5K sessions/mo and a 4-month-old domain | Journey by Mediavine |
| 10K sessions/mo | Email alerts, a paid data product, first sponsors |
| 20K+ sessions/mo or steady buyer interest | Featured spots (D13), then quote requests |
| 12 months of earnings | Keep or sell |

## Stage 6: Keep or kill (per site)

| Day | Continue if |
|---|---|
| 30 | Pages are being indexed |
| 60 | 60%+ indexed and impressions rising |
| 90 | 1K+ sessions/mo, or page-two rankings on core terms |
| 180 | 5K+ sessions/mo, or a paying buyer |

A miss gets one fix cycle, then the site is parked. Run at most three new sites until one passes
day 90; then clone the winner into neighboring niches.

## Forecast, up to three sites (estimates)

| | Cautious | Base | Stretch |
|---|---|---|---|
| Month-12 sessions | 8K | 30K | 90K |
| Month-12 ad revenue | $40 | $360 | $1,350 |
| Monthly break-even | Not in year 1 | About month 8 | Sooner |

Year-one cost about $920: $341 upfront (DataForSEO $50, three domains $33, two months of an SEO tool
about $258) plus $48/mo.

## Build order

| # | Work | Task |
|---|---|---|
| 1 | `check-build` and the formal DTF launch | T15 |
| 2 | Niche scorecard | T23 |
| 3 | Niche definition file, national metros, multi-dataset fixes | T24 |
| 4 | Open-data importer | T25 |
| 5 | Assisted fact collection and batch approval | T26 |
| 6 | State pages and ZIP finder | T27 |
| 7 | Ad module | T28 |
| 8 | Rebuilds, batched daily, and IndexNow | T14 |
| 9 | Portfolio scoreboard | T29 |
| 10 | Owner outreach | T20 |
| 11 | Advertise page, sponsors, then quote requests | T30 |

Hosting: new sites go on Cloudflare Pages. On Netlify's credit plans each production deploy costs
credits, and running out takes every site offline; check the plan before T14.

## Risks

Slow ranking, AdSense rejection, AI answers taking clicks, and copycats. The gates cap the loss:
killing a niche after Stage 1 and one domain costs about $60.

## Sources

[Journey](https://journeymv.com/), [Mediavine requirements](https://www.mediavine.com/mediavine-requirements/),
[Ezoic Incubator](https://www.ezoic.com/incubator), [AdSense content policy](https://support.google.com/adsense/answer/81904),
[Google spam policies](https://developers.google.com/search/docs/essentials/spam-policies),
[Netlify credits](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/how-credits-work/),
[Cloudflare Pages limits](https://developers.cloudflare.com/pages/platform/limits),
[DataForSEO pricing](https://dataforseo.com/apis/serp-api/pricing). Ad rates come from third-party blogs.
Inspiration: `inspiration/` (an interview with a directory builder, and a launch plan drafted by Grok).
