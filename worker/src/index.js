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
const MFL_LIVE_TYPES = ["liveScoring", "weeklyResults", "leagueStandings", "transactions", "rosters"];

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
    description: `Pull live data for the CURRENT (${MFL_SEASON}) in-progress season directly from MFL — this week's live or final scores, current standings, recent waiver/trade activity, or current rosters ("who's on X's roster right now" -> type "rosters"). Use this instead of query_league_database for anything about the in-progress season, "this week," "right now," current roster, or recent transactions, since the SQL database stops at 2025. The response includes franchiseNames (MFL franchise id -> current team name) and playerNames (MFL player id -> {name, pos}) lookups alongside the raw data — cross-reference any id field in the data against those rather than guessing or showing a raw id to the user. Typical shapes: leagueStandings has wins/losses/points-for per franchise; weeklyResults/liveScoring have per-franchise (often per-player) scores for a week; transactions has recent adds/drops/trades with timestamps; rosters has each franchise's player ids plus contractStatus (keeper cost) and drafted (how acquired). The exact fields can vary by type — read what actually comes back rather than assuming.`,
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
    max_uses: 3,
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

async function mflFetch(type, params = "") {
  const url = `https://${MFL_HOST}/${MFL_SEASON}/export?TYPE=${type}&L=${MFL_LEAGUE_ID}&JSON=1${params}`;
  const res = await fetch(url);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `MFL didn't return usable data for ${type} — the league's site may not be set to allow public (logged-out) viewing. Check MFL League Settings > Website for a "non-owner/public viewing" option.`
    );
  }
}

// MFL returns player names as "Lastname, Firstname" (e.g. "Walker III,
// Kenneth"); team defenses have no comma (e.g. "Green Bay Packers").
function toFirstLast(mflName) {
  if (!mflName.includes(",")) return mflName;
  const [last, first] = mflName.split(",").map((s) => s.trim());
  return `${first} ${last}`;
}

// Walks the response looking for every value under a key literally named
// "id" — covers player ids in rosters/liveScoring/weeklyResults/
// transactions without needing to hand-model each type's exact shape.
// Franchise ids get swept up too; they just won't match anything in the
// players lookup below, so they're harmless noise.
function collectIds(obj, out = new Set()) {
  if (Array.isArray(obj)) {
    for (const item of obj) collectIds(item, out);
  } else if (obj && typeof obj === "object") {
    for (const [key, val] of Object.entries(obj)) {
      if (key === "id" && typeof val === "string") out.add(val);
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

const MFL_TO_ESPN_TEAM = { ARZ: "ARI", BLT: "BAL", CLV: "CLE", HST: "HOU", JAC: "JAX", LVR: "LV", WAS: "WSH" };

async function fetchEspnScoreboard() {
  try {
    const res = await fetch("https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard");
    if (!res.ok) return {};
    const data = await res.json();
    const byTeam = {};
    for (const event of data.events || []) {
      const comp = event.competitions?.[0];
      if (!comp) continue;
      const status = comp.status || {};
      const situation = comp.situation || {};
      const [a, b] = comp.competitors || [];
      if (!a || !b) continue;
      const build = (self, opp) => ({
        opponent: opp.team?.abbreviation ?? null,
        quarter: status.period ?? null,
        clock: status.displayClock ?? null,
        state: status.type?.state ?? null, // "pre" | "in" | "post"
        final: !!status.type?.completed,
        redZone: !!situation.isRedZone,
        teamScore: Number(self.score) || 0,
        oppScore: Number(opp.score) || 0,
      });
      if (a.team?.abbreviation) byTeam[a.team.abbreviation] = build(a, b);
      if (b.team?.abbreviation) byTeam[b.team.abbreviation] = build(b, a);
    }
    return byTeam;
  } catch (e) {
    console.error("ESPN scoreboard fetch failed:", e.message);
    return {}; // live fantasy scores should never break just because this did
  }
}

function extractMatchups(scheduleData) {
  const s = scheduleData?.schedule;
  if (!s) return [];
  const weekly = Array.isArray(s.weeklySchedule) ? s.weeklySchedule[0] : s.weeklySchedule;
  const matchups = weekly?.matchup ?? s.matchup;
  if (!matchups) return [];
  return Array.isArray(matchups) ? matchups : [matchups];
}

function extractLiveFranchises(liveData) {
  const franchises = liveData?.liveScoring?.franchise;
  if (!franchises) return [];
  return Array.isArray(franchises) ? franchises : [franchises];
}

async function handleLiveScores(request, env) {
  const url = new URL(request.url);
  const weekParam = url.searchParams.get("week");
  const debug = url.searchParams.get("debug") === "1";

  const [league, live, espn] = await Promise.all([
    mflFetch("league"),
    mflFetch("liveScoring", weekParam ? `&W=${weekParam}` : ""),
    fetchEspnScoreboard(),
  ]);

  const week = live?.liveScoring?.week || weekParam || null;
  const schedule = week ? await mflFetch("schedule", `&W=${week}`) : { schedule: {} };

  const franchiseNames = {};
  for (const f of league.league.franchises.franchise) franchiseNames[f.id] = f.name;

  const liveFranchises = extractLiveFranchises(live);
  const scoreById = {};
  const playersById = {};
  for (const f of liveFranchises) {
    scoreById[f.id] = Number(f.score) || 0;
    const players = f.players?.player;
    playersById[f.id] = Array.isArray(players) ? players : players ? [players] : [];
  }

  const allPlayerIds = [...new Set(Object.values(playersById).flat().map((p) => p.id))];
  const playerInfo = {};
  if (allPlayerIds.length) {
    const playersRes = await mflFetch("players", `&PLAYERS=${allPlayerIds.join(",")}`);
    for (const p of playersRes.players?.player || []) {
      playerInfo[p.id] = { name: toFirstLast(p.name), pos: p.position === "Def" ? "D" : p.position, nflTeam: p.team || null };
    }
  }

  function gameContextFor(nflTeam) {
    if (!nflTeam) return null;
    return espn[MFL_TO_ESPN_TEAM[nflTeam] || nflTeam] || null;
  }

  function buildTeam(franchiseId) {
    const starters = (playersById[franchiseId] || []).map((p) => {
      const info = playerInfo[p.id] || {};
      return {
        id: p.id,
        name: info.name || `Player ${p.id}`,
        pos: info.pos || null,
        points: Number(p.score) || 0,
        status: p.status || null,
        nflTeam: info.nflTeam || null,
        game: gameContextFor(info.nflTeam),
      };
    });
    return { franchiseId, team: franchiseNames[franchiseId] || `Franchise ${franchiseId}`, score: scoreById[franchiseId] || 0, starters };
  }

  const matchups = extractMatchups(schedule)
    .map((m) => {
      const sides = Array.isArray(m.franchise) ? m.franchise : m.franchise ? [m.franchise] : [];
      if (sides.length < 2) return null;
      const homeSide = sides.find((f) => f.isHome === "1") || sides[0];
      const awaySide = sides.find((f) => f !== homeSide) || sides[1];
      return { home: buildTeam(homeSide.id), away: buildTeam(awaySide.id) };
    })
    .filter(Boolean);

  const body = debug ? { week, raw: { league, live, schedule, espn } } : { week, matchups };

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
      max_tokens: 1024,
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

    return new Response("Not found", { status: 404, headers: corsHeaders(env, request) });
  },
};
