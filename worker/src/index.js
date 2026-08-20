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

const SYSTEM_PROMPT = `You are DERIK, the #ELITE Fantasy Football league historian. You answer questions about the league's full history (2013-present) using a SQLite database via the query_league_database tool. Always use the tool to look up facts rather than guessing — you have no league knowledge outside the database.

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

draft_picks(season, round, pick_in_round, is_keeper INTEGER, franchise_id,
            player_name, position, value REAL)
  -- value is a market-value-over-ADP style grade LeagueLegacy computed for
  -- the pick, not fantasy points. Note: 2024's draft is sparsely recorded
  -- (only 14 picks) because that draft happened on MyFantasyLeague during a
  -- platform migration and LeagueLegacy only imported partial data for it —
  -- mention this caveat if asked about the 2024 draft specifically.

transactions(transaction_id, season, week, ts TEXT, franchise_id, type TEXT,
             player_added, value_added REAL, player_dropped, value_dropped REAL, faab_bid REAL)
  -- type is one of 'add','drop','add/drop','trade', etc. Very few transactions
  -- are recorded before 2020 — LeagueLegacy's early ESPN-imported seasons
  -- don't include full transaction history.

season_champions(season INTEGER PRIMARY KEY, franchise_id INTEGER)
  -- the authoritative champion for each season, sourced from LeagueLegacy's
  -- own record book. Use this — not games.is_championship — for any
  -- "how many championships"/"who won the season X title" question.
  -- games.is_championship is unset for 2025 specifically (a known gap;
  -- LeagueLegacy's own site was still reconciling that season's data when
  -- this was last synced), so it under-counts if you rely on it instead.

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
- Who did Jackie trade with in 2022: SELECT * FROM transactions t JOIN franchise_owners fo ON fo.franchise_id=t.franchise_id WHERE fo.owner_name LIKE '%Jackie%' AND t.type='trade' AND t.season=2022;

Only SELECT statements are allowed. Write plain, direct answers — this is a casual league chatbot, not a report. Use team names (joined via franchise_names for the relevant season) or owner first names, not franchise_id numbers, when answering.`;

const TOOLS = [
  {
    name: "query_league_database",
    description: "Run a read-only SQL SELECT query against the league history database described in the system prompt. Returns rows as JSON.",
    input_schema: {
      type: "object",
      properties: {
        sql: { type: "string", description: "A single SELECT statement." },
      },
      required: ["sql"],
    },
  },
];

const MODEL = "claude-sonnet-5";
const MAX_TOOL_ROUNDS = 6;

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
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

async function callClaude(env, messages, { stream }) {
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
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages,
      stream,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error("Claude API error", res.status, JSON.stringify([...res.headers.entries()]), body);
    throw new Error(`Claude API error ${res.status}: ${body.slice(0, 500)}`);
  }
  return res;
}

async function runToolLoop(env, messages) {
  for (let i = 0; i < MAX_TOOL_ROUNDS; i++) {
    const res = await callClaude(env, messages, { stream: false });
    const data = await res.json();
    if (data.stop_reason !== "tool_use") return { messages, finalContent: data.content };

    const toolResults = [];
    for (const block of data.content.filter((b) => b.type === "tool_use")) {
      let content;
      try {
        const safeSql = assertSelectOnly(block.input.sql);
        const { results } = await env.DB.prepare(safeSql).all();
        content = JSON.stringify(results).slice(0, 20000);
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
      ...corsHeaders(env),
    },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(env) });
    }

    if (url.pathname === "/api/chat" && request.method === "POST") {
      try {
        return await handleChat(request, env);
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500,
          headers: { "content-type": "application/json", ...corsHeaders(env) },
        });
      }
    }

    return new Response("Not found", { status: 404, headers: corsHeaders(env) });
  },
};
