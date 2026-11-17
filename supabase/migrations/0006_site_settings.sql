-- Site settings edited in the admin app (D31): the parts of a site that change without a code
-- change. A set column wins over sites/<slug>.json at build time; null keeps the file's value.
-- Structure (dataset, angle, metros, affiliates, index gates) stays in the site file.
--
-- The theme is stored as the text Chris pastes (a Tailwind config and its CSS). It is read as data
-- by @directory-engine/core and never run, in the admin app or in the build.

create table public.site_settings (
  site_id         uuid primary key references public.sites(id) on delete cascade,
  name            text check (name is null or (length(btrim(name)) between 1 and 80)),
  operator_name   text check (operator_name is null or (length(btrim(operator_name)) between 1 and 120)),
  operator_email  text check (operator_email is null or operator_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  theme_config    text check (theme_config is null or length(theme_config) <= 50000),
  theme_css       text check (theme_css is null or length(theme_css) <= 50000),
  updated_at      timestamptz not null default now(),
  updated_by      uuid default auth.uid(),
  check (operator_email is null or operator_name is not null)
);

create or replace function public.touch_site_settings() returns trigger
language plpgsql set search_path = public as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end $$;

create trigger site_settings_touch before update on public.site_settings
  for each row execute function public.touch_site_settings();

alter table public.site_settings enable row level security;
revoke all on public.site_settings from anon;
-- Signed-in admins (the admin app) read and write; the build reads with the service role.
create policy admin_all on public.site_settings for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
