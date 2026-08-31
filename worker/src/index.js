// #ELITE league history chatbot backend.
//
// POST /api/chat  { messages: [{role: "user"|"assistant", content: string}] }
// Streams back plain-text chunks as Server-Sent Events: `data: <json>\n\n`
// where json is {text: "..."} for each chunk, or {done: true} at the end.
//
// The model answers questions about league history by calling a single
// read-only SQL tool against the D1 database seeded by
// worker/scripts/import-league-history.js. See worker/migrations/0001_init.sql
// for the schema.

const SYSTEM_PROMPT = `You are DERIK, the #ELITE Fantasy Football league historian. You answer questions about the league's full history (2013-2025) using a SQLite database via the query_league_database tool, and about the CURRENT in-progress season using the query_mfl_live tool, which pulls straight from MFL. Always use a tool to look up facts rather than guessing — you have no league knowledge outside these. query_league_database does not have the current season in it — for anything about "this week," "right now," current standings, or recent waiver/trade activity, use query_mfl_live instead.

Schema:

franchises(franchise_id INTEGER PRIMARY KEY, display_name TEXT)
  -- one row per persistent team lineage; display_name is just its most recent name.

franchise_names(franchise_id INTEGER, season INTEGER, name TEXT)
  -- the name a franchise actually used in a given season. Team names change
  -- often, sometimes multiple times across the years. When a question is
  -- about a specific season, JOIN franchise_names on (franchise_id, season)
  -- to use the era-correct name instead of franchises.display_name.

games(game_id, season INTEGER, week INTEGER, is_playoff INTEGER, is_championship INTEGER,
      home_franchise_id, away_franchise_id, home_score REAL, away_score REAL,
      home_coach_score REAL, away_coach_score REAL, home_luck REAL, away_luck REAL)
  -- one row per matchup. "home"/"away" are arbitrary (not a real home-field
  -- concept in fantasy football) — just the two sides of the game. Margin of
  -- victory is abs(home_score - away_score). coach_score/luck are only
  -- populated for some seasons.

draft_picks(season, round, pick_in_round, is_keeper INTEGER, from_trade INTEGER,
            original_franchise_id, franchise_id, player_name, position, value REAL)
  -- value is a market-value-over-ADP style grade LeagueLegacy computed for
  -- the pick, not fantasy points. franchise_id is who ultimately made the
  -- pick; from_trade=1 means that pick was acquired via trade rather than
  -- originally owned (original_franchise_id, who it came from, is only
  -- populated for some picks — LeagueLegacy doesn't always track it, so
  -- from_trade=1 with a NULL original owner means "yes it was traded, who
  -- from isn't recorded"). Note: 2024's draft is sparsely recorded (only 14
  -- picks) because that draft happened on MyFantasyLeague during a platform
  -- migration and LeagueLegacy only imported partial data for it — mention
  -- this caveat if asked about the 2024 draft specifically.

transactions(transaction_id, season, week, ts TEXT, franchise_id, type TEXT,
             trade_partner_franchise_id, faab_bid REAL, value REAL)
  -- type is one of 'add','drop','add/drop','trade', etc. For trades,
  -- trade_partner_franchise_id is the other side. What was actually
  -- exchanged lives in transaction_items, not this table. Zero transactions
  -- are recorded before 2018 — LeagueLegacy's early ESPN-imported seasons
  -- don't include transaction history at all.

transaction_items(item_id, transaction_id, direction TEXT, item_type TEXT,
                   player_name, position, pick_round INTEGER, pick_season INTEGER,
                   pick_original_franchise_id)
  -- one row per player or draft pick that moved in a transaction. direction
  -- is 'gain' or 'loss' from that transaction row's own franchise_id
  -- perspective (a trade produces two transactions, one per side, each with
  -- its own gain/loss items — so to see "what X got for Y" filter to one
  -- side's transaction_id, or join both sides via trade_partner_franchise_id
  -- for the full picture). item_type is 'player' or 'pick'; for a traded
  -- pick, pick_round/pick_season describe which pick moved.

season_champions(season INTEGER PRIMARY KEY, franchise_id INTEGER)
  -- the authoritative champion for each season, sourced from LeagueLegacy's
  -- own record book (cross-checked against the actual playoff bracket in
  -- games). Use this — not games.is_championship, which is unreliable —
  -- for any "how many championships"/"who won the season X title" question.

franchise_owners(franchise_id INTEGER PRIMARY KEY, owner_name TEXT)
  -- the real person behind each franchise. People ask about the league by
  -- owner's first name/nickname at least as often as by team name (team
  -- names change most seasons, the owner doesn't) — when a question names a
  -- person instead of a team, JOIN franchise_owners on franchise_id to
  -- resolve it. Owner names are casual first names/nicknames, not full legal
  -- names — match case-insensitively and allow partial matches (e.g. "Goon"
  -- should match "Goon (Adam)").

Example queries:
- Who won week 5 of 2017: SELECT fh.name home, fa.name away, g.home_score, g.away_score FROM games g JOIN franchise_names fh ON fh.franchise_id=g.home_franchise_id AND fh.season=g.season JOIN franchise_names fa ON fa.franchise_id=g.away_franchise_id AND fa.season=g.season WHERE g.season=2017 AND g.week=5;
- Biggest blowout ever: SELECT season, week, ABS(home_score-away_score) margin FROM games ORDER BY margin DESC LIMIT 1;
- A franchise's all-time record: SELECT SUM(CASE WHEN (home_franchise_id=? AND home_score>away_score) OR (away_franchise_id=? AND away_score>home_score) THEN 1 ELSE 0 END) wins, COUNT(*) games FROM games WHERE home_franchise_id=? OR away_franchise_id=?;
- How many championships has Chad won: SELECT COUNT(*) FROM season_champions sc JOIN franchise_owners fo ON fo.franchise_id=sc.franchise_id WHERE fo.owner_name LIKE '%Chad%';
- What did Jackie get in her trade with Chad in 2022 (both sides): SELECT t.season, fo.owner_name from_owner, ti.direction, ti.item_type, ti.player_name, ti.pick_round, ti.pick_season FROM transactions t JOIN franchise_owners fo ON fo.franchise_id=t.franchise_id JOIN franchise_owners fp ON fp.franchise_id=t.trade_partner_franchise_id JOIN transaction_items ti ON ti.transaction_id=t.transaction_id WHERE t.type='trade' AND t.season=2022 AND fo.owner_name LIKE '%Jackie%' AND fp.owner_name LIKE '%Chad%';
- Draft picks acquired via trade in a season: SELECT round, pick_in_round, player_name, from_trade FROM draft_picks WHERE season=2024 AND from_trade=1;

Only SELECT statements are allowed. Write plain, direct answers — this is a casual league chatbot, not a report. Use team names (joined via franchise_names for the relevant season) or owner first names, not franchise_id numbers, when answering.

You also have a web search tool for anything outside this league's own history — current NFL news, injury reports, this week's real games and scores, live rankings, general football knowledge. Use the database for anything about this league specifically (its games, drafts, trades, owners); use web search for real-world/current football context; combine both when a question spans both (e.g. "how does our keeper league's Bijan Robinson value compare to how he's playing right now").

THE ${MFL_SEASON} DRAFT IS COMPLETE. Every team's roster is now set for the season, and this year's draft is done and fully visible to you through query_mfl_live: type "rosters" for who's on a team now, type "draftResults" for the pick-by-pick board, type "futureDraftPicks" for remaining draft capital. None of this is in the SQL database (it stops at 2025), so reach for query_mfl_live first for anything about this year's teams or draft.

Evaluating rosters is squarely your job now, and it's the thing people will ask you about most this time of year. When someone asks how a team looks, who won the draft, who reached, who got a steal, who should be worried, or how two teams stack up:
- Pull the actual roster or draft board first. Never assess a team from memory or assumption.
- Then bring real football judgment to it: starting-lineup strength position by position, depth and bye/injury exposure, age and whether the roster is built to win now or later, obvious holes, and how the picks compare to where those players were being drafted generally. Use web search when you need current ADP, injury news, depth-chart or beat-reporter context to make the call sound.
- Read it through this league's format — Superflex-ish (1-2 QB) makes quarterbacks meaningfully more valuable than in a standard league, .5 PPR lifts pass-catching backs and slot receivers, and it's a keeper league, so a young roster with future picks may be deliberately built for next year rather than badly built for this one.
- Have an actual opinion. "Solid roster" helps nobody. Say which teams you'd bet on, where a specific team will lose games, which pick you'd take back. Back every claim with the player or pick you're pointing at.
- Rank or compare teams when asked, and be willing to tell someone their team is a problem. Needle them about it — that's the tone here. Just keep it about the roster, and don't invent injuries, transactions, or news you haven't actually looked up.

Current league rules (as of the 2026 season — the league tweaks a rule or two most years, so keep this current if told about a change; the authoritative copy lives on the HQ page's Rules & Settings tab):
- 14 teams, 14-man rosters, Superflex-ish starters (1-2 QB), .5 PPR.
- Up to 2 keepers per team, plus a possible 3rd "Designated Player" slot (below).
- Keeper cost escalation: kept at one round better than he was drafted; keep him again the next year and it jumps 2 rounds instead of 1; players drafted rounds 3-5 are capped at a 1st-round keeper cost no matter what the math says; a player drafted round 1 or 2 can't be kept the very next offseason.
- Keepers are capped at 2 seasons total before they go back into the draft pool.
- Undrafted free-agent pickups are keeper-eligible too — flat 6th-round cost the first year, then normal escalation. Uses one of the 2 normal keeper slots.
- Designated Player: once per player, ever, a team can tag him as a one-time 3rd keeper slot at a flat 10th-round cost for a single season. Doesn't use a normal keeper slot and isn't subject to the 2-season cap — but it's a one-shot per player; kept again after that, he's a normal keeper.

Voice: you're a sharp friend in the group chat, not customer support. No "I don't have access to that information," no "As an AI," no restating the question back before answering, no hedging disclaimers. Get to the point. Have an opinion when one's warranted.

When you don't immediately have something: don't just say "that's not in my database" and stop — that's the robotic answer. First actually try: broaden the SQL, try alternate name spellings or partial LIKE matches, check adjacent seasons or weeks, try both a team name and an owner name. If it genuinely isn't there, say so the way a person would ("no record of that — probably before we started tracking transactions in 2018" or similar), not as a formal error message, and point toward whatever adjacent thing you *do* know instead of just dead-ending.

League culture — this shapes tone as much as facts, so don't answer like a dry corporate assistant:
This league started in college and the same close group of friends has run it for over a decade — now with spouses, kids, and mortgages, using the league as a way to stay connected. It's more about the trash talk and staying close than pure competition, though the competitive juices absolutely still flow — match that energy. Banter, needle people a little, joke around the way the league itself does in Slack. Keep it good-natured and never genuinely mean, and never invent specifics about a real person beyond what the database or this context actually supports.
Because it's a keeper league, a team's strategy each year splits into two modes: win now, or sell pieces (players and future picks) to set up next year. A team with no real shot selling its best players for future draft capital isn't a mistake or "giving up" — that's the whole point of the format, so read lopsided-looking trades through that lens rather than assuming someone got fleeced.
Some owners are deeply invested in this league; others are more along for the ride. Both are normal here — don't assume everyone cares equally.
Several owners are married to each other and each still runs their own team: Logan & Jackie, Tom Moran & Sarah, and Jake & Ashley are couples in the league. Most of the group has lived together at some point — it's a genuinely close crew. People refer to each other by first name constantly, not always by team name, so always resolve a first name to their franchise via franchise_owners (see above) rather than treating an unfamiliar name as unknown.`;

