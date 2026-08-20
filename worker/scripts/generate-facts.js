// Builds the "Did You Know" fact deck for the DERIK home page from the same
// schema+seed data used to validate the D1 import. Two kinds of facts:
//   - "record" facts: always-true league records, shown as the daily fallback
//   - "onthisday" facts: real transactions/drafts tagged with the calendar
//     day they happened, shown when today's date matches
// Output: ../../build/facts.json (bundled into the home page by build.js)
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const root = path.join(__dirname, "..", "..");
const db = new DatabaseSync(":memory:");
db.exec(fs.readFileSync(path.join(root, "worker", "migrations", "0001_init.sql"), "utf8"));
const seedDir = path.join(root, "worker", "migrations", "seed");
for (const f of fs.readdirSync(seedDir).sort()) db.exec(fs.readFileSync(path.join(seedDir, f), "utf8"));
db.exec(fs.readFileSync(path.join(root, "worker", "migrations", "0002_champions.sql"), "utf8"));
db.exec(fs.readFileSync(path.join(root, "worker", "migrations", "0003_owners.sql"), "utf8"));

const all = (q, ...params) => db.prepare(q).all(...params);
const name = (id, season) => {
  const row = db.prepare("select name from franchise_names where franchise_id=? and season=?").get(id, season);
  return row ? row.name : db.prepare("select display_name from franchises where franchise_id=?").get(id).display_name;
};

const record = [];

// Biggest blowout
for (const g of all(`select *, abs(home_score-away_score) margin from games order by margin desc limit 1`)) {
  const winner = g.home_score > g.away_score ? g.home_franchise_id : g.away_franchise_id;
  const loser = g.home_score > g.away_score ? g.away_franchise_id : g.home_franchise_id;
  const wScore = Math.max(g.home_score, g.away_score);
  const lScore = Math.min(g.home_score, g.away_score);
  record.push(
    `The biggest blowout in league history: **${name(winner, g.season)}** demolished **${name(loser, g.season)}** ${wScore}–${lScore} in Week ${g.week}, ${g.season} — a ${g.margin.toFixed(1)}-point margin.`
  );
}

// Closest game
for (const g of all(`select *, abs(home_score-away_score) margin from games where home_score<>away_score order by margin asc limit 1`)) {
  const winner = g.home_score > g.away_score ? g.home_franchise_id : g.away_franchise_id;
  const loser = g.home_score > g.away_score ? g.away_franchise_id : g.home_franchise_id;
  const wScore = Math.max(g.home_score, g.away_score);
  const lScore = Math.min(g.home_score, g.away_score);
  record.push(
    `The closest game in league history: **${name(winner, g.season)}** edged **${name(loser, g.season)}** ${wScore}–${lScore} in Week ${g.week}, ${g.season} — a margin of just ${g.margin.toFixed(2)} points.`
  );
}

// Highest single-game score
{
  const rows = all(`
    select season, week, home_franchise_id fid, home_score s from games
    union all
    select season, week, away_franchise_id fid, away_score s from games
    order by s desc limit 1
  `);
  const r = rows[0];
  record.push(`The highest single-game score in league history: **${name(r.fid, r.season)}** dropped ${r.s} points in Week ${r.week}, ${r.season}.`);
}

// Lowest single-game score
{
  const rows = all(`
    select season, week, home_franchise_id fid, home_score s from games
    union all
    select season, week, away_franchise_id fid, away_score s from games
    order by s asc limit 1
  `);
  const r = rows[0];
  record.push(`The lowest single-game score in league history: **${name(r.fid, r.season)}** managed only ${r.s} points in Week ${r.week}, ${r.season}.`);
}

// Most championships (by franchise; ties handled)
{
  const byFranchise = all(`select franchise_id, count(*) c from season_champions group by franchise_id order by c desc`);
  const top = byFranchise[0].c;
  const leaders = byFranchise.filter((r) => r.c === top).map((r) => `**${name(r.franchise_id, 2025)}**`);
  const list = leaders.length > 1 ? leaders.slice(0, -1).join(", ") + " and " + leaders[leaders.length - 1] : leaders[0];
  record.push(`${list} ${leaders.length > 1 ? "are tied for" : "has"} the most championships in league history: ${top}.`);
}

// Most championships by owner (ties handled — several owners share the top spot)
{
  const byOwner = all(`
    select fo.owner_name, count(*) c from season_champions sc
    join franchise_owners fo on fo.franchise_id = sc.franchise_id
    group by fo.owner_name order by c desc
  `);
  const top = byOwner[0].c;
  const leaders = byOwner.filter((r) => r.c === top).map((r) => `**${r.owner_name}**`);
  const list = leaders.length > 1 ? leaders.slice(0, -1).join(", ") + " and " + leaders[leaders.length - 1] : leaders[0];
  record.push(`${list} ${leaders.length > 1 ? "are tied for" : "has"} the most championships of any owner in league history: ${top}.`);
}

