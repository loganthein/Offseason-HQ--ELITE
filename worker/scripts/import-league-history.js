// Reads the raw LeagueLegacy pulls in scripts/raw/ and turns them into SQL
// insert statements matching worker/migrations/0001_init.sql, one file per
// season so each stays under D1's per-execute size limit.
//
// Usage: node worker/scripts/import-league-history.js
// Output: worker/migrations/seed/*.sql (apply with `wrangler d1 execute
// <db-name> --remote --file=<path>` for each file, in any order except
// 0000_franchises.sql must run first since other tables reference it).
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const rawDir = path.join(root, 'scripts', 'raw');
const outDir = path.join(__dirname, '..', 'migrations', 'seed');
fs.mkdirSync(outDir, { recursive: true });

function sqlStr(v) {
  if (v === null || v === undefined) return 'NULL';
  return `'${String(v).replace(/'/g, "''")}'`;
}
function sqlNum(v) {
  if (v === null || v === undefined || v === '') return 'NULL';
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : 'NULL';
}

// --- Load raw season pulls (files are either a single {year,...} object or
// a {seasons: [...]} batch of several years) ---
const seasonFiles = fs.readdirSync(rawDir).filter((f) => f.startsWith('ll_') && f.endsWith('.json') && f !== 'll_season_team_id_map.json');
const seasons = [];
for (const f of seasonFiles) {
  const data = JSON.parse(fs.readFileSync(path.join(rawDir, f), 'utf8'));
  for (const s of data.seasons || [data]) seasons.push(s);
}
seasons.sort((a, b) => a.year - b.year);

const teamIdMap = JSON.parse(fs.readFileSync(path.join(rawDir, 'll_season_team_id_map.json'), 'utf8'));

// --- franchises + franchise_names ---
const franchiseNames = new Map(); // franchise_id -> latest name seen
const franchiseNameRows = [];
for (const s of seasons) {
  for (const t of s.teams) {
    franchiseNames.set(t.id, t.name);
    franchiseNameRows.push(`(${t.id}, ${s.year}, ${sqlStr(t.name)})`);
  }
}
const franchiseRows = [...franchiseNames.entries()].sort((a, b) => a[0] - b[0]).map(([id, name]) => `(${id}, ${sqlStr(name)})`);

fs.writeFileSync(
  path.join(outDir, '0000_franchises.sql'),
  `INSERT INTO franchises (franchise_id, display_name) VALUES\n${franchiseRows.join(',\n')};\n\n` +
    `INSERT INTO franchise_names (franchise_id, season, name) VALUES\n${franchiseNameRows.join(',\n')};\n`
);

// --- per-season games / draft_picks / transactions ---
for (const s of seasons) {
  const lines = [];

  // games: matchup rows come in mirrored pairs (one per team's perspective).
  // Keep one row per actual game, with the lower franchise_id as "home".
  const seenGames = new Set();
  const gameRows = [];
  for (const [week, isPlayoff, isChampionship, , points, oppPoints, coachScore, luck, teamId, oppId] of s.matchups) {
    const a = Math.min(teamId, oppId);
    const b = Math.max(teamId, oppId);
    const key = `${week}-${a}-${b}`;
    if (seenGames.has(key)) continue;
    seenGames.add(key);
    const homeIsTeam = teamId === a;
    const homeScore = homeIsTeam ? points : oppPoints;
    const awayScore = homeIsTeam ? oppPoints : points;
    const homeCoach = homeIsTeam ? coachScore : null;
    const awayCoach = homeIsTeam ? null : coachScore;
    const homeLuck = homeIsTeam ? luck : null;
    const awayLuck = homeIsTeam ? null : luck;
    gameRows.push(
      `(${s.year}, ${sqlNum(week)}, ${isPlayoff ? 1 : 0}, ${isChampionship ? 1 : 0}, ${a}, ${b}, ${sqlNum(homeScore)}, ${sqlNum(awayScore)}, ${sqlNum(homeCoach)}, ${sqlNum(awayCoach)}, ${sqlNum(homeLuck)}, ${sqlNum(awayLuck)})`
    );
  }
  if (gameRows.length) {
    lines.push(
      `INSERT INTO games (season, week, is_playoff, is_championship, home_franchise_id, away_franchise_id, home_score, away_score, home_coach_score, away_coach_score, home_luck, away_luck) VALUES\n${gameRows.join(',\n')};`
    );
  }

  // draft_picks
  const draftRows = s.draft_results.map(
    ([round, pickInRound, isKeeper, playerName, position, value, franchiseId]) =>
      `(${s.year}, ${round}, ${pickInRound}, ${isKeeper ? 1 : 0}, ${franchiseId}, ${sqlStr(playerName)}, ${sqlStr(position)}, ${sqlNum(value)})`
  );
  if (draftRows.length) {
    lines.push(
      `INSERT INTO draft_picks (season, round, pick_in_round, is_keeper, franchise_id, player_name, position, value) VALUES\n${draftRows.join(',\n')};`
    );
  }

  // transactions (season_team_id -> franchise_id via the lookup map)
  const txRows = [];
  for (const [week, ts, type, playerAdded, valueAdded, playerDropped, valueDropped, faabBid, seasonTeamId] of s.transactions) {
    const franchiseId = teamIdMap[seasonTeamId];
    if (!franchiseId) continue; // shouldn't happen, but skip rather than fail the whole import
    txRows.push(
      `(${s.year}, ${sqlNum(week)}, ${sqlStr(ts)}, ${franchiseId}, ${sqlStr(type)}, ${sqlStr(playerAdded)}, ${sqlNum(valueAdded)}, ${sqlStr(playerDropped)}, ${sqlNum(valueDropped)}, ${sqlNum(faabBid)})`
    );
  }
  if (txRows.length) {
    lines.push(
      `INSERT INTO transactions (season, week, ts, franchise_id, type, player_added, value_added, player_dropped, value_dropped, faab_bid) VALUES\n${txRows.join(',\n')};`
    );
  }

  if (lines.length) {
    fs.writeFileSync(path.join(outDir, `${s.year}.sql`), lines.join('\n\n') + '\n');
  }
}

console.log(`Wrote seed SQL for ${seasons.length} seasons to ${outDir}`);
console.log(`Apply with, e.g.: wrangler d1 execute elite-league-history --remote --file=worker/migrations/seed/0000_franchises.sql`);
