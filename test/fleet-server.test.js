'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { createServer } = require('../fleet/lib/server');
const { FleetState } = require('../fleet/lib/state');
const { DEFAULT_LIMITS } = require('../fleet/lib/registry');
const { sandbox, gov, activeRun, GOOD_PLAN } = require('./helpers');
const { SECRET, fleetHomeDir } = require('./fleet-helpers');

function setup() {
  const repo = sandbox();
  gov(repo, ['start', 'Add login'], 'agent');
  fs.writeFileSync(path.join(activeRun(repo), 'plan.md'), GOOD_PLAN);
  const idle = sandbox();
  const home = fleetHomeDir();
  const state = new FleetState(home);
  Object.assign(state.project('web'), {
    current: { asanaGid: 'A1', asanaName: 'Add login', asanaUrl: 'https://app.asana.com/A1', govTaskId: null },
    lastRun: { runId: 'run-1', action: 'start', exitCode: 0, ok: true, durationMs: 1200, at: new Date().toISOString() },
    last: { action: 'await-human', queue: [{ gid: 'A2', name: 'Next', url: null }], at: new Date().toISOString() },
  });
  state.save();
  fs.mkdirSync(path.dirname(state.runLogPath('web', 'run-1')), { recursive: true });
  fs.writeFileSync(state.runLogPath('web', 'run-1'), '{"type":"system","subtype":"init"}\nhello from the agent\n');
  state.event('run-end', { project: 'web', runId: 'run-1', ok: true });
  const registry = {
    projects: [
      { name: 'web', path: repo, asanaProjectGid: '1', enabled: true, allowedTools: [] },
      { name: 'api', path: idle, asanaProjectGid: '2', enabled: true, allowedTools: [] },
      { name: 'missing', path: path.join(home, 'nope'), asanaProjectGid: '3', enabled: true, allowedTools: [] },
    ],
    asana: { section: 'Agente' },
    limits: DEFAULT_LIMITS,
    claudeBin: 'claude',
  };
  return { repo, home, state, registry };
}

function listen(server, host) {
  return new Promise((resolve) => server.listen(0, host, () => resolve(server.address())));
}

function request(port, pathname, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ code: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('AC6: /api/fleet reports phase, gates with missing evidence, awaiting approval, and the Asana link', async (t) => {
  const { state, registry } = setup();
  const server = createServer({ registry, state });
  const { port } = await listen(server, '127.0.0.1');
  t.after(() => server.close());

  const r = await request(port, '/api/fleet');
  assert.equal(r.code, 200);
  const { projects } = JSON.parse(r.body);
  const web = projects.find((p) => p.name === 'web');
  assert.equal(web.task.phase, 'plan');
  assert.equal(web.task.title, 'Add login');
  assert.equal(web.awaiting, 'plan');
  assert.equal(web.gates.plan.ok, false);
  assert.match(web.gates.plan.missing.join('\n'), /human approval/);
  assert.match(web.gates.build.missing.join('\n'), /never run/);
  assert.deepEqual(web.asanaTask, { name: 'Add login', url: 'https://app.asana.com/A1' });
  assert.equal(web.lastRun.runId, 'run-1');
  assert.equal(web.queue.length, 1);

  const api = projects.find((p) => p.name === 'api');
  assert.equal(api.task, null);
  assert.equal(api.awaiting, null);
  assert.match(projects.find((p) => p.name === 'missing').error, /not installed/);
});

test('AC6: serves plan/review/verification markdown and run log tails; 404s otherwise', async (t) => {
  const { state, registry } = setup();
  const server = createServer({ registry, state });
  const { port } = await listen(server, '127.0.0.1');
  t.after(() => server.close());

  const plan = await request(port, '/api/projects/web/files/plan');
  assert.equal(plan.code, 200);
  assert.match(plan.body, /## Acceptance Criteria/);
  assert.equal((await request(port, '/api/projects/web/files/review')).code, 404);
  assert.equal((await request(port, '/api/projects/web/files/ledger')).code, 404);
  assert.equal((await request(port, '/api/projects/nope/files/plan')).code, 404);
  assert.equal((await request(port, '/api/projects/api/files/plan')).code, 404);

  const log = await request(port, '/api/runs/web/run-1/log');
  assert.equal(log.code, 200);
  assert.match(log.body, /hello from the agent/);
  assert.equal((await request(port, '/api/runs/web/..%2F..%2Fstate/log')).code, 404);
  assert.equal((await request(port, '/api/runs/web/nope/log')).code, 404);
});

test('AC6: streams existing and new events over SSE', async (t) => {
  const { state, registry } = setup();
  const server = createServer({ registry, state, pollMs: 50 });
  const { port } = await listen(server, '127.0.0.1');
  t.after(() => server.close());

  const got = await new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/events' }, (res) => {
      assert.equal(res.headers['content-type'], 'text/event-stream');
      let buf = '';
      res.on('data', (d) => {
        buf += d;
        if (buf.includes('"run-end"') && !buf.includes('"awaiting-human"')) state.event('awaiting-human', { project: 'web', gate: 'plan' });
        if (buf.includes('data: {') && buf.includes('"awaiting-human"')) {
          req.destroy();
          resolve(buf);
        }
      });
    });
    req.on('error', (e) => (e.code === 'ECONNRESET' ? null : reject(e)));
  });
  assert.match(got, /"type":"run-end"/);
  assert.match(got, /"type":"awaiting-human"/);
});

