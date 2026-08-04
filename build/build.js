// Regenerates ../index.html from template.html + the data files in this folder.
// Run with: node build.js   (from inside the build/ folder)
const fs = require('fs');
const path = require('path');

const root = __dirname;
const outPath = path.join(root, '..', 'index.html');

let html = fs.readFileSync(path.join(root, 'template.html'), 'utf8');
const fonts = JSON.parse(fs.readFileSync(path.join(root, 'fonts_b64.json'), 'utf8'));
const roster = fs.readFileSync(path.join(root, 'seed_roster_final.json'), 'utf8');
const picks = fs.readFileSync(path.join(root, 'seed_picks_final.json'), 'utf8');
const notes = fs.readFileSync(path.join(root, 'team_notes_min.json'), 'utf8');

html = html.replace('{{FONT_BEBAS}}', fonts.f1);
html = html.replace('{{FONT_DMMONO400}}', fonts.f2);
html = html.replace('{{FONT_DMMONO500}}', fonts.f3);
html = html.replace('{{FONT_INTER}}', fonts.f4);
html = html.replace('{{SEED_ROSTER}}', roster);
html = html.replace('{{SEED_PICKS}}', picks);
html = html.replace('{{TEAM_NOTES}}', notes);

const remaining = html.match(/{{[A-Z_]+}}/g);
if (remaining) {
  console.error('ERROR: unresolved placeholders:', remaining);
  process.exit(1);
}

fs.writeFileSync(outPath, html);
console.log('Wrote', outPath, `(${(html.length / 1024).toFixed(0)} KB)`);
