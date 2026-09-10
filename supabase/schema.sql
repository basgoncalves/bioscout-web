-- BioScout accounts and private sync (stage 2).
--
-- Two tables:
--   accounts  one row per login: username, display name, open/private.
--   records   every synced log entry, one row per (owner, kind, rid), exactly the
--             identities src/syncmeta.js already uses on the device. A deletion
--             is a row with deleted = true, so it syncs like any other change.
--
-- Nothing in `records` is readable by anyone but its owner (row-level security);
-- health records never leave `records`, and `records` is never shared. The
-- feed has its own table, `posts`, at the end of this file.
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
                                           'water','coffee','cardio','reaction','profiles',
                                           'sessions','ledger','assessments')),
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
language plpgsql set search_path = '' as $$
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
  -- A username that is malformed or taken is left out rather than allowed to
  -- fail the sign-up itself: the login matters more than the handle.
  insert into public.accounts (id, username, display_name)
  values (new.id,
          case when lower(new.raw_user_meta_data ->> 'username') ~ '^[a-z0-9_.]{3,24}$'
                and not exists (select 1 from public.accounts a
                                where a.username = lower(new.raw_user_meta_data ->> 'username'))
               then lower(new.raw_user_meta_data ->> 'username') end,
          left(nullif(new.raw_user_meta_data ->> 'display_name', ''), 60))
  on conflict (id) do nothing;
  return new;
end $$;
revoke execute on function public.new_account() from public, anon, authenticated;
revoke execute on function public.records_lww() from public, anon, authenticated;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.new_account();

alter table public.accounts enable row level security;
alter table public.records  enable row level security;

drop policy if exists "own account: read"   on public.accounts;
drop policy if exists "open accounts: read" on public.accounts;
drop policy if exists "own or open account: read" on public.accounts;
drop policy if exists "own account: update" on public.accounts;
-- (select auth.uid()) rather than auth.uid(): evaluated once per query, not per row.
-- Your own row, and an OPEN account's name to anyone signed in (it is printed
-- on that account's posts). One policy, not two: two permissive policies on
-- the same action are both evaluated for every row.
create policy "own or open account: read" on public.accounts for select to authenticated
  using (id = (select auth.uid()) or visibility = 'open');
create policy "own account: update" on public.accounts for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

drop policy if exists "own records" on public.records;
create policy "own records" on public.records for all to authenticated
  using (owner = (select auth.uid())) with check (owner = (select auth.uid()));

-- Delete my account: the signed-in person removes their login, their account
-- row and every synced record, in one call from the app (both app stores
-- require in-app deletion for apps that let people create an account).
-- Security definer because a user cannot delete from auth.users themselves;
-- it only ever touches auth.uid(), the caller.
create or replace function public.delete_my_account() returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  delete from public.records  where owner = uid;
  delete from public.accounts where id = uid;
  delete from auth.users      where id = uid;
end $$;
revoke execute on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;

-- Posts: a set shared to the BioScout feed (a picture or a short clip and up to
-- 42 characters). The media sits in the private storage bucket "posts", under
-- <owner uuid>/..., so the folder name alone says whose it is.
--
-- Who sees a post: its owner always; everyone signed in when the owner's
-- account is open; and friends (see the end of this file), private or not. Health records never come here -- a post carries
-- only what the person chose to put on it.

create table if not exists public.posts (
  id          uuid primary key default gen_random_uuid(),
  owner       uuid not null default auth.uid() references public.accounts (id) on delete cascade,
  body        text not null default '' check (char_length(body) <= 42),
  media_path  text check (media_path is null or
                          (split_part(media_path, '/', 1) = owner::text and char_length(media_path) <= 200)),
  media_type  text check (media_type in ('image', 'video')),
  meta        jsonb check (meta is null or pg_column_size(meta) <= 2000),
  created_at  timestamptz not null default now(),
  check ((media_path is null) = (media_type is null)),
  check (media_path is not null or char_length(body) > 0)
);
create index if not exists posts_recent on public.posts (created_at desc);
create index if not exists posts_owner  on public.posts (owner, created_at desc);

alter table public.posts enable row level security;

drop policy if exists "posts: read own or open" on public.posts;
drop policy if exists "posts: write own"        on public.posts;
drop policy if exists "posts: delete own"       on public.posts;
create policy "posts: read own or open" on public.posts for select to authenticated
  using (owner = (select auth.uid())
         or exists (select 1 from public.accounts a where a.id = posts.owner and a.visibility = 'open'));
create policy "posts: write own" on public.posts for insert to authenticated
  with check (owner = (select auth.uid()));
create policy "posts: delete own" on public.posts for delete to authenticated
  using (owner = (select auth.uid()));

