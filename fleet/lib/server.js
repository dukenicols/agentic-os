'use strict';
// Read-only fleet UI: one HTML page plus a small JSON/SSE API. No mutating endpoints, no Asana access,
// no secrets. Binds to 127.0.0.1 unless told otherwise — reach it over an SSH tunnel or Tailscale.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { govStatusAsync } = require('./tick');
const { readEvents } = require('./state');

const PHASES = ['plan', 'build', 'review', 'test', 'ship'];
const DOCS = new Set(['plan', 'review', 'verification']);
const LOG_TAIL_BYTES = 64 * 1024;
const PAGE = path.join(__dirname, '..', 'ui', 'index.html');

/** Everything the UI and `fleet status` show, per project. `status` may return a value or a promise. */
async function snapshot({ registry, state, status = govStatusAsync }) {
  state.reload();
  const statuses = await Promise.all(registry.projects.map((p) => Promise.resolve(status(p.path))));
  return registry.projects.map((p, i) => {
    const ps = state.project(p.name);
    const st = statuses[i];
    const task = st.task || null;
    const gates = task ? Object.fromEntries(PHASES.map((ph) => [ph, { ok: st.gates[ph].ok, missing: st.gates[ph].missing, human: st.gates[ph].human || [] }])) : null;
    const g = task && gates[task.phase];
    const awaiting = g && ['plan', 'ship'].includes(task.phase) && g.missing.length && g.missing.length === g.human.length ? task.phase : null;
    return {
      name: p.name,
      path: p.path,
      enabled: p.enabled,
      error: st.error || null,
      task: task && { id: task.id, title: task.title, phase: task.phase, createdAt: task.createdAt },
      gates,
      changed: st.changed ? st.changed.length : 0,
      awaiting,
      paused: ps.paused,
      pausedReason: ps.pausedReason,
      asanaTask: ps.current && { name: ps.current.asanaName, url: ps.current.asanaUrl },
      queue: ps.last?.queue || [],
      queueError: ps.last?.queueError || null,
      lastDecision: ps.last && { action: ps.last.action, reason: ps.last.reason, at: ps.last.at },
      lastRun: ps.lastRun,
      consecutiveFailures: ps.consecutiveFailures,
    };
  });
}

function createServer({ registry, state, status = govStatusAsync, pollMs = 1000, host = '127.0.0.1' }) {
  const byName = new Map(registry.projects.map((p) => [p.name, p]));
  // DNS-rebinding guard: only answer requests addressed to this machine by a name we expect.
  const allowedHosts = new Set(['localhost', '127.0.0.1', '[::1]', host.includes(':') ? `[${host}]` : host]);
  let cache = { at: 0, data: null };
  const fleet = async () => {
    // gov status hashes every file in the repo: cache briefly so several open tabs don't multiply that.
    if (Date.now() - cache.at > 3000) cache = { at: Date.now(), data: snapshot({ registry, state, status }) };
    return cache.data;
  };

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method !== 'GET') return send(res, 405, { error: 'read-only' }, { Allow: 'GET' });
      const hostName = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
      if (!allowedHosts.has(hostName)) return send(res, 421, { error: 'unexpected Host header' });
      let url;
      let parts;
      try {
        url = new URL(req.url, 'http://localhost');
        parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      } catch {
        return send(res, 400, { error: 'malformed URL' });
      }

      if (url.pathname === '/') {
        return send(res, 200, fs.readFileSync(PAGE, 'utf8'), { 'Content-Type': 'text/html; charset=utf-8' });
      }
      if (url.pathname === '/api/fleet') return send(res, 200, { generatedAt: new Date().toISOString(), projects: await fleet() });

      // /api/projects/:name/files/:doc
      if (parts[0] === 'api' && parts[1] === 'projects' && parts[3] === 'files' && parts.length === 5) {
        const p = byName.get(parts[2]);
        if (!p || !DOCS.has(parts[4])) return send(res, 404, { error: 'not found' });
        const row = (await fleet()).find((x) => x.name === p.name);
        if (!row?.task) return send(res, 404, { error: 'no active task' });
        const file = path.join(p.path, '.governance', 'runs', row.task.id, `${parts[4]}.md`);
        return fs.existsSync(file) ? text(res, fs.readFileSync(file, 'utf8')) : send(res, 404, { error: `${parts[4]}.md not written yet` });
      }

      // /api/runs/:project/:runId/log
      if (parts[0] === 'api' && parts[1] === 'runs' && parts[4] === 'log' && parts.length === 5) {
        if (!byName.has(parts[2]) || !/^[\w.-]+$/.test(parts[3]) || parts[3].startsWith('.')) return send(res, 404, { error: 'not found' });
        const file = state.runLogPath(parts[2], parts[3]);
        if (!fs.existsSync(file)) return send(res, 404, { error: 'no such run' });
        return text(res, tail(file, LOG_TAIL_BYTES));
      }

      if (url.pathname === '/api/events') return events(req, res, state, pollMs);
      return send(res, 404, { error: 'not found' });
    } catch (err) {
      if (!res.headersSent) return send(res, 500, { error: err.message });
      res.end();
    }
  });
  return server;
}

/** Server-sent events: the last 100 events, then every new line of events.jsonl as it is appended. */
function events(req, res, state, pollMs) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  let { events: initial, offset } = readEvents(state.eventsFile, { limit: 100 });
  for (const e of initial) res.write(`data: ${JSON.stringify(e)}\n\n`);
  const timer = setInterval(() => {
    const r = readEvents(state.eventsFile, { from: offset });
    offset = r.offset;
    for (const e of r.events) res.write(`data: ${JSON.stringify(e)}\n\n`);
    res.write(': ping\n\n');
  }, pollMs);
  req.on('close', () => clearInterval(timer));
}

function tail(file, bytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return (size > len ? `… (showing last ${len} bytes)\n` : '') + buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function send(res, code, body, headers = {}) {
  const isText = typeof body === 'string';
  res.writeHead(code, { 'Content-Type': isText ? 'text/plain; charset=utf-8' : 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(isText ? body : JSON.stringify(body));
}

const text = (res, body) => send(res, 200, body, { 'Content-Type': 'text/plain; charset=utf-8' });

module.exports = { createServer, snapshot };
