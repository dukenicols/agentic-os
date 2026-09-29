'use strict';
// Fleet UI: one HTML page plus a small JSON/SSE API. Read-only except two passphrase-protected actions
// (approve a gate, request plan changes). No Asana access, no secrets. Binds to 127.0.0.1 unless told
// otherwise — reach it over an SSH tunnel or Tailscale.

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { govStatusAsync } = require('./tick');
const { readEvents } = require('./state');
const { acquireLock, agentEnv } = require('./runner');
const { MAX_FEEDBACK_RUNS } = require('./decide');
const { loadApprover, verifyPassphrase, RateLimiter } = require('./approver');

const PHASES = ['plan', 'build', 'review', 'test', 'ship'];
const DOCS = new Set(['plan', 'review', 'verification']);
const LOG_TAIL_BYTES = 64 * 1024;
const DIFF_MAX_BYTES = 2 * 1024 * 1024;
const BODY_MAX_BYTES = 64 * 1024;
const FEEDBACK_MAX_CHARS = 4000;
const PAGE = path.join(__dirname, '..', 'ui', 'index.html');

/** Where a change request stands: pending (agent will revise), addressed (plan changed), superseded
 *  (the plan was approved anyway), or returned (the agent didn't change the plan after its runs). */
function feedbackStatus(f, st) {
  if (f.planHash !== st.planHash) return 'addressed';
  if (st.task?.phase !== 'plan' || st.gates?.plan?.ok) return 'superseded';
  return (f.runs || 0) >= MAX_FEEDBACK_RUNS ? 'returned' : 'pending';
}

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
      feedback: task ? (ps.feedback || []).filter((f) => f.taskId === task.id).map((f) => ({ at: f.at, text: f.text, status: feedbackStatus(f, st) })) : [],
    };
  });
}

/** Run a repo's own gov CLI as a human process (no agent markers in the environment). */
function govRun(repo, args, maxBuffer = 16 * 1024 * 1024) {
  return new Promise((resolve) => {
    const bin = path.join(repo, '.governance', 'bin', 'gov');
    execFile(process.execPath, [bin, ...args], { cwd: repo, env: agentEnv(process.env), encoding: 'utf8', maxBuffer, timeout: 60_000 }, (err, stdout, stderr) =>
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, errCode: err && typeof err.code === 'string' ? err.code : null, stdout: stdout || '', stderr: stderr || '' }),
    );
  });
}

/** The change under review. Too large to show in full → flagged, never silently truncated. */
async function shipDiff(repo, maxBytes) {
  // Buffer at most maxBytes (+1 to detect overflow); past that the child is killed and the diff is "too large".
  const r = await govRun(repo, ['diff', '--patch'], maxBytes + 1);
  const overflow = r.errCode === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
  const bytes = Buffer.byteLength(r.stdout);
  const tooLarge = overflow || bytes > maxBytes;
  return { code: tooLarge ? 0 : r.code, error: (r.stderr || r.stdout).trim().split('\n')[0], diff: tooLarge ? '' : r.stdout, bytes, tooLarge };
}

/** Older gov copies ignore unknown flags, which would approve unchecked: only use --expect where gov documents it. */
async function supportsExpect(repo) {
  const r = await govRun(repo, ['help']);
  return r.code === 0 && r.stdout.includes('--expect');
}

/** What is awaiting the human in this repo right now, and the hash that binds an approval to it. */
function pending(st) {
  const task = st.task;
  if (!task || !st.gates) return null;
  const g = st.gates[task.phase];
  const human = g && ['plan', 'ship'].includes(task.phase) && g.missing.length && g.missing.length === (g.human || []).length;
  if (!human) return null;
  return { gate: task.phase, taskId: task.id, title: task.title, expect: task.phase === 'plan' ? st.planHash || null : st.gates.fingerprint || null };
}