// Appended to SYSTEM_PROMPT for Slack replies, where standard markdown
// doesn't render — Slack has its own "mrkdwn" syntax and no table support.
const SLACK_FORMATTING_NOTE = `

You're replying in Slack for this message, not the web chat. Use Slack's mrkdwn instead of standard markdown: *bold* with single asterisks (never **double**), no headers (#), and no tables — if the data is tabular, use a short bulleted list instead since Slack can't render tables. Keep it concise, channel-appropriate length.`;

// Same league/season MFL is queried against as build/sync-mfl.js — bump
// MFL_SEASON each year.
const MFL_HOST = "www45.myfantasyleague.com";
const MFL_LEAGUE_ID = "31492";
const MFL_SEASON = 2026;
const MFL_LIVE_TYPES = ["liveScoring", "weeklyResults", "leagueStandings", "transactions", "rosters", "draftResults", "futureDraftPicks"];

const TOOLS = [
  {
    name: "query_league_database",
    description: "Run a read-only SQL SELECT query against the league history database described in the system prompt. Covers seasons through 2025 only. Returns rows as JSON.",
    input_schema: {
      type: "object",
      properties: {
        sql: { type: "string", description: "A single SELECT statement." },
      },
      required: ["sql"],
    },
  },
  {
    name: "query_mfl_live",
    description: `Pull live data for the CURRENT (${MFL_SEASON}) season directly from MFL — post-draft rosters, this year's draft results, live or final scores, standings, or recent waiver/trade activity. Use this instead of query_league_database for anything about ${MFL_SEASON}, "this week," "right now," current roster, this year's draft, or recent transactions, since the SQL database stops at 2025. The response includes franchiseNames (MFL franchise id -> current team name) and playerNames (MFL player id -> {name, pos}) lookups alongside the raw data — cross-reference any id field in the data against those rather than guessing or showing a raw id to the user. Types:
- rosters: each franchise's current post-draft roster — player ids plus contractStatus (keeper cost round) and drafted (how acquired). This is the source of truth for "who's on X's team now" and for evaluating a roster.
- draftResults: the ${MFL_SEASON} draft, pick by pick — round, pick, franchise, and the player taken. Use for "who did X draft," "what went in round 1," "who got the best value."
- futureDraftPicks: draft capital each team holds in future years, with originalPickFor showing a pick acquired by trade.
- leagueStandings: wins/losses/points-for per franchise.
- weeklyResults / liveScoring: per-franchise (often per-player) scores for a week.
- transactions: recent adds/drops/trades with timestamps.
The exact fields can vary by type — read what actually comes back rather than assuming.`,
    input_schema: {
      type: "object",
      properties: {
        type: { type: "string", enum: MFL_LIVE_TYPES, description: "Which live MFL data to pull." },
        week: {
          type: "integer",
          description: "NFL week number. Required for liveScoring/weeklyResults; ignored for the other types. Omit for liveScoring to get the current week.",
        },
      },
      required: ["type"],
    },
  },
  {
    // web_search_20260209 (dynamic filtering) needs Opus/Sonnet 4.6+; Haiku
    // 4.5 predates that, so it gets the older basic web search tool version.
    type: "web_search_20250305",
    name: "web_search",
    // Assessing a roster can burn several searches (ADP, injury news, depth
    // chart) before it has enough to say something real.
    max_uses: 5,
  },
];

