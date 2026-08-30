# DERIK backend

A Cloudflare Worker that powers DERIK, the chatbot on the site's home page
(`index.html`). It holds the Anthropic API key, runs a tool-use loop against
a D1 (SQLite) database seeded with the league's full history, and streams
the answer back to the browser.

## One-time setup

You'll need a free [Cloudflare account](https://dash.cloudflare.com/sign-up)
and an [Anthropic API key](https://console.anthropic.com/).

```bash
npm install -g wrangler   # if you don't already have it
cd worker
wrangler login
```

### 1. Create the database and load the schema

```bash
wrangler d1 create elite-league-history
```

Copy the `database_id` it prints into `worker/wrangler.toml` (replace
`REPLACE_WITH_D1_DATABASE_ID`).

```bash
wrangler d1 execute elite-league-history --remote --file=migrations/0001_init.sql
wrangler d1 execute elite-league-history --remote --file=migrations/0002_champions.sql
wrangler d1 execute elite-league-history --remote --file=migrations/0003_owners.sql
```

`0002_champions.sql` is the authoritative season-by-season champion list
(sourced from LeagueLegacy's own record book, not inferred from
`games.is_championship` — that flag is missing for 2025, and possibly future
seasons until LeagueLegacy finishes processing them; re-derive this file by
hand from `leaguelegacy.io/leagues/elite-fantasy-football/history` → Season
Champions if a new season needs adding).

`0003_owners.sql` maps each franchise to the real person behind it, so DERIK
resolves "Chad" the same as "Seal Team Nix." If a franchise changes hands,
update this file and re-run it.

### 2. Load the league history

The raw data was already scraped from LeagueLegacy.io into `scripts/raw/`
(one JSON file per season/batch of seasons) and validated against
LeagueLegacy's own totals — 1,315 games, 2,372 draft picks, 1,390
transactions, all present and accounted for. Turn it into SQL and load it:

```bash
node scripts/import-league-history.js
# writes worker/migrations/seed/0000_franchises.sql and one file per season

for f in migrations/seed/*.sql; do
  wrangler d1 execute elite-league-history --remote --file="$f"
done
```

Sanity check:

```bash
wrangler d1 execute elite-league-history --remote --command "select count(*) from games"
# should return 1315
```

**Known gap:** the 2024 draft only has 14 picks recorded — that draft
happened on MyFantasyLeague during the platform migration, and
LeagueLegacy only imported a partial set for it. The Worker's system prompt
already tells the model to mention this if asked about the 2024 draft
specifically. Not worth a special fix for one season.

**Future seasons:** once 2026+ is fully on MFL, this history stops needing
LeagueLegacy re-scrapes. If you ever want to backfill more recent
LeagueLegacy data the same way, the pattern that worked was hitting these
endpoints directly (cookie-authenticated, `X-Inertia: true` +
`X-Inertia-Version: <current>` headers) rather than walking the UI:
- `GET /leagues/elite-fantasy-football/seasons/{year}/matchups`
- `GET /leagues/elite-fantasy-football/draft/seasons/{year}`
- `GET /leagues/elite-fantasy-football/transactions/seasons/{year}`

### 3. Add your Anthropic API key

```bash
wrangler secret put ANTHROPIC_API_KEY
```

### 4. Check the CORS origin

`wrangler.toml` has `ALLOWED_ORIGIN = "https://loganthein.github.io"` under
`[vars]` — that's this repo's GitHub Pages origin. Update it if you ever move
to a custom domain.

### 5. Deploy

```bash
wrangler deploy
```

This prints a `*.workers.dev` URL. Paste it (with `/api/chat` appended) into
`API_URL` at the top of `../home/chat.js`, then rebuild and commit:

```bash
cd ../build
node build.js
cd ..
git add home/chat.js index.html hq/index.html
git commit -m "Wire up DERIK backend URL"
git push
```

### 6. Test it

```bash
curl -N -X POST https://<your-worker>.workers.dev/api/chat \
  -H "content-type: application/json" \
  -d '{"messages":[{"role":"user","content":"Who won week 5 of the 2017 season?"}]}'
```

You should see a stream of `data: {"text": "..."}` lines. Then load the
chat page for real and ask it something.

## How it answers questions

The Worker gives Claude one tool, `query_league_database`, which runs a
single read-only `SELECT` against D1 (validated server-side — no writes, no
multiple statements). The system prompt in `src/index.js` describes the
schema (`franchises`, `franchise_names`, `games`, `draft_picks`,
`transactions`) and a few example queries. Claude writes its own SQL per
question rather than the Worker hand-coding a query for every possible
question — this is what makes "biggest blowout ever" and "who won week 5 of
2017" both work through the same simple loop.

For the **current, in-progress season**, `query_league_database` doesn't
have it (it stops at 2025) — Claude instead reaches for `query_mfl_live`
(`src/index.js`), which fetches live/final scores, standings, recent
transactions, or current rosters straight from MFL's export API at
`https://www45.myfantasyleague.com`, no login required. This needs the
league's MFL site set to allow logged-out/public viewing — check **League
Settings > Website** on MFL if this tool starts erroring with "didn't
return usable data." Bump `MFL_SEASON` in `src/index.js` each year.

## Slack (@DERIK in the league's workspace)

Same Worker, same Claude/DB logic — `/slack/events` is just a second front
door that answers by posting back to Slack instead of streaming to a
browser. Set it up once:

### 1. Create the Slack app

Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App**
→ **From an app manifest** → pick your workspace → paste this (YAML), name
included:

```yaml
display_information:
  name: DERIK
  description: The #ELITE Fantasy Football league historian
features:
  bot_user:
    display_name: DERIK
    always_online: true
oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - chat:write
settings:
  socket_mode_enabled: false
```

Deliberately leaves Event Subscriptions off for now — Slack verifies the
Request URL the moment you turn it on, and the Worker needs to already be
deployed with the right secrets for that to succeed. Create the app, then:

- **Basic Information** → App Credentials → copy **Signing Secret**.
- **OAuth & Permissions** → **Install to Workspace** → copy the **Bot User
  OAuth Token** (`xoxb-...`).

### 2. Set the secrets and deploy

```bash
wrangler secret put SLACK_SIGNING_SECRET
wrangler secret put SLACK_BOT_TOKEN
wrangler deploy
```

### 3. Turn on Event Subscriptions

Back in the Slack app config → **Event Subscriptions** → toggle on → Request
URL: `https://<your-worker>.workers.dev/slack/events` (should show
"Verified" — that's the Worker answering Slack's `url_verification`
challenge). Under **Subscribe to bot events**, add `app_mention` → **Save
Changes** → reinstall the app if it asks.

### 4. Use it

`/invite @DERIK` in whatever channel(s) the league wants it in, then
`@DERIK who won week 5 of 2017` — it replies in-thread. Each mention is
answered as a standalone question (no memory of the rest of the thread).
Slack's own markdown ("mrkdwn") differs from the web chat's, and Slack can't
render tables at all, so the system prompt gets a Slack-specific formatting
note (`SLACK_FORMATTING_NOTE` in `src/index.js`) added only for this path.
