-- ═══════════════════════════════════════════════════════════════════════════
-- TGIS database security
-- Run each step on its own in Supabase → SQL Editor, in order.
-- Tables the app uses: guides, tours, tracker, forms, special_requests.
-- ═══════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 1 — Look before changing anything (read-only). Run each query ON ITS
-- OWN (the SQL Editor only shows the last result when several run together).
-- ───────────────────────────────────────────────────────────────────────────

-- 1. One-shot overview: every table, whether RLS is on, and its policies
select c.relname as table_name,
       c.relrowsecurity as rls_on,
       coalesce((select string_agg(p.policyname || ' [' || p.cmd || ' → ' || array_to_string(p.roles, ',') || ']', '; ')
                 from pg_policies p
                 where p.schemaname = 'public' and p.tablename = c.relname), '— none —') as policies
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
order by 1;

-- 1a. Which tables have row-level security (RLS) turned on
select c.relname as table_name, c.relrowsecurity as rls_on
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
order by 1;

-- 1b. What the public key (anon) and signed-in users (authenticated) may do
select table_name, grantee, string_agg(privilege_type, ', ' order by privilege_type) as privileges
from information_schema.role_table_grants
where table_schema = 'public' and grantee in ('anon', 'authenticated')
group by 1, 2
order by 1, 2;

-- 1c. Existing RLS policies
select tablename, policyname, roles, cmd
from pg_policies
where schemaname = 'public'
order by 1, 2;


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 2 — Safe to run now. Tightens what SIGNED-IN users can do; does not
-- touch the public key, so Apps Script keeps working exactly as before.
-- (The live site on main doesn't use Supabase at all — only Apps Script and
-- the new app do.)
-- ───────────────────────────────────────────────────────────────────────────

-- Is the signed-in Slack user an actual guide? (security definer so policies
-- on guides can call it without recursing into themselves)
create or replace function public.is_guide()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.guides
    where lower(trim(email)) = lower(auth.jwt() ->> 'email')
  );
$$;

-- The signed-in guide's own full profile (including dietary), matched on the
-- email inside their verified login token — the app can't ask for anyone else's.
create or replace function public.get_my_guide()
returns setof public.guides
language sql stable security definer set search_path = public
as $$
  select * from public.guides
  where lower(trim(email)) = lower(auth.jwt() ->> 'email')
  limit 1;
$$;

revoke all on function public.is_guide()     from public, anon;
revoke all on function public.get_my_guide() from public, anon;
grant execute on function public.is_guide()     to authenticated;
grant execute on function public.get_my_guide() to authenticated;

-- Signed-in users are read-only (the app never writes).
revoke insert, update, delete, truncate, references, trigger
  on public.guides, public.tours, public.tracker, public.forms, public.special_requests
  from authenticated;
grant select on public.tours, public.tracker, public.forms, public.special_requests to authenticated;

-- Everyone's guides row is readable EXCEPT dietary (that comes from get_my_guide).
revoke select on public.guides from authenticated;
do $$
declare cols text;
begin
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position) into cols
  from information_schema.columns
  where table_schema = 'public' and table_name = 'guides' and column_name <> 'dietary';
  execute format('grant select (%s) on public.guides to authenticated', cols);
end $$;

-- Read policy for signed-in users: only people who are actually guides
-- (a Slack member with no guides row gets nothing). Applies wherever RLS is on.
do $$
declare t text;
begin
  foreach t in array array['guides','tours','tracker','forms','special_requests'] loop
    execute format('drop policy if exists "Signed-in guides can read" on public.%I', t);
    execute format('create policy "Signed-in guides can read" on public.%I for select to authenticated using (public.is_guide())', t);
  end loop;
