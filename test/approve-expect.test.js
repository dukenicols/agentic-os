'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { sandbox, write, gov, activeRun, GOOD_PLAN, reviewDoc, VERIFICATION } = require('./helpers');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const ledger = (dir) => fs.readFileSync(path.join(activeRun(dir), 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const approvals = (dir) => ledger(dir).filter((e) => e.type === 'approval');
const statusJSON = (dir) => JSON.parse(gov(dir, ['status', '--json']).out);

function withPlan() {
  const dir = sandbox();
  gov(dir, ['start', 'fix add'], 'agent');
  fs.writeFileSync(path.join(activeRun(dir), 'plan.md'), GOOD_PLAN);
  return dir;
}

function toShip() {
  const dir = withPlan();
  assert.equal(gov(dir, ['approve', 'plan']).code, 0);
  assert.equal(gov(dir, ['advance'], 'agent').code, 0);
  write(dir, 'app.js', 'exports.add = (a, b) => a + b;\n');
  assert.equal(gov(dir, ['run', 'build'], 'agent').code, 0);
  assert.equal(gov(dir, ['advance'], 'agent').code, 0);
  fs.writeFileSync(path.join(activeRun(dir), 'review.md'), reviewDoc('PASS', ['app.js']));
  assert.equal(gov(dir, ['record', 'review'], 'agent').code, 0);
  assert.equal(gov(dir, ['advance'], 'agent').code, 0);
  assert.equal(gov(dir, ['run', 'test'], 'agent').code, 0);
  fs.writeFileSync(path.join(activeRun(dir), 'verification.md'), VERIFICATION);
  assert.equal(gov(dir, ['record', 'verification'], 'agent').code, 0);
  assert.equal(gov(dir, ['advance'], 'agent').code, 0);
  return dir;
}

test('AC1: status --json includes the plan hash', () => {
  const dir = withPlan();
  assert.equal(statusJSON(dir).planHash, sha(GOOD_PLAN));
});

test('AC1: approve plan --expect succeeds only for the current plan hash, and records --via', () => {
  const dir = withPlan();
  const bad = gov(dir, ['approve', 'plan', '--expect', sha('something else'), '--via', 'fleet-ui']);
  assert.equal(bad.code, 2);
  assert.match(bad.out, /plan\.md changed since it was reviewed/);
  assert.equal(approvals(dir).length, 0, 'nothing recorded on mismatch');

  const ok = gov(dir, ['approve', 'plan', '--expect', sha(GOOD_PLAN), '--via', 'fleet-ui']);
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /via fleet-ui/);
  const [a] = approvals(dir);
  assert.equal(a.via, 'fleet-ui');
  assert.equal(a.planHash, sha(GOOD_PLAN));
  assert.match(a.actor, /^human:/);
  assert.match(gov(dir, ['log', '--verify']).out, /intact/);
});

test('AC1: approve ship --expect succeeds only for the current tree fingerprint', () => {
  const dir = toShip();
  const fp = statusJSON(dir).gates.fingerprint;
  const bad = gov(dir, ['approve', 'ship', '--expect', '0'.repeat(64)]);
  assert.equal(bad.code, 2);
  assert.match(bad.out, /tree changed since it was reviewed/);
  assert.equal(approvals(dir).filter((a) => a.phase === 'ship').length, 0);
  assert.equal(gov(dir, ['approve', 'ship', '--expect', fp, '--via', 'fleet-ui']).code, 0);
  const ship = approvals(dir).find((a) => a.phase === 'ship');
  assert.equal(ship.fingerprint, fp);
  assert.equal(ship.via, 'fleet-ui');
});

test('AC1: without flags approval behaves as before; agents still cannot approve', () => {
  const dir = withPlan();
  assert.match(gov(dir, ['approve', 'plan', '--expect', sha(GOOD_PLAN)], 'agent').out, /must come from a human/);
  assert.equal(approvals(dir).length, 0);
  const r = gov(dir, ['approve', 'plan']);
  assert.equal(r.code, 0);
  assert.equal(approvals(dir)[0].via, undefined);
});

test('AC1: malformed flags are rejected without recording anything', () => {
  const dir = withPlan();
  assert.match(gov(dir, ['approve', 'plan', '--expect']).out, /--expect needs a value/);
  assert.match(gov(dir, ['approve', 'plan', '--via', 'Fleet UI!']).out, /--via must match/);
  assert.match(gov(dir, ['approve', 'plan', `--expect=${sha(GOOD_PLAN)}`]).out, /with a space/);
  assert.equal(approvals(dir).length, 0);
});