// Best / worst all-time win pct (min 60 games)
{
  const rows = all(`
    select fid, sum(w) wins, count(*) games, cast(sum(w) as real)/count(*) pct from (
      select home_franchise_id fid, case when home_score>away_score then 1 else 0 end w from games
      union all
      select away_franchise_id fid, case when away_score>home_score then 1 else 0 end w from games
    ) group by fid having games>=60 order by pct desc limit 1
  `);
  const r = rows[0];
  record.push(`**${name(r.fid, 2025)}** owns the best all-time winning percentage in the league: ${(r.pct * 100).toFixed(1)}% (${r.wins}-${r.games - r.wins}).`);
}
{
  const rows = all(`
    select fid, sum(w) wins, count(*) games, cast(sum(w) as real)/count(*) pct from (
      select home_franchise_id fid, case when home_score>away_score then 1 else 0 end w from games
      union all
      select away_franchise_id fid, case when away_score>home_score then 1 else 0 end w from games
    ) group by fid having games>=60 order by pct asc limit 1
  `);
  const r = rows[0];
  record.push(`**${name(r.fid, 2025)}** owns the worst all-time winning percentage in the league: ${(r.pct * 100).toFixed(1)}% (${r.wins}-${r.games - r.wins}).`);
}

// Best/worst draft value
for (const p of all(`select * from draft_picks where value is not null order by value desc limit 1`)) {
  record.push(`The best-value draft pick in league history: **${name(p.franchise_id, p.season)}** took **${p.player_name}** in Round ${p.round}, Pick ${p.pick_in_round} of the ${p.season} draft — graded +${Number(p.value).toFixed(1)}.`);
}
for (const p of all(`select * from draft_picks where value is not null order by value asc limit 1`)) {
  record.push(`The biggest draft bust in league history: **${p.player_name}**, taken by **${name(p.franchise_id, p.season)}** in the ${p.season} draft — graded ${Number(p.value).toFixed(1)}.`);
}

// Highest FAAB bid
for (const t of all(`select * from transactions where faab_bid is not null order by faab_bid desc limit 1`)) {
  record.push(`The biggest FAAB bid in league history: **${name(t.franchise_id, t.season)}** paid $${t.faab_bid} to add **${t.player_added}** in ${t.season}.`);
}

// Most transactions in a season by one franchise
for (const r of all(`select franchise_id, season, count(*) c from transactions group by franchise_id, season order by c desc limit 1`)) {
  record.push(`Most moves in a single season: **${name(r.franchise_id, r.season)}** made ${r.c} transactions in ${r.season}.`);
}

// --- On this day (real calendar dates from transaction timestamps) ---
const onthisday = [];
const trades = all(`select * from transactions where type='trade' and ts is not null and (player_added is not null or player_dropped is not null)`);
for (const t of trades) {
  const d = new Date(t.ts.replace(" ", "T") + "Z");
  if (isNaN(d)) continue;
  let detail;
  if (t.player_added && t.player_dropped) detail = `— adding **${t.player_added}**, sending away **${t.player_dropped}**`;
  else if (t.player_added) detail = `— acquiring **${t.player_added}**`;
  else detail = `— trading away **${t.player_dropped}**`;
  onthisday.push({
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    year: d.getUTCFullYear(),
    text: `On this day in ${d.getUTCFullYear()}, **${name(t.franchise_id, t.season)}** made a trade ${detail}.`,
  });
}
// notable big-FAAB or big-value adds, also real-dated
const notableAdds = all(`select * from transactions where ts is not null and (faab_bid>=40 or value_added>=15) order by ts`);
for (const t of notableAdds) {
  const d = new Date(t.ts.replace(" ", "T") + "Z");
  if (isNaN(d)) continue;
  const detail = t.faab_bid >= 40 ? `for $${t.faab_bid} FAAB` : `off waivers`;
  onthisday.push({
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    year: d.getUTCFullYear(),
    text: `On this day in ${d.getUTCFullYear()}, **${name(t.franchise_id, t.season)}** added **${t.player_added}** ${detail}.`,
  });
}

const out = { record, onthisday };
fs.writeFileSync(path.join(root, "build", "facts.json"), JSON.stringify(out));
console.log(`Wrote facts.json: ${record.length} record facts, ${onthisday.length} on-this-day facts`);
