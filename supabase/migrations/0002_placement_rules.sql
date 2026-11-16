-- T18: affiliate placements limited to some metros and/or capabilities.
--
-- `placements` keeps the placement names (what the admin app shows). `placement_rules` holds the full
-- config entries from sites/<slug>.json, each as {"placement": ..., "metros"?: [...], "capabilities"?: [...]};
-- a plain name in the config is stored as {"placement": name}. sync-sites writes both; pages read
-- placements from the config files at build time, not from here.
alter table public.site_affiliates
  add column placement_rules jsonb not null default '[]'::jsonb
    check (jsonb_typeof(placement_rules) = 'array');

-- Existing rows: every placement applied to the whole site.
update public.site_affiliates
   set placement_rules = coalesce((select jsonb_agg(jsonb_build_object('placement', p)) from unnest(placements) p), '[]'::jsonb);
