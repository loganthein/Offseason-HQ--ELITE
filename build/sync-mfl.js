// Pulls fresh roster + draft pick data from MFL (League 31492) and rewrites
// seed_roster_final.json / seed_picks_final.json in the schema build.js
// expects. Run from inside build/:
//
//   node sync-mfl.js
//   node build.js        (regenerates ../hq/index.html)
//
// If the league is set to private on MFL, set MFL_USERNAME / MFL_PASSWORD
// env vars first (PowerShell: $env:MFL_USERNAME="you"; $env:MFL_PASSWORD="pw").
//
// NOTE ON 2026 (current-year) TRADED PICKS: MFL's API gives an explicit
// "original owner" for future-year picks (2027+), so those "via TeamName"
// notes are exact. For the CURRENT year's board it does not expose that —
// only who holds each slot right now, not who held it before any trade. So
// this script fills in the correct slot number ("Pick N") for every 2026
// pick, but leaves off "via TeamName" for those unless you tell me which
// ones moved and I'll add them by hand — safer than guessing and mislabeling
// a trade between two actual people.

const fs = require("fs");
const path = require("path");

const HOST = "www45.myfantasyleague.com"; // from the last known-good mfl_league.json
const LEAGUE_ID = "31492";
const SEASON = 2026; // the upcoming/current draft year — bump this each year
const ROOT = __dirname;

let cookie = "";

async function mflFetch(type, extraParams = "") {
  const url = `https://${HOST}/${SEASON}/export?TYPE=${type}&L=${LEAGUE_ID}&JSON=1${extraParams}`;
  const res = await fetch(url, { headers: cookie ? { Cookie: cookie } : {} });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${type}: MFL didn't return JSON (got: ${text.slice(0, 200)})`);
  }
  if (json?.error) throw new Error(`${type}: MFL error — ${JSON.stringify(json.error)}`);
  return json;
}

async function login() {
  const user = process.env.MFL_USERNAME;
  const pass = process.env.MFL_PASSWORD;
  if (!user || !pass) return;
  const url = `https://${HOST}/${SEASON}/login?USERNAME=${encodeURIComponent(user)}&PASSWORD=${encodeURIComponent(pass)}&XML=1`;
  const res = await fetch(url);
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) {
    cookie = setCookie.split(";")[0];
    console.log("Logged in to MFL.");
  } else {
    console.warn("MFL login didn't return a session cookie — continuing anonymously.");
  }
}

function backup(file) {
  const p = path.join(ROOT, file);
  if (fs.existsSync(p)) fs.copyFileSync(p, path.join(ROOT, file.replace(".json", ".prev.json")));
}

