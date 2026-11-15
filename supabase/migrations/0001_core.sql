-- Directory engine: core schema.
--
-- Model: a DATASET holds shared facts (listings, capabilities, metros, verification log).
-- A SITE is a filtered view over one dataset; its filter, pages and "angle" live in sites/<slug>.json.
-- Nothing public reads these tables at request time: the static build reads them with the service
-- role key, and public forms go through Edge Functions. So anon gets no access at all.

-- ------------------------------------------------------------------ helpers

create or replace function public.touch_updated_at() returns trigger
language plpgsql set search_path = public as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ------------------------------------------------------------------ datasets and vocab

create table public.datasets (
  id          uuid primary key default gen_random_uuid(),
  slug        text unique not null check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name        text not null,
  created_at  timestamptz not null default now()
);

create table public.capabilities (
  id          uuid primary key default gen_random_uuid(),
  dataset_id  uuid not null references public.datasets(id),
  slug        text not null check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name        text not null,
  unique (dataset_id, slug),
  unique (id, dataset_id)
);

create table public.metros (
  id          uuid primary key default gen_random_uuid(),
  dataset_id  uuid not null references public.datasets(id),
  slug        text not null check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name        text not null,
  state       text not null check (state ~ '^[A-Z]{2}$'),
  cities      text[] not null default '{}',
  unique (dataset_id, slug),
  unique (id, dataset_id)
);

-- What can be known about a listing in this dataset. A new niche adds rows here, not columns.
create table public.fact_defs (
  dataset_id  uuid not null references public.datasets(id),
  key         text not null check (key ~ '^[a-z][a-z0-9_]*$'),
  label       text not null,
  value_type  text not null check (value_type in ('text','boolean','number','time','hours','url')),
  fact_group  text not null,                 -- sites pick facts by key or by group for their angle
  sort        integer not null default 0,
  primary key (dataset_id, key)
);

-- ------------------------------------------------------------------ listings

create table public.listings (
  id                uuid primary key default gen_random_uuid(),
  dataset_id        uuid not null references public.datasets(id),
  slug              text not null check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name              text not null check (char_length(btrim(name)) > 0),
  status            text not null default 'draft' check (status in ('draft','published','removed')),
  place_id          text unique,             -- the ONLY value from Google ever stored
  address1          text,
  address2          text,
  city              text not null,
  state             text not null check (state ~ '^[A-Z]{2}$'),
  zip               text check (zip ~ '^[0-9]{5}$'),
  phone             text,
  website           text check (website ~ '^https?://'),
  lat               numeric(9,6),            -- ZIP centroid (GeoNames), never from Google
  lng               numeric(9,6),
  description       text check (char_length(description) <= 500),  -- owner-written only
  claimed_email     text,
  claimed_at        timestamptz,
  last_verified_at  date,                    -- kept current by trigger
  published_at      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),   -- sitemap lastmod comes from here
  unique (dataset_id, slug),
  unique (id, dataset_id)
);
create index listings_dataset_status on public.listings (dataset_id, status);

create table public.listing_capabilities (
  listing_id     uuid not null,
  capability_id  uuid not null,
  dataset_id     uuid not null,
  primary key (listing_id, capability_id),
  foreign key (listing_id, dataset_id) references public.listings (id, dataset_id),
  foreign key (capability_id, dataset_id) references public.capabilities (id, dataset_id)
);

create table public.listing_metros (
  listing_id  uuid not null,
  metro_id    uuid not null,
  dataset_id  uuid not null,
  is_primary  boolean not null default false,
  primary key (listing_id, metro_id),
  foreign key (listing_id, dataset_id) references public.listings (id, dataset_id),
  foreign key (metro_id, dataset_id) references public.metros (id, dataset_id)
);
create unique index listing_metros_one_primary on public.listing_metros (listing_id) where is_primary;

create table public.listing_facts (
  listing_id        uuid not null,
  dataset_id        uuid not null,
  key               text not null,
  value             jsonb not null,
  value_changed_at  timestamptz not null default now(),
  primary key (listing_id, key),
  foreign key (listing_id, dataset_id) references public.listings (id, dataset_id),
  foreign key (dataset_id, key) references public.fact_defs (dataset_id, key)
);

