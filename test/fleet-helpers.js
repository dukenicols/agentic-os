'use strict';
// Fleet test helpers: a throwaway FLEET_HOME, a registry writer, and a fake `claude` executable.

const fs = require('fs');
const os = require('os');
const path = require('path');

const FLEET = path.join(__dirname, '..', 'fleet');
const SECRET = 'asana-secret-token-DO-NOT-LEAK-7f3a';

function fleetHomeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-test-'));
}

function writeRegistry(home, registry) {
  fs.writeFileSync(path.join(home, 'fleet.json'), JSON.stringify(registry, null, 2));
}

/**
 * A stand-in for `claude -p`. Records each call to $FAKE_CALLS (args, cwd, stdin, full env), prints
 * its environment to stdout (which lands in the run log), and behaves per env:
 *   FAKE_SLEEP_MS  wait before exiting      FAKE_EXIT  exit code (default 0)
 *   FAKE_START=1   run `gov start` in cwd, as an agent would on a start prompt
 */
function fakeClaude(dir) {
  const file = path.join(dir, 'fake-claude');
  fs.writeFileSync(
    file,
    `#!${process.execPath}
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
let stdin = '';
process.stdin.on('data', (d) => (stdin += d));
process.stdin.on('end', () => {
  const call = { args: process.argv.slice(2), cwd: process.cwd(), stdin, env: process.env, at: Date.now() };
  if (process.env.FAKE_CALLS) fs.appendFileSync(process.env.FAKE_CALLS, JSON.stringify(call) + '\\n');
  console.log(JSON.stringify({ type: 'system', subtype: 'init', env: process.env }));
  if (process.env.FAKE_START === '1') {
    spawnSync(process.execPath, [path.join(process.cwd(), '.governance', 'bin', 'gov'), 'start', 'from fake'], {
      cwd: process.cwd(), env: { ...process.env, CLAUDECODE: '1' },
    });
  }
  setTimeout(() => process.exit(Number(process.env.FAKE_EXIT || 0)), Number(process.env.FAKE_SLEEP_MS || 0));
});
`,
  );
  fs.chmodSync(file, 0o755);
  return file;
}

function calls(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

/** Recursively read every file under dir as one string (to assert a secret appears nowhere). */
function readAll(dir) {
  let out = '';
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) out += readAll(abs);
    else if (ent.isFile()) out += fs.readFileSync(abs, 'utf8');
  }
  return out;
}

/** A stub `gov status --json` result. */
function govStatusJSON({ phase = null, missing = {}, human = {} } = {}) {
  if (!phase) return { task: null, mode: 'enforce' };
  const gates = {};
  for (const p of ['plan', 'build', 'review', 'test', 'ship']) {
    const h = human[p] || [];
    const m = [...(missing[p] || []), ...h];
    gates[p] = { ok: m.length === 0, missing: m, human: h };
  }
  return { task: { id: 'T1', title: 'demo', phase }, mode: 'enforce', gates, changed: [] };
}

module.exports = { FLEET, SECRET, fleetHomeDir, writeRegistry, fakeClaude, calls, readAll, govStatusJSON };
