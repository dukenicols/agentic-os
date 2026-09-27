'use strict';
// Build check: every JS file parses and every JSON config is valid.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const js = ['.governance/bin/gov', ...['.governance/lib', '.governance/hooks', 'scripts', 'test'].flatMap((d) =>
  fs.readdirSync(path.join(root, d)).filter((f) => f.endsWith('.js')).map((f) => `${d}/${f}`))];
const json = ['.governance/config.json', 'package.json', ...['.claude/settings.json', '.claude/settings.json.off'].filter((f) => fs.existsSync(path.join(root, f)))];

let failed = 0;
for (const f of js) {
  const r = spawnSync(process.execPath, ['--check', path.join(root, f)], { encoding: 'utf8' });
  if (r.status !== 0) { failed++; console.error(`✘ ${f}\n${r.stderr}`); }
}
for (const f of json) {
  try { JSON.parse(fs.readFileSync(path.join(root, f), 'utf8')); } catch (e) { failed++; console.error(`✘ ${f}: ${e.message}`); }
}
console.log(`${failed ? '✘' : '✔'} checked ${js.length} JS + ${json.length} JSON files, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