end $$;


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 2b — Roster for codirectors and admins (safe to run any time after
-- step 2). Returns every guide's full row, dietary included, but only when the
-- caller's own guides row has one of these statuses. Keep this list in sync
-- with ROSTER_ROLES in index.html.
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.get_roster()
returns setof public.guides
language sql stable security definer set search_path = public
as $$
  select g.* from public.guides g
  where exists (
    select 1 from public.guides me
    where lower(trim(me.email)) = lower(auth.jwt() ->> 'email')
      and me.status in ('Codirector', 'Admin')
  )
  order by g.display_name;
$$;

revoke all on function public.get_roster() from public, anon;
grant execute on function public.get_roster() to authenticated;


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 2c — Make sure the server-only service_role key has full access. This
-- project's default grants were changed at some point, so service_role (used by
-- the slack-import Edge Function, and by Apps Script after step 3) can get
-- "permission denied". It never reaches the browser, so this is safe.
-- ───────────────────────────────────────────────────────────────────────────

grant usage on schema public to service_role;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant all on sequences to service_role;


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 2d — Lets apps-script/tracker-sync.gs update tracker rows in place
-- (matched on display_name). If this errors with "could not create unique
-- index", two tracker rows share a display_name — find them with:
--   select display_name, count(*) from tracker group by 1 having count(*) > 1;
-- ───────────────────────────────────────────────────────────────────────────

create unique index if not exists tracker_display_name_key on public.tracker (display_name);


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 2e — Sign-in codes sent by Slack DM (supabase/functions/slack-code).
-- Only the Edge Function (service_role) touches this table; RLS on with no
-- policies, and no grants, keeps it invisible to the browser.
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists public.login_codes (
  email      text primary key,
  code_hash  text not null,
  expires_at timestamptz not null,
  attempts   int not null default 0,
  created_at timestamptz not null default now()
);
alter table public.login_codes enable row level security;
revoke all on public.login_codes from anon, authenticated;
grant all on public.login_codes to service_role;


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 2f — Profile editing. Signed-in users stay read-only on the tables; these
-- two functions are the only way the app writes to guides.
--   update_my_profile(patch)              a guide edits a safe set of their OWN fields
--   admin_update_guide(username, patch)   codirectors/admins edit any guide's fields
-- `patch` is a JSON object of column → new value; unknown or disallowed keys are
-- ignored, values are converted to each column's type, and null clears a field.
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.update_my_profile(patch jsonb)
returns setof public.guides
language plpgsql security definer set search_path = public
as $$
declare
  -- Keep in sync with PROFILE_SELF_FIELDS in index.html
  allowed text[] := array['major','minor','certificate','college','grad_date','year','hometown','dietary'];
  me text := lower(auth.jwt() ->> 'email');
  sets text;