test('gov help documents --expect (fleet detects support from it)', () => {
  const dir = sandbox();
  assert.match(gov(dir, ['help']).out, /--expect/);
});

test('gov diff --patch shows real content even with hostile repo-local git attributes and config', () => {
  const dir = sandbox();
  gov(dir, ['start', 'x'], 'agent');
  fs.writeFileSync(path.join(activeRun(dir), 'plan.md'), GOOD_PLAN);
  write(dir, 'app.js', 'exports.add = (a, b) => a + b; function evil() {}\n');
  fs.mkdirSync(path.join(dir, '.git', 'info'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.git', 'info', 'attributes'), '*.js -diff\n*.js diff=hide\n');
  const git = (...a) => require('child_process').spawnSync('git', a, { cwd: dir });
  git('config', 'diff.hide.textconv', 'true');
  git('config', 'diff.external', 'true');
  git('config', 'diff.relative', 'true');
  const out = gov(dir, ['diff', '--patch']).out;
  assert.match(out, /function evil\(\) \{\}/);
  assert.doesNotMatch(out, /Binary files/);
});

// ------------------------------------------------------------ gov diff --patch is built from verified bytes

const cp = require('child_process');

function changedRepo() {
  const dir = sandbox();
  write(dir, 'lib.js', 'module.exports = 1;\n');
  cp.spawnSync('git', ['add', '-A'], { cwd: dir });
  cp.spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'lib'], { cwd: dir });
  gov(dir, ['start', 'x'], 'agent');
  write(dir, 'app.js', 'exports.add = (a, b) => a + b; function evil() {}\n');
  write(dir, 'lib.js', 'module.exports = 1; function evil2() {}\n');
  return dir;
}
const git = (dir, ...a) => cp.spawnSync('git', a, { cwd: dir, encoding: 'utf8' });

test('diff shows real changes despite clean filters, assume-unchanged, skip-worktree and replace refs', () => {
  const dir = changedRepo();
  fs.writeFileSync(path.join(dir, '.git', 'app.js.orig'), 'exports.add = (a, b) => a - b;\n'); // a working "clean" filter source
  fs.mkdirSync(path.join(dir, '.git', 'info'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.git', 'info', 'attributes'), '*.js filter=hide -diff\n');
  git(dir, 'config', 'filter.hide.clean', 'cat .git/app.js.orig');
  git(dir, 'update-index', '--assume-unchanged', 'app.js');
  git(dir, 'update-index', '--skip-worktree', 'lib.js');
  // replace the base blob of lib.js with an "already evil" one: the baseline hash check must reject it
  const fake = cp.spawnSync('git', ['hash-object', '-w', '--stdin'], { cwd: dir, input: 'module.exports = 1; function evil2() {}\n', encoding: 'utf8' }).stdout.trim();
  const real = git(dir, 'rev-parse', 'HEAD:lib.js').stdout.trim();
  git(dir, 'replace', real, fake);
  const out = gov(dir, ['diff', '--patch']).out;
  assert.match(out, /^\+exports\.add = \(a, b\) => a \+ b; function evil\(\) \{\}$/m);
  assert.match(out, /^\+module\.exports = 1; function evil2\(\) \{\}$/m);
  assert.match(out, /^-module\.exports = 1;$/m, 'old side came from the verified base, not the replace ref');
});

test('diff shows the whole current file when the base cannot be verified (base gone)', () => {
  const dir = changedRepo();
  // point the baseline at a commit that doesn't exist, as if history were rewritten and gc'd
  const runs = path.join(dir, '.governance', 'runs');
  const id = fs.readdirSync(runs).find((n) => !n.startsWith('.'));
  const bl = path.join(runs, id, 'baseline.json');
  const b = JSON.parse(fs.readFileSync(bl, 'utf8'));
  b.gitHead = 'f'.repeat(40);
  fs.writeFileSync(bl, JSON.stringify(b));
  const out = gov(dir, ['diff', '--patch']);
  assert.equal(out.code, 0);
  assert.match(out.out, /could not be verified[\s\S]*^\+module\.exports = 1; function evil2\(\) \{\}$/m);
  assert.match(out.out, /^\+exports\.add = \(a, b\) => a \+ b; function evil\(\) \{\}$/m);
});

test('diff shows NUL-containing files as text instead of hiding them', () => {
  const dir = changedRepo();
  write(dir, 'app.js', 'ok();\n// \u0000\nhidden();\n');
  const out = gov(dir, ['diff', '--patch']).out;
  assert.match(out, /contains NUL bytes/);
  assert.match(out, /^\+hidden\(\);$/m);
});

test('the line diff reconstructs both sides exactly', () => {
  const { lineOps } = require('../.governance/lib/core')._patch;
  let seed = 7;
  const rnd = (n) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) % n);
  for (let t = 0; t < 200; t++) {
    const a = Array.from({ length: rnd(30) }, () => `l${rnd(8)}`);
    const b = Array.from({ length: rnd(30) }, () => `l${rnd(8)}`);
    const ops = lineOps(a, b);
    assert.deepEqual(ops.filter((o) => o[0] !== '+').map((o) => o[1]), a);
    assert.deepEqual(ops.filter((o) => o[0] !== '-').map((o) => o[1]), b);
  }
});