async function main() {
  await login();

  console.log("Fetching league, rosters, players, draft results, future picks...");
  // DETAILS=1 is a heavier response but carries draft_year, which is the
  // only way to flag NFL rookies for the HQ page's "Rookies only" filter.
  const [league, rosters, players, draftResults, futurePicks] = await Promise.all([
    mflFetch("league"),
    mflFetch("rosters"),
    mflFetch("players", "&DETAILS=1"),
    mflFetch("draftResults"),
    mflFetch("futureDraftPicks"),
  ]);

  // --- lookups ---
  const franchiseName = {};
  for (const f of league.league.franchises.franchise) franchiseName[f.id] = f.name;

  // MFL returns player names as "Lastname, Firstname" (e.g. "Walker III,
  // Kenneth"); team defenses have no comma (e.g. "Green Bay Packers").
  function toFirstLast(mflName) {
    if (!mflName.includes(",")) return mflName;
    const [last, first] = mflName.split(",").map((s) => s.trim());
    return `${first} ${last}`;
  }

  // draft_year only comes back under DETAILS=1, and not for every player
  // (undrafted free agents have none). Treat "same year as this season" as
  // a rookie; anything missing stays false rather than guessing.
  const playerInfo = {};
  let rookieCount = 0;
  for (const p of players.players.player) {
    const isRookie = String(p.draft_year || "") === String(SEASON);
    if (isRookie) rookieCount++;
    // nflTeam feeds the live scoreboard's demo mode (generated in build.js)
    // so it shows real players on their real NFL teams.
    playerInfo[p.id] = { name: toFirstLast(p.name), pos: p.position === "Def" ? "D" : p.position, rookie: isRookie, nflTeam: p.team || null };
  }

  const ktcMap = JSON.parse(fs.readFileSync(path.join(ROOT, "ktc_map.json"), "utf8"));
  function ktcLookup(name) {
    const hit = ktcMap[name.toLowerCase()];
    return hit ? { ktcValue: hit.value, adpRank: parseInt(hit.rank, 10) || null } : { ktcValue: null, adpRank: null };
  }

  // --- rosters ---
  const rosterOut = [];
  let missingPlayers = 0;
  let missingKtc = 0;
  for (const franchise of rosters.rosters.franchise) {
    const team = franchiseName[franchise.id] || `Franchise ${franchise.id}`;
    for (const p of franchise.player || []) {
      const info = playerInfo[p.id];
      if (!info) {
        missingPlayers++;
        console.warn(`  no player-export match for id ${p.id} on ${team} — skipping`);
        continue;
      }
      const roundNum = parseInt(String(p.contractStatus || "").replace(/\D/g, ""), 10);
      const acquired = p.drafted || "FA";
      const designation = acquired === "Keeper 1" ? "K1" : acquired === "Keeper 2" ? "K2" : "none";
      const { ktcValue, adpRank } = ktcLookup(info.name);
      if (ktcValue === null) missingKtc++;
      rosterOut.push({
        team,
        player: info.name,
        pos: info.pos,
        round: Number.isFinite(roundNum) ? roundNum : null,
        acquired,
        designation,
        rookie: !!info.rookie,
        nflTeam: info.nflTeam || null,
        ktcValue,
        adpRank,
      });
    }
  }

  // --- picks: current season (SEASON) from draftResults ---
  // A pick that's already been used carries the player it was spent on, so
  // once the draft is done those aren't assets any more and listing them
  // alongside future picks would misrepresent what a team actually holds.
  // Unused slots (pre-draft, or a draft still in progress) still count.
  const picksOut = [];
  const draftUnits = draftResults.draftResults.draftUnit;
  const allUnits = Array.isArray(draftUnits) ? draftUnits : [draftUnits];
  let usedPicks = 0;
  const draftBoard = [];
  for (const unit of allUnits) {
    const dps = Array.isArray(unit.draftPick) ? unit.draftPick : unit.draftPick ? [unit.draftPick] : [];
    for (const dp of dps) {
      const team = franchiseName[dp.franchise] || `Franchise ${dp.franchise}`;
      const round = parseInt(dp.round, 10);
      const pick = parseInt(dp.pick, 10);
      const drafted = dp.player ? playerInfo[dp.player] : null;
      if (dp.player) {
        usedPicks++;
        draftBoard.push({
          team, round, pick,
          player: drafted ? drafted.name : `Player ${dp.player}`,
          pos: drafted ? drafted.pos : null,
          rookie: !!(drafted && drafted.rookie),
        });
      } else {
        picksOut.push({ team, year: SEASON, round, note: `Pick ${pick}` });
      }
    }
  }
  draftBoard.sort((a, b) => a.round - b.round || a.pick - b.pick);

  // --- picks: future seasons from futureDraftPicks, exact "via" from originalPickFor ---
  for (const franchise of futurePicks.futureDraftPicks.franchise) {
    const team = franchiseName[franchise.id] || `Franchise ${franchise.id}`;
    for (const fp of franchise.futureDraftPick || []) {
      const original = fp.originalPickFor;
      const note = original && original !== franchise.id ? `via ${franchiseName[original] || `Franchise ${original}`}` : "";
      picksOut.push({ team, year: parseInt(fp.year, 10), round: parseInt(fp.round, 10), note });
    }
  }

  // --- write ---
  backup("seed_roster_final.json");
  backup("seed_picks_final.json");
  fs.writeFileSync(path.join(ROOT, "seed_roster_final.json"), JSON.stringify(rosterOut));
  fs.writeFileSync(path.join(ROOT, "seed_picks_final.json"), JSON.stringify(picksOut));
  fs.writeFileSync(path.join(ROOT, "mfl_rosters.json"), JSON.stringify(rosters));
  fs.writeFileSync(path.join(ROOT, "mfl_league.json"), JSON.stringify(league));
  fs.writeFileSync(path.join(ROOT, "mfl_draftresults.json"), JSON.stringify(draftResults));
  fs.writeFileSync(path.join(ROOT, "mfl_futurepicks.json"), JSON.stringify(futurePicks));
  fs.writeFileSync(path.join(ROOT, "draft_board.json"), JSON.stringify(draftBoard));

  console.log(`\nWrote ${rosterOut.length} roster entries, ${picksOut.length} unused pick entries.`);
  console.log(`${SEASON} draft: ${usedPicks} picks made (written to draft_board.json), ${rookieCount} rookies flagged league-wide.`);
  if (usedPicks && picksOut.some((p) => p.year === SEASON)) {
    console.log(`NOTE: the ${SEASON} draft looks partially complete — some slots still unused.`);
  }
  if (missingPlayers) console.log(`${missingPlayers} roster player id(s) had no match in the players export — check the warnings above.`);
  console.log(`${missingKtc} player(s) have no KTC value match (expected for defenses/some names — same as before).`);
  console.log(`\nPrevious files backed up as *.prev.json for comparison.`);
  console.log(`\nNext: node build.js   (then check hq/index.html, commit, push)`);
}

main().catch((e) => {
  console.error("\nFAILED:", e.message);
  console.error("If this is a login/permission error, set MFL_USERNAME and MFL_PASSWORD env vars and re-run.");
  process.exit(1);
});
