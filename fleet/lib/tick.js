'use strict';
// One supervisor pass: for every enabled project, read `gov status`, read its Asana queue, decide, and
// run the agent where there is work — bounded by locks and maxConcurrent.
//
// State writes always go through state.update(), which re-reads state.json first: a pass can last as long
// as its agent runs, and must never write back a stale copy over a human's `fleet pause`.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync, execFile } = require('child_process');
const { decide } = require('./decide');
const { runAgent, acquireLock, agentEnv, prompt, safeTitle } = require('./runner');

function govArgs(repo) {
  const bin = path.join(repo, '.governance', 'bin', 'gov');
  return fs.existsSync(bin) ? [bin, 'status', '--json'] : null;
}

function parseStatus(code, stdout, stderr) {
  if (code !== 0) return { error: (stderr || stdout || `exit ${code}`).trim().split('\n')[0] };
  try {
    return JSON.parse(stdout);
  } catch {
    return { error: 'gov status --json returned invalid JSON' };
  }
}

const GOV_OPTS = { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 60_000 };

/** `gov status --json` of a repo, run as a human process from the repo root. */
function govStatus(repo) {
  const args = govArgs(repo);
  if (!args) return { error: `agentic-os is not installed in ${repo}` };
  const r = spawnSync(process.execPath, args, { ...GOV_OPTS, cwd: repo, env: agentEnv(process.env) });
  return parseStatus(r.status, r.stdout, r.stderr);
}

/** Same, without blocking the event loop (for the UI server). */
function govStatusAsync(repo) {
  const args = govArgs(repo);
  if (!args) return Promise.resolve({ error: `agentic-os is not installed in ${repo}` });
  return new Promise((resolve) => {
    execFile(process.execPath, args, { ...GOV_OPTS, cwd: repo, env: agentEnv(process.env) }, (err, stdout, stderr) => {
      resolve(parseStatus(err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr));
    });
  });
}

const today = (now) => now.toISOString().slice(0, 10);

async function tick({ registry, state, asana, env = process.env, status = govStatus, run = runAgent, now = () => new Date() }) {
  state.event('tick', { projects: registry.projects.filter((p) => p.enabled).map((p) => p.name) });
  const jobs = [];

  for (const project of registry.projects) {
    if (!project.enabled) continue;
    const st = status(project.path);
    reconcile(state, project, st);

    let queue = [];
    let queueError = null;
    try {
      queue = (await asana.queue(project.asanaProjectGid, registry.asana.section)).tasks;
    } catch (err) {
      queueError = err.message;
      state.event('asana-error', { project: project.name, error: err.message });
    }

    const ps = state.reload().project(project.name);
    const d = decide({ status: st, pstate: ps, queue, limits: registry.limits, today: today(now()) });
    state.update(project.name, (p) => {
      p.last = {
        action: d.action,
        reason: d.reason || null,
        gate: d.gate || null,
        queue: queue.map(({ gid, name, url }) => ({ gid, name, url })),
        queueError,
        at: now().toISOString(),
      };
    });
    if (d.action === 'await-human') state.event('awaiting-human', { project: project.name, gate: d.gate, taskId: d.taskId });
    if (d.action === 'paused') state.event('paused', { project: project.name, reason: d.reason });
    if (d.action === 'start' || d.action === 'continue') jobs.push({ project, decision: d });
  }

  // Bounded concurrency: at most maxConcurrent agents at once across the fleet.
  const results = [];
  const pending = [...jobs];
  const runJob = async ({ project, decision }) => {
    const release = acquireLock(state.home, project.name);
    if (!release) {
      state.event('skipped-locked', { project: project.name });
      return { project: project.name, skipped: 'locked' };
    }
    try {
      // The human may have paused the project since this pass decided.
      if (state.reload().project(project.name).paused) return { project: project.name, skipped: 'paused' };
      return await execute({ project, decision, state, registry, env, status, run, now, onSpawn: release.agent });
    } finally {
      release();
    }
  };
  const worker = async () => {
    for (let job = pending.shift(); job; job = pending.shift()) results.push(await runJob(job));
  };
  await Promise.all(Array.from({ length: Math.min(registry.limits.maxConcurrent, jobs.length) }, worker));
  return results;
}

