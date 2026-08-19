# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single-page reading tracker for the book *Mastering Prometheus*. The entire app — markup, styles, and
logic — lives in one file, `index.html`. There is no build step, no package manager, and no test suite.

## Commands

There is no build/lint/test tooling in this repo. To preview locally:

```bash
python3 -m http.server 8000   # then open http://localhost:8000
```

Note: Netlify Identity (login) will not work against `localhost` — the widget is initialized with a hardcoded
`APIUrl` pointing at the production site (see below), so auth only functions on the deployed Netlify URL.

## Architecture

`index.html` has three parts, in order:

1. **`<style>`** — all CSS, using custom properties defined on `:root` (spacing scale, colors, radii). No
   external stylesheet or framework.
2. **Markup** — two top-level sections inside `<body>`: `#authScreen` (login/signup buttons) and `#app`
   (the tracker itself, initially `hidden`). Exactly one is visible at a time, toggled via the `hidden`
   attribute — see `[hidden] { display: none !important; }`.
3. **Two independent IIFEs at the bottom of the file**:
   - The **auth IIFE** loads and initializes the Netlify Identity widget
     (`netlify-identity-widget.js`), and toggles `#authScreen`/`#app` visibility on `init`/`login`/`logout`
     events. `NETLIFY_IDENTITY_API_URL` is hardcoded to the production Netlify site's `.netlify/identity`
     endpoint.
   - The **tracker IIFE** owns chapter completion state. State is a `{ chapters: boolean[15] }` object
     persisted to `localStorage` under the key `mp-reading-progress`, and `updateUI()` re-derives all
     progress bars/labels/percentages from that array on every change. This state is **not** scoped per
     Netlify Identity user — it's shared per-browser, not per-account.

Adding a chapter means: add a `.chapter-card` block in the markup (following the existing pattern, with
`data-pages` set) and bump `TOTAL_CHAPTERS` in the tracker IIFE. Chapter count, per-chapter page estimate,
and total pages are otherwise derived from the constants at the top of the tracker IIFE, not hardcoded
per-card.

## Deployment

- GitHub repo `chadmcrowell/mastering-prometheus-tracker`, connected to Netlify for auto-deploy on push to
  `main`. A push to `main` is a live production deploy — there is no staging environment or preview branch
  workflow in use.
- Netlify Identity is enabled on the Netlify site with email/password auth and `autoconfirm: false` (new
  signups must click an email confirmation link before they can log in).
- To verify a deploy went live, check for updated markup at the production URL (e.g. `curl -s
  https://mastering-prometheus-tracker.netlify.app/ | grep <marker>`) rather than assuming the push
  succeeded — Netlify build/publish is asynchronous relative to `git push`.