test('AC6: every non-GET request is refused with 405', async (t) => {
  const { state, registry } = setup();
  const server = createServer({ registry, state });
  const { port } = await listen(server, '127.0.0.1');
  t.after(() => server.close());
  for (const m of ['HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']) {
    for (const p of ['/', '/api/fleet', '/api/projects/web/files/plan']) {
      assert.equal((await request(port, p, m)).code, 405, `${m} ${p}`);
    }
  }
});

test('AC6: the CLI binds 127.0.0.1 by default', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'fleet', 'bin', 'fleet'), 'utf8');
  assert.match(src, /flag\(rest, '--host', '127\.0\.0\.1'\)/);
});

test('AC7: the page renders projects, approval inbox, live feed and drill-down without reloads', async (t) => {
  const { state, registry } = setup();
  const server = createServer({ registry, state });
  const { port } = await listen(server, '127.0.0.1');
  t.after(() => server.close());
  const r = await request(port, '/');
  assert.equal(r.code, 200);
  assert.match(r.headers['content-type'], /text\/html/);
  for (const needle of ["fetch('/api/fleet')", "new EventSource('/api/events')", 'id="inbox"', 'id="grid"', 'id="feed"', '/files/', '/log`', 'setInterval(refresh']) {
    assert.ok(r.body.includes(needle), `page contains ${needle}`);
  }
  assert.ok(!/<script[^>]+src=|<link[^>]+href=/.test(r.body), 'self-contained: no external assets');
});

test('AC8: no API response contains the Asana token', async (t) => {
  const saved = process.env.ASANA_TOKEN;
  process.env.ASANA_TOKEN = SECRET;
  t.after(() => (saved === undefined ? delete process.env.ASANA_TOKEN : (process.env.ASANA_TOKEN = saved)));
  const { state, registry } = setup();
  const server = createServer({ registry, state });
  const { port } = await listen(server, '127.0.0.1');
  t.after(() => server.close());
  for (const p of ['/', '/api/fleet', '/api/projects/web/files/plan', '/api/runs/web/run-1/log']) {
    assert.ok(!(await request(port, p)).body.includes(SECRET), p);
  }
});

test('a malformed URL gets 400 and the server keeps serving', async (t) => {
  const { state, registry } = setup();
  const server = createServer({ registry, state });
  const { port } = await listen(server, '127.0.0.1');
  t.after(() => server.close());
  assert.equal((await request(port, '/api/runs/%E0%A4%A/x/log')).code, 400);
  assert.equal((await request(port, '/api/fleet')).code, 200);
});

test('requests with an unexpected Host header are refused (DNS rebinding)', async (t) => {
  const { state, registry } = setup();
  const server = createServer({ registry, state });
  const { port } = await listen(server, '127.0.0.1');
  t.after(() => server.close());
  const code = await new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: '/api/fleet', headers: { Host: 'evil.example:7420' } }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      })
      .on('error', reject);
  });
  assert.equal(code, 421);
  assert.equal((await request(port, '/api/fleet')).code, 200);
});