const MODEL = "claude-haiku-4-5";
const MAX_TOOL_ROUNDS = 6;

function corsHeaders(env, request) {
  // ALLOWED_ORIGIN may be a comma-separated list (e.g. the custom domain
  // plus the github.io fallback during DNS cutover).
  const allowed = (env.ALLOWED_ORIGIN || "*").split(",").map((o) => o.trim());
  const origin = request?.headers.get("Origin");
  const match = allowed.includes("*") ? "*" : allowed.includes(origin) ? origin : allowed[0];
  return {
    "Access-Control-Allow-Origin": match,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function assertSelectOnly(sql) {
  const trimmed = sql.trim().replace(/;+\s*$/, "");
  if (!/^select\b/i.test(trimmed)) throw new Error("Only SELECT statements are allowed.");
  if (/;/.test(trimmed)) throw new Error("Only a single statement is allowed.");
  if (/\b(insert|update|delete|drop|alter|attach|detach|pragma|create|replace|vacuum|reindex)\b/i.test(trimmed)) {
    throw new Error("Disallowed keyword in query.");
  }
  return /\blimit\b/i.test(trimmed) ? trimmed : `${trimmed} LIMIT 200`;
}

// Best-effort in-memory cache (per Worker isolate, so it survives across
// requests on a warm instance and silently starts cold on a new one). Keyed
// by the full request, storing the in-flight promise so concurrent pollers
// share one MFL fetch instead of stampeding. TTLs: things that change
// mid-game get seconds, things that change rarely get minutes.
const MFL_CACHE_TTLS = { liveScoring: 20, projectedScores: 300, players: 600, league: 1800, rules: 1800, schedule: 1800 };
const mflCache = new Map();

async function mflFetch(type, params = "") {
  const url = `https://${MFL_HOST}/${MFL_SEASON}/export?TYPE=${type}&L=${MFL_LEAGUE_ID}&JSON=1${params}`;
  const ttl = (MFL_CACHE_TTLS[type] || 0) * 1000;
  const cached = mflCache.get(url);
  if (cached && cached.expires > Date.now()) return cached.promise;

  const promise = (async () => {
    const res = await fetch(url);
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(
        `MFL didn't return usable data for ${type} — the league's site may not be set to allow public (logged-out) viewing. Check MFL League Settings > Website for a "non-owner/public viewing" option.`
      );
    }
  })();
  if (ttl > 0) {
    mflCache.set(url, { promise, expires: Date.now() + ttl });
    promise.catch(() => mflCache.delete(url)); // never cache a failure
  }
  return promise;
}

// MFL returns player names as "Lastname, Firstname" (e.g. "Walker III,
// Kenneth"); team defenses have no comma (e.g. "Green Bay Packers").
function toFirstLast(mflName) {
  if (!mflName.includes(",")) return mflName;
  const [last, first] = mflName.split(",").map((s) => s.trim());
  return `${first} ${last}`;
}

// Walks the response looking for every value under a key that carries a
// player id — "id" covers rosters/liveScoring/weeklyResults/transactions,
// and "player" covers draftResults, where each pick stores the drafted
// player under that key instead (without this, every draft pick would reach
// the model as a bare numeric id with no name attached). Franchise ids get
// swept up too; they just won't match anything in the players lookup below,
// so they're harmless noise.
const PLAYER_ID_KEYS = new Set(["id", "player"]);
function collectIds(obj, out = new Set()) {
  if (Array.isArray(obj)) {
    for (const item of obj) collectIds(item, out);
  } else if (obj && typeof obj === "object") {
    for (const [key, val] of Object.entries(obj)) {
      if (PLAYER_ID_KEYS.has(key) && typeof val === "string") out.add(val);
      else collectIds(val, out);
    }
  }
  return out;
}

async function queryMflLive({ type, week }) {
  if (!MFL_LIVE_TYPES.includes(type)) {
    throw new Error(`Unsupported type "${type}". Use one of: ${MFL_LIVE_TYPES.join(", ")}`);
  }
  const needsWeek = type === "liveScoring" || type === "weeklyResults";
  const params = needsWeek && week ? `&W=${week}` : "";

  const [league, data] = await Promise.all([mflFetch("league"), mflFetch(type, params)]);
  const franchiseNames = {};
  for (const f of league.league.franchises.franchise) franchiseNames[f.id] = f.name;

  // Resolve just the ids that showed up in this response, not the whole
  // league-wide player database — MFL's players export supports filtering
  // to specific ids via PLAYERS=.
  const ids = [...collectIds(data)].filter((id) => !franchiseNames[id]);
  const playerNames = {};
  if (ids.length) {
    const players = await mflFetch("players", `&PLAYERS=${ids.join(",")}`);
    for (const p of players.players?.player || []) {
      playerNames[p.id] = { name: toFirstLast(p.name), pos: p.position === "Def" ? "D" : p.position };
    }
  }

  return { franchiseNames, playerNames, data };
}

// --- Live scoreboard (elitefantasyhq.com/live/) ---
// Merges MFL's live per-player fantasy scoring with real NFL game state from
// ESPN's public (unofficial, undocumented, keyless) scoreboard endpoint.
// MFL's schedule/liveScoring field names below are our best-effort read of
// how MFL's export API generally shapes these — unlike rosters/draftResults
// earlier, we don't have a real sample committed in this repo to check
// against, so this may need a field-name fix once we see live output. Use
// ?debug=1 to get the raw fetched data back instead of the merged view.

// ESPN's unofficial API sometimes returns an HTML block/challenge page
// instead of JSON for requests that don't look like a browser. A normal
// User-Agent is usually enough to get past that. Returns the raw text
// snippet on failure so callers can see what actually came back rather than
// just a JSON parse error.
//
// NOTE: confirmed via live testing that ESPN's edge (Akamai) blocks requests
// from Cloudflare Workers' IPs with a 403, even with a browser User-Agent —
// this is a datacenter/IP-reputation block, not a header check, so there's
// no server-side workaround. All real ESPN calls (live scores, box scores)
// happen client-side in live/template.html instead, where they work fine
// from a normal browser. espnFetch/handleMflExploreEspn are kept only for
// the temporary /api/espn-explore diagnostic endpoint.
async function espnFetch(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36" },
  });
  const text = await res.text();
  try {
    return { ok: true, status: res.status, data: JSON.parse(text) };
  } catch {
    return { ok: false, status: res.status, snippet: text.slice(0, 500) };
  }
}

