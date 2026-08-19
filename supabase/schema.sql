-- One row per Netlify Identity user, keyed by their Identity user id (JWT `sub`).
-- updated_at is a client-generated epoch-ms timestamp (matches the JS `Date.now()`
-- already used for conflict resolution in index.html) rather than a DB timestamp,
-- so the client and server agree on "who wrote last" without a clock-format layer.
create table if not exists reading_progress (
  user_id text primary key,
  chapters boolean[] not null,
  updated_at bigint not null default 0,
  constraint reading_progress_chapters_length check (array_length(chapters, 1) = 15)
);

-- This table is only ever read/written by the progress Netlify Function, using the
-- Supabase service role key (which bypasses RLS). No policies are defined, so RLS
-- denies all access from the anon/public key by default.
alter table reading_progress enable row level security;
