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
const notes = fs.readFileSync(path.join(root, 'team_notes_min.json'), 'utf8');
// Written by sync-mfl.js once a draft has actually been run; before that
// there's no board to show, so the tab renders its own empty state.
const draftBoardPath = path.join(root, 'draft_board.json');
const draftBoard = fs.existsSync(draftBoardPath) ? fs.readFileSync(draftBoardPath, 'utf8') : '[]';

hqHtml = injectFonts(hqHtml)
  .replace('{{SEED_ROSTER}}', roster)
  .replace('{{SEED_PICKS}}', picks)
  .replace('{{TEAM_NOTES}}', notes)
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
const liveOutPath = path.join(root, '..', 'live', 'index.html');
let liveHtml = fs.readFileSync(path.join(root, '..', 'live', 'template.html'), 'utf8');

liveHtml = injectFonts(liveHtml);

checkResolved(liveHtml, 'live/template.html');
fs.writeFileSync(liveOutPath, liveHtml);
console.log('Wrote', liveOutPath, `(${(liveHtml.length / 1024).toFixed(0)} KB)`);
