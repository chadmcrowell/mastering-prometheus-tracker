# Profiles

Readers can create a public profile page at `/profile/<username>` with a name, avatar, bio, and links.
Anyone can view a profile, with no login needed. Only the owner can create or edit it, at
`/profile/edit`, which is reachable from the account menu in the app header.

Profiles are **opt-in**. A profile exists only once its owner saves it for the first time, so no reader
gets a public page they didn't ask for. Until then, a reader appears on the leaderboard as
`Reader #xxxx`.

## Data model

`supabase/migrations/002_profiles.sql`:

| Column | Type | Rules |
|---|---|---|
| `user_id` | `text` PK | Netlify Identity user id (JWT `sub`), same key as `reading_progress` |
| `username` | `text` unique, not null | `^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$` (lowercase, so uniqueness is case-insensitive); not a reserved word |
| `display_name` | `text` | 1–40 characters, or null (falls back to `username`) |
| `bio` | `text` | **Plain text**, 1–500 characters, or null |
| `avatar_url` | `text` | `https://` only, ≤ 500 characters, or null (generated avatar) |
| `social_links` | `jsonb`, default `{}` | Object; keys limited to `linkedin`, `bluesky`, `twitter`, `github`, `website`; every value an `https://` string |
| `created_at` | `timestamptz` | Shown as "Joined …" |
| `updated_at` | `timestamptz` | Maintained by the `profiles_set_updated_at` trigger |

`profiles.display_name` is the **single source of truth for a reader's name**, both on their profile
and on the leaderboard (the `leaderboard` view left-joins `profiles`). The Netlify Identity signup
"Name" (`user_metadata.full_name`) is used only to pre-fill the form the first time.

The public page also shows **chapters completed** (counted from `chapter_completions`), but **not the
leaderboard rank**. The leaderboard stays visible only to logged-in readers.

### Bio format

Bios are plain text, deliberately not Markdown. Rendering Markdown safely would need a parser and an
HTML sanitizer, and there's no build step to bundle them. Bios are rendered with `textContent` plus
`white-space: pre-line`, so line breaks are kept and any HTML shows up as literal text.

## Access control

Like the other tables, `profiles` has **RLS enabled with no policies**, and access is revoked from `anon`
and `authenticated`. Supabase's public API can't read or write it. All access goes through
`netlify/functions/profile.js`, using the service role key:

| Request | Auth | What it does |
|---|---|---|
| `GET ?username=<name>` | none | Public profile + `chaptersCompleted`, or 404 |
| `GET ?me=1` | JWT | Caller's own profile (`null` if none), plus `suggested` defaults for a first-time form |
| `PUT` (JSON body) | JWT | Validates the body and upserts the caller's row; returns the saved profile |

**Why there are no RLS policies:** Supabase RLS identifies users with `auth.uid()`, which only works for
Supabase Auth tokens. This app uses Netlify Identity, so `auth.uid()` is always null and RLS can't tell
who's calling. Ownership is enforced in the Function instead:

- Netlify's runtime verifies the Identity JWT and exposes it as `context.clientContext.user`.
- **Every write is keyed on that JWT's `sub`, never on anything in the request body**, so a user can
  only ever write their own row.
- There's no delete endpoint. To delete a profile, do it manually in the Supabase SQL editor:
  `delete from profiles where username = '...'`.

**Usernames can't be hijacked:**

- The `unique (username)` constraint is the final guard. A clash returns 409 "That username is taken".
- Reserved names can't be registered, enforced by a check constraint in the database and mirrored in the
  Function: `edit`, `admin`, `me`, `new`, `api`, `leaderboard`, `profile`, `profiles`, `settings`,
  `null`, `undefined`. Without this, a reader called `edit` would shadow `/profile/edit`.
- **Caveat:** usernames can be changed. When someone renames, their old URL 404s and the old username
  becomes free for someone else to claim.

**Validation and safe rendering:**

- The Function re-validates everything, so the browser's form checks are only a convenience:
  - display names have whitespace collapsed, control characters stripped, and bidi override characters
    stripped, since those can visually reverse text to spoof another name
  - bios have control characters stripped, except newlines
  - URLs must be `https:` with no `user:pass@`
  - each social link must point at its network's host, subdomains included: `linkedin.com`, `bsky.app`,
    `x.com`/`twitter.com`, `github.com`. `website` can be any https URL.
