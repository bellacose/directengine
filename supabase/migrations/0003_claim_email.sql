-- T19: email confirmation for owner claims.
--
-- When a claim is submitted, the submit-claim function emails its contact address a single-use link
-- that expires after 7 days. Opening it marks the claim email_confirmed with a timestamp. Nothing else
-- changes: confirming never publishes a listing, records a check or touches a fact.
--
-- - The token itself is never stored. The function keeps a SHA-256 hash (64 hex characters), and the
--   check on token_hash refuses anything else, so a raw token can't be saved here by mistake.
-- - The only way to confirm is confirm_claim_email(hash): no claim ID goes in, so a claim can't be
--   confirmed by guessing one. Only the service role (the Edge Functions) may call it.
-- - Approving a claim whose email isn't confirmed needs approved_without_email = true in the same
--   update: the admin app's explicit override, kept on the claim as a record of it.

alter table public.claims
  add column email_confirmed_at     timestamptz,
  add column email_confirmed        boolean generated always as (email_confirmed_at is not null) stored,
  add column approved_without_email boolean not null default false;

create table public.claim_email_tokens (
  id          uuid primary key default gen_random_uuid(),
  claim_id    uuid not null unique references public.claims(id),   -- one link per claim
  token_hash  text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '7 days',
  used_at     timestamptz,
  check (expires_at > created_at and expires_at <= created_at + interval '7 days')
);

-- Service role only: no policy, so signed-in admins get nothing either (they don't need hashes).
alter table public.claim_email_tokens enable row level security;
revoke all on public.claim_email_tokens from anon, authenticated;

-- Confirmation state is set once, only by confirm_claim_email (not even an admin can set it by hand),
-- and never cleared or moved.
create or replace function public.claims_email_rules() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if new.email_confirmed_at is not null then
      raise exception 'a new claim cannot already be email-confirmed';
    end if;
    if new.approved_without_email then
      raise exception 'a new claim cannot already be approved';
    end if;
    return new;
  end if;
  if old.email_confirmed_at is not null and new.email_confirmed_at is distinct from old.email_confirmed_at then
    raise exception 'email confirmation cannot be changed once set';
  end if;
  if old.email_confirmed_at is null and new.email_confirmed_at is not null
     and coalesce(current_setting('app.claim_email_confirm', true), '') <> 'on' then
    raise exception 'email confirmation is set only by confirm_claim_email()';
  end if;
  if new.status = 'approved' and old.status <> 'approved'
     and new.email_confirmed_at is null and not new.approved_without_email then
    raise exception 'email_not_confirmed: approving this claim needs the unconfirmed-email override';
  end if;
  return new;
end $$;
create trigger claims_email_rules before insert or update on public.claims
  for each row execute function public.claims_email_rules();

-- Marks the claim whose unused, unexpired token has this hash; true if it did. A used, expired or
-- unknown hash does nothing and returns false. Single use holds under concurrency: the update locks
-- the token row, and a second caller re-checks used_at after the first commits.
create or replace function public.confirm_claim_email(p_token_hash text) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_claim uuid;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    return false;
  end if;
  update public.claim_email_tokens set used_at = now()
   where token_hash = p_token_hash and used_at is null and expires_at > now()
   returning claim_id into v_claim;
  if v_claim is null then
    return false;
  end if;
  perform set_config('app.claim_email_confirm', 'on', true);
  update public.claims set email_confirmed_at = now() where id = v_claim and email_confirmed_at is null;
  perform set_config('app.claim_email_confirm', '', true);
  return true;
end $$;
revoke all on function public.confirm_claim_email(text) from public, anon, authenticated;
grant execute on function public.confirm_claim_email(text) to service_role;