-- Fact values must match their declared type; a changed value restarts its verification clock.
create or replace function public.listing_facts_guard() returns trigger
language plpgsql set search_path = public as $$
declare
  v_type text;
  v_json text := jsonb_typeof(new.value);
  d record;
begin
  select value_type into v_type from public.fact_defs where dataset_id = new.dataset_id and key = new.key;
  if v_type is null then
    raise exception 'unknown fact key "%" for this dataset', new.key;
  end if;
  if v_type = 'boolean' and v_json <> 'boolean' then
    raise exception 'fact "%" must be true or false', new.key;
  elsif v_type = 'number' and v_json <> 'number' then
    raise exception 'fact "%" must be a number', new.key;
  elsif v_type in ('text','url','time') and v_json <> 'string' then
    raise exception 'fact "%" must be a string', new.key;
  elsif v_type = 'text' and char_length(btrim(new.value #>> '{}')) = 0 then
    raise exception 'fact "%" must not be empty; delete the fact if it is unknown', new.key;
  elsif v_type = 'time' and (new.value #>> '{}') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
    raise exception 'fact "%" must be HH:MM in 24-hour time', new.key;
  elsif v_type = 'url' and (new.value #>> '{}') !~ '^https?://' then
    raise exception 'fact "%" must be a full URL', new.key;
  elsif v_type = 'hours' then
    if v_json <> 'object' then
      raise exception 'fact "%" must be an object keyed mon..sun', new.key;
    end if;
    for d in select * from jsonb_each(new.value) loop
      if d.key not in ('mon','tue','wed','thu','fri','sat','sun') then
        raise exception 'fact "%": unknown day "%"', new.key, d.key;
      end if;
      if jsonb_typeof(d.value) = 'null' then
        continue;                           -- closed that day
      end if;
      if jsonb_typeof(d.value) <> 'object'
         or coalesce(d.value ->> 'open', '')  !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
         or coalesce(d.value ->> 'close', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
         or (d.value ->> 'open') >= (d.value ->> 'close') then
        raise exception 'fact "%": % must be null or {"open":"HH:MM","close":"HH:MM"} with open before close', new.key, d.key;
      end if;
    end loop;
  end if;

  if tg_op = 'UPDATE' and new.value is distinct from old.value then
    new.value_changed_at := now();
  elsif tg_op = 'UPDATE' then
    new.value_changed_at := old.value_changed_at;
  end if;
  return new;
end $$;

create trigger listing_facts_guard before insert or update on public.listing_facts
  for each row execute function public.listing_facts_guard();

-- ------------------------------------------------------------------ verification log (append-only)

create table public.verification_events (
  id            uuid primary key default gen_random_uuid(),
  listing_id    uuid not null references public.listings(id) on delete restrict,
  checked_at    date not null,
  method        text not null check (method in ('website','phone_call','site_visit','owner_submitted')),
  fact_keys     text[] not null check (cardinality(fact_keys) > 0),
  note          text,
  evidence_url  text check (evidence_url ~ '^https?://'),
  checked_by    text not null check (char_length(btrim(checked_by)) > 0),
  created_at    timestamptz not null default now()
);
create index verification_events_listing on public.verification_events (listing_id, checked_at desc);

-- Keys every listing has, outside fact_defs.
create or replace function public.core_fact_keys() returns text[]
language sql immutable as $$ select array['name','address','phone','website','capabilities','metros'] $$;

create or replace function public.verification_events_check() returns trigger
language plpgsql set search_path = public as $$
declare
  k text;
  v_dataset uuid;
begin
  if new.checked_at > current_date then
    raise exception 'checked_at cannot be in the future';
  end if;
  select dataset_id into v_dataset from public.listings where id = new.listing_id;
  foreach k in array new.fact_keys loop
    if k <> all (public.core_fact_keys())
       and not exists (select 1 from public.fact_defs where dataset_id = v_dataset and key = k) then
      raise exception '"%" is not a fact key for this dataset', k;
    end if;
  end loop;
  new.created_at := now();
  return new;
end $$;

create or replace function public.verification_events_sync() returns trigger
language plpgsql set search_path = public as $$
begin
  update public.listings
     set last_verified_at = greatest(coalesce(last_verified_at, new.checked_at), new.checked_at)
   where id = new.listing_id;
  return new;
end $$;

create or replace function public.forbid_change() returns trigger
language plpgsql set search_path = public as $$
begin
  raise exception '% is append-only: add a new row instead of changing or removing one', tg_table_name;
end $$;

create trigger verification_events_check before insert on public.verification_events
  for each row execute function public.verification_events_check();
create trigger verification_events_sync after insert on public.verification_events
  for each row execute function public.verification_events_sync();
create trigger verification_events_no_update before update or delete on public.verification_events
  for each row execute function public.forbid_change();
create trigger verification_events_no_truncate before truncate on public.verification_events
  for each statement execute function public.forbid_change();

-- ------------------------------------------------------------------ listing rules

create or replace function public.listings_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if new.status = 'published' then
      raise exception 'create the listing as a draft, log a check, then publish';
    end if;
    return new;
  end if;

  -- URLs must not change once a listing has been public.
  if old.published_at is not null and new.slug <> old.slug then
    raise exception 'slug cannot change after a listing has been published';
  end if;
  if new.dataset_id <> old.dataset_id then
    raise exception 'a listing cannot move between datasets';
  end if;

  if new.status = 'published' and old.status <> 'published' then
    if not exists (select 1 from public.verification_events where listing_id = new.id) then
      raise exception 'cannot publish "%": no verification event yet', new.slug;
    end if;
    if not exists (select 1 from public.listing_capabilities where listing_id = new.id) then
      raise exception 'cannot publish "%": no capabilities', new.slug;
    end if;
    if not exists (select 1 from public.listing_metros where listing_id = new.id) then
      raise exception 'cannot publish "%": no metro', new.slug;
    end if;
    new.published_at := coalesce(old.published_at, now());
  end if;

  new.updated_at := now();
  return new;
end $$;

create trigger listings_guard before insert or update on public.listings
  for each row execute function public.listings_guard();

-- Any change to a listing's facts, tags or metros counts as a change to the listing.
create or replace function public.touch_listing() returns trigger
language plpgsql set search_path = public as $$
begin
  update public.listings set updated_at = now()
   where id = coalesce(new.listing_id, old.listing_id);
  return coalesce(new, old);
end $$;

create trigger listing_facts_touch after insert or update or delete on public.listing_facts
  for each row execute function public.touch_listing();
create trigger listing_capabilities_touch after insert or delete on public.listing_capabilities
  for each row execute function public.touch_listing();
create trigger listing_metros_touch after insert or update or delete on public.listing_metros
  for each row execute function public.touch_listing();

-- ------------------------------------------------------------------ what a page may show

-- Latest check per listing and key (core keys and facts alike).
create view public.listing_key_checks with (security_invoker = true) as
select distinct on (e.listing_id, k.key)
       e.listing_id, k.key, e.checked_at, e.method
  from public.verification_events e
 cross join lateral unnest(e.fact_keys) as k(key)
 order by e.listing_id, k.key, e.checked_at desc, e.created_at desc;

-- Every fact with its verification state. A fact is verified only by a check logged at or after the
-- moment its current value was set, so editing a value un-verifies it until someone checks again.
create view public.listing_fact_status with (security_invoker = true) as
select f.listing_id, f.dataset_id, f.key, f.value, f.value_changed_at,
       c.checked_at, c.method,
       (c.checked_at is not null)                         as verified,
       coalesce(c.checked_at < current_date - 180, false) as stale
  from public.listing_facts f
  left join lateral (
        select e.checked_at, e.method
          from public.verification_events e
         where e.listing_id = f.listing_id
           and f.key = any (e.fact_keys)
           and e.created_at >= f.value_changed_at
         order by e.checked_at desc, e.created_at desc
         limit 1) c on true;

-- The only fact source the build may read: verified facts of published listings.
create view public.public_listing_facts with (security_invoker = true) as
select s.listing_id, s.dataset_id, s.key, s.value, s.checked_at, s.method, s.stale
  from public.listing_fact_status s
  join public.listings l on l.id = s.listing_id
 where s.verified and l.status = 'published';

-- Log a check and the facts it established, in one transaction.
--   p_facts      {"key": value, ...}  sets each fact; a JSON null deletes it (unknown)
--   p_confirmed  keys confirmed without a new value (core keys such as 'phone', or existing facts)
create or replace function public.record_check(
  p_listing      uuid,
  p_method       text,
  p_checked_by   text,
  p_facts        jsonb  default '{}'::jsonb,
  p_confirmed    text[] default '{}',
  p_checked_at   date   default current_date,
  p_note         text   default null,
  p_evidence_url text   default null
) returns uuid
language plpgsql set search_path = public as $$
declare
  v_dataset uuid;
  v_keys    text[] := coalesce(p_confirmed, '{}');
  v_id      uuid;
  f         record;
begin
  select dataset_id into v_dataset from public.listings where id = p_listing;
  if v_dataset is null then
    raise exception 'listing % not found', p_listing;
  end if;

  for f in select key, value from jsonb_each(coalesce(p_facts, '{}'::jsonb)) loop
    if jsonb_typeof(f.value) = 'null' then
      delete from public.listing_facts where listing_id = p_listing and key = f.key;
    else
      insert into public.listing_facts (listing_id, dataset_id, key, value)
      values (p_listing, v_dataset, f.key, f.value)
      on conflict (listing_id, key) do update set value = excluded.value;
      v_keys := array_append(v_keys, f.key);
    end if;
  end loop;

  select coalesce(array_agg(distinct k), '{}') into v_keys from unnest(v_keys) as k;
  if cardinality(v_keys) = 0 then
    raise exception 'a check must confirm at least one fact';
  end if;

  insert into public.verification_events (listing_id, checked_at, method, fact_keys, note, evidence_url, checked_by)
  values (p_listing, p_checked_at, p_method, v_keys, p_note, p_evidence_url, p_checked_by)
  returning id into v_id;
  return v_id;
end $$;

-- ------------------------------------------------------------------ sites and money

-- Identity only. Filter, pages, angle and branding live in sites/<slug>.json and are synced here.
create table public.sites (
  id          uuid primary key default gen_random_uuid(),
  slug        text unique not null check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  domain      text unique,
  name        text not null,
  dataset_id  uuid not null references public.datasets(id),
  created_at  timestamptz not null default now()
);

create table public.affiliate_programs (
  id                uuid primary key default gen_random_uuid(),
  slug              text unique not null check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name              text not null,
  program_url       text check (program_url ~ '^https?://'),
  commission_note   text,
  -- Facts shown on ship-to-you pages, read off the supplier's own site, with the date they were read.
  cutoff_note       text,
  price_note        text,
  facts_checked_at  date,
  check ((cutoff_note is null and price_note is null) or facts_checked_at is not null)
);

-- Approval and tracking links are per site: networks approve each website separately.
create table public.site_affiliates (
  site_id     uuid not null references public.sites(id),
  program_id  uuid not null references public.affiliate_programs(id),
  status      text not null default 'apply' check (status in ('apply','applied','approved','rejected','paused')),
  url         text check (url ~ '^https://'),
  placements  text[] not null default '{}',
  primary key (site_id, program_id),
  check (status <> 'approved' or url is not null)
);

create table public.clicks (
  id          bigint generated always as identity primary key,
  site_id     uuid not null references public.sites(id),
  kind        text not null check (kind in ('affiliate','website','call','directions','claim_cta')),
  listing_id  uuid references public.listings(id),
  program_id  uuid references public.affiliate_programs(id),
  page_path   text check (char_length(page_path) <= 300),
  created_at  timestamptz not null default now()
);
create index clicks_site_time on public.clicks (site_id, created_at desc);

-- ------------------------------------------------------------------ public submissions

create table public.claims (
  id             uuid primary key default gen_random_uuid(),
  dataset_id     uuid not null references public.datasets(id),
  site_id        uuid references public.sites(id),
  listing_id     uuid references public.listings(id),      -- null = a shop we don't list yet
  contact_email  text not null check (contact_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and char_length(contact_email) <= 320),
  payload        jsonb not null check (octet_length(payload::text) <= 16000),
  status         text not null default 'pending' check (status in ('pending','approved','rejected')),
  created_at     timestamptz not null default now(),
  decided_at     timestamptz
);

create table public.corrections (
  id          uuid primary key default gen_random_uuid(),
  listing_id  uuid not null references public.listings(id),
  site_id     uuid references public.sites(id),
  detail      text not null check (char_length(btrim(detail)) between 5 and 2000),
  status      text not null default 'open' check (status in ('open','done','dismissed')),
  created_at  timestamptz not null default now()
);

-- Flood guards in the database, so no caller can skip them. Errors start with "rate_limited".
create or replace function public.corrections_rate_limit() returns trigger
language plpgsql set search_path = public as $$
begin
  if (select count(*) from public.corrections where created_at > now() - interval '1 hour') >= 30 then
    raise exception 'rate_limited: too many reports this hour';
  end if;
  if exists (select 1 from public.corrections
              where created_at > now() - interval '1 day' and lower(btrim(detail)) = lower(btrim(new.detail))) then
    raise exception 'rate_limited: duplicate report';
  end if;
  return new;
end $$;
create trigger corrections_rate_limit before insert on public.corrections
  for each row execute function public.corrections_rate_limit();

create or replace function public.claims_rate_limit() returns trigger
language plpgsql set search_path = public as $$
begin
  if (select count(*) from public.claims where created_at > now() - interval '1 hour') >= 20 then
    raise exception 'rate_limited: too many claims this hour';
  end if;
  if exists (select 1 from public.claims
              where created_at > now() - interval '1 day'
                and lower(contact_email) = lower(new.contact_email)
                and listing_id is not distinct from new.listing_id
                and status = 'pending') then
    raise exception 'rate_limited: this claim is already waiting for review';
  end if;
  return new;
end $$;
create trigger claims_rate_limit before insert on public.claims
  for each row execute function public.claims_rate_limit();

-- Discovery queue. Place ID only; no other Google content is ever stored.
create table public.candidates (
  id             uuid primary key default gen_random_uuid(),
  dataset_id     uuid not null references public.datasets(id),
  place_id       text not null,
  query          text,
  status         text not null default 'new' check (status in ('new','added','rejected')),
  discovered_at  timestamptz not null default now(),
  unique (dataset_id, place_id)
);

-- ------------------------------------------------------------------ access

create table public.admins (
  user_id     uuid primary key,              -- auth.users.id
  created_at  timestamptz not null default now()
);

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins where user_id = auth.uid())
$$;

do $$
declare
  t text;
begin
  foreach t in array array[
    'datasets','capabilities','metros','fact_defs','listings','listing_capabilities','listing_metros',
    'listing_facts','verification_events','sites','affiliate_programs','site_affiliates','clicks',
    'claims','corrections','candidates','admins']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
    -- Signed-in admins (the admin app) get full access; nobody else gets any.
    if t <> 'admins' then
      execute format(
        'create policy admin_all on public.%I for all to authenticated using (public.is_admin()) with check (public.is_admin())', t);
    end if;
  end loop;
end $$;

create policy admin_read_self on public.admins for select to authenticated using (user_id = auth.uid());

revoke all on public.listing_key_checks, public.listing_fact_status, public.public_listing_facts from anon;
revoke execute on function public.record_check(uuid, text, text, jsonb, text[], date, text, text) from public, anon;
grant execute on function public.record_check(uuid, text, text, jsonb, text[], date, text, text) to authenticated, service_role;