test('diff shows byte changes that are not valid UTF-8, unambiguously', () => {
  const { filePatch, decodeBytes } = require('../.governance/lib/core')._patch;
  const p = filePatch('x.bin', Buffer.from([0x68, 0x69, 0x0a, 0xff, 0x0a]), Buffer.from([0x68, 0x69, 0x0a, 0xfe, 0x0a]), { added: false, removed: false });
  assert.match(p, /^-⟦0xFF⟧$/m);
  assert.match(p, /^\+⟦0xFE⟧$/m);
  assert.match(p, /not valid UTF-8/);
  // a literal "⟦0xFF⟧" and a real 0xFF byte never render the same
  const lit = Buffer.from('⟦0xFF⟧\n');
  const raw = Buffer.from([0xff, 0x0a]);
  assert.notEqual(decodeBytes(lit, true), decodeBytes(raw, true));
  const p2 = filePatch('y', lit, raw, { added: false, removed: false });
  assert.match(p2, /^-⟦⟦0xFF⟧$/m);
  assert.match(p2, /^\+⟦0xFF⟧$/m);
  // Latin-1 é vs ü, and U+FFFD vs 0xFF
  assert.match(filePatch('z', Buffer.from([0x63, 0xe9]), Buffer.from([0x63, 0xfc]), { added: false, removed: false }), /^\+c⟦0xFC⟧$/m);
  assert.match(filePatch('w', Buffer.from('�'), Buffer.from([0xff]), { added: false, removed: false }), /^\+⟦0xFF⟧$/m);
  // valid UTF-8 is untouched
  assert.equal(decodeBytes(Buffer.from('añ 日本 ⟦x⟧'), false), 'añ 日本 ⟦x⟧');
});

test('property: distinct byte strings always produce a visible change', () => {
  const { filePatch } = require('../.governance/lib/core')._patch;
  let seed = 11;
  const rnd = (n) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) % n);
  const alphabet = [0x0a, 0x0d, 0x41, 0xc3, 0xa9, 0xe2, 0x9f, 0xa6, 0xff, 0x00, 0xef, 0xbf, 0xbd];
  for (let t = 0; t < 500; t++) {
    const a = Buffer.from(Array.from({ length: rnd(12) }, () => alphabet[rnd(alphabet.length)]));
    const b = Buffer.from(Array.from({ length: rnd(12) }, () => alphabet[rnd(alphabet.length)]));
    if (a.equals(b)) continue;
    const p = filePatch('f', a, b, { added: false, removed: false });
    assert.match(p, /^[+-]/m, `no visible change for ${a.toString('hex')} → ${b.toString('hex')}`);
  }
});

test('symlinks are shown as their target, never followed', () => {
  const dir = changedRepo();
  const outside = path.join(require('os').tmpdir(), `secret-${process.pid}.txt`);
  fs.writeFileSync(outside, 'TOP-SECRET-CONTENT\n');
  fs.symlinkSync(outside, path.join(dir, 'link.txt'));
  const out = gov(dir, ['diff', '--patch']).out;
  assert.match(out, /symbolic link to/);
  assert.doesNotMatch(out, /TOP-SECRET-CONTENT/);
  fs.rmSync(outside);
});
