'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { matchPath, validatePlan, acceptanceCriteria, diffManifests } = require('../.governance/lib/core');
const { GOOD_PLAN } = require('./helpers');

test('matchPath', () => {
  assert.ok(matchPath('node_modules/', 'node_modules/x/y.js'));
  assert.ok(matchPath('node_modules/', 'pkg/node_modules/x.js'));
  assert.ok(matchPath('.governance/runs/', '.governance/runs/a/ledger.jsonl'));
  assert.ok(!matchPath('.governance/runs/', 'x/.governance/runs/a'));
  assert.ok(matchPath('.env.*', 'config/.env.local'));
  assert.ok(!matchPath('.env', '.env.example'));
  assert.ok(matchPath('*.pem', 'a/b/c.pem'));
  assert.ok(matchPath('AGENTS.md', 'AGENTS.md'));
  assert.ok(matchPath('AGENTS.md', 'docs/AGENTS.md')); // nested instruction files are protected too
  assert.ok(!matchPath('AGENTS.md', 'docs/AGENTS.md.bak'));
});

test('validatePlan', () => {
  assert.deepEqual(validatePlan(GOOD_PLAN), []);
  assert.ok(validatePlan('').length);
  assert.ok(validatePlan(GOOD_PLAN.replace('## Rollback', '## Other')).some((p) => /Rollback/.test(p)));
  assert.ok(validatePlan(GOOD_PLAN.replace('- AC1: add(2, 2) returns 4', 'it works')).some((p) => /acceptance/.test(p)));
});

test('acceptanceCriteria dedupes and normalises ids', () => {
  const md = '## Acceptance Criteria\n- AC1: a\n- [ ] AC-2: b\n- ac1: dup\n## Approach\n- AC9: not here\n';
  assert.deepEqual(acceptanceCriteria(md), ['AC1', 'AC2']);
});

test('diffManifests', () => {
  const d = diffManifests({ a: '1', b: '2', c: '3' }, { a: '1', b: 'X', d: '4' });
  assert.deepEqual(d, { added: ['d'], removed: ['c'], modified: ['b'], all: ['b', 'c', 'd'] });
});
