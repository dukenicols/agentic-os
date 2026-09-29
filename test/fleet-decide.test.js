'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { decide } = require('../fleet/lib/decide');
const { DEFAULT_LIMITS } = require('../fleet/lib/registry');
const { govStatusJSON } = require('./fleet-helpers');

const TODAY = '2026-09-28';
const owned = (extra = {}) => ({ current: { asanaGid: 'a1', govTaskId: 'T1' }, mappings: { a1: 'T1' }, runsByDay: {}, consecutiveFailures: 0, ...extra });
const fresh = (extra = {}) => ({ current: null, mappings: {}, runsByDay: {}, consecutiveFailures: 0, ...extra });
const Q = [{ gid: 'a2', name: 'next task' }];
const APPROVE_PLAN = 'human approval: run `gov approve plan` in your own terminal';
const APPROVE_SHIP = 'human approval: run `gov approve ship` in your own terminal';

const d = (status, pstate, queue = [], limits = DEFAULT_LIMITS) => decide({ status, pstate, queue, limits, today: TODAY });

test('AC3: start when no active task and the queue is non-empty', () => {
  const r = d(govStatusJSON(), fresh(), Q);
  assert.equal(r.action, 'start');
  assert.equal(r.asanaTask.gid, 'a2');
});

test('AC3: idle when there is no task and no queue', () => {
  assert.equal(d(govStatusJSON(), fresh(), []).action, 'idle');
});

test('AC3: an Asana task already mapped to a gov task is never started again', () => {
  const r = d(govStatusJSON(), fresh({ mappings: { a2: 'OLD' } }), Q);
  assert.equal(r.action, 'idle');
  const r2 = d(govStatusJSON(), fresh({ mappings: { a2: 'OLD' } }), [...Q, { gid: 'a3', name: 'x' }]);
  assert.equal(r2.asanaTask.gid, 'a3');
});

test('AC3: continue in build, review and test', () => {
  for (const phase of ['build', 'review', 'test']) {
    const r = d(govStatusJSON({ phase, missing: { [phase]: ['something missing'] } }), owned(), Q);
    assert.equal(r.action, 'continue', phase);
    assert.equal(r.phase, phase);
  }
});

test('AC3: continue in plan while the plan itself is unfinished', () => {
  const r = d(govStatusJSON({ phase: 'plan', missing: { plan: ['Goal: _TBD_'] }, human: { plan: [APPROVE_PLAN] } }), owned());
  assert.equal(r.action, 'continue');
});

test('AC3: continue in plan after approval (the agent advances to build)', () => {
  assert.equal(d(govStatusJSON({ phase: 'plan' }), owned()).action, 'continue');
});

test('once ship is approved fleet stops: releasing is the human\'s job', () => {
  const r = d(govStatusJSON({ phase: 'ship' }), owned());
  assert.equal(r.action, 'idle');
  assert.match(r.reason, /release is yours/);
});

test('a start whose gov task was never recorded does not own whatever task is active', () => {
  const r = d(govStatusJSON({ phase: 'build', missing: { build: ['x'] } }), fresh({ current: { asanaGid: 'a1', govTaskId: null } }));
  assert.equal(r.action, 'idle');
});

test('AC3: await-human plan when only the human plan approval is missing', () => {
  const r = d(govStatusJSON({ phase: 'plan', human: { plan: [APPROVE_PLAN] } }), owned(), Q);
  assert.deepEqual(r, { action: 'await-human', gate: 'plan', taskId: 'T1' });
});

test('AC3: await-human ship when in ship awaiting approval', () => {
  const r = d(govStatusJSON({ phase: 'ship', human: { ship: [APPROVE_SHIP] } }), owned());
  assert.deepEqual(r, { action: 'await-human', gate: 'ship', taskId: 'T1' });
  // a failing earlier gate in ship is agent work, not a human wait
  const r2 = d(govStatusJSON({ phase: 'ship', missing: { ship: ['test gate failing'] }, human: { ship: [APPROVE_SHIP] } }), owned());
  assert.equal(r2.action, 'continue');
});

test('AC3: awaiting a human is reported even when caps are hit', () => {
  const r = d(govStatusJSON({ phase: 'plan', human: { plan: [APPROVE_PLAN] } }), owned({ consecutiveFailures: 99 }));
  assert.equal(r.action, 'await-human');
});

test('AC3: paused when the project is paused', () => {
  const r = d(govStatusJSON(), fresh({ paused: true, pausedReason: 'holiday' }), Q);
  assert.deepEqual(r, { action: 'paused', reason: 'holiday' });
});

test('AC3: paused when the daily run cap is hit', () => {
  const r = d(govStatusJSON({ phase: 'build', missing: { build: ['x'] } }), owned({ runsByDay: { [TODAY]: DEFAULT_LIMITS.maxRunsPerProjectPerDay } }));
  assert.equal(r.action, 'paused');
  assert.match(r.reason, /daily run cap/);
  // yesterday's runs don't count
  const r2 = d(govStatusJSON({ phase: 'build', missing: { build: ['x'] } }), owned({ runsByDay: { '2026-09-27': 99 } }));
  assert.equal(r2.action, 'continue');
});

test('AC3: paused when consecutive failures reach the limit', () => {
  const r = d(govStatusJSON(), fresh({ consecutiveFailures: DEFAULT_LIMITS.maxConsecutiveFailures }), Q);
  assert.equal(r.action, 'paused');
  assert.match(r.reason, /consecutive failed runs/);
});

test('paused when gov status failed; idle for a task the human started by hand', () => {
  assert.equal(d({ error: 'agentic-os is not installed' }, fresh(), Q).action, 'paused');
  const r = d(govStatusJSON({ phase: 'build', missing: { build: ['x'] } }), fresh(), Q);
  assert.equal(r.action, 'idle');
  assert.match(r.reason, /not started by fleet/);
});