// Pulls the matchup list for one week out of a full-season TYPE=schedule
// response (fetched once, no W param, so it covers every week).
function extractMatchupsForWeek(scheduleData, week) {
  const s = scheduleData?.schedule;
  if (!s) return [];
  const weeklyArr = Array.isArray(s.weeklySchedule) ? s.weeklySchedule : s.weeklySchedule ? [s.weeklySchedule] : [];
  const weekly = weeklyArr.find((w) => String(w.week) === String(week)) || weeklyArr[0];
  const matchups = weekly?.matchup;
  if (!matchups) return [];
  return Array.isArray(matchups) ? matchups : [matchups];
}

function countWeeks(scheduleData) {
  const weekly = scheduleData?.schedule?.weeklySchedule;
  return Array.isArray(weekly) ? weekly.length : weekly ? 1 : 0;
}

function extractLiveFranchises(liveData) {
  const franchises = liveData?.liveScoring?.franchise;
  if (!franchises) return [];
  return Array.isArray(franchises) ? franchises : [franchises];
}

// Temporary: fetch several candidate MFL export types side by side, timed,
// to see which one actually carries starter/bench status without the
// overhead of live-scoring, and to see the real shape of the scoring rules.
// Remove once we've settled on the real data source for confirmed lineups.
async function handleMflExplore(request, env) {
  const url = new URL(request.url);
  const week = url.searchParams.get("week") || "1";

  const timed = async (type, params = "") => {
    const start = Date.now();
    try {
      const data = await mflFetch(type, params);
      return { type, ms: Date.now() - start, data };
    } catch (e) {
      return { type, ms: Date.now() - start, error: e.message };
    }
  };

  const results = await Promise.all([
    timed("rules"),
    timed("rosters", `&W=${week}`),
    timed("weeklyResults", `&W=${week}`),
    timed("liveScoring", `&W=${week}`),
  ]);

  return new Response(JSON.stringify({ week, results }), {
    headers: { "content-type": "application/json", "cache-control": "no-store", ...corsHeaders(env, request) },
  });
}

