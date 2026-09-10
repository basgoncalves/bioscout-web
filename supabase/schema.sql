-- BioScout accounts and private sync (stage 2).
--
-- Two tables:
--   accounts  one row per login: username, display name, open/private.
--   records   every synced log entry, one row per (owner, kind, rid), exactly the
--             identities src/syncmeta.js already uses on the device. A deletion
--             is a row with deleted = true, so it syncs like any other change.
--
-- Nothing here is readable by anyone but its owner (row-level security). The
-- public profile and feed (stage 3) will get their own tables and policies;
-- health records never leave `records`, and `records` is never shared.
--
-- Safe to run more than once.

create table if not exists public.accounts (
  id           uuid primary key references auth.users (id) on delete cascade,
  username     text unique check (username ~ '^[a-z0-9_.]{3,24}$'),
  display_name text check (char_length(display_name) <= 60),
  visibility   text not null default 'private' check (visibility in ('private', 'open')),
  created_at   timestamptz not null default now()
);

create table if not exists public.records (
  owner      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kind       text not null check (kind in ('meals','diary','weights','cycle','sleep','vitals',
                                           'water','coffee','cardio','profiles','sessions',
                                           'ledger','assessments')),
  rid        text not null check (char_length(rid) <= 200),
  data       jsonb,                                   -- null for a deletion
  u          text not null,                           -- device's last-write time, ISO
  deleted    boolean not null default false,
  server_at  timestamptz not null default clock_timestamp(),
  primary key (owner, kind, rid)
);
create index if not exists records_pull on public.records (owner, server_at);

-- Last writer wins, on the server too: an upsert carrying an older (or the
-- same) `u` than the stored row is dropped, so two devices pushing in either
-- order end with the same row. server_at is the pull cursor, always server time.
create or replace function public.records_lww() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    if new.u <= old.u then return null; end if;      -- keep the newer row
    new.owner := old.owner;                           -- never re-owned
  end if;
  new.server_at := clock_timestamp();
  return new;
end $$;

drop trigger if exists records_lww on public.records;
create trigger records_lww before insert or update on public.records
  for each row execute function public.records_lww();

-- An account row appears with the login. The username comes from sign-up
-- metadata; an email-only sign-up gets none until one is chosen.
create or replace function public.new_account() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.accounts (id, username, display_name)
  values (new.id,
          nullif(lower(new.raw_user_meta_data ->> 'username'), ''),
          nullif(new.raw_user_meta_data ->> 'display_name', ''))
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.new_account();

-- Is a username free? Callable before signing in, answers only yes/no.
create or replace function public.username_available(name text) returns boolean
language sql stable security definer set search_path = public as $$
  select not exists (select 1 from public.accounts where username = lower(name));
$$;
grant execute on function public.username_available(text) to anon, authenticated;

alter table public.accounts enable row level security;
alter table public.records  enable row level security;

drop policy if exists "own account: read"   on public.accounts;
drop policy if exists "own account: update" on public.accounts;
create policy "own account: read"   on public.accounts for select using (id = auth.uid());
create policy "own account: update" on public.accounts for update using (id = auth.uid())
  with check (id = auth.uid());

drop policy if exists "own records" on public.records;
create policy "own records" on public.records for all
  using (owner = auth.uid()) with check (owner = auth.uid());
