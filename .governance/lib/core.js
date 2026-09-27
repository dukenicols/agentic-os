'use strict';
// Governance core: task state, tree fingerprints, hash-chained evidence ledger,
// and phase gates. Zero dependencies; Node >= 18.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { spawnSync } = require('child_process');

const PHASES = ['plan', 'build', 'review', 'test', 'ship'];
const GENESIS = '0'.repeat(64);

// ---------------------------------------------------------------- paths/config

function findRoot(start = process.env.CLAUDE_PROJECT_DIR || process.cwd()) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.governance', 'config.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

class Gov {
  constructor(root) {
    this.root = root;
    this.dir = path.join(root, '.governance');
    this.config = readJSON(path.join(this.dir, 'config.json'), {});
    this.config.mode = process.env.GOV_MODE || this.config.mode || 'enforce';
  }

  static open(start) {
    const root = findRoot(start);
    return root ? new Gov(root) : null;
  }

  rel(p) {
    return path.relative(this.root, path.resolve(this.root, p)).split(path.sep).join('/');
  }

  // --------------------------------------------------------------- state/task

  get statePath() {
    return path.join(this.dir, 'state.json');
  }

  activeTaskId() {
    return readJSON(this.statePath, {}).activeTask || null;
  }

  runDir(id) {
    return path.join(this.dir, 'runs', id);
  }

  task(id = this.activeTaskId()) {
    if (!id) return null;
    const t = readJSON(path.join(this.runDir(id), 'task.json'), null);
    return t && { ...t, dir: this.runDir(id) };
  }

  saveTask(task) {
    const { dir, ...data } = task;
    writeJSON(path.join(this.runDir(task.id), 'task.json'), data);
  }

