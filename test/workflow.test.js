'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { sandbox, write, gov, activeRun, GOOD_PLAN, reviewDoc, VERIFICATION } = require('./helpers');

function toBuild(dir) {
  assert.equal(gov(dir, ['start', 'fix add']).code, 0);
  fs.writeFileSync(path.join(activeRun(dir), 'plan.md'), GOOD_PLAN);
  assert.equal(gov(dir, ['approve', 'plan']).code, 0);
  assert.equal(gov(dir, ['advance'], 'agent').code, 0);
}

test('happy path: plan → build → review → test → ship', () => {
  const dir = sandbox();
  toBuild(dir);
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

  assert.match(gov(dir, ['ship', 'x'], 'agent').out, /human approval/);
  assert.equal(gov(dir, ['approve', 'ship']).code, 0);
  assert.equal(gov(dir, ['ship', 'abc123'], 'agent').code, 0);
  assert.match(gov(dir, ['status']).out, /No active task/);
  assert.match(gov(dir, ['log', '--verify']).out, /intact/);
});

test('plan phase cannot be left without a complete, approved plan', () => {
  const dir = sandbox();
  gov(dir, ['start', 'x']);
  const r = gov(dir, ['advance'], 'agent');
  assert.equal(r.code, 2);
  assert.match(r.out, /_TBD_/);
  assert.match(r.out, /human approval/);
  // approving an incomplete plan is refused
  assert.match(gov(dir, ['approve', 'plan']).out, /incomplete/);
});

test('editing the plan after approval voids the approval', () => {
  const dir = sandbox();
  gov(dir, ['start', 'x']);
  fs.writeFileSync(path.join(activeRun(dir), 'plan.md'), GOOD_PLAN);
  gov(dir, ['approve', 'plan']);
  fs.appendFileSync(path.join(activeRun(dir), 'plan.md'), '\n- AC2: sneaky extra scope\n');
  assert.match(gov(dir, ['advance'], 'agent').out, /changed after approval/);
});

test('the agent cannot approve', () => {
  const dir = sandbox();
  gov(dir, ['start', 'x']);
  fs.writeFileSync(path.join(activeRun(dir), 'plan.md'), GOOD_PLAN);
  const r = gov(dir, ['approve', 'plan'], 'agent');
  assert.equal(r.code, 2);
  assert.match(r.out, /must come from a human/);
});

test('a failing build is recorded but does not satisfy the gate', () => {
  const dir = sandbox();
  toBuild(dir);
  write(dir, 'app.js', 'exports.add = (a, b) => ;\n'); // syntax error
  assert.equal(gov(dir, ['run', 'build'], 'agent').code, 1);
  assert.match(gov(dir, ['advance'], 'agent').out, /failed \(exit 1\)/);
});

test('configured commands are authoritative: no substituting `true`', () => {
  const dir = sandbox();
  toBuild(dir);
  const r = gov(dir, ['run', 'test', '--', 'true'], 'agent');
  assert.equal(r.code, 2);
  assert.match(r.out, /not a configured test command/);
});

test('changing code after review makes build and review stale', () => {
  const dir = sandbox();
  toBuild(dir);
  write(dir, 'app.js', 'exports.add = (a, b) => a + b;\n');
  gov(dir, ['run', 'build'], 'agent');
  gov(dir, ['advance'], 'agent');
  fs.writeFileSync(path.join(activeRun(dir), 'review.md'), reviewDoc('PASS', ['app.js']));
  gov(dir, ['record', 'review'], 'agent');

  write(dir, 'app.js', 'exports.add = (a, b) => a + b + 0;\n');
  const out = gov(dir, ['status']).out;
  assert.match(out, /passed on an older tree/);
  assert.match(out, /review is stale/);
  assert.equal(gov(dir, ['advance'], 'agent').code, 2);
});

test('committing does not invalidate evidence (fingerprint is content-based)', () => {
  const { git } = require('./helpers');
  const dir = sandbox();
  toBuild(dir);
  write(dir, 'app.js', 'exports.add = (a, b) => a + b;\n');
  gov(dir, ['run', 'build'], 'agent');
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'fix');
  assert.equal(gov(dir, ['check', 'build']).code, 0);
});

test('review must cover every changed file and have no open blockers', () => {
  const dir = sandbox();
  toBuild(dir);
  write(dir, 'app.js', 'exports.add = (a, b) => a + b;\n');
  write(dir, 'extra.js', '1;\n');
  gov(dir, ['run', 'build'], 'agent');
  gov(dir, ['advance'], 'agent');
  const file = path.join(activeRun(dir), 'review.md');

  fs.writeFileSync(file, reviewDoc('PASS', ['app.js']));
  assert.match(gov(dir, ['record', 'review'], 'agent').out, /not covered by the review: extra\.js/);

  fs.writeFileSync(file, reviewDoc('PASS', ['app.js', 'extra.js'], '- [ ] BLOCKER: bad thing'));
  assert.match(gov(dir, ['record', 'review'], 'agent').out, /unresolved BLOCKER/);

  fs.writeFileSync(file, reviewDoc('CHANGES_REQUESTED', ['app.js', 'extra.js'], '- [ ] BLOCKER: bad thing'));
  assert.equal(gov(dir, ['record', 'review'], 'agent').code, 0);
  assert.match(gov(dir, ['advance'], 'agent').out, /verdict is CHANGES_REQUESTED/);
});

test('verification must map every AC to PASS with evidence', () => {
  const dir = sandbox();
  toBuild(dir);
  write(dir, 'app.js', 'exports.add = (a, b) => a + b;\n');
  gov(dir, ['run', 'build'], 'agent');
  gov(dir, ['advance'], 'agent');
  fs.writeFileSync(path.join(activeRun(dir), 'review.md'), reviewDoc('PASS', ['app.js']));
  gov(dir, ['record', 'review'], 'agent');
  gov(dir, ['advance'], 'agent');
  const file = path.join(activeRun(dir), 'verification.md');

  fs.writeFileSync(file, '- AC1: PASS\n');
  assert.match(gov(dir, ['record', 'verification'], 'agent').out, /no "evidence:" pointer/);
  fs.writeFileSync(file, fs.readFileSync(path.join(dir, '.governance/templates/verification.md'), 'utf8'));
  assert.match(gov(dir, ['record', 'verification'], 'agent').out, /AC1 is not marked PASS/);
});

test('tampering with the ledger voids all evidence', () => {
  const dir = sandbox();
  toBuild(dir);
  const ledger = path.join(activeRun(dir), 'ledger.jsonl');
  const lines = fs.readFileSync(ledger, 'utf8').trim().split('\n');
  const e = JSON.parse(lines[1]);
  e.actor = 'human:someone-else';
  lines[1] = JSON.stringify(e);
  fs.writeFileSync(ledger, lines.join('\n') + '\n');
  assert.match(gov(dir, ['log', '--verify']).out, /broken at entry 1/);
  assert.match(gov(dir, ['status']).out, /ledger tampered/);
});

test('only one active task; abort closes it', () => {
  const dir = sandbox();
  gov(dir, ['start', 'a']);
  assert.match(gov(dir, ['start', 'b']).out, /still active/);
  assert.equal(gov(dir, ['abort', 'changed my mind']).code, 0);
  assert.equal(gov(dir, ['start', 'b']).code, 0);
});
