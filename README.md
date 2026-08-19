# mastering-prometheus-tracker

## Setup: cross-device progress sync

Reading progress is stored in Supabase, per Netlify Identity user, via the `progress` Netlify Function.
To enable it on a deploy:

1. Create a Supabase project.
2. Run `supabase/schema.sql` in the Supabase SQL editor to create the `reading_progress` table.
3. In the Netlify site's dashboard, set these environment variables:
   - `SUPABASE_URL` — the project's API URL.
   - `SUPABASE_SERVICE_ROLE_KEY` — the project's service role key (server-side only; the function uses it
     to bypass RLS, so never expose it to the client).
4. Deploy. Netlify installs `@supabase/supabase-js` (declared in `package.json`) and bundles
   `netlify/functions/progress.js` automatically.

Without these env vars set, the app still works per-browser via `localStorage` — the account sync just
fails silently (logged to the console) until they're configured.
