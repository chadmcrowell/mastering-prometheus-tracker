# Leaderboard

Logged-in readers can open **Leaderboard** (tab in the app header, or `/leaderboard`) to see everyone
ranked by how many chapters they've completed. Logged-out visitors see a short teaser on the sign-in
screen but can't view the rankings.

## Ranking rules

1. More chapters completed ranks higher. Chapters can be completed in any order, so the count is used,
   not the highest chapter number (marking only chapter 15 shouldn't put someone in first place).
2. Ties go to whoever **reached that count first**: the earlier `reached_at`, which is the completion
   time of the most recent chapter they currently have checked.
3. Exact ties (same count and same timestamp) share a rank (`rank()`, so 1, 1, 3).
4. Readers with zero completed chapters don't appear.
5. Un-checking a chapter removes it. Re-checking it later records a new completion time, so toggling a
   chapter can only lower your position, never raise it.

## Data model

```text
reading_progress (existing)                 chapter_completions (new, derived)
───────────────────────────                 ──────────────────────────────────
user_id      text PK  ◄──────────────────── user_id         text  FK, on delete cascade
chapters     boolean[15]  ── trigger ─────► chapter_number  smallint  check 1..15
updated_at   bigint (client epoch ms)       completed_at    timestamptz default now()
display_name text (new)                     PK (user_id, chapter_number)

leaderboard (view): rank, user_id, display_name, chapters_completed, reached_at
```

- **`reading_progress`** is still the only thing the app writes. The `progress` Function upserts the
  whole `chapters` array, exactly as before.
- **`chapter_completions`** is maintained by the `reading_progress_sync_completions` trigger. On every
  write to `chapters`, the trigger inserts every checked chapter (`on conflict do nothing`, so existing
  timestamps are kept) and deletes every unchecked one. **`completed_at` comes from the database clock
  (`now()`), never from the client.** That's the main anti-cheat measure: the client-supplied
  `updated_at` is used only for cross-device sync, never for ranking.
- **`leaderboard`** is a plain view that aggregates `chapter_completions` per user. It's declared
  `security_invoker`, and `anon`/`authenticated` have no grants on it, so it's unreachable through
  Supabase's public REST API.
- **`display_name`** comes from the Netlify Identity JWT (`user_metadata.full_name`, the "Name" field
  on the signup form). The `progress` Function writes it on every POST. If it's empty, the leaderboard
  Function shows a stable pseudonym, `Reader #<first 4 hex of sha256(user_id)>`. **Emails and Identity
  user ids are never sent to the browser.**

### Access path

There's no client-side Supabase access, the same as for progress sync. The browser calls
`GET /.netlify/functions/leaderboard` with the Identity JWT. The Function queries the view with the
service role key and returns:

```json
{
  "entries": [
    { "rank": 1, "displayName": "Ada", "chaptersCompleted": 9, "reachedAt": "2026-10-02T14:03:11.52+00:00", "isCurrentUser": false },
    { "rank": 2, "displayName": "Reader #3f9a", "chaptersCompleted": 7, "reachedAt": "2026-10-01T09:12:40.10+00:00", "isCurrentUser": true }
  ],
  "me": { "rank": 2, "displayName": "Reader #3f9a", "chaptersCompleted": 7, "reachedAt": "2026-10-01T09:12:40.10+00:00", "isCurrentUser": true }
}
```

`entries` is the top 50 (`LEADERBOARD_LIMIT`). `me` is the caller's own row even when they're outside
the top 50, which the UI then appends below a `⋯` row. `me` is `null` if the caller hasn't completed
anything. Requests without a JWT get a 401.

The UI fetches when the view opens, every 30 s while it stays open, and again when the tab regains
focus. Before each fetch it waits for any in-flight progress POST, so a chapter you just checked is
reflected immediately.

## Setup / deploy order

1. Run `supabase/migrations/001_leaderboard.sql` in the Supabase SQL editor (after `schema.sql`). It's
   idempotent, and it backfills `chapter_completions` from existing progress.
2. **Then** deploy the code. The updated `progress` Function writes `display_name`, so if it deploys
   before the migration, every POST fails with a "column does not exist" error.

Backfill caveat: per-chapter completion times were never recorded before this feature. Existing
readers' chapters all get their row's last `updated_at` (clamped to `now()`), so ties among pre-existing
readers are approximate.

Display names only update when a reader next toggles a chapter (that's when the `progress` Function
POSTs). Until then, existing readers appear as `Reader #xxxx`.

## Changing the number of chapters

`TOTAL_CHAPTERS` currently lives in four places, and all must match:

| Where | What |
|---|---|
| `index.html` | `TOTAL_CHAPTERS` constant, plus the `.chapter-card` markup |
| `netlify/functions/progress.js` | `TOTAL_CHAPTERS` (payload validation) |
| `supabase/schema.sql` | `reading_progress_chapters_length` check (`array_length = 15`) |
| `supabase/migrations/001_leaderboard.sql` | `chapter_completions_chapter_range` check (`between 1 and 15`) |

For an existing database, write a new migration that drops and re-creates both check constraints.
Existing `chapters` arrays also need padding to the new length (e.g.
`update reading_progress set chapters = chapters || array_fill(false, array[<added>])`), or the length
check will fail.

## Resetting for a new cohort

**Don't just truncate the tables.** Each reader's browser caches progress in `localStorage`. When the
app finds no saved progress for the account, it POSTs the cached copy back, and the trigger puts those
chapters back on the leaderboard.

### Option A — wipe everyone's progress (leaderboard and personal tracker)

```sql
update reading_progress
set chapters = array_fill(false, array[15]),
    updated_at = (extract(epoch from now()) * 1000)::bigint;
```

The trigger clears `chapter_completions`. Because `updated_at` is now newer than every device's cached
copy, each client adopts the empty state on its next sync instead of re-uploading old progress. (One
exception: a device whose clock runs ahead of the server's can still win the timestamp comparison.)

### Option B — reset only the leaderboard, keep personal progress

Add a cohort start time and count only completions after it:

```sql
create table cohort (id int primary key default 1 check (id = 1), started_at timestamptz not null);
insert into cohort (started_at) values (now())
  on conflict (id) do update set started_at = excluded.started_at;
alter table cohort enable row level security;
```

Then add `where c.completed_at >= (select started_at from cohort)` to the `leaderboard` view. Chapters
checked before the cohort started keep their old `completed_at`, so they don't count. To start the
next cohort, re-run the upsert above.

## Alternative: materialized view (not applied)

The plain view aggregates every completion row on each request. That's trivial at this scale
(≤ 15 rows per reader), so a materialized view would add moving parts without a measurable win. If
readership ever grows into the tens of thousands, swap it in:

```sql
drop view if exists leaderboard;
create materialized view leaderboard as
select rank() over (order by count(*) desc, max(c.completed_at) asc)::int as rank,
       c.user_id, rp.display_name,
       count(*)::int as chapters_completed, max(c.completed_at) as reached_at
from chapter_completions c
join reading_progress rp on rp.user_id = c.user_id
group by c.user_id, rp.display_name;

create unique index on leaderboard (user_id);   -- required for CONCURRENTLY
create index on leaderboard (rank);
revoke all on leaderboard from anon, authenticated;

-- Refresh periodically (pg_cron, available on Supabase) rather than per write:
select cron.schedule('refresh-leaderboard', '* * * * *',
  'refresh materialized view concurrently leaderboard');
```

Avoid refreshing from a trigger on `chapter_completions`. Each toggle would recompute the whole
leaderboard while holding the write open, which is worse than the plain view at any scale. Note too that
materialized views don't support RLS or `security_invoker`, so the `revoke` above is the only thing
keeping it off the public API.
