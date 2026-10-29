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