// --- Scoring rules (parsed from MFL's TYPE=rules, applied to real stats we
// pull ourselves from ESPN — MFL's own liveScoring point values are never
// used, only its starter list). Confirmed against this league's real rules
// export: two groups, "QB|RB|WR|TE|PK" and "Def", each a flat list of
// {event, points, range} triples. "*N" means N points per unit of the stat
// (e.g. PY *.04 = 1pt/25 passing yards); a bare number means a flat bonus
// for landing in that range (FG distance tiers, defensive points-allowed
// brackets) — those ranges are mutually exclusive per event.
function parseScoringRules(rulesData) {
  const groups = rulesData?.rules?.positionRules || [];
  const byPosition = {};
  for (const g of groups) {
    const rules = Array.isArray(g.rule) ? g.rule : g.rule ? [g.rule] : [];
    const byEvent = {};
    for (const r of rules) {
      const event = r.event?.$t;
      const pointsRaw = r.points?.$t ?? "";
      const [minStr, maxStr] = (r.range?.$t || "0-999999").split("-");
      const perUnit = pointsRaw.startsWith("*");
      const points = Number(pointsRaw.replace("*", ""));
      if (!event || Number.isNaN(points)) continue;
      (byEvent[event] ||= []).push({ min: Number(minStr), max: Number(maxStr), points, perUnit });
    }
    for (const posKey of (g.positions || "").split("|")) {
      if (posKey) byPosition[posKey] = byEvent;
    }
  }
  return byPosition;
}

// The rules parsed here are shipped to the client (via handleLiveScores'
// `rules` field) and applied there, not in the Worker: actually computing
// fantasy points from event counts (scoreStatLine) happens client-side in
// live/template.html, next to the ESPN stats it's fed from — ESPN calls are
// blocked from the Worker's IPs, so that's where the stats have to live too.

