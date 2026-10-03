-- Leaderboard: ranks readers by chapters completed, ties going to whoever
-- reached that count first. Run once, after supabase/schema.sql. Safe to re-run.
--
-- reading_progress stays the source of truth for sync (one boolean[] per user,
-- written only by the progress Function). chapter_completions is derived from
-- it by trigger, so completion timestamps come from the database clock rather
-- than the client-supplied updated_at.

-- Shown on the leaderboard instead of the user's email. Populated by the
-- progress Function from the Identity JWT's user_metadata.full_name.
alter table reading_progress add column if not exists display_name text;

create table if not exists chapter_completions (
  user_id text not null references reading_progress (user_id) on delete cascade,
  chapter_number smallint not null,
  completed_at timestamptz not null default now(),
  primary key (user_id, chapter_number),
  -- Keep the upper bound in sync with TOTAL_CHAPTERS (see LEADERBOARD.md).
  constraint chapter_completions_chapter_range check (chapter_number between 1 and 15)
);

-- Same model as reading_progress: RLS on, no policies, so only the service
-- role (the Netlify Functions) can read or write it.
alter table chapter_completions enable row level security;

-- Idempotent rather than diff-based: every write inserts all completed
-- chapters (keeping the original completed_at for ones already recorded) and
-- deletes all uncompleted ones. Re-posting identical state is a no-op, and
-- un-checking then re-checking a chapter resets its timestamp to now().
create or replace function sync_chapter_completions()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  insert into chapter_completions (user_id, chapter_number)
  select new.user_id, i
  from generate_subscripts(new.chapters, 1) as i
  where new.chapters[i]
  on conflict (user_id, chapter_number) do nothing;

  delete from chapter_completions c
  where c.user_id = new.user_id
    and not coalesce(new.chapters[c.chapter_number], false);

  return null;
end;
$$;

drop trigger if exists reading_progress_sync_completions on reading_progress;
create trigger reading_progress_sync_completions
  after insert or update of chapters on reading_progress
  for each row execute function sync_chapter_completions();

-- Backfill progress saved before this migration. True per-chapter completion
-- times were never recorded, so every chapter gets the row's last-updated
-- time (client-supplied, hence clamped to now()).
insert into chapter_completions (user_id, chapter_number, completed_at)
select
  rp.user_id,
  i,
  case
    when rp.updated_at > 0 then least(to_timestamp(rp.updated_at / 1000.0), now())
    else now()
  end
from reading_progress rp
cross join lateral generate_subscripts(rp.chapters, 1) as i
where rp.chapters[i]
on conflict (user_id, chapter_number) do nothing;

-- reached_at is when the user completed the most recent of their currently
-- completed chapters, i.e. when they reached their current count. Users with
-- no completed chapters have no rows and so don't appear.
--
-- security_invoker makes the view apply the caller's RLS (Postgres views
-- otherwise run as their owner, which would bypass RLS and expose this view
-- to the anon key through Supabase's REST API).
create or replace view leaderboard
with (security_invoker = true)
as
select
  rank() over (order by count(*) desc, max(c.completed_at) asc)::int as rank,
  c.user_id,
  rp.display_name,
  count(*)::int as chapters_completed,
  max(c.completed_at) as reached_at
from chapter_completions c
join reading_progress rp on rp.user_id = c.user_id
group by c.user_id, rp.display_name;

revoke all on leaderboard from anon, authenticated;
revoke all on chapter_completions from anon, authenticated;
