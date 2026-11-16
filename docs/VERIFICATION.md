# Verifying a shop

For Chris, or whoever makes the calls. A listing is published only after a person has checked it, and
every fact on a page shows when and how it was checked. One call updates every directory the shop
appears on.

Until the admin app exists (task T7), use the Supabase table editor and the `record_check` SQL in
`docs/DATA.md`. After T7, the admin app has a "Record a check" form that does the same thing.

## Before the call

1. Find the shop: the discovery list, a search, or a claim.
2. Read its website. Note what it states: what it does, cutoff, prices, file rules, hours.
3. Add the shop as a draft with its capabilities and metro.
4. Record a `website` check for the facts the site states, with the page URL as evidence.
   Small and home-based printers often have no site of their own: their Etsy shop, storefront
   (Shopify, Square, shop.com) or a public page that loads without logging in counts the same way.
   Record the address they publish; mark pickup arranged ahead as `pickup_by_appointment`.

## The call (about 3 minutes)

"Hi, I'm Chris. I'm putting together a free list of local print and laser shops for people who need
things fast. Can I check a few details so we list you correctly?"

| Ask | Records |
|---|---|
| Do you print DTF transfers? UV DTF? Laser engraving or cutting? Sublimation? Embroidery? | capabilities |
| If I order print-ready DTF today, what's the latest time to get it the same day? | `dtf_same_day_cutoff` |
| What do you charge per foot for a 22-inch DTF sheet? How wide can you print? | `dtf_price_per_foot_usd`, `dtf_price_note`, `dtf_max_width_in` |
| What file format do you want? | `dtf_file_requirements` |
| Laser: what kind of laser, what materials, and will you engrave items people bring in? | `laser_types`, `laser_materials`, `laser_customer_items` |
| Laser: typical turnaround, pricing, any minimum? | `laser_turnaround_note`, `laser_price_note`, `laser_min_order_note` |
| Can people walk in to pick up? Evenings or weekends? A 24/7 pickup box? | `pickup_*` |
| Do you stock blanks? Which brands? | `blanks_on_site`, `blanks_brands_note` |
| Do you ship, or local only? | `ships` |
| Are these your hours? (read them back) | `hours` |

Ask only the rows that fit the shop. Close with: "Thanks. Your page will show these details with
today's date. There's a link on it to tell us if anything changes, or you can claim the listing."

## After the call

1. Record a `phone_call` check with exactly the facts they confirmed and a short note.
2. Publish the listing.

A shop needs at least three verified facts in a site's angle to get its own page on that site, so a
call that covers one technology well is worth more than a quick yes or no on everything.

## Honesty rules

- Record only what they said. "It depends" or "usually" means leave the fact out and add a note.
- Never record a fact the shop didn't give and its site doesn't state.
- If they ask not to be listed, set the listing to `removed`. It comes off every site.
- Recheck every 180 days. Pages flag older facts on their own.