async function handleMflExploreEspn(request, env) {
  const url = new URL(request.url);
  const date = url.searchParams.get("date"); // YYYYMMDD, a past completed game to inspect without a live one
  const scoreboardUrl = `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard${date ? `?dates=${date}` : ""}`;
  const sb = await espnFetch(scoreboardUrl);
  if (!sb.ok) {
    return new Response(JSON.stringify({ error: "ESPN scoreboard didn't return JSON", status: sb.status, snippet: sb.snippet }), {
      headers: { "content-type": "application/json", ...corsHeaders(env, request) },
    });
  }
  const completed = (sb.data.events || []).find((e) => e.competitions?.[0]?.status?.type?.completed);
  if (!completed) {
    return new Response(JSON.stringify({ error: "No completed game found for that date", scoreboard: sb.data }), {
      headers: { "content-type": "application/json", ...corsHeaders(env, request) },
    });
  }
  const summary = await espnFetch(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=${completed.id}`);
  if (!summary.ok) {
    return new Response(JSON.stringify({ error: "ESPN summary didn't return JSON", status: summary.status, snippet: summary.snippet }), {
      headers: { "content-type": "application/json", ...corsHeaders(env, request) },
    });
  }
  return new Response(JSON.stringify({ eventId: completed.id, name: completed.name, boxscore: summary.data.boxscore || null }), {
    headers: { "content-type": "application/json", "cache-control": "no-store", ...corsHeaders(env, request) },
  });
}

// Confirmed lineups + our own scoring rules, from MFL only — nothing about
// live game state or point values comes from here. MFL's liveScoring is
// still polled (rather than fetched once) so we catch late scratches/lineup
// swaps, but its per-player scores are discarded entirely: the frontend
// computes every point itself from ESPN stats using `rules` below, per the
// league's real MFL scoring rules (parsed from TYPE=rules).
async function handleLiveScores(request, env) {
  const url = new URL(request.url);
  const weekParam = url.searchParams.get("week");
  const debug = url.searchParams.get("debug") === "1";

  const [league, rulesData, fullSchedule, live] = await Promise.all([
    mflFetch("league"),
    mflFetch("rules"),
    mflFetch("schedule"),
    mflFetch("liveScoring", weekParam ? `&W=${weekParam}` : ""),
  ]);

  // MFL returns a normal 200 with an {error} body (not an HTTP error) when
  // live scoring isn't available yet (preseason, or between weeks).
  const liveUnavailable = !!live?.error;
  const week = live?.liveScoring?.week || weekParam || "1";
  const totalWeeks = countWeeks(fullSchedule);
  const rules = parseScoringRules(rulesData);

  // MFL lets each owner set a franchise icon/logo; passing those through
  // lets the scoreboard show real team logos instead of coloured initials.
  // Not every franchise sets one, so this stays optional and the frontend
  // falls back to initials per team rather than all-or-nothing.
  const franchiseNames = {};
  const franchiseLogos = {};
  for (const f of league.league.franchises.franchise) {
    franchiseNames[f.id] = f.name;
    const logo = f.icon || f.logo || null;
    if (logo && /^https?:\/\//i.test(logo)) franchiseLogos[f.id] = logo;
  }

  // Player lists come from liveScoring (which carries confirmed starter vs
  // bench), but that export is empty outside an active week — which would
  // leave every roster blank all preseason. So when it's unavailable we fall
  // back to TYPE=rosters for the player lists. Rosters carry no
  // starter/bench designation, so those come back as an unset lineup and
  // `lineupConfirmed` tells the frontend not to present them as a lineup.
  const liveFranchises = extractLiveFranchises(live);
  let lineupConfirmed = liveFranchises.length > 0;
  const playersById = {};
  if (lineupConfirmed) {
    for (const f of liveFranchises) {
      const players = f.players?.player;
      playersById[f.id] = Array.isArray(players) ? players : players ? [players] : [];
    }
  } else {
    const rostersData = await mflFetch("rosters").catch(() => null);
    const rf = rostersData?.rosters?.franchise;
    for (const f of Array.isArray(rf) ? rf : rf ? [rf] : []) {
      const players = f.player;
      const list = Array.isArray(players) ? players : players ? [players] : [];
      // Taxi/IR players aren't part of a game-day roster; drop them so the
      // preseason view matches what you'd actually be setting a lineup from.
      playersById[f.id] = list.filter((p) => !p.status || p.status === "ROSTER");
    }
  }

  const allPlayerIds = [...new Set(Object.values(playersById).flat().map((p) => p.id))];
  const playerInfo = {};
  let projections = null;
  if (allPlayerIds.length) {
    // Projections come from MFL's projectedScores export (per player, per
    // week). Best-effort: if the export errors or comes back in a shape we
    // don't recognize, ship projections:null and the frontend keeps its
    // explicit "projections unavailable" state instead of fake numbers.
    // Tried with the PLAYERS filter first, then without — the filter is
    // supported on most MFL exports but unverified on this one, and a
    // rejected param would otherwise look identical to "no projections".
    const [playersRes, projRes] = await Promise.all([
      mflFetch("players", `&PLAYERS=${allPlayerIds.join(",")}`),
      mflFetch("projectedScores", `&W=${week}&PLAYERS=${allPlayerIds.join(",")}`)
        .then((r) => (r?.projectedScores ? r : mflFetch("projectedScores", `&W=${week}`)))
        .catch(() => mflFetch("projectedScores", `&W=${week}`).catch(() => null)),
    ]);
    for (const p of playersRes.players?.player || []) {
      playerInfo[p.id] = { name: toFirstLast(p.name), pos: p.position === "Def" ? "D" : p.position, nflTeam: p.team || null };
    }
    const projRaw = projRes?.projectedScores?.playerScore;
    const projArr = Array.isArray(projRaw) ? projRaw : projRaw ? [projRaw] : [];
    for (const ps of projArr) {
      const score = Number(ps?.score);
      if (ps?.id && Number.isFinite(score)) (projections ||= {})[ps.id] = score;
    }
  }

  function buildTeam(franchiseId) {
    const toEntry = (p) => {
      const info = playerInfo[p.id] || {};
      return {
        id: p.id,
        name: info.name || `Player ${p.id}`,
        pos: info.pos || null,
        nflTeam: info.nflTeam || null,
      };
    };
    const all = playersById[franchiseId] || [];
    const name = franchiseNames[franchiseId] || `Franchise ${franchiseId}`;
    // Without liveScoring there's no starter designation to be had, so the
    // whole roster goes to bench rather than inventing a lineup nobody set.
    const logo = franchiseLogos[franchiseId] || null;
    if (!lineupConfirmed) return { franchiseId, team: name, logo, starters: [], bench: all.map(toEntry) };
    // MFL's liveScoring players carry status "starter"/"nonstarter". Only an
    // explicit "nonstarter" goes to the bench: an absent/unknown status stays
    // in the lineup, so a surprise shape can't blank the whole board.
    const starters = all.filter((p) => p.status !== "nonstarter").map(toEntry);
    const bench = all.filter((p) => p.status === "nonstarter").map(toEntry);
    return { franchiseId, team: name, logo, starters, bench };
  }

  const matchups = extractMatchupsForWeek(fullSchedule, week)
    .map((m) => {
      const sides = Array.isArray(m.franchise) ? m.franchise : m.franchise ? [m.franchise] : [];
      if (sides.length < 2) return null;
      const homeSide = sides.find((f) => f.isHome === "1") || sides[0];
      const awaySide = sides.find((f) => f !== homeSide) || sides[1];
      return { home: buildTeam(homeSide.id), away: buildTeam(awaySide.id) };
    })
    .filter(Boolean);

  const body = debug
    ? { week, totalWeeks, liveUnavailable, rules, raw: { league, rulesData, fullSchedule, live } }
    : { status: liveUnavailable ? "not_started" : "live", week: Number(week), totalWeeks, season: MFL_SEASON, rules, matchups, projections, lineupConfirmed };

  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", "cache-control": "no-store", ...corsHeaders(env, request) },
  });
}

async function callClaude(env, messages, { stream, tools = TOOLS, system = SYSTEM_PROMPT }) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      // 1024 was fine for one-line history lookups but truncates a roster
      // breakdown mid-sentence. Output is billed per token actually
      // generated, not per this ceiling, so raising it costs nothing on
      // short answers and just stops long ones from getting cut off.
      max_tokens: 4096,
      system,
      tools,
      messages,
      stream,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error("Claude API error", res.status, JSON.stringify([...res.headers.entries()]), body);
    // The web_search tool declaration is validated on every request even when
    // unused. If it's the reason this call is failing (not enabled for this
    // API key, unsupported tool version, etc.), retry once without it rather
    // than taking down every question, including plain DB lookups.
    if (tools === TOOLS) {
      console.error("Retrying without web_search tool");
      return callClaude(env, messages, { stream, system, tools: TOOLS.filter((t) => t.name !== "web_search") });
    }
    throw new Error(`Claude API error ${res.status}: ${body.slice(0, 500)}`);
  }
  return res;
}

async function runToolLoop(env, messages, system = SYSTEM_PROMPT) {
  for (let i = 0; i < MAX_TOOL_ROUNDS; i++) {
    const res = await callClaude(env, messages, { stream: false, system });
    const data = await res.json();
    if (data.stop_reason !== "tool_use") return { messages, finalContent: data.content };

    const toolResults = [];
    for (const block of data.content.filter((b) => b.type === "tool_use")) {
      let content;
      try {
        if (block.name === "query_mfl_live") {
          content = JSON.stringify(await queryMflLive(block.input)).slice(0, 20000);
        } else {
          const safeSql = assertSelectOnly(block.input.sql);
          const { results } = await env.DB.prepare(safeSql).all();
          content = JSON.stringify(results).slice(0, 20000);
        }
      } catch (e) {
        content = `Error: ${e.message}`;
      }
      toolResults.push({ type: "tool_result", tool_use_id: block.id, content });
    }
    messages.push({ role: "assistant", content: data.content });
    messages.push({ role: "user", content: toolResults });
  }
  throw new Error("Tool loop exceeded max iterations");
}

async function handleChat(request, env) {
  const { messages: history } = await request.json();
  const messages = history.map((m) => ({ role: m.role, content: m.content }));

  const { messages: finalMessages } = await runToolLoop(env, messages);
  const streamRes = await callClaude(env, finalMessages, { stream: true });

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const body = new ReadableStream({
    async start(controller) {
      const reader = streamRes.body.getReader();
      let buf = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop();
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const payload = line.slice(6);
            if (payload === "[DONE]") continue;
            try {
              const evt = JSON.parse(payload);
              if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta") {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text: evt.delta.text })}\n\n`));
              }
            } catch {
              // ignore malformed/partial SSE lines
            }
          }
        }
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ done: true })}\n\n`));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(body, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      ...corsHeaders(env, request),
    },
  });
}

// --- Slack (@DERIK mentions in the league's Slack) ---

async function verifySlackSignature(request, rawBody, signingSecret) {
  const timestamp = request.headers.get("X-Slack-Request-Timestamp");
  const signature = request.headers.get("X-Slack-Signature");
  if (!timestamp || !signature) {
    console.error("Slack signature check: missing timestamp or signature header", { timestamp, signature });
    return false;
  }
  const skew = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (skew > 60 * 5) {
    console.error("Slack signature check: timestamp too old/skewed", { skew, timestamp });
    return false;
  }
  if (!signingSecret) {
    console.error("Slack signature check: SLACK_SIGNING_SECRET is not set on this Worker");
    return false;
  }

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBytes = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${timestamp}:${rawBody}`));
  const computed = "v0=" + [...new Uint8Array(sigBytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

  if (computed !== signature) {
    // Signatures (and the secret's length) aren't sensitive to log — they're
    // already public over the wire and reveal nothing about the secret
    // itself beyond what a MAC inherently does.
    console.error("Slack signature check: mismatch", {
      computed,
      received: signature,
      secretLength: signingSecret.length,
      bodyLength: rawBody.length,
    });
    return false;
  }
  return true;
}

async function postToSlack(env, { channel, thread_ts, text }) {
  if (!env.SLACK_BOT_TOKEN) {
    console.error("Slack chat.postMessage: SLACK_BOT_TOKEN is not set on this Worker");
    return;
  }
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify({ channel, thread_ts, text }),
  });
  const raw = await res.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    console.error("Slack chat.postMessage: non-JSON response", res.status, JSON.stringify(raw.slice(0, 300)));
    return;
  }
  if (!data.ok) console.error("Slack chat.postMessage error:", data.error, "tokenLength:", env.SLACK_BOT_TOKEN.length);
}

