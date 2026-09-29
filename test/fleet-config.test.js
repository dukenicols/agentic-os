'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadRegistry, DEFAULT_LIMITS } = require('../fleet/lib/registry');
const { createAsana } = require('../fleet/lib/asana');
const { FLEET, SECRET, fleetHomeDir, writeRegistry, fakeClaude, calls } = require('./fleet-helpers');

const PROJECT = { name: 'demo', path: '/srv/repos/demo', asanaProjectGid: '123' };

function fleetCli(home, args, env = {}) {
  const e = { ...process.env, FLEET_HOME: home, ...env };
  if (!('ASANA_TOKEN' in env)) delete e.ASANA_TOKEN;
  const r = spawnSync(process.execPath, [path.join(FLEET, 'bin', 'fleet'), ...args], { encoding: 'utf8', env: e });
  return { code: r.status, out: r.stdout + r.stderr };
}

// ------------------------------------------------------------------ AC1

test('AC1: missing fleet.json fails closed', () => {
  const home = fleetHomeDir();
  assert.throws(() => loadRegistry(home), /missing or not valid JSON.*failing closed/);
  const r = fleetCli(home, ['tick'], { ASANA_TOKEN: 'x' });
  assert.equal(r.code, 2);
  assert.match(r.out, /failing closed/);
});

test('AC1: invalid fleet.json lists every problem and performs no runs', () => {
  const home = fleetHomeDir();
  const bin = fakeClaude(home);
  const callsFile = path.join(home, 'calls.jsonl');
  const bad = [
    { projects: [] },
    { projects: [{ ...PROJECT, path: 'relative/path' }] },
    { projects: [{ ...PROJECT, asanaProjectGid: 123 }] },
    { projects: [PROJECT, { ...PROJECT }] },
    { projects: [PROJECT], limits: { maxConcurrent: 0 } },
    { projects: [PROJECT], limits: { bogus: 1 } },
    { projects: [{ ...PROJECT, allowedTools: 'Bash' }] },
    { projects: [PROJECT], asana: { section: '  ' } },
    [],
  ];
  for (const cfg of bad) {
    writeRegistry(home, Array.isArray(cfg) ? cfg : { claudeBin: bin, ...cfg });
    assert.throws(() => loadRegistry(home), /invalid.*failing closed/, JSON.stringify(cfg));
    const r = fleetCli(home, ['tick'], { ASANA_TOKEN: 'x', FAKE_CALLS: callsFile });
    assert.equal(r.code, 2, JSON.stringify(cfg));
  }
  assert.equal(calls(callsFile).length, 0);
});

test('AC1: a valid config loads with defaults applied', () => {
  const home = fleetHomeDir();
  writeRegistry(home, { projects: [PROJECT, { ...PROJECT, name: 'other', enabled: false, allowedTools: ['Read'] }], limits: { maxConcurrent: 4 } });
  const r = loadRegistry(home);
  assert.deepEqual(r.limits, { ...DEFAULT_LIMITS, maxConcurrent: 4 });
  assert.equal(r.asana.section, 'Agente');
  assert.equal(r.claudeBin, 'claude');
  assert.deepEqual(r.projects[0], { ...PROJECT, enabled: true, allowedTools: [] });
  assert.equal(r.projects[1].enabled, false);
});

// ------------------------------------------------------------------ AC2

function stubFetch(routes, seen = []) {
  return async (url, opts) => {
    seen.push({ url, opts });
    const route = Object.keys(routes).find((r) => url.includes(r));
    if (!route) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ data: routes[route] }) };
  };
}

test('AC2: queue returns only incomplete tasks from the configured section of the project', async () => {
  const seen = [];
  const fetch = stubFetch(
    {
      '/projects/999/sections': [{ gid: 's1', name: 'Backlog' }, { gid: 's2', name: ' agente ' }],
      '/sections/s2/tasks': [
        { gid: 't1', name: 'Add login', notes: 'details', permalink_url: 'https://app.asana.com/t1', completed: false },
        { gid: 't2', name: 'Done thing', completed: true },
        { gid: 't3', name: 'Fix footer', completed: false },
      ],
    },
    seen,
  );
  const asana = createAsana({ token: SECRET, fetch });
  const q = await asana.queue('999', 'Agente');
  assert.equal(q.section, 's2');
  assert.deepEqual(q.tasks.map((t) => t.gid), ['t1', 't3']);
  assert.deepEqual(q.tasks[0], { gid: 't1', name: 'Add login', notes: 'details', url: 'https://app.asana.com/t1' });
  assert.ok(seen.every((s) => s.url.startsWith('https://app.asana.com/api/1.0/')));
  assert.ok(seen[0].url.includes('/projects/999/'));
  assert.ok(seen[1].url.includes('/sections/s2/tasks') && seen[1].url.includes('completed_since=now'));
  assert.ok(seen.every((s) => s.opts.headers.Authorization === `Bearer ${SECRET}`));
  assert.ok(!seen.some((s) => s.url.includes('/sections/s1')), 'other sections are never read');
});

test('AC2: a project without the configured section is an error, not an empty queue', async () => {
  const asana = createAsana({ token: 't', fetch: stubFetch({ '/projects/1/sections': [{ gid: 's1', name: 'Backlog' }] }) });
  await assert.rejects(asana.queue('1', 'Agente'), /no section named "Agente"/);
});

test('AC2: token comes only from ASANA_TOKEN; missing token is an error and tick runs nothing', () => {
  const saved = process.env.ASANA_TOKEN;
  try {
    delete process.env.ASANA_TOKEN;
    assert.throws(() => createAsana({ fetch: stubFetch({}) }), /ASANA_TOKEN is not set/);
    process.env.ASANA_TOKEN = 'from-env';
    const seen = [];
    createAsana({ fetch: stubFetch({}, seen) }).queue('1', 'x').catch(() => {});
    return new Promise((r) => setImmediate(r)).then(() => assert.equal(seen[0].opts.headers.Authorization, 'Bearer from-env'));
  } finally {
    if (saved === undefined) delete process.env.ASANA_TOKEN;
    else process.env.ASANA_TOKEN = saved;
  }
});

test('AC2: fleet tick without ASANA_TOKEN exits with an error before any run', () => {
  const home = fleetHomeDir();
  const callsFile = path.join(home, 'calls.jsonl');
  writeRegistry(home, { claudeBin: fakeClaude(home), projects: [PROJECT] });
  const r = fleetCli(home, ['tick'], { FAKE_CALLS: callsFile });
  assert.equal(r.code, 2);
  assert.match(r.out, /ASANA_TOKEN is not set/);
  assert.equal(calls(callsFile).length, 0);
  assert.ok(!fs.existsSync(path.join(home, 'events.jsonl')));
});

test('AC8: Asana errors never include the token', async () => {
  const asana = createAsana({ token: SECRET, fetch: async () => ({ ok: false, status: 401, json: async () => ({}) }) });
  await assert.rejects(asana.queue('1', 'Agente'), (err) => !err.message.includes(SECRET) && /401/.test(err.message));
  const failing = createAsana({ token: SECRET, fetch: async () => { throw new Error('ECONNRESET'); } });
  await assert.rejects(failing.queue('1', 'Agente'), (err) => !err.message.includes(SECRET));
});