class HttpError extends Error {
  constructor(code, message, headers = {}) {
    super(message);
    Object.assign(this, { code, headers });
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size <= BODY_MAX_BYTES) chunks.push(c); // past the cap: keep draining, keep nothing
    });
    req.on('end', () => {
      if (size > BODY_MAX_BYTES) return reject(new HttpError(413, 'request body too large'));
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new HttpError(400, 'body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function createServer({ registry, state, status = govStatusAsync, pollMs = 1000, host = '127.0.0.1', allowApprovals = !process.env.CLAUDECODE, limiter = new RateLimiter(), diffMaxBytes = DIFF_MAX_BYTES }) {
  const byName = new Map(registry.projects.map((p) => [p.name, p]));
  // DNS-rebinding guard: only answer requests addressed to this machine by a name we expect.
  const allowedHosts = new Set(['localhost', '127.0.0.1', '[::1]', host.includes(':') ? `[${host}]` : host]);
  let cache = { at: 0, data: null };
  const fleet = async () => {
    // gov status hashes every file in the repo: cache briefly so several open tabs don't multiply that.
    if (Date.now() - cache.at > 3000) cache = { at: Date.now(), data: snapshot({ registry, state, status }) };
    return cache.data;
  };

  /** Everything a UI action must pass before it touches a repo. Returns the fresh pending gate. */
  async function authorize(req, name, body, wantGate) {
    // A server started from inside an agent session must never sign anything as the human.
    if (!allowApprovals) throw new HttpError(503, 'UI approvals are disabled in this process (it runs inside an agent session).');
    const approver = loadApprover(state.home);
    if (!approver) throw new HttpError(503, 'UI approvals are disabled: set a passphrase on the server with `fleet passphrase`.');
    if (limiter.blocked()) {
      const after = limiter.retryAfterSeconds();
      throw new HttpError(429, `too many wrong passphrases; try again in ${Math.ceil(after / 60)} min`, { 'Retry-After': String(after) });
    }
    const forgive = limiter.reserve(); // counted before the await: a parallel burst can't outrun the limit
    if (!(await verifyPassphrase(approver, body.passphrase))) {
      state.event('approval-denied', { project: name, reason: 'wrong passphrase' });
      throw new HttpError(401, 'wrong passphrase');
    }
    forgive();
    const p = byName.get(name);
    if (!p) throw new HttpError(404, 'unknown project');
    if (!(await supportsExpect(p.path))) {
      throw new HttpError(426, `the gov in ${p.name} is too old for UI approvals; re-run agentic-os install.sh in that repo`);
    }
    const now = pending(await Promise.resolve(status(p.path)));
    if (!now || now.gate !== wantGate) throw new HttpError(409, `${p.name} is not awaiting ${wantGate} approval right now`);
    if (typeof body.expect !== 'string' || body.expect !== now.expect) {
      throw new HttpError(412, `${wantGate === 'plan' ? 'the plan' : 'the code'} changed since you loaded it; review it again`);
    }
    return { p, now };
  }

  async function act(req, res, name, action) {
    const origin = req.headers.origin;
    let originHost = null;
    try {
      originHost = origin ? new URL(origin).host : null;
    } catch {}
    if (!originHost || originHost !== req.headers.host) throw new HttpError(403, 'cross-origin or missing Origin');
    if (!/^application\/json\s*(;|$)/i.test(String(req.headers['content-type'] || ''))) throw new HttpError(415, 'Content-Type must be application/json');
    const body = await readJsonBody(req);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'body must be a JSON object');

    if (action === 'approve') {
      if (!['plan', 'ship'].includes(body.gate)) throw new HttpError(400, 'gate must be plan or ship');
    } else if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > FEEDBACK_MAX_CHARS) {
      throw new HttpError(400, `text must be 1–${FEEDBACK_MAX_CHARS} characters`);
    }
    const { p, now } = await authorize(req, name, body, action === 'approve' ? body.gate : 'plan');

    if (action === 'approve' && now.gate === 'ship' && (await shipDiff(p.path, diffMaxBytes)).tooLarge) {
      throw new HttpError(413, 'the diff is too large to review in the UI; review it and sign off in a terminal on the server');
    }
    const release = acquireLock(state.home, p.name);
    if (!release) throw new HttpError(423, `an agent is working in ${p.name} right now; try again when it finishes`);
    try {
      if (action === 'approve') {
        const r = await govRun(p.path, ['approve', now.gate, '--expect', now.expect, '--via', 'fleet-ui']);
        if (r.code !== 0) throw new HttpError(422, (r.stderr || r.stdout).trim().replace(/^gov: /, '').split('\n')[0] || 'gov approve failed');
        state.event('approved', { project: p.name, gate: now.gate, taskId: now.taskId, via: 'fleet-ui' });
        cache.at = 0;
        return send(res, 200, { ok: true, message: `${now.gate} approved for "${now.title}"` });
      }
      state.update(p.name, (ps) => {
        ps.feedback = [...(ps.feedback || []), { at: new Date().toISOString(), text: body.text.trim(), planHash: now.expect, taskId: now.taskId }];
      });
      state.event('changes-requested', { project: p.name, taskId: now.taskId, chars: body.text.trim().length });
      cache.at = 0;
      return send(res, 200, { ok: true, message: 'changes requested; the agent will revise the plan on the next pass' });
    } finally {
      release();
    }
  }

  const server = http.createServer(async (req, res) => {
    try {
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
      const projectRoute = parts[0] === 'api' && parts[1] === 'projects' && parts.length >= 4;

      // The only two writes: POST /api/projects/:name/approve | feedback
      if (projectRoute && parts.length === 4 && ['approve', 'feedback'].includes(parts[3])) {
        if (req.method !== 'POST') return send(res, 405, { error: 'use POST' }, { Allow: 'POST' });
        return await act(req, res, parts[2], parts[3]);
      }
      if (req.method !== 'GET') return send(res, 405, { error: 'read-only' }, { Allow: 'GET' });

      if (url.pathname === '/') {
        return send(res, 200, fs.readFileSync(PAGE, 'utf8'), { 'Content-Type': 'text/html; charset=utf-8' });
      }
      if (url.pathname === '/api/fleet') return send(res, 200, { generatedAt: new Date().toISOString(), projects: await fleet() });

      // /api/projects/:name/files/:doc
      if (projectRoute && parts[3] === 'files' && parts.length === 5) {
        const p = byName.get(parts[2]);
        if (!p || !DOCS.has(parts[4])) return send(res, 404, { error: 'not found' });
        const row = (await fleet()).find((x) => x.name === p.name);
        if (!row?.task) return send(res, 404, { error: 'no active task' });
        const file = path.join(p.path, '.governance', 'runs', row.task.id, `${parts[4]}.md`);
        return fs.existsSync(file) ? text(res, fs.readFileSync(file, 'utf8')) : send(res, 404, { error: `${parts[4]}.md not written yet` });
      }

      // /api/projects/:name/approval — what is awaiting the human, fresh (not cached)
      if (projectRoute && parts[3] === 'approval' && parts.length === 4) {
        const p = byName.get(parts[2]);
        if (!p) return send(res, 404, { error: 'not found' });
        const release = acquireLock(state.home, p.name);
        if (!release) return send(res, 423, { error: `an agent is working in ${p.name} right now; reload when it finishes` });
        try {
          const [st, supported] = await Promise.all([Promise.resolve(status(p.path)), supportsExpect(p.path)]);
          const now = pending(st);
          // Hand back exactly what an approval will be bound to, in the same response as its hash:
          // the plan text for plan; the diff, review and verification for ship (re-checked against the
          // fingerprint afterwards, so the documents and the hash describe the same tree).
          let document = null;
          let ship = null;
          const runDoc = (name) => readText(path.join(p.path, '.governance', 'runs', now.taskId, `${name}.md`));
          if (now && now.gate === 'plan') {
            document = runDoc('plan');
            if (crypto.createHash('sha256').update(document).digest('hex') !== now.expect) return send(res, 409, { error: 'the plan is being edited right now; reload in a moment' });
          } else if (now && now.gate === 'ship') {
            const d = await shipDiff(p.path, diffMaxBytes);
            ship = {
              diff: d.tooLarge ? '' : d.diff,
              diffTooLarge: d.tooLarge,
              review: runDoc('review'),
              verification: runDoc('verification'),
            };
            const after = pending(await Promise.resolve(status(p.path)));
            if (d.code !== 0 || !after || after.gate !== 'ship' || after.expect !== now.expect) {
              return send(res, 409, { error: 'the code is changing right now; reload in a moment' });
            }
          }
          const enabled = allowApprovals && !!loadApprover(state.home);
          return send(res, 200, { pending: now, document, ship, supported, enabled, reason: !allowApprovals ? 'disabled in an agent session' : !enabled ? 'no passphrase set: run `fleet passphrase` on the server' : !supported ? 're-run install.sh in this repo to enable UI approvals' : null });
        } finally {
          release();
        }
      }

      // /api/projects/:name/diff — the change under review
      if (projectRoute && parts[3] === 'diff' && parts.length === 4) {
        const p = byName.get(parts[2]);
        if (!p) return send(res, 404, { error: 'not found' });
        const d = await shipDiff(p.path, diffMaxBytes);
        if (d.code !== 0) return send(res, 409, { error: d.error });
        return text(res, d.tooLarge ? `(diff over ${diffMaxBytes} bytes is too large to show here; review it on the server)` : d.diff);
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
      if (res.headersSent) return res.end();
      if (err instanceof HttpError) return send(res, err.code, { error: err.message }, err.headers);
      return send(res, 500, { error: err.message });
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

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
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