begin
  if me is null then raise exception 'Not signed in'; end if;
  select string_agg(format('%I = r.%I', c.column_name, c.column_name), ', ') into sets
  from information_schema.columns c
  where c.table_schema = 'public' and c.table_name = 'guides'
    and c.column_name = any(allowed) and patch ? c.column_name;
  if sets is null then raise exception 'Nothing to update'; end if;
  execute format('update public.guides g set %s from jsonb_populate_record(null::public.guides, $1) r
                  where lower(trim(g.email)) = $2', sets) using patch, me;
  return query select * from public.guides where lower(trim(email)) = me limit 1;
end $$;

create or replace function public.admin_update_guide(target_username text, patch jsonb)
returns setof public.guides
language plpgsql security definer set search_path = public
as $$
declare
  blocked text[] := array['id','username','slack_photo','created_at','updated_at'];
  roles   text[] := array['Tour Guide','Manager','Codirector','Admin','Boss','Retired'];
  sets text;
  n int;
begin
  if not exists (select 1 from public.guides me
                 where lower(trim(me.email)) = lower(auth.jwt() ->> 'email')
                   and me.status in ('Codirector', 'Admin')) then
    raise exception 'Codirectors and admins only';
  end if;
  if patch ? 'status' and not (patch ->> 'status' = any(roles)) then
    raise exception 'Unknown role: %', patch ->> 'status';
  end if;
  select string_agg(format('%I = r.%I', c.column_name, c.column_name), ', ') into sets
  from information_schema.columns c
  where c.table_schema = 'public' and c.table_name = 'guides'
    and not (c.column_name = any(blocked)) and patch ? c.column_name;
  if sets is null then raise exception 'Nothing to update'; end if;
  execute format('update public.guides g set %s from jsonb_populate_record(null::public.guides, $1) r
                  where g.username = $2', sets) using patch, target_username;
  get diagnostics n = row_count;
  if n = 0 then raise exception 'No guide with username %', target_username; end if;
  return query select * from public.guides where username = target_username;
end $$;

revoke all on function public.update_my_profile(jsonb) from public, anon;
revoke all on function public.admin_update_guide(text, jsonb) from public, anon;
grant execute on function public.update_my_profile(jsonb) to authenticated;
grant execute on function public.admin_update_guide(text, jsonb) to authenticated;


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 2g — Custom links on the Resources page. Every signed-in guide can read
-- them; only codirectors/admins can add, edit or remove them. Links must be
-- http(s) so nobody can store a javascript: link.
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists public.resource_links (
  id          bigint generated always as identity primary key,
  title       text not null check (length(trim(title)) between 1 and 80),
  url         text not null check (url ~* '^https?://[^\s]+$' and length(url) <= 2000),
  description text check (length(description) <= 200),
  category    text not null default 'Links' check (length(trim(category)) between 1 and 40),
  sort        int  not null default 0,
  created_by  text default (auth.jwt() ->> 'email'),
  created_at  timestamptz not null default now()
);

create or replace function public.is_roster_admin()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from public.guides
                 where lower(trim(email)) = lower(auth.jwt() ->> 'email')
                   and status in ('Codirector', 'Admin'));
$$;
revoke all on function public.is_roster_admin() from public, anon;
grant execute on function public.is_roster_admin() to authenticated;

alter table public.resource_links enable row level security;
revoke all on public.resource_links from anon;
grant select, insert, update, delete on public.resource_links to authenticated;
grant all on public.resource_links to service_role;

drop policy if exists "Guides read links" on public.resource_links;
drop policy if exists "Admins add links" on public.resource_links;
drop policy if exists "Admins edit links" on public.resource_links;
drop policy if exists "Admins remove links" on public.resource_links;
create policy "Guides read links"   on public.resource_links for select to authenticated using (public.is_guide());
create policy "Admins add links"    on public.resource_links for insert to authenticated with check (public.is_roster_admin());
create policy "Admins edit links"   on public.resource_links for update to authenticated using (public.is_roster_admin()) with check (public.is_roster_admin());
create policy "Admins remove links" on public.resource_links for delete to authenticated using (public.is_roster_admin());


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 2h — Census in TGIS v4. Run after step 2g (uses is_roster_admin()).
--   app_settings       small key/value settings admins change in the app
--                      (key 'census' = { "term": "Spring 2027", "open": true })
--   census_responses   one row per guide per term
--   submit_census()    the only way a guide writes a response; it also writes
--                      their info corrections (step 1), dietary, involvements
--                      and giving-tours answer straight onto their guides row
--                      (corrections aren't kept on the response itself)
-- Guides read only their own response; codirectors/admins read all of them.
-- ───────────────────────────────────────────────────────────────────────────

alter table public.guides add column if not exists involvements text;
alter table public.guides add column if not exists birthday text;

create table if not exists public.app_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by text default (auth.jwt() ->> 'email')
);
alter table public.app_settings enable row level security;
revoke all on public.app_settings from anon;
grant select, insert, update on public.app_settings to authenticated;
grant all on public.app_settings to service_role;
drop policy if exists "Guides read settings" on public.app_settings;
drop policy if exists "Admins add settings" on public.app_settings;
drop policy if exists "Admins change settings" on public.app_settings;
create policy "Guides read settings"   on public.app_settings for select to authenticated using (public.is_guide());
create policy "Admins add settings"    on public.app_settings for insert to authenticated with check (public.is_roster_admin());
create policy "Admins change settings" on public.app_settings for update to authenticated using (public.is_roster_admin()) with check (public.is_roster_admin());

create table if not exists public.census_responses (
  id                  bigint generated always as identity primary key,
  term                text not null,
  email               text not null,
  username            text,
  display_name        text,
  submitted_at        timestamptz not null default now(),
  info_correct        boolean,
  profile_updates     jsonb not null default '{}'::jsonb,
  giving_tours        text not null check (giving_tours in ('Yes', 'No')),
  no_tour_reason      text,
  tours_per_week      int check (tours_per_week in (1, 2)),
  training_days_avail text,
  training_days_pref  text,
  training_times      text,
  dietary             text,
  involvements        text,
  desk_interest       text check (desk_interest in ('Yes', 'No', 'Assigned')),
  desk_where          text,
  desk_hours          int check (desk_hours between 5 and 10),
  commitment          boolean not null default false,
  unique (term, email)
);
alter table public.census_responses enable row level security;
revoke all on public.census_responses from anon;
revoke insert, update, delete on public.census_responses from authenticated;
grant select on public.census_responses to authenticated;
grant all on public.census_responses to service_role;
drop policy if exists "Own response or admins" on public.census_responses;
create policy "Own response or admins" on public.census_responses for select to authenticated
  using (lower(email) = lower(auth.jwt() ->> 'email') or public.is_roster_admin());

create or replace function public.submit_census(p_term text, answers jsonb)
returns setof public.census_responses
language plpgsql security definer set search_path = public
as $$
declare
  me_email text := lower(auth.jwt() ->> 'email');
  me public.guides;
  cfg jsonb;
  giving text := answers ->> 'giving_tours';
  -- profile columns the census may update on the guide's own row (keep in sync with index.html)
  allowed text[] := array['display_name','major','minor','certificate','college','grad_date','year','hometown','birthday','dietary','involvements','giving_tours'];
  profile jsonb := coalesce(answers -> 'profile', '{}'::jsonb);
  patch jsonb;
  sets text;
begin
  select * into me from public.guides where lower(trim(email)) = me_email limit 1;
  if me is null then raise exception 'No TGIS profile for this account'; end if;

  select value into cfg from public.app_settings where key = 'census';
  if cfg is not null and (coalesce((cfg ->> 'open')::boolean, false) = false or cfg ->> 'term' is distinct from p_term) then
    raise exception 'The % census is closed', p_term;
  end if;
  if giving is null or giving not in ('Yes', 'No') then raise exception 'Answer whether you are giving tours'; end if;
  if giving = 'No' and coalesce(trim(answers ->> 'no_tour_reason'), '') = '' then raise exception 'Give a reason for not giving tours'; end if;
  if giving = 'Yes' and coalesce(answers ->> 'tours_per_week', '') not in ('1', '2') then raise exception 'Pick 1 or 2 tours per week'; end if;
  if coalesce(answers ->> 'desk_hours', '') <> '' and (answers ->> 'desk_hours')::numeric not between 5 and 10 then
    raise exception 'Desk hours must be between 5 and 10';
  end if;

  insert into public.census_responses as c (term, email, username, display_name, info_correct, profile_updates, giving_tours,
      no_tour_reason, tours_per_week, training_days_avail, training_days_pref, training_times, dietary, involvements,
      desk_interest, desk_where, desk_hours, commitment)
  values (p_term, me_email, me.username, coalesce(nullif(trim(profile ->> 'preferred_name'), ''), me.display_name),
      (answers ->> 'info_correct')::boolean, '{}'::jsonb, giving, nullif(trim(answers ->> 'no_tour_reason'), ''),
      nullif(answers ->> 'tours_per_week', '')::int, nullif(answers ->> 'training_days_avail', ''),
      nullif(answers ->> 'training_days_pref', ''), nullif(answers ->> 'training_times', ''),
      nullif(trim(answers ->> 'dietary'), ''), nullif(trim(answers ->> 'involvements'), ''),
      nullif(answers ->> 'desk_interest', ''), nullif(answers ->> 'desk_where', ''),
      nullif(answers ->> 'desk_hours', '')::int, coalesce((answers ->> 'commitment')::boolean, false))
  on conflict (term, email) do update set
      submitted_at = now(), username = excluded.username, display_name = excluded.display_name,
      info_correct = excluded.info_correct, profile_updates = excluded.profile_updates, giving_tours = excluded.giving_tours,
      no_tour_reason = excluded.no_tour_reason, tours_per_week = excluded.tours_per_week,
      training_days_avail = excluded.training_days_avail, training_days_pref = excluded.training_days_pref,
      training_times = excluded.training_times, dietary = excluded.dietary, involvements = excluded.involvements,
      desk_interest = excluded.desk_interest, desk_where = excluded.desk_where, desk_hours = excluded.desk_hours,
      commitment = excluded.commitment;

  -- Write answers onto the guide's row: info corrections (preferred name = display_name),
  -- dietary, involvements, giving tours
  if nullif(trim(profile ->> 'preferred_name'), '') is not null then
    profile := profile || jsonb_build_object('display_name', trim(profile ->> 'preferred_name'));
  end if;
  patch := (profile - 'preferred_name')
        || jsonb_build_object('giving_tours', giving)
        || jsonb_strip_nulls(jsonb_build_object('dietary', nullif(trim(answers ->> 'dietary'), ''),
                                                'involvements', nullif(trim(answers ->> 'involvements'), '')));
  select string_agg(format('%I = r.%I', c.column_name, c.column_name), ', ') into sets
  from information_schema.columns c
  where c.table_schema = 'public' and c.table_name = 'guides'
    and c.column_name = any(allowed) and patch ? c.column_name;
  if sets is not null then
    execute format('update public.guides g set %s from jsonb_populate_record(null::public.guides, $1) r
                    where lower(trim(g.email)) = $2', sets) using patch, me_email;
  end if;

  return query select * from public.census_responses where term = p_term and email = me_email;
end $$;

revoke all on function public.submit_census(text, jsonb) from public, anon;
grant execute on function public.submit_census(text, jsonb) to authenticated;


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 3 — Not SQL. Move Apps Script off the public key BEFORE step 4.
--   1. Supabase → Project Settings → API Keys → copy the service_role (secret) key.
--   2. Apps Script → Project Settings → Script Properties → SUPABASE_ANON_KEY →
--      replace its value with the service_role key and save. (If the script reads
--      the key from that property for its Supabase calls, nothing else changes.
--      Rename the property later if you like, updating the code to match.)
--   3. Run whatever syncs Supabase (or wait for its trigger) and check the
--      executions log shows no errors.
--   The service key bypasses RLS, so it must only ever live in Script Properties —
--   never in an HTML file.
-- ───────────────────────────────────────────────────────────────────────────


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 4 — As soon as step 3 is done and Apps Script syncs fine. (The live site
-- doesn't use Supabase, so this doesn't affect it.) This shuts the public key out:
-- after it, only signed-in guides can read the app's tables, the logs/config
-- tables are reachable only by Apps Script, and nobody can write except Apps Script.
-- ───────────────────────────────────────────────────────────────────────────

do $$
declare t text; pol record;
begin
  foreach t in array array['guides','tours','tracker','forms','special_requests',
                           'access_log','admin_log','family_points','subrequest_log','tgit_config'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
    for pol in select policyname from pg_policies
               where schemaname = 'public' and tablename = t and 'anon' = any(roles) loop
      execute format('drop policy %I on public.%I', pol.policyname, t);
    end loop;
  end loop;
end $$;
