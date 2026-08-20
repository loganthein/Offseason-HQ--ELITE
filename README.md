# #ELITE Offseason HQ

The home for **#ELITE Fantasy Football** (MFL League 31492) — a chatbot for the full league history, plus rosters, keeper costs, draft picks, and a trade finder.

**Live site:** `https://<your-username>.github.io/<repo-name>/`

## What this is

- **`index.html`** (site root) — **DERIK**, a Claude-style chatbot that answers anything about league history since 2013 (matchups, blowouts, drafts, transactions) with a daily "Did You Know" factoid. See [`worker/README.md`](worker/README.md) for how its backend is built and deployed.
- **`hq/index.html`** ("Offseason HQ", reachable from DERIK's "Offseason HQ" menu) — the roster/keeper/draft tool:
  - **Rules & Settings** — how keepers and their cost escalation work, league settings
  - **Team Overview** — per-team roster, keeper math, and picks
  - **Roster & Keepers** — full league roster, sortable/filterable, with a leaguewide keeper-value ranking
  - **Draft Picks** — the draft order plus future years, with a by-round breakdown
  - **Trade Finder** — player search, similar-value finder, AI-written team breakdowns, and a keep planner

Both pages are self-contained static HTML: no server, no external requests except DERIK's chat calls to its Worker backend. Fonts and data are embedded directly in the file.

## Publishing to GitHub Pages

1. Push this repo to GitHub (public repo, since Pages requires that on the free tier).
2. On github.com: **Settings → Pages → Source → Deploy from a branch**, pick `main` and `/ (root)`, then **Save**.
3. GitHub gives you a URL like `https://<your-username>.github.io/<repo-name>/` within a minute or two.

## Updating the data later

Both pages are snapshots, not live — rosters, picks, and market values only update when rebuilt. To refresh:

1. Ask Claude to re-pull the latest data from MFL League 31492 and KeepTradeCut, and regenerate the site.
2. Or, if you're doing it yourself: update the files in `build/`, then run:
   ```
   cd build
   node build.js
   ```
   This regenerates `../index.html` (DERIK) and `../hq/index.html` (Offseason HQ) from their templates + the data files. Commit and push to publish.

To refresh DERIK's "Did You Know" facts from the current league database, run `node worker/scripts/generate-facts.js` (writes `build/facts.json`) before rebuilding.

## Folder structure

```
index.html              DERIK, the chat homepage — generated, this is what GitHub Pages serves at /
hq/index.html            Offseason HQ (rosters/keepers/picks/trade finder) — generated
home/
  template.html          DERIK page source, {{PLACEHOLDER}} slots for fonts/facts
  chat.js                 DERIK's chat logic (streaming, markdown, Did You Know)
build/
  template.html          Offseason HQ page source with {{PLACEHOLDER}} slots for data/fonts
  build.js                regenerates ../index.html and ../hq/index.html from the files below
  facts.json              DERIK's "Did You Know" fact deck (see worker/scripts/generate-facts.js)
  seed_roster_final.json  current roster snapshot (from MFL)
  seed_picks_final.json   draft picks snapshot (from MFL)
  team_notes_min.json     the Trade Finder team breakdown write-ups
  fonts_b64.json          embedded font data (Bebas Neue, DM Mono, Inter)
  mfl_*.json              raw MFL API pulls the roster/picks data was built from
  ktc_map.json            KeepTradeCut market value snapshot
worker/                  DERIK's backend (Cloudflare Worker + D1) — see worker/README.md
scripts/raw/             raw LeagueLegacy.io pulls DERIK's history is built from
```