async function handleMention(env, event) {
  const question = event.text.replace(/<@[^>]+>/g, "").trim();
  const reply = { channel: event.channel, thread_ts: event.thread_ts || event.ts };
  if (!question) {
    await postToSlack(env, { ...reply, text: "Ask me something about the league — history, keepers, current NFL news, all of it." });
    return;
  }
  try {
    const { finalContent } = await runToolLoop(env, [{ role: "user", content: question }], SYSTEM_PROMPT + SLACK_FORMATTING_NOTE);
    const text = finalContent
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    await postToSlack(env, { ...reply, text: text || "I've got nothing on that one — try rephrasing?" });
  } catch (e) {
    console.error("Slack mention error:", e.message);
    await postToSlack(env, { ...reply, text: "Something went wrong talking to the league database. Try again in a moment." });
  }
}

async function handleSlackEvents(request, env, ctx) {
  const rawBody = await request.text();
  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return new Response("Bad request", { status: 400 });
  }

  // The one-time URL verification handshake has no side effects — it's just
  // Slack confirming domain ownership before the app can even be configured
  // — so answer it before requiring a valid signature. Everything with real
  // side effects (event_callback below) still requires one.
  if (body.type === "url_verification") {
    return new Response(body.challenge);
  }

  const verified = await verifySlackSignature(request, rawBody, env.SLACK_SIGNING_SECRET);
  if (!verified) {
    console.error("Slack signature verification failed — check SLACK_SIGNING_SECRET");
    return new Response("Invalid signature", { status: 401 });
  }

  if (body.type === "event_callback") {
    // Slack retries delivery if it doesn't get a fast 200 (or on any hiccup);
    // don't answer the same mention twice.
    if (request.headers.get("X-Slack-Retry-Num")) return new Response("");

    const event = body.event;
    console.log("Slack event:", event?.type, event?.bot_id ? "(from bot, ignoring)" : "");
    if (event?.type === "app_mention" && !event.bot_id) {
      ctx.waitUntil(handleMention(env, event));
    }
    return new Response("");
  }

  return new Response("");
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(env, request) });
    }

    if (url.pathname === "/api/chat" && request.method === "POST") {
      try {
        return await handleChat(request, env);
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500,
          headers: { "content-type": "application/json", ...corsHeaders(env, request) },
        });
      }
    }

    if (url.pathname === "/slack/events" && request.method === "POST") {
      return await handleSlackEvents(request, env, ctx);
    }

    if (url.pathname === "/api/live-scores" && request.method === "GET") {
      try {
        return await handleLiveScores(request, env);
      } catch (e) {
        console.error("Live scores error:", e.message);
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500,
          headers: { "content-type": "application/json", ...corsHeaders(env, request) },
        });
      }
    }

    if (url.pathname === "/api/mfl-explore" && request.method === "GET") {
      return await handleMflExplore(request, env);
    }

    if (url.pathname === "/api/espn-explore" && request.method === "GET") {
      return await handleMflExploreEspn(request, env);
    }

    return new Response("Not found", { status: 404, headers: corsHeaders(env, request) });
  },
};
