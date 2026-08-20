# #ELITE Offseason HQ

A single-page offseason hub for **#ELITE Fantasy Football** (MFL League 31492) — rosters, keeper costs, draft picks through 2029, and a trade finder, all in one static page.

**Live site:** _(fill in once GitHub Pages is enabled — see below)_

## What this is

`index.html` is one self-contained file: no build step, no server, no external requests. Fonts, data, and styling are all embedded directly in the file, so it works from any static host.

- **Rules & Settings** — how keepers and their cost escalation work, league settings
- **Team Overview** — per-team roster, keeper math, and picks
- **Roster & Keepers** — full league roster, sortable/filterable, with a leaguewide keeper-value ranking
- **Draft Picks** — the 2026 draft order plus 2027–2029, with a by-round breakdown
- **Trade Finder** — player search, similar-value finder, AI-written team breakdowns, and a keep planner
- **League AI** (`/chat`) — a Claude-style chatbot that can answer anything about league history since 2013 (matchups, blowouts, drafts, transactions). See [`worker/README.md`](worker/README.md) for how it's built and how to deploy its backend.

## Publishing to GitHub Pages

1. Push this repo to GitHub (public repo, since Pages requires that on the free tier).
2. On github.com: **Settings → Pages → Source → Deploy from a branch**, pick `main` and `/ (root)`, then **Save**.
3. GitHub gives you a URL like `https://<your-username>.github.io/<repo-name>/` within a minute or two.

## Updating the data later

The page is a snapshot, not live — rosters, picks, and market values only update when rebuilt. To refresh it:

1. Ask Claude to re-pull the latest data from MFL League 31492 and KeepTradeCut, and regenerate the site.
2. Or, if you're doing it yourself: update the files in `build/`, then run:
   ```
   cd build
   node build.js
   ```
   This regenerates `index.html` from `build/template.html` + the data files. Commit and push the updated `index.html` to publish the change.

## Folder structure

```
index.html              the actual site — this is all GitHub Pages needs
build/
  template.html          page source with {{PLACEHOLDER}} slots for data/fonts
  build.js                regenerates ../index.html from the files below
  seed_roster_final.json  current roster snapshot (from MFL)
  seed_picks_final.json   draft picks snapshot (from MFL)
  team_notes_min.json     the Trade Finder team breakdown write-ups
  fonts_b64.json          embedded font data (Bebas Neue, DM Mono, Inter)
  mfl_*.json              raw MFL API pulls the roster/picks data was built from
  ktc_map.json            KeepTradeCut market value snapshot
```