  startTask(title) {
    if (this.activeTaskId()) {
      throw new Error(`Task ${this.activeTaskId()} is still active. Ship it or run \`gov abort\` first.`);
    }
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'task';
    const id = `${stamp}-${slug}`;
    const dir = this.runDir(id);
    fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });

    const manifest = this.manifest();
    writeJSON(path.join(dir, 'baseline.json'), { gitHead: this.gitHead(), manifest });
    const template = fs.readFileSync(path.join(this.dir, 'templates', 'plan.md'), 'utf8');
    fs.writeFileSync(path.join(dir, 'plan.md'), template.replace('{{title}}', title));

    const task = { id, title, phase: 'plan', status: 'active', createdAt: new Date().toISOString() };
    this.saveTask(task);
    writeJSON(this.statePath, { activeTask: id });
    this.append(id, { type: 'start', title, fingerprint: fingerprintOf(manifest) });
    return this.task(id);
  }

  // ------------------------------------------------------------- fingerprints

  isIgnored(rel) {
    return (this.config.fingerprint?.ignore || []).some((p) => matchPath(p, rel));
  }

  listFiles() {
    const git = spawnSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
      cwd: this.root,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    });
    if (git.status === 0) return git.stdout.split('\0').filter(Boolean);

    const out = [];
    const walk = (dir) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, ent.name);
        const rel = path.relative(this.root, abs).split(path.sep).join('/');
        if (this.isIgnored(ent.isDirectory() ? rel + '/' : rel)) continue;
        if (ent.isDirectory()) walk(abs);
        else if (ent.isFile()) out.push(rel);
      }
    };
    walk(this.root);
    return out;
  }

  /** Content-addressed map of every relevant file. Independent of commits. */
  manifest() {
    const m = {};
    for (const rel of this.listFiles()) {
      if (this.isIgnored(rel)) continue;
      try {
        m[rel] = sha256(fs.readFileSync(path.join(this.root, rel)));
      } catch {
        // tracked but deleted from working tree: absent from manifest
      }
    }
    return m;
  }

  fingerprint() {
    return fingerprintOf(this.manifest());
  }

  gitHead() {
    const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: this.root, encoding: 'utf8' });
    return r.status === 0 ? r.stdout.trim() : null;
  }

  baseline(task) {
    return readJSON(path.join(task.dir, 'baseline.json'), { manifest: {} });
  }

  changedFiles(task, manifest = this.manifest()) {
    return diffManifests(this.baseline(task).manifest, manifest);
  }

  // ------------------------------------------------------------------- ledger

  ledgerPath(id) {
    return path.join(this.runDir(id), 'ledger.jsonl');
  }

  ledger(id) {
    try {
      return fs
        .readFileSync(this.ledgerPath(id), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  }

  append(id, entry) {
    const entries = this.ledger(id);
    const prev = entries.length ? entries[entries.length - 1].hash : GENESIS;
    const body = { seq: entries.length, at: new Date().toISOString(), actor: actor(), ...entry, prev };
    const record = { ...body, hash: sha256(prev + JSON.stringify(body)) };
    fs.appendFileSync(this.ledgerPath(id), JSON.stringify(record) + '\n');
    return record;
  }

  verifyLedger(id) {
    let prev = GENESIS;
    for (const [i, e] of this.ledger(id).entries()) {
      const { hash, ...body } = e;
      if (e.seq !== i || e.prev !== prev || sha256(prev + JSON.stringify(body)) !== hash) {
        return { ok: false, brokenAt: i };
      }
      prev = hash;
    }
    return { ok: true };
  }

  // --------------------------------------------------------------- evidence

  /** Execute a command and record the result as evidence. */
  run(kind, argvCmd, { echo = true } = {}) {
    const task = this.requireTask();
    const configured = this.config.commands?.[kind] || [];
    let cmds;
    if (argvCmd) {
      if (configured.length && !configured.includes(argvCmd)) {
        throw new Error(
          `"${argvCmd}" is not a configured ${kind} command. Configured: ${configured.join(', ')}.\n` +
            `Run \`gov run ${kind}\` with no command, or ask the human to change .governance/config.json.`,
        );
      }
      cmds = [argvCmd];
    } else {
      if (!configured.length) throw new Error(`No ${kind} commands configured. Use: gov run ${kind} -- <command>`);
      cmds = configured;
    }

    const results = [];
    for (const cmd of cmds) {
      const before = this.fingerprint();
      const t0 = Date.now();
      const r = spawnSync(cmd, { cwd: this.root, shell: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      const output = (r.stdout || '') + (r.stderr || '') + (r.error ? String(r.error) : '');
      const exitCode = r.status ?? 1;
      const after = this.fingerprint();
      if (echo) process.stdout.write(output);

      const n = this.ledger(task.id).filter((e) => e.type === 'run').length;
      const logFile = `logs/${kind}-${String(n).padStart(3, '0')}.log`;
      fs.writeFileSync(path.join(task.dir, logFile), `$ ${cmd}\n${output}\n[exit ${exitCode}]\n`);
      const rec = this.append(task.id, {
        type: 'run',
        kind,
        cmd,
        exitCode,
        durationMs: Date.now() - t0,
        fingerprint: after,
        fingerprintBefore: before,
        logFile,
        logHash: sha256(fs.readFileSync(path.join(task.dir, logFile))),
        tail: output.trimEnd().split('\n').slice(-15).join('\n'),
      });
      results.push(rec);
    }
    return results;
  }

  /** Stamp a markdown artifact (review.md / verification.md) against the current tree. */
  record(kind) {
    const task = this.requireTask();
    const file = path.join(task.dir, `${kind}.md`);
    if (!fs.existsSync(file)) throw new Error(`Missing ${this.rel(file)}. Write it first.`);
    const text = fs.readFileSync(file, 'utf8');
    const manifest = this.manifest();
    const problems =
      kind === 'review'
        ? validateReview(text, this.changedFiles(task, manifest).all)
        : validateVerification(text, acceptanceCriteria(this.planText(task)));
    if (problems.length) throw new Error(`${kind}.md is not valid evidence:\n  - ${problems.join('\n  - ')}`);
    return this.append(task.id, {
      type: kind,
      fingerprint: fingerprintOf(manifest),
      fileHash: sha256(text),
      verdict: kind === 'review' ? reviewVerdict(text) : 'PASS',
    });
  }

  approve(phase) {
    if (process.env.CLAUDECODE) {
      throw new Error('Approvals must come from a human. Run `gov approve` in your own terminal, not through the agent.');
    }
    const task = this.requireTask();
    if (!['plan', 'ship'].includes(phase)) throw new Error('Only `plan` and `ship` take approvals.');
    const entry = { type: 'approval', phase };
    if (phase === 'plan') {
      const problems = validatePlan(this.planText(task));
      if (problems.length) throw new Error(`Plan is incomplete:\n  - ${problems.join('\n  - ')}`);
      entry.planHash = sha256(this.planText(task));
    } else {
      const g = this.gates(task);
      const blocking = PHASES.slice(0, 4).filter((p) => !g[p].ok);
      if (blocking.length) throw new Error(`Cannot approve ship: gates failing: ${blocking.join(', ')}`);
      entry.fingerprint = g.fingerprint;
    }
    return this.append(task.id, entry);
  }

  planText(task) {
    try {
      return fs.readFileSync(path.join(task.dir, 'plan.md'), 'utf8');
    } catch {
      return '';
    }
  }

  // -------------------------------------------------------------------- gates

  /** Evaluate every gate against the current tree. Evidence is only valid for the tree it was produced on. */
  gates(task = this.requireTask()) {
    const manifest = this.manifest();
    const fp = fingerprintOf(manifest);
    const ledger = this.ledger(task.id);
    const latest = (pred) => [...ledger].reverse().find(pred);
    const plan = this.planText(task);
    const g = { fingerprint: fp };

    // plan
    {
      const missing = validatePlan(plan);
      if (this.config.approvals?.plan) {
        const a = latest((e) => e.type === 'approval' && e.phase === 'plan');
        if (!a) missing.push('human approval: run `gov approve plan` in your own terminal');
        else if (a.planHash !== sha256(plan)) missing.push('plan.md changed after approval — re-approve');
      }
      g.plan = gate(missing);
    }

    // build & test commands
    const commandGate = (kind) => {
      const missing = [];
      const configured = this.config.commands?.[kind] || [];
      const runs = ledger.filter((e) => e.type === 'run' && e.kind === kind);
      const required = configured.length ? configured : [...new Set(runs.map((r) => r.cmd))];
      if (!required.length) missing.push(`no ${kind} evidence: run \`gov run ${kind}\``);
      for (const cmd of required) {
        const r = [...runs].reverse().find((e) => e.cmd === cmd);
        if (!r) missing.push(`\`${cmd}\` never run via \`gov run ${kind}\``);
        else if (r.exitCode !== 0) missing.push(`\`${cmd}\` failed (exit ${r.exitCode}) — see ${r.logFile}`);
        else if (r.fingerprint !== fp) missing.push(`\`${cmd}\` passed on an older tree — code changed since, re-run`);
      }
      return missing;
    };

    {
      const missing = commandGate('build');
      if (!this.changedFiles(task, manifest).all.length) missing.unshift('no changes vs. baseline');
      g.build = gate(missing);
    }

    // review
    {
      const missing = [];
      const r = latest((e) => e.type === 'review');
      const text = readText(path.join(task.dir, 'review.md'));
      if (!r) missing.push('no review recorded: have the gov-reviewer subagent write review.md, then `gov record review`');
      else {
        if (r.verdict !== 'PASS') missing.push(`review verdict is ${r.verdict}`);
        if (r.fingerprint !== fp) missing.push('code changed after review — review is stale');
        if (r.fileHash !== sha256(text)) missing.push('review.md edited after it was recorded');
      }
      g.review = gate(missing);
    }

    // test
    {
      const missing = commandGate('test');
      const v = latest((e) => e.type === 'verification');
      const text = readText(path.join(task.dir, 'verification.md'));
      if (!v) missing.push('no verification recorded: map every AC to evidence in verification.md, then `gov record verification`');
      else {
        if (v.fingerprint !== fp) missing.push('code changed after verification — stale');
        if (v.fileHash !== sha256(text)) missing.push('verification.md edited after it was recorded');
      }
      g.test = gate(missing);
    }

    // ship
    {
      const missing = PHASES.slice(0, 4)
        .filter((p) => !g[p].ok)
        .map((p) => `${p} gate failing`);
      if (this.config.approvals?.ship) {
        const a = latest((e) => e.type === 'approval' && e.phase === 'ship');
        if (!a) missing.push('human approval: run `gov approve ship` in your own terminal');
        else if (a.fingerprint !== fp) missing.push('code changed after ship approval — re-approve');
      }
      g.ship = gate(missing);
    }

    const integrity = this.verifyLedger(task.id);
    if (!integrity.ok) {
      for (const p of PHASES) g[p] = gate([`ledger tampered (entry ${integrity.brokenAt}) — all evidence void`]);
    }
    return g;
  }

  /** Cumulative: to leave a phase, it and every earlier gate must pass on the current tree. */
  canLeave(task, g = this.gates(task)) {
    const upto = PHASES.slice(0, PHASES.indexOf(task.phase) + 1);
    return upto.flatMap((p) => g[p].missing.map((m) => `[${p}] ${m}`));
  }

  advance() {
    const task = this.requireTask();
    if (task.phase === 'ship') throw new Error('Already in ship. Use `gov ship` to close the task.');
    const missing = this.canLeave(task);
    if (missing.length) throw new Error(`Cannot leave ${task.phase}:\n  - ${missing.join('\n  - ')}`);
    const next = PHASES[PHASES.indexOf(task.phase) + 1];
    this.append(task.id, { type: 'advance', from: task.phase, to: next, fingerprint: this.fingerprint() });
    this.saveTask({ ...task, phase: next });
    return next;
  }

  back(to) {
    const task = this.requireTask();
    if (!PHASES.includes(to) || PHASES.indexOf(to) >= PHASES.indexOf(task.phase)) {
      throw new Error(`Can only go back to an earlier phase than ${task.phase}.`);
    }
    this.append(task.id, { type: 'back', from: task.phase, to });
    this.saveTask({ ...task, phase: to });
    return to;
  }

  ship(ref) {
    const task = this.requireTask();
    if (task.phase !== 'ship') throw new Error(`Task is in ${task.phase}, not ship.`);
    const g = this.gates(task);
    if (!g.ship.ok) throw new Error(`Ship gate failing:\n  - ${g.ship.missing.join('\n  - ')}`);
    this.append(task.id, { type: 'ship', fingerprint: g.fingerprint, gitHead: this.gitHead(), ref: ref || null });
    this.close(task, 'shipped');
  }

  abort(reason) {
    const task = this.requireTask();
    this.append(task.id, { type: 'abort', reason });
    this.close(task, 'aborted');
  }

  close(task, status) {
    this.saveTask({ ...task, status, closedAt: new Date().toISOString() });
    writeJSON(this.statePath, { activeTask: null });
  }

  requireTask() {
    const t = this.task();
    if (!t) throw new Error('No active task. Start one with: gov start "<title>"');
    return t;
  }
}

// ------------------------------------------------------------------ validators

const PLAN_SECTIONS = ['Goal', 'Scope', 'Acceptance Criteria', 'Approach', 'Risks', 'Rollback'];

function sections(md) {
  const out = {};
  let cur = null;
  for (const line of md.split('\n')) {
    const m = line.match(/^##\s+(.+?)\s*$/);
    if (m) out[(cur = m[1].trim().toLowerCase())] = '';
    else if (cur) out[cur] += line + '\n';
  }
  return out;
}

function validatePlan(md) {
  if (!md.trim()) return ['plan.md is missing or empty'];
  const s = sections(md);
  const problems = [];
  for (const name of PLAN_SECTIONS) {
    const body = s[name.toLowerCase()];
    if (body === undefined) problems.push(`missing section "## ${name}"`);
    else if (!body.replace(/<!--[\s\S]*?-->/g, '').trim()) problems.push(`section "${name}" is empty`);
  }
  if (/_TBD_/.test(md)) problems.push('placeholder _TBD_ still present');
  if (!acceptanceCriteria(md).length) problems.push('no acceptance criteria (lines like "- AC1: ...")');
  return problems;
}

function acceptanceCriteria(md) {
  const body = sections(md)['acceptance criteria'] || '';
  return [...new Set([...body.matchAll(/^\s*[-*]\s*(?:\[.\]\s*)?(AC-?\d+)\b/gim)].map((m) => normAC(m[1])))];
}

const normAC = (id) => id.toUpperCase().replace('-', '');

function reviewVerdict(md) {
  const m = md.match(/^\s*\**Verdict\**\s*:\s*\**\s*([A-Z_]+)/im);
  return m ? m[1].toUpperCase() : 'MISSING';
}

function validateReview(md, changed) {
  const problems = [];
  const verdict = reviewVerdict(md);
  if (!['PASS', 'CHANGES_REQUESTED'].includes(verdict)) problems.push('needs a "Verdict: PASS" or "Verdict: CHANGES_REQUESTED" line');
  if (!/^\s*\**Reviewer\**\s*:\s*\S+/im.test(md)) problems.push('needs a "Reviewer:" line');
  const open = md.split('\n').filter((l) => /^\s*[-*]\s*\[\s\]\s*\**BLOCKER/i.test(l));
  if (verdict === 'PASS' && open.length) problems.push(`verdict PASS with ${open.length} unresolved BLOCKER(s)`);
  const unreviewed = changed.filter((f) => !md.includes(f));
  if (unreviewed.length) problems.push(`changed files not covered by the review: ${unreviewed.join(', ')}`);
  return problems;
}

function validateVerification(md, acs) {
  if (!acs.length) return ['plan has no acceptance criteria to verify'];
  const problems = [];
  const lines = md.split('\n');
  for (const ac of acs) {
    const line = lines.find((l) => {
      const m = l.match(/^\s*[-*|]\s*(?:\[.\]\s*)?(AC-?\d+)\b/i);
      return m && normAC(m[1]) === ac;
    });
    if (!line) problems.push(`${ac} not verified`);
    else if (!/\bPASS\b/.test(line) || /\bFAIL\b/.test(line)) problems.push(`${ac} is not marked PASS`);
    else if (!/evidence\s*:\s*\S/i.test(line)) problems.push(`${ac} has no "evidence:" pointer`);
  }
  return problems;
}

// --------------------------------------------------------------------- helpers

function gate(missing) {
  return { ok: missing.length === 0, missing };
}

function fingerprintOf(manifest) {
  return sha256(
    Object.keys(manifest)
      .sort()
      .map((k) => `${k}\0${manifest[k]}`)
      .join('\n'),
  );
}

function diffManifests(a, b) {
  const added = Object.keys(b).filter((k) => !(k in a));
  const removed = Object.keys(a).filter((k) => !(k in b));
  const modified = Object.keys(b).filter((k) => k in a && a[k] !== b[k]);
  return { added, removed, modified, all: [...added, ...modified, ...removed].sort() };
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function actor() {
  const who = process.env.CLAUDECODE ? 'agent' : 'human';
  let user = 'unknown';
  try {
    user = os.userInfo().username;
  } catch {}
  return `${who}:${user}`;
}

/** gitignore-flavoured matcher: "dir/" matches a directory anywhere (or anchored if it contains
 *  an inner slash), "*.ext" matches basenames, "a/b.json" matches exactly. */
function matchPath(pattern, rel) {
  const re = (glob) => new RegExp('^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]') + '$');
  if (pattern.endsWith('/')) {
    const dir = pattern.slice(0, -1);
    if (dir.includes('/')) return rel === dir || rel.startsWith(dir + '/');
    return rel.split('/').slice(0, -1).some((seg) => re(dir).test(seg)) || rel === dir || rel.startsWith(dir + '/');
  }
  if (pattern.includes('/')) return re(pattern).test(rel);
  return re(pattern).test(rel.split('/').pop());
}

module.exports = {
  Gov,
  PHASES,
  findRoot,
  matchPath,
  validatePlan,
  validateReview,
  validateVerification,
  acceptanceCriteria,
  diffManifests,
  fingerprintOf,
  sha256,
};
