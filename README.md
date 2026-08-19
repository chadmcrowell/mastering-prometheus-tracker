# Mastering Prometheus Book Tracker

[![Netlify Status](https://api.netlify.com/api/v1/badges/1810d1cc-d379-466a-a3a5-2196e15939e1/deploy-status)](https://app.netlify.com/projects/mastering-prometheus-tracker/deploys)

[https://mastering-prometheus-tracker.netlify.app/](https://mastering-prometheus-tracker.netlify.app/)

A single-page reading tracker for the book *Mastering Prometheus*. Check off chapters as you read them and
watch overall progress (percent complete, pages read) update automatically. Progress is cached in
`localStorage` for instant loads and offline use, and — once logged in via Netlify Identity — synced to a
Supabase-backed account so it follows you across devices/browsers.

## Features

- Per-chapter completion checkboxes, with a live progress bar and page-count summary.
- Works with no account at all — progress is saved to `localStorage` on the device/browser.
- Optional login (email/password, via Netlify Identity) syncs progress to an account across devices, with
  automatic reconciliation between local and remote state (newest `updatedAt` wins).
- Cross-tab/cross-device sync without a manual refresh.
- Light/dark theme, both automatic (`prefers-color-scheme`) and manually toggleable.

## Tech stack

- **Frontend**: plain HTML/CSS/JS in a single file (`index.html`) — no framework, no client-side build
  step.
- **Auth**: [Netlify Identity](https://docs.netlify.com/manage/security/security-scanning/netlify-identity/)
  (email/password).
- **Backend**: one Netlify Function (`netlify/functions/progress.js`) that reads/writes progress.
- **Database**: [Supabase](https://supabase.com/) (Postgres), accessed only from the Function via the
  service role key.

## Project structure

```text
index.html                      # entire frontend: markup, styles, and app logic
netlify/functions/progress.js   # GET/POST endpoint for reading/writing a user's progress
supabase/schema.sql             # reading_progress table + RLS setup, run once per Supabase project
netlify.toml                    # points Netlify at netlify/functions for Functions bundling
package.json                    # @supabase/supabase-js dependency, used only by the Function
mastering-prometheus-cover.jpg  # book cover, also reused as the favicon source
favicon-light.png               # light-mode favicon variant
```

## Local development

There's no build step. To preview the static frontend:

```bash
python3 -m http.server 8000   # then open http://localhost:8000
```

Login and progress sync won't work against `localhost` — the Identity widget is hardcoded to the production
site's `.netlify/identity` endpoint, and the Function is only reachable once deployed (or via `netlify dev`
if you have the [Netlify CLI](https://docs.netlify.com/cli/get-started/) installed). Without an account,
the app still works fully using `localStorage`.

To work on the Function itself:

```bash
npm install   # pulls in @supabase/supabase-js per package.json
```

Then edit `netlify/functions/progress.js` and deploy (or run under `netlify dev`) to test it — see
[Setup: cross-device progress sync](#setup-cross-device-progress-sync) below for the required Supabase
project and environment variables.

## How it works

- Chapter state is an array of 15 booleans plus an `updatedAt` timestamp, kept in `localStorage` under
  `mp-reading-progress`. Every checkbox toggle updates this immediately, so the UI never waits on a network
  round trip.
- On login (or session restore), the app fetches the account's saved progress from the `progress` Function
  and reconciles it with the local copy: whichever side has the newer `updatedAt` wins, falling back to
  whichever has more chapters completed if the timestamps tie. This keeps a freshly-opened device from
  clobbering progress that's already saved to the account.
- After reconciliation, every future toggle both updates `localStorage` and POSTs the new state to the
  Function, which upserts it into the `reading_progress` table in Supabase, keyed by the Netlify Identity
  user id.
- The Function trusts `context.clientContext.user`, which Netlify's Functions runtime populates from the
  Identity JWT — no manual token verification is needed in the Function itself.

### Adding a chapter

1. Add a new `.chapter-card` block in `index.html`'s markup, following the existing pattern (set
   `data-pages` for that chapter).
2. Bump `TOTAL_CHAPTERS` in **both** `index.html`'s script and `netlify/functions/progress.js` —
   `TOTAL_CHAPTERS` gates payload validation in the Function, so a mismatch makes every `POST` fail with a
   400.

Chapter count, per-chapter page estimates, and total pages are otherwise derived from these constants, not
hardcoded per card.

## Setup: cross-device progress sync

Reading progress is stored in Supabase, per Netlify Identity user, via the `progress` Netlify Function.
To enable it on a deploy:

1. Create a Supabase project.
2. Run `supabase/schema.sql` in the Supabase SQL editor to create the `reading_progress` table.
3. In the Netlify site's dashboard, set these environment variables:
   - `SUPABASE_URL` — the project's API URL.
   - `SUPABASE_SERVICE_ROLE_KEY` — the project's **secret**/**service_role** key (labeled "Secret key" in
     newer Supabase projects, "service_role" in older ones) — server-side only; the function uses it to
     bypass RLS, so never expose it to the client, and never use the anon/public/"Publishable key" here.
     Since `reading_progress` has RLS enabled with no policies, using the wrong key doesn't fail loudly —
     every request 500s with a row-level-security error instead.
4. Deploy. Netlify installs `@supabase/supabase-js` (declared in `package.json`) and bundles
   `netlify/functions/progress.js` automatically.

Without these env vars set, the app still works per-browser via `localStorage` — the account sync just
fails silently (logged to the console) until they're configured.

Netlify Functions only pick up environment variable changes on their **next deploy** — after changing an
env var in the Netlify UI, trigger a redeploy (e.g. an empty commit) before retesting.

## Deployment

- The GitHub repo (`chadmcrowell/mastering-prometheus-tracker`) is connected to Netlify for auto-deploy on
  push to `main`. **There is no staging environment or preview branch workflow** — every push to `main` is
  a live production deploy.
- Netlify Identity is enabled on the Netlify site with email/password auth and `autoconfirm: false`, so new
  signups must click an email confirmation link before they can log in.
- The `progress` Function needs `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` set as Netlify environment
  variables, and `supabase/schema.sql` run against the Supabase project, per
  [Setup: cross-device progress sync](#setup-cross-device-progress-sync) above.

### Verifying a deploy

Netlify's build/publish is asynchronous relative to `git push`, so confirm a deploy actually went live
rather than assuming the push succeeded:

```bash
# Frontend: look for updated markup at the production URL
curl -s https://mastering-prometheus-tracker.netlify.app/ | grep <marker>

# Function: should return 401 with this body once the deploy is live and reachable
curl -s https://mastering-prometheus-tracker.netlify.app/.netlify/functions/progress
# {"error":"Not authenticated"}
```

A bare `curl` to the Function has no Identity JWT attached, so the 401 only confirms the deploy succeeded —
it doesn't confirm Supabase connectivity. To check that, log in on the deployed site and toggle a chapter;
a Supabase misconfiguration (missing env vars, wrong key, schema not applied) fails silently to the browser
console and falls back to `localStorage`-only behavior, so check the console for errors, not just the UI.
