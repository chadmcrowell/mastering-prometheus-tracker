-- Public reader profiles. Run once, after 001_leaderboard.sql. Safe to re-run.
--
-- Profiles are opt-in: a row exists only once the user saves their profile for
-- the first time, so no one gets a public page they didn't ask for. There's no
-- backfill for that reason.
--
-- profiles.display_name is the single source of truth for a reader's name,
-- both on their profile page and on the leaderboard. (It replaces
-- reading_progress.display_name, which is left in place but no longer read or
-- written; see PROFILES.md for dropping it once this has been deployed.)

create table if not exists profiles (
  -- Netlify Identity user id (JWT `sub`), same key as reading_progress.
  user_id text primary key,
  username text not null,
  display_name text,
  -- Plain text, not Markdown; rendered with line breaks preserved.
  bio text,
  avatar_url text,
  social_links jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint profiles_username_key unique (username),
  -- Lowercase only, so the unique constraint is also case-insensitive.
  constraint profiles_username_format
    check (username ~ '^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$'),
  -- Route segments and names that could be mistaken for the site itself.
  -- Keep in sync with RESERVED_USERNAMES in netlify/functions/profile.js.
  constraint profiles_username_reserved
    check (username not in ('admin', 'api', 'edit', 'leaderboard', 'me', 'new', 'null',
                            'profile', 'profiles', 'settings', 'undefined')),
  constraint profiles_display_name_length
    check (display_name is null or char_length(display_name) between 1 and 40),
  constraint profiles_bio_length
    check (bio is null or char_length(bio) between 1 and 500),
  constraint profiles_avatar_url_https
    check (avatar_url is null or (avatar_url like 'https://%' and char_length(avatar_url) <= 500)),
  -- Only known networks, and every value an https URL string. The Function
  -- additionally checks each URL's host (e.g. github.com for "github").
  constraint profiles_social_links_shape
    check (
      jsonb_typeof(social_links) = 'object'
      and social_links - array['linkedin', 'bluesky', 'twitter', 'github', 'website'] = '{}'::jsonb
      and not jsonb_path_exists(social_links, '$.* ? (@.type() != "string" || !(@ starts with "https://"))')
    )
);

-- The username lookup used by public profile pages is covered by the index
-- behind profiles_username_key; user_id is covered by the primary key.

create or replace function set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_set_updated_at on profiles;
create trigger profiles_set_updated_at
  before update on profiles
  for each row execute function set_updated_at();

-- Same access model as the other tables: RLS on with no policies, so only the
-- service role (the Netlify Functions) can read or write. Ownership is enforced
-- in netlify/functions/profile.js, which keys every write on the caller's
-- verified Identity `sub`. Supabase RLS can't do it, because Netlify Identity
-- JWTs aren't Supabase JWTs, so auth.uid() is always null.
alter table profiles enable row level security;
revoke all on profiles from anon, authenticated;

-- Leaderboard names now come from profiles. Readers without a profile have
-- null username/display_name and are shown as "Reader #xxxx". `username` is
-- appended last so `create or replace` works over the 001 definition.
create or replace view leaderboard
with (security_invoker = true)
as
select
  rank() over (order by count(*) desc, max(c.completed_at) asc)::int as rank,
  c.user_id,
  p.display_name,
  count(*)::int as chapters_completed,
  max(c.completed_at) as reached_at,
  p.username
from chapter_completions c
left join profiles p on p.user_id = c.user_id
group by c.user_id, p.display_name, p.username;

revoke all on leaderboard from anon, authenticated;
