# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single-page reading tracker for the book *Mastering Prometheus*. The frontend — markup, styles, and
logic — lives in one file, `index.html`, with no framework and no client-side build step. Reading progress
is synced per-user to Supabase through a Netlify Function (`netlify/functions/progress.js`); a second
Function (`netlify/functions/leaderboard.js`) serves a logged-in-only reader leaderboard (see `LEADERBOARD.md`),
and a third (`netlify/functions/profile.js`) serves opt-in public reader profiles (see `PROFILES.md`).

## Commands

There is no lint/test tooling in this repo. To preview the frontend locally:

```bash
python3 -m http.server 8000   # then open http://localhost:8000
```

Note: Netlify Identity (login) and the `progress` Function will not work against `localhost` — the widget
is initialized with a hardcoded `APIUrl` pointing at the production site, and the Function endpoint is a
relative `/.netlify/functions/progress` path. Both only function on the deployed Netlify URL (or under
`netlify dev`, if the Netlify CLI is installed).

To work on the Function: `npm install` (pulls in `@supabase/supabase-js` per `package.json`), then edit
`netlify/functions/progress.js`. See `README.md` for the required Supabase project + env var setup.

## Architecture

**Frontend (`index.html`)** has three parts, in order:

1. **`<style>`** — all CSS, using custom properties defined on `:root` (spacing scale, colors, radii). No
   external stylesheet or framework.
2. **Markup** — three top-level screens inside `<body>`:
   - `#authScreen`: login/signup buttons, plus a leaderboard teaser.
   - `#app`: the logged-in app. Its header has an account menu (`.user-menu`).
   - `#profileScreen`: the public profile page, which needs no login.

   Exactly one is visible at a time, toggled via the `hidden` attribute (see
   `[hidden] { display: none !important; }`). Inside `#app`, `#trackerView`, `#leaderboardView` and
   `#profileEditView` are toggled the same way.

   `renderRoute()` picks the screen and view from `location.pathname`. Paths: `/`, `/leaderboard`,
   `/profile/edit` (login required), and `/profile/:username` (public). Every path is rewritten to
   `index.html` in `netlify.toml`. Any `<a data-route>` navigates in-page via `history.pushState`. Asset
   URLs are root-absolute so they resolve under nested paths.
3. **A single IIFE at the bottom of the file** that owns both auth and tracker state (they're coupled —
   login/logout drives which screen is visible, and login drives loading/saving progress — so they live in
   one scope rather than two isolated IIFEs):
   - Loads and initializes the Netlify Identity widget (`netlify-identity-widget.js`).
     `init`/`login`/`logout` call `startSession()`/`endSession()`, which start or stop polling, load the
     user's own profile (`myProfile`), and re-run `renderRoute()`. `NETLIFY_IDENTITY_API_URL` is
     hardcoded to the production Netlify site's `.netlify/identity` endpoint.
   - Chapter completion state is `{ chapters: boolean[15], updatedAt: number }`, cached in `localStorage`
     under the key `mp-reading-progress` for instant paint and offline resilience, and `updateUI()`
     re-derives all progress bars/labels/percentages from `state.chapters` on every change.
   - On login/session-restore, `reconcileWithAccount()` calls the `progress` Function (authenticated via
     `user.jwt()`) to fetch the account's saved progress, and reconciles it against the local copy —
     preferring whichever side has a newer `updatedAt`, falling back to whichever has more chapters
     completed when timestamps tie (this covers legacy local data saved before account sync existed, so a
     freshly-opened device never clobbers real progress already saved to the account). Every chapter toggle
     saves locally and then POSTs the new state to the Function.

**Backend**: `netlify/functions/progress.js` handles progress sync. It reads the caller's identity
from `context.clientContext.user` (populated by Netlify's Functions runtime from the Identity JWT sent as
`Authorization: Bearer <token>` — no manual JWT verification needed), keyed by `user.sub`. `GET` returns
`{ chapters, updatedAt }` for that user from the `reading_progress` table in Supabase; `POST` upserts it.
It talks to Supabase with the **service role key** (env var `SUPABASE_SERVICE_ROLE_KEY`), which bypasses
RLS — `supabase/schema.sql` enables RLS on `reading_progress` with no policies, so the table is otherwise
unreachable from the anon/public key. There is no client-side Supabase access at all.

