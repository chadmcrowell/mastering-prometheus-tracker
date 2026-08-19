# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single-page reading tracker for the book *Mastering Prometheus*. The frontend — markup, styles, and
logic — lives in one file, `index.html`, with no framework and no client-side build step. Reading progress
is synced per-user to Supabase through a single Netlify Function (`netlify/functions/progress.js`).

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
2. **Markup** — two top-level sections inside `<body>`: `#authScreen` (login/signup buttons) and `#app`
   (the tracker itself, initially `hidden`). Exactly one is visible at a time, toggled via the `hidden`
   attribute — see `[hidden] { display: none !important; }`.
3. **A single IIFE at the bottom of the file** that owns both auth and tracker state (they're coupled —
   login/logout drives which screen is visible, and login drives loading/saving progress — so they live in
   one scope rather than two isolated IIFEs):
   - Loads and initializes the Netlify Identity widget (`netlify-identity-widget.js`), and toggles
     `#authScreen`/`#app` visibility on `init`/`login`/`logout` events. `NETLIFY_IDENTITY_API_URL` is
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

**Backend**: `netlify/functions/progress.js` is the only server-side code. It reads the caller's identity
from `context.clientContext.user` (populated by Netlify's Functions runtime from the Identity JWT sent as
`Authorization: Bearer <token>` — no manual JWT verification needed), keyed by `user.sub`. `GET` returns
`{ chapters, updatedAt }` for that user from the `reading_progress` table in Supabase; `POST` upserts it.
It talks to Supabase with the **service role key** (env var `SUPABASE_SERVICE_ROLE_KEY`), which bypasses
RLS — `supabase/schema.sql` enables RLS on `reading_progress` with no policies, so the table is otherwise
unreachable from the anon/public key. There is no client-side Supabase access at all.

Adding a chapter means: add a `.chapter-card` block in the markup (following the existing pattern, with
`data-pages` set) and bump `TOTAL_CHAPTERS` in both `index.html`'s script and
`netlify/functions/progress.js` (`TOTAL_CHAPTERS` gates payload validation there — a mismatch makes `POST`
reject every request with a 400). Chapter count, per-chapter page estimate, and total pages are otherwise
derived from constants, not hardcoded per-card.

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
- To verify a deploy went live, check for updated markup at the production URL (e.g. `curl -s
  https://mastering-prometheus-tracker.netlify.app/ | grep <marker>`) rather than assuming the push
  succeeded — Netlify build/publish is asynchronous relative to `git push`.
