// Regenerates ../index.html (DERIK home page) and ../hq/index.html (the
// roster/keeper/draft tool) from their templates + the data files in this
// folder. Run with: node build.js   (from inside the build/ folder)
const fs = require('fs');
const path = require('path');

const root = __dirname;
const fonts = JSON.parse(fs.readFileSync(path.join(root, 'fonts_b64.json'), 'utf8'));

function injectFonts(html) {
  return html
    .replace('{{FONT_BEBAS}}', fonts.f1)
    .replace('{{FONT_DMMONO400}}', fonts.f2)
    .replace('{{FONT_DMMONO500}}', fonts.f3)
    .replace('{{FONT_INTER}}', fonts.f4)
    .replace('{{FONT_QUICKSAND}}', fonts.f5);
}

function checkResolved(html, label) {
  const remaining = html.match(/{{[A-Z_]+}}/g);
  if (remaining) {
    console.error(`ERROR: unresolved placeholders in ${label}:`, remaining);
    process.exit(1);
  }
}

// --- hq/index.html (Offseason HQ: rosters, keepers, picks, trade finder) ---
const hqOutPath = path.join(root, '..', 'hq', 'index.html');
let hqHtml = fs.readFileSync(path.join(root, 'template.html'), 'utf8');
const roster = fs.readFileSync(path.join(root, 'seed_roster_final.json'), 'utf8');
const picks = fs.readFileSync(path.join(root, 'seed_picks_final.json'), 'utf8');
// Written by sync-mfl.js once a draft has actually been run; before that
// there's no board to show, so the tab renders its own empty state.
const draftBoardPath = path.join(root, 'draft_board.json');
const draftBoard = fs.existsSync(draftBoardPath) ? fs.readFileSync(draftBoardPath, 'utf8') : '[]';

hqHtml = injectFonts(hqHtml)
  .replace('{{SEED_ROSTER}}', roster)
  .replace('{{SEED_PICKS}}', picks)
  .replace('{{DRAFT_BOARD}}', draftBoard);

checkResolved(hqHtml, 'build/template.html');
fs.writeFileSync(hqOutPath, hqHtml);
console.log('Wrote', hqOutPath, `(${(hqHtml.length / 1024).toFixed(0)} KB)`);

// --- index.html (DERIK home page) ---
const homeOutPath = path.join(root, '..', 'index.html');
let homeHtml = fs.readFileSync(path.join(root, '..', 'home', 'template.html'), 'utf8');
const facts = fs.readFileSync(path.join(root, 'facts.json'), 'utf8');

homeHtml = injectFonts(homeHtml).replace('{{FACTS}}', facts);

checkResolved(homeHtml, 'home/template.html');
fs.writeFileSync(homeOutPath, homeHtml);
console.log('Wrote', homeOutPath, `(${(homeHtml.length / 1024).toFixed(0)} KB)`);

// --- live/index.html (live scoreboard) ---
// The scoreboard's ?demo=1 mode is generated from the real post-draft
// rosters rather than hand-written, so it always shows this league's actual
// teams and players (and therefore never invents a kicker — the league
// doesn't roster them). Fake stat lines and game states only.
function buildDemoMatchups() {
  const rows = JSON.parse(roster);
  const byTeam = new Map();
  for (const r of rows) {
    if (!byTeam.has(r.team)) byTeam.set(r.team, []);
    byTeam.get(r.team).push(r);
  }
  // The league's real starting lineup. Must stay in step with LINEUP_SLOTS
  // in live/template.html — this generates the demo those slots render.
  const SLOTS = ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'QB/RB/WR/TE', 'RB/WR/TE', 'D'];
  const CONTEXTS = [
    ['Final · 27-20', false, 'post'], ['Q3 8:42', true, 'in'], ['● Q3 8:42', true, 'in'],
    ['Final · 31-24', false, 'post'], ['Q2 2:15', true, 'in'], ['Pregame', false, 'pre'],
    ['Q4 1:12', true, 'in'], ['Final · 20-16', false, 'post'], ['Q1 5:03', true, 'in'],
  ];
  let seq = 0;
  const mkPlayer = (r, i) => {
    const [contextText, live, phase] = CONTEXTS[(seq + i) % CONTEXTS.length];
    seq++;
    // Deterministic pseudo-points so the demo looks alive but never shifts
    // between builds.
    const h = [...r.player].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
    const points = phase === 'pre' ? 0 : Math.round(((h % 210) / 10) * 10) / 10;
    return {
      id: 'demo' + (++seq), name: r.player, pos: r.pos, nflTeam: r.nflTeam || null,
      points, contextText, live, statLine: phase === 'pre' ? '' : demoStatLine(r.pos, h),
    };
  };
  const teams = [...byTeam.keys()];
  const out = [];
  for (let i = 0; i + 1 < teams.length && out.length < 4; i += 2) {
    const side = (name) => {
      const pool = [...byTeam.get(name)];
      const starters = [];
      for (const slot of SLOTS) {
        const want = slot.includes('/') ? slot.split('/') : [slot];
        const idx = pool.findIndex((p) => want.includes(p.pos));
        if (idx !== -1) starters.push(pool.splice(idx, 1)[0]);
      }
      return {
        franchiseId: name, team: name,
        starters: starters.map(mkPlayer),
        bench: pool.map(mkPlayer),
      };
    };
    out.push({ home: side(teams[i]), away: side(teams[i + 1]) });
  }
  return out;
}
function demoStatLine(pos, h) {
  const n = (mod, add = 0) => (h % mod) + add;
  if (pos === 'QB') return `${n(180, 140)} YD, ${n(4)} TD, ${n(2)} INT`;
  if (pos === 'RB') return `${n(90, 20)} YD, ${n(2)} TD, ${n(5)} REC`;
  if (pos === 'WR') return `${n(9, 1)} REC, ${n(110, 15)} YD, ${n(2)} TD`;
  if (pos === 'TE') return `${n(6, 1)} REC, ${n(70, 10)} YD`;
  if (pos === 'D') return `${n(5)} SACK, ${n(3)} INT, ${n(28)} PA`;
  return '';
}

const liveOutPath = path.join(root, '..', 'live', 'index.html');
let liveHtml = fs.readFileSync(path.join(root, '..', 'live', 'template.html'), 'utf8');

liveHtml = injectFonts(liveHtml).replace('{{DEMO_MATCHUPS}}', JSON.stringify(buildDemoMatchups()));

checkResolved(liveHtml, 'live/template.html');
fs.writeFileSync(liveOutPath, liveHtml);
console.log('Wrote', liveOutPath, `(${(liveHtml.length / 1024).toFixed(0)} KB)`);