`netlify/functions/leaderboard.js` (GET, auth required) reads the `leaderboard` view defined in
`supabase/migrations/001_leaderboard.sql`. That migration adds a trigger on `reading_progress` that keeps
`chapter_completions` in sync with the `chapters` array, timestamped by the DB clock — ranking never uses
the client-supplied `updated_at`. The leaderboard response never includes emails or user ids.

`netlify/functions/profile.js` handles three requests:
- `GET ?username=` (public)
- `GET ?me=1` (auth)
- `PUT` (auth; upserts the caller's own row in `profiles`, keyed by the JWT `sub`)

`supabase/migrations/002_profiles.sql` creates `profiles`. Profiles are opt-in, and
`profiles.display_name` is the single source of truth for reader names, both on profile pages and on the
leaderboard (the view left-joins `profiles`). The Identity `full_name` only pre-fills a first-time
profile form. `reading_progress.display_name` is unused legacy.

`profiles` follows the same RLS-on, no-policies, service-role-only pattern as the other tables. The
Function re-validates every field: usernames, sanitized names and bios, and https-only URLs with a
per-network host check. Social-link keys must match in three places: `SOCIAL_NETWORKS` (`index.html`),
`SOCIAL_HOSTS` (`profile.js`) and the `profiles_social_links_shape` constraint. All user-controlled text
(names, bios) is rendered with `textContent`, never `innerHTML`.

Adding a chapter means: add a `.chapter-card` block in the markup (following the existing pattern, with
`data-pages` set) and bump `TOTAL_CHAPTERS` in both `index.html`'s script and
`netlify/functions/progress.js` (`TOTAL_CHAPTERS` gates payload validation there — a mismatch makes `POST`
reject every request with a 400), and update the chapter-count check constraints in `supabase/schema.sql`
and `supabase/migrations/001_leaderboard.sql` via a new migration. Chapter count, per-chapter page
estimate, and total pages are otherwise derived from constants, not hardcoded per-card.

## Deployment

- GitHub repo `chadmcrowell/mastering-prometheus-tracker`, connected to Netlify for auto-deploy on push to
  `main`. A push to `main` is a live production deploy — there is no staging environment or preview branch
  workflow in use.
- Netlify Identity is enabled on the Netlify site with email/password auth and `autoconfirm: false` (new
  signups must click an email confirmation link before they can log in).
- The `progress` Function requires `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to be set as Netlify
  environment variables, and `supabase/schema.sql` to have been run against the Supabase project — see
  `README.md`. Without them, account sync fails silently (logged to the browser console) and the app falls
  back to `localStorage`-only, per-browser progress.
  - `SUPABASE_SERVICE_ROLE_KEY` must be Supabase's **secret** key (labeled "Secret key" in newer Supabase
    projects, "service_role" in older ones) — never the anon/public/"Publishable key". Since
    `reading_progress` has RLS enabled with no policies, using the wrong key doesn't fail loudly at
    startup; every request 500s with `"new row violates row-level security policy for table
    \"reading_progress\""`, because only a service-role connection bypasses RLS.
  - Netlify Functions only pick up environment variable changes on their **next deploy** — saving a new
    value in the Netlify UI does not affect already-deployed function instances. After changing an env var,
    trigger a redeploy (e.g. `git commit --allow-empty -m "..." && git push`) before retesting.
- To verify a deploy went live, check for updated markup at the production URL (e.g. `curl -s
  https://mastering-prometheus-tracker.netlify.app/ | grep <marker>`) rather than assuming the push
  succeeded — Netlify build/publish is asynchronous relative to `git push`. The same applies to the
  Function: `curl -s https://mastering-prometheus-tracker.netlify.app/.netlify/functions/progress` should
  return `{"error":"Not authenticated"}` (401) once it's live and reachable — a bare `curl` request has no
  Identity JWT, so this doesn't confirm Supabase connectivity itself, only that the deploy succeeded.
