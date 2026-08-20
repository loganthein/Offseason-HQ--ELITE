// Reads the raw LeagueLegacy pulls in scripts/raw/ and turns them into SQL
// insert statements matching the schema in worker/migrations/*.sql, one file
// per season so each stays under D1's per-execute size limit.
//
// Games come from the original ll_*.json pulls. draft_picks and
// transactions/transaction_items come from the richer ll_rich_*.json pulls
// (added later to capture traded draft picks and full multi-item trade
// detail — the original pulls only had a thin player_added/player_dropped
// pair that was empty for many real trades).
//
// Usage: node worker/scripts/import-league-history.js
// Output: worker/migrations/seed/*.sql (apply with `wrangler d1 execute
// <db-name> --remote --file=<path>` for each file — 0000_franchises.sql
// must run first since other tables reference it).
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

const teamIdMap = JSON.parse(fs.readFileSync(path.join(rawDir, 'll_season_team_id_map.json'), 'utf8'));

// --- games + team names come from the original (non-"rich") pulls ---
const gameFiles = fs
  .readdirSync(rawDir)
  .filter((f) => f.startsWith('ll_') && f.endsWith('.json') && f !== 'll_season_team_id_map.json' && !f.startsWith('ll_rich_'));
const seasons = [];
for (const f of gameFiles) {
  const data = JSON.parse(fs.readFileSync(path.join(rawDir, f), 'utf8'));
  for (const s of data.seasons || [data]) seasons.push(s);
}
seasons.sort((a, b) => a.year - b.year);

// --- draft_picks + transactions come from the richer pulls ---
const richFiles = fs.readdirSync(rawDir).filter((f) => f.startsWith('ll_rich_') && f.endsWith('.json'));
const richByYear = new Map();
for (const f of richFiles) {
  const data = JSON.parse(fs.readFileSync(path.join(rawDir, f), 'utf8'));
  for (const s of data.seasons) richByYear.set(s.year, s);
}

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

let nextTransactionId = 1;

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

  const rich = richByYear.get(s.year);
  if (rich) {
    // draft_picks
    const draftRows = rich.draft_results.map(
      ([round, pickInRound, isKeeper, fromTrade, originalOwnerId, playerName, position, value, franchiseId]) =>
        `(${s.year}, ${round}, ${pickInRound}, ${isKeeper ? 1 : 0}, ${fromTrade ? 1 : 0}, ${originalOwnerId ? originalOwnerId : 'NULL'}, ${franchiseId}, ${sqlStr(playerName)}, ${sqlStr(position)}, ${sqlNum(value)})`
    );
    if (draftRows.length) {
      lines.push(
        `INSERT INTO draft_picks (season, round, pick_in_round, is_keeper, from_trade, original_franchise_id, franchise_id, player_name, position, value) VALUES\n${draftRows.join(',\n')};`
      );
    }

    // transactions + transaction_items (season_team_id -> franchise_id via the lookup map)
    const txRows = [];
    const itemRows = [];
    for (const [week, ts, type, seasonTeamId, tradePartnerSeasonTeamId, faabBid, value, items] of rich.transactions) {
      const franchiseId = teamIdMap[seasonTeamId];
      if (!franchiseId) continue; // shouldn't happen, but skip rather than fail the whole import
      const partnerFranchiseId = tradePartnerSeasonTeamId ? teamIdMap[tradePartnerSeasonTeamId] : null;
      const transactionId = nextTransactionId++;
      txRows.push(
        `(${transactionId}, ${s.year}, ${sqlNum(week)}, ${sqlStr(ts)}, ${franchiseId}, ${sqlStr(type)}, ${partnerFranchiseId ? partnerFranchiseId : 'NULL'}, ${sqlNum(faabBid)}, ${sqlNum(value)})`
      );
      for (const [direction, itemType, playerName, position, pickRound, pickSeason, pickOriginalOwnerId] of items) {
        itemRows.push(
          `(${transactionId}, ${sqlStr(direction)}, ${sqlStr(itemType)}, ${sqlStr(playerName)}, ${sqlStr(position)}, ${sqlNum(pickRound)}, ${sqlNum(pickSeason)}, ${pickOriginalOwnerId ? pickOriginalOwnerId : 'NULL'})`
        );
      }
    }
    if (txRows.length) {
      lines.push(
        `INSERT INTO transactions (transaction_id, season, week, ts, franchise_id, type, trade_partner_franchise_id, faab_bid, value) VALUES\n${txRows.join(',\n')};`
      );
    }
    if (itemRows.length) {
      lines.push(
        `INSERT INTO transaction_items (transaction_id, direction, item_type, player_name, position, pick_round, pick_season, pick_original_franchise_id) VALUES\n${itemRows.join(',\n')};`
      );
    }
  }

  if (lines.length) {
    fs.writeFileSync(path.join(outDir, `${s.year}.sql`), lines.join('\n\n') + '\n');
  }
}

console.log(`Wrote seed SQL for ${seasons.length} seasons to ${outDir}`);
console.log(`Apply with, e.g.: wrangler d1 execute elite-league-history --remote --file=worker/migrations/seed/0000_franchises.sql`);