-- The bucket: private (no public URLs), 25 MB a file, pictures and clips only
-- (quicktime: an iPhone video picked from the gallery for a post).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('posts', 'posts', false, 26214400,
        array['image/jpeg', 'image/png', 'video/mp4', 'video/webm', 'video/quicktime'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
                               allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "posts media: read own or open" on storage.objects;
drop policy if exists "posts media: upload own"       on storage.objects;
drop policy if exists "posts media: delete own"       on storage.objects;
create policy "posts media: read own or open" on storage.objects for select to authenticated
  using (bucket_id = 'posts' and (
           (storage.foldername(name))[1] = (select auth.uid())::text
           or exists (select 1 from public.accounts a
                      where a.id::text = (storage.foldername(name))[1] and a.visibility = 'open')));
create policy "posts media: upload own" on storage.objects for insert to authenticated
  with check (bucket_id = 'posts' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "posts media: delete own" on storage.objects for delete to authenticated
  using (bucket_id = 'posts' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- ============================================================================
-- Friends, a username for everyone, and reaction tests in the sync.
--
-- Friends are mutual: one person asks, the other accepts. A friend sees your
-- posts (and their pictures and clips) even when your account is private, and
-- sees your username and display name. Nothing else: `records` -- every
-- health and training log -- stays owner-only, friends or not.
--
-- The table is only ever changed through the functions below (security
-- definer, each acting for auth.uid() alone), so the rules -- one row per
-- pair, only the person asked can accept, either can end it -- live in one
-- place instead of in four RLS policies.

-- Reaction-time tests (src/reaction.js) sync like any other record.
alter table public.records drop constraint if exists records_kind_check;
alter table public.records add constraint records_kind_check
  check (kind in ('meals','diary','weights','cycle','sleep','vitals','water','coffee','cardio',
                  'reaction','profiles','sessions','ledger','assessments'));

-- A username is chosen once. Username-password logins sign in WITH it
-- (<name>@users.bioscout.invalid), so changing it would lock them out; and a
-- handle people found you by should not quietly become someone else's.
create or replace function public.accounts_username_once() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.username is not null and new.username is distinct from old.username then
    raise exception 'username cannot be changed' using errcode = '42501';
  end if;
  new.username := lower(new.username);
  return new;
end $$;
revoke execute on function public.accounts_username_once() from public, anon, authenticated;
drop trigger if exists accounts_username_once on public.accounts;
create trigger accounts_username_once before update on public.accounts
  for each row execute function public.accounts_username_once();

create table if not exists public.friendships (
  requester   uuid not null references public.accounts (id) on delete cascade,
  addressee   uuid not null references public.accounts (id) on delete cascade,
  status      text not null default 'pending' check (status in ('pending', 'accepted')),
  created_at  timestamptz not null default now(),
  accepted_at timestamptz,
  primary key (requester, addressee),
  check (requester <> addressee)
);
-- One row per PAIR, whichever of the two asked.
create unique index if not exists friendships_pair
  on public.friendships (least(requester, addressee), greatest(requester, addressee));
create index if not exists friendships_addressee on public.friendships (addressee);

alter table public.friendships enable row level security;
drop policy if exists "friendships: read own" on public.friendships;
create policy "friendships: read own" on public.friendships for select to authenticated
  using (requester = (select auth.uid()) or addressee = (select auth.uid()));
-- No insert/update/delete policies: changes go through the functions below.

-- Is `other` my friend (accepted)? Used by the posts and media policies.
create or replace function public.is_friend(other uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.friendships f
                 where f.status = 'accepted'
                   and ((f.requester = (select auth.uid()) and f.addressee = other)
                     or (f.addressee = (select auth.uid()) and f.requester = other)));
$$;
-- Any link, a request either way included: enough to see each other's name.
create or replace function public.is_linked(other uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.friendships f
                 where (f.requester = (select auth.uid()) and f.addressee = other)
                    or (f.addressee = (select auth.uid()) and f.requester = other));
$$;
revoke execute on function public.is_friend(uuid) from public, anon;
revoke execute on function public.is_linked(uuid) from public, anon;
grant execute on function public.is_friend(uuid) to authenticated;
grant execute on function public.is_linked(uuid) to authenticated;

-- Names: your own, open accounts', and anyone you are linked to.
drop policy if exists "own or open account: read" on public.accounts;
create policy "own or open account: read" on public.accounts for select to authenticated
  using (id = (select auth.uid()) or visibility = 'open' or public.is_linked(id));

-- Posts: your own, open accounts', and your friends'.
drop policy if exists "posts: read own or open" on public.posts;
create policy "posts: read own or open" on public.posts for select to authenticated
  using (owner = (select auth.uid())
         or exists (select 1 from public.accounts a where a.id = posts.owner and a.visibility = 'open')
         or public.is_friend(owner));

drop policy if exists "posts media: read own or open" on storage.objects;
create policy "posts media: read own or open" on storage.objects for select to authenticated
  using (bucket_id = 'posts' and (
           (storage.foldername(name))[1] = (select auth.uid())::text
           or exists (select 1 from public.accounts a
                      where a.id::text = (storage.foldername(name))[1]
                        and (a.visibility = 'open' or public.is_friend(a.id)))));

-- Search by username: the start of a handle, two characters at least, twenty
-- results. Returns only the handle and display name -- the two things a
-- person needs to recognise someone -- whatever the account's visibility.
create or replace function public.search_accounts(q text)
returns table (id uuid, username text, display_name text)
language plpgsql stable security definer set search_path = '' as $$
declare s text := lower(trim(both from coalesce(q, '')));
begin
  if (select auth.uid()) is null then raise exception 'not signed in' using errcode = '28000'; end if;
  s := ltrim(s, '@');
  if char_length(s) < 2 then return; end if;
  return query
    select a.id, a.username, a.display_name from public.accounts a
    where a.username is not null and left(a.username, char_length(s)) = s
      and a.id <> (select auth.uid())
    order by a.username limit 20;
end $$;

-- Ask someone by username. If they had already asked you, this accepts.
-- Returns what happened: sent | accepted | already_sent | already_friends |
-- not_found | self | too_many.
create or replace function public.request_friend(p_username text) returns text
language plpgsql security definer set search_path = '' as $$
declare me uuid := (select auth.uid()); them uuid; st text; req uuid;
begin
  if me is null then raise exception 'not signed in' using errcode = '28000'; end if;
  select a.id into them from public.accounts a
   where a.username = lower(ltrim(trim(both from coalesce(p_username, '')), '@'));
  if them is null then return 'not_found'; end if;
  if them = me then return 'self'; end if;
  select f.status, f.requester into st, req from public.friendships f
   where (f.requester = me and f.addressee = them) or (f.requester = them and f.addressee = me);
  if st = 'accepted' then return 'already_friends'; end if;
  if st = 'pending' and req = me then return 'already_sent'; end if;
  if st = 'pending' and req = them then
    update public.friendships set status = 'accepted', accepted_at = now()
     where requester = them and addressee = me;
    return 'accepted';
  end if;
  if (select count(*) from public.friendships f where f.requester = me and f.status = 'pending') >= 100 then
    return 'too_many';
  end if;
  insert into public.friendships (requester, addressee) values (me, them);
  return 'sent';
end $$;

-- Accept (or decline) a request someone sent you.
create or replace function public.respond_friend(p_other uuid, p_accept boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare me uuid := (select auth.uid());
begin
  if me is null then raise exception 'not signed in' using errcode = '28000'; end if;
  if p_accept then
    update public.friendships set status = 'accepted', accepted_at = now()
     where requester = p_other and addressee = me and status = 'pending';
  else
    delete from public.friendships where requester = p_other and addressee = me and status = 'pending';
  end if;
end $$;

-- End it from either side: unfriend, or take back a request you sent.
create or replace function public.remove_friend(p_other uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare me uuid := (select auth.uid());
begin
  if me is null then raise exception 'not signed in' using errcode = '28000'; end if;
  delete from public.friendships
   where (requester = me and addressee = p_other) or (requester = p_other and addressee = me);
end $$;

-- Everyone you are linked to, with the state of the link.
create or replace function public.my_friends()
returns table (id uuid, username text, display_name text, status text, outgoing boolean, since timestamptz)
language sql stable security definer set search_path = '' as $$
  select a.id, a.username, a.display_name, f.status, f.requester = (select auth.uid()),
         coalesce(f.accepted_at, f.created_at)
  from public.friendships f
  join public.accounts a on a.id = case when f.requester = (select auth.uid()) then f.addressee else f.requester end
  where (select auth.uid()) in (f.requester, f.addressee)
  order by f.status, a.username;
$$;

revoke execute on function public.search_accounts(text) from public, anon;
revoke execute on function public.request_friend(text) from public, anon;
revoke execute on function public.respond_friend(uuid, boolean) from public, anon;
revoke execute on function public.remove_friend(uuid) from public, anon;
revoke execute on function public.my_friends() from public, anon;
grant execute on function public.search_accounts(text) to authenticated;
grant execute on function public.request_friend(text) to authenticated;
grant execute on function public.respond_friend(uuid, boolean) to authenticated;
grant execute on function public.remove_friend(uuid) to authenticated;
grant execute on function public.my_friends() to authenticated;