- The database check constraints repeat the essential rules as a backstop.
- In the browser, all user content is set with `textContent`. Social links are re-checked for
  `https://` before rendering and open with `rel="noopener noreferrer nofollow ugc"`.
- The public API response never includes the Identity user id or the email.

## Avatars

- **Default:** an SVG with the reader's initials, coloured by a hash of their username, generated in the
  browser as a `data:` URL. It needs no storage and makes no third-party request.
- **Custom:** readers can paste any `https://` image URL. It loads with `referrerpolicy="no-referrer"`,
  and falls back to the generated avatar if it fails to load.
  - **Trade-off:** the image host sees the IP address of everyone who views that profile (the same as
    any hotlinked image), and the app doesn't moderate the image.

### Adding real uploads later (Supabase Storage)

1. Create a public `avatars` bucket with a size limit (e.g. 1 MB) and allowed MIME types `image/png`,
   `image/jpeg`, `image/webp`. Avoid `image/svg+xml`: SVGs can carry scripts.
2. Add a `POST` handler to the profile Function. It authenticates the caller, then calls
   `supabase.storage.from('avatars').createSignedUploadUrl(`${user.sub}/avatar`)` with the service
   role key. Keying the path on `sub` means users can only overwrite their own avatar.
3. In the form, upload the file with `uploadToSignedUrl`. Then save
   `getPublicUrl(path).data.publicUrl` (plus a cache-busting `?v=<timestamp>`) as `avatar_url`.
4. Optionally tighten `profiles_avatar_url_https` and the Function's check so `avatar_url` must start
   with your project's storage URL. That removes hotlinking, and with it the IP-leak trade-off above.

## Adding or removing a social network

The allowed keys are listed in three places, which must match:

1. `SOCIAL_NETWORKS` in `index.html`: order, label, input type, placeholder.
2. `SOCIAL_HOSTS` in `netlify/functions/profile.js`: the allowed hosts for that network, or `null` for
   any https URL.
3. The `profiles_social_links_shape` check in a **new** migration. Drop and re-create the constraint
   with the updated key array.

When removing a network, also strip existing values first, or the new constraint will fail:
`update profiles set social_links = social_links - 'twitter';`

## Changing other limits

- **Username format or reserved names:** `USERNAME_PATTERN` / `RESERVED_USERNAMES` in `profile.js`,
  the `pattern` attribute on the username input in `index.html`, and the
  `profiles_username_format` / `profiles_username_reserved` constraints (via a new migration).
- **Bio or display-name length:** `MAX_BIO_LENGTH` / `MAX_DISPLAY_NAME_LENGTH` in `profile.js`,
  `MAX_BIO_LENGTH` and the `maxlength` attributes in `index.html`, and the matching constraints.

## Extending profiles

- **New simple fields** (e.g. a `location` or a `pronouns` field) need four changes:
  - a nullable column with a length check, added in a new migration
  - `validateProfileInput()` and `toPublicProfile()` in `profile.js`
  - a form field
  - the `renderPublicProfile()` output
- **Badges** (e.g. "Finished the book", "Top 10"): derive them on read from `chapter_completions` in the
  profile Function rather than storing them, so they can't drift out of sync. Add a `badges` table only
  for manually awarded ones.
- **Custom themes or accent colours:** store a small enum (e.g. `accent text check (accent in (...))`)
  rather than free-form CSS. Apply it as a `data-accent` attribute that maps to existing CSS custom
  properties.
- **Private profiles:** add `is_public boolean not null default true`, and have
  `GET ?username=` return 404 when it's false. The leaderboard would keep the name but drop the link.

## Deploy notes

1. Run `supabase/migrations/002_profiles.sql` in the Supabase SQL editor **before** deploying. The
   updated `leaderboard` Function selects the view's new `username` column, so the leaderboard breaks if
   the code deploys first. The migration is idempotent and safe to run against the currently deployed
   code. However, from the moment it runs, leaderboard names come from `profiles`, so **everyone shows as
   `Reader #xxxx` until they create a profile**. That includes readers who had set a name with the old
   leaderboard name editor.
2. After the deploy is verified, `reading_progress.display_name` is unused (the `progress` Function no
   longer reads or writes it). **Optionally drop it:**
   `alter table reading_progress drop column display_name;`. It was left in place so the migration
   couldn't break the previously deployed `progress` Function, which still wrote to it.