async function execute({ project, decision, state, registry, env, status, run, now, onSpawn }) {
  const runId = `${now().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;
  const logFile = state.runLogPath(project.name, runId);
  const started = now().toISOString();
  let ps = state.update(project.name, (p) => {
    if (decision.action === 'start') {
      const t = decision.asanaTask;
      p.current = { asanaGid: t.gid, asanaName: t.name, asanaUrl: t.url, govTaskId: null, startedAt: started };
    }
  });
  state.event('run-start', {
    project: project.name,
    runId,
    action: decision.action,
    phase: decision.phase || null,
    asanaTask: decision.asanaTask ? decision.asanaTask.name : ps.current?.asanaName || null,
  });

  const r = await run({
    bin: registry.claudeBin,
    cwd: project.path,
    input: prompt(decision, project),
    allowedTools: project.allowedTools,
    timeoutMs: registry.limits.runTimeoutMinutes * 60_000,
    logFile,
    env,
    onSpawn,
  });

  let ok = r.exitCode === 0 && !r.timedOut;
  const st = decision.action === 'start' ? status(project.path) : null;
  const day = now().toISOString().slice(0, 10);
  ps = state.update(project.name, (p) => {
    if (decision.action === 'start') {
      if (st.error) {
        ok = false; // can't tell what the run did: keep the attempt; reconcile resolves it next pass
      } else if (!adoptStartedTask(p, st)) {
        ok = false; // the agent never opened a governed task: retry next tick, counted as a failure
        p.current = null;
      }
    }
    p.runsByDay = { [day]: (p.runsByDay[day] || 0) + 1 }; // only today's count matters
    if (decision.feedback) {
      // Count revision runs per request, so feedback the agent doesn't act on returns to the human.
      const served = new Set(decision.feedback.map((f) => f.at));
      p.feedback = (p.feedback || []).map((f) => (served.has(f.at) ? { ...f, runs: (f.runs || 0) + 1 } : f));
    }
    p.consecutiveFailures = ok ? 0 : (p.consecutiveFailures || 0) + 1;
    p.lastRun = { runId, action: decision.action, exitCode: r.exitCode, timedOut: r.timedOut, ok, durationMs: r.durationMs, at: now().toISOString() };
  });
  state.event('run-end', { project: project.name, runId, action: decision.action, exitCode: r.exitCode, timedOut: r.timedOut, ok, durationMs: r.durationMs });
  return { project: project.name, runId, ...r, ok };
}

/**
 * After a start run: map the repo's active gov task to the Asana task, if it is one the run created
 * (opened after the run began, not already mapped, and — when recovering — titled as instructed).
 * Mutates p; returns whether it adopted a task.
 */
function adoptStartedTask(p, st, { requireTitle = false } = {}) {
  const t = st && !st.error ? st.task : null;
  if (!p.current || !t || Object.values(p.mappings).includes(t.id)) return false;
  if (t.createdAt && p.current.startedAt && t.createdAt < p.current.startedAt) return false;
  // Without the run's lock as proof, only the exact title fleet told the agent to use identifies its task.
  if (requireTitle && t.title !== safeTitle(p.current.asanaName)) return false;
  p.current.govTaskId = t.id;
  p.mappings[p.current.asanaGid] = t.id;
  return true;
}

/**
 * Bring fleet memory in line with the repo before deciding:
 *  - a task fleet was driving has closed (shipped/aborted) → free the project;
 *  - a start run was cut off (reboot, kill) before its task was recorded → adopt the task it opened, or
 *    forget the attempt. Only when no run holds the project's lock, i.e. nothing is mid-start.
 */
function reconcile(state, project, st) {
  if (st.error) return;
  const cur = state.reload().project(project.name).current;
  if (!cur) return;
  const active = st.task?.id || null;

  if (cur.govTaskId) {
    if (active === cur.govTaskId) return;
    state.update(project.name, (p) => (p.current = null));
    state.event('task-closed', { project: project.name, taskId: cur.govTaskId, asanaTask: cur.asanaName });
    return;
  }

  const release = acquireLock(state.home, project.name);
  if (!release) return; // a start run is in progress right now
  try {
    let adopted = false;
    state.update(project.name, (p) => {
      if (!p.current || p.current.govTaskId) return;
      adopted = adoptStartedTask(p, st, { requireTitle: true });
      if (!adopted) p.current = null;
    });
    state.event('recovered-interrupted-start', { project: project.name, asanaTask: cur.asanaName, adoptedTaskId: adopted ? active : null });
  } finally {
    release();
  }
}

module.exports = { tick, govStatus, govStatusAsync };
