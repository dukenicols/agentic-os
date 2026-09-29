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
    // Never fall back to an empty config: that would silently switch every guard off.
    const oneLine = (s) => String(s).replace(/\s+/g, ' ');
    let problems = [];
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(path.join(this.dir, 'config.json'), 'utf8'));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not a JSON object');
    } catch (err) {
      problems = [oneLine(err.message)];
    }
    if (!problems.length) {
      try {
        problems = validateConfig(raw);
      } catch (err) {
        // A bug in the validator is not the human's config being wrong: say which it is.
        this.configError = `governance guard error while checking config.json (${oneLine(err.message)}); failing closed.`;
      }
    }
    if (problems.length) this.configError = `.governance/config.json is invalid (${problems.join('; ')}); governance is failing closed.`;
    this.configError = this.configError || null;
    this.config = this.configError ? {} : raw;
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

  /**
   * The change since the task started, as a unified diff built from bytes, not by `git diff`. The new side
   * is read straight from the worktree (the same bytes the fingerprint hashes). The old side comes from the
   * base commit's objects and is used only if its sha256 matches the manifest recorded at `gov start`.
   * Repo-local git config, attributes, filters, replace refs and index flags therefore can't change what it
   * shows. When the old side can't be verified, the whole current file is shown: complete, never partial.
   */
  patch(task) {
    const base = this.baseline(task);
    const manifest = this.manifest();
    const d = diffManifests(base.manifest, manifest);
    return d.all
      .map((rel) => {
        const removed = !(rel in manifest);
        const abs = path.join(this.root, rel);
        // A symlink is shown as its target, never followed: its target may be outside the repo (or a secret).
        if (!removed && fs.lstatSync(abs).isSymbolicLink()) {
          return `diff --gov a/${rel} b/${rel}\nnote: symbolic link to ${JSON.stringify(fs.readlinkSync(abs))}; target content not shown\n`;
        }
        const oldBuf = rel in base.manifest ? this.baseBlob(base.gitHead, rel, base.manifest[rel]) : Buffer.alloc(0);
        const newBuf = removed ? Buffer.alloc(0) : fs.readFileSync(abs);
        return filePatch(rel, oldBuf, newBuf, { added: !(rel in base.manifest), removed });
      })
      .join('');
  }

  /** A file as it was at task start, from git objects — only if it matches the recorded hash; else null. */
  baseBlob(gitHead, rel, expectedSha) {
    if (!gitHead) return null;
    const r = spawnSync('git', ['--no-replace-objects', 'cat-file', 'blob', `${gitHead}:${rel}`], {
      cwd: this.root,
      maxBuffer: 256 * 1024 * 1024,
      env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' },
    });
    if (r.status !== 0 || !r.stdout) return null;
    return sha256(r.stdout) === expectedSha ? r.stdout : null;
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

  /**
   * Record a human approval. `expect` binds it to what the human reviewed: the plan's sha256 (plan) or
   * the tree fingerprint (ship). On a mismatch nothing is recorded. `via` names the channel (e.g. fleet-ui).
   */
  approve(phase, { expect, via } = {}) {
    if (process.env.CLAUDECODE) {
      throw new Error('Approvals must come from a human. Run `gov approve` in your own terminal, not through the agent.');
    }
    const task = this.requireTask();
    if (!['plan', 'ship'].includes(phase)) throw new Error('Only `plan` and `ship` take approvals.');
    if (via !== undefined && !/^[a-z0-9-]{1,32}$/.test(via)) throw new Error('--via must match [a-z0-9-]{1,32}');
    const entry = { type: 'approval', phase };
    if (phase === 'plan') {
      const plan = this.planText(task); // read once: what is checked is what is hashed
      const problems = validatePlan(plan);
      if (problems.length) throw new Error(`Plan is incomplete:\n  - ${problems.join('\n  - ')}`);
      entry.planHash = sha256(plan);
      if (expect !== undefined && expect !== entry.planHash) {
        throw new Error('plan.md changed since it was reviewed (hash mismatch); review it again before approving.');
      }
    } else {
      const g = this.gates(task);
      const blocking = PHASES.slice(0, 4).filter((p) => !g[p].ok);
      if (blocking.length) throw new Error(`Cannot approve ship: gates failing: ${blocking.join(', ')}`);
      entry.fingerprint = g.fingerprint;
      if (expect !== undefined && expect !== entry.fingerprint) {
        throw new Error('the tree changed since it was reviewed (fingerprint mismatch); review it again before approving.');
      }
    }
    if (via) entry.via = via;
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
      const human = [];
      if (this.config.approvals?.plan) {
        const a = latest((e) => e.type === 'approval' && e.phase === 'plan');
        if (!a) human.push('human approval: run `gov approve plan` in your own terminal');
        else if (a.planHash !== sha256(plan)) human.push('plan.md changed after approval — human must re-approve');
      }
      g.plan = gate(missing, human);
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
      const human = [];
      if (this.config.approvals?.ship) {
        const a = latest((e) => e.type === 'approval' && e.phase === 'ship');
        if (!a) human.push('human approval: run `gov approve ship` in your own terminal');
        else if (a.fingerprint !== fp) human.push('code changed after ship approval — human must re-approve');
      }
      g.ship = gate(missing, human);
    }

    const integrity = this.verifyLedger(task.id);
    if (!integrity.ok) {
      for (const p of PHASES) g[p] = gate([`ledger tampered (entry ${integrity.brokenAt}) — all evidence void`]);
    }
    return g;
  }

  /** Cumulative: to leave a phase, it and every earlier gate must pass on the current tree. */
  canLeave(task, g = this.gates(task)) {
    return this.blockers(task, g).map((b) => `[${b.phase}] ${b.message}`);
  }

  /** Everything blocking the current phase, each flagged with whether only a human can resolve it. */
  blockers(task, g = this.gates(task)) {
    const upto = PHASES.slice(0, PHASES.indexOf(task.phase) + 1);
    return upto.flatMap((p) => g[p].missing.map((message) => ({ phase: p, message, human: g[p].human.includes(message) })));
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

// ---------------------------------------------------------------------- config

/** Shape checks for config.json. Any problem makes governance fail closed. */
function validateConfig(c) {
  const problems = [];
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const strings = (v, name) => {
    if (v !== undefined && !(Array.isArray(v) && v.every((x) => typeof x === 'string'))) problems.push(`${name} must be an array of strings`);
  };
  const regex = (src, name) => {
    try {
      new RegExp(src, 'i');
    } catch {
      problems.push(`${name} is not a valid regex`);
    }
  };

  if (c.mode !== undefined && typeof c.mode !== 'string') problems.push('mode must be a string');
  for (const k of ['protectedPaths', 'secretPaths', 'secretAllow', 'allowWithoutTask']) strings(c[k], k);
  if (c.fingerprint !== undefined) {
    if (!isObj(c.fingerprint)) problems.push('fingerprint must be an object');
    else strings(c.fingerprint.ignore, 'fingerprint.ignore');
  }
  if (c.commands !== undefined) {
    if (!isObj(c.commands)) problems.push('commands must be an object');
    else for (const k of ['build', 'test']) strings(c.commands[k], `commands.${k}`);
  }
  if (c.approvals !== undefined && !isObj(c.approvals)) problems.push('approvals must be an object');
  const g = c.guardrails;
  if (g !== undefined) {
    if (!isObj(g)) problems.push('guardrails must be an object');
    else {
      if (g.bashDeny !== undefined) {
        if (!Array.isArray(g.bashDeny)) problems.push('guardrails.bashDeny must be an array');
        else
          g.bashDeny.forEach((r, i) => {
            if (!isObj(r) || typeof r.pattern !== 'string') problems.push(`guardrails.bashDeny[${i}].pattern must be a string`);
            else regex(r.pattern, `guardrails.bashDeny[${i}].pattern`);
          });
      }
      strings(g.shipGated, 'guardrails.shipGated');
      if (Array.isArray(g.shipGated)) g.shipGated.forEach((s, i) => typeof s === 'string' && regex(s, `guardrails.shipGated[${i}]`));
    }
  }
  return problems;
}

// --------------------------------------------------------------------- helpers

/** A gate result. `human` lists the items only a person can resolve (approvals); they are also in `missing`. */
function gate(missing, human = []) {
  return { ok: missing.length + human.length === 0, missing: [...missing, ...human], human };
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

// ------------------------------------------------------------------- patches

const PATCH_CONTEXT = 3;
const LCS_MAX_CELLS = 4e6;

/** One file's section of `gov diff --patch`. Nothing is ever elided or decoded lossily. */
function filePatch(rel, oldBuf, newBuf, { added, removed }) {
  const head = `diff --gov a/${rel} b/${rel}\n`;
  if (oldBuf === null) {
    if (removed) return `${head}deleted file; its previous content could not be verified against the baseline\n`;
    const note = 'note: previous content could not be verified against the baseline: showing the whole current file';
    const t = decodeBytes(newBuf, !isUtf8(newBuf));
    return `${head}${note}\n${textNotes([newBuf])}--- a/${rel}\n+++ b/${rel}\n${hunks(lineOps([], toLines(t)))}`;
  }
  // Any side that isn't valid UTF-8 switches both sides to the escaped form, so escapes can't collide with text.
  const escape = !isUtf8(oldBuf) || !isUtf8(newBuf);
  const ops = lineOps(toLines(decodeBytes(oldBuf, escape)), toLines(decodeBytes(newBuf, escape)));
  let notes = textNotes([oldBuf, newBuf]);
  if (!oldBuf.equals(newBuf) && !ops.some((o) => o[0] !== ' ')) {
    // Safety net: must never happen with the escaping above, but a change must never look like no change.
    notes += `note: BYTES DIFFER BUT NOT AS TEXT (sha256 ${sha256(oldBuf).slice(0, 12)} → ${sha256(newBuf).slice(0, 12)}); review this file on the server\n`;
  }
  return `${head}${notes}--- ${added ? '/dev/null' : `a/${rel}`}\n+++ ${removed ? '/dev/null' : `b/${rel}`}\n${hunks(ops)}`;
}

function isUtf8(buf) {
  return Buffer.from(buf.toString('utf8'), 'utf8').equals(buf);
}

/**
 * Bytes → text without loss. With `escape`, every byte that isn't part of a valid UTF-8 sequence becomes
 * ⟦0xNN⟧ and a literal ⟦ becomes ⟦⟦, so distinct byte strings always give distinct text.
 */
function decodeBytes(buf, escape) {
  if (!escape) return buf.toString('utf8');
  let out = '';
  let i = 0;
  while (i < buf.length) {
    const b = buf[i];
    const len = b < 0x80 ? 1 : b >= 0xc2 && b <= 0xdf ? 2 : b >= 0xe0 && b <= 0xef ? 3 : b >= 0xf0 && b <= 0xf4 ? 4 : 0;
    const seq = len ? buf.subarray(i, i + len) : null;
    if (seq && seq.length === len && Buffer.from(seq.toString('utf8'), 'utf8').equals(seq)) {
      out += seq.toString('utf8').replace(/⟦/g, '⟦⟦');
      i += len;
    } else {
      out += `⟦0x${b.toString(16).toUpperCase().padStart(2, '0')}⟧`;
      i += 1;
    }
  }
  return out;
}

function textNotes(bufs) {
  let n = '';
  if (bufs.some((b) => b.includes(0))) n += 'note: contains NUL bytes (shown as text)\n';
  if (bufs.some((b) => !isUtf8(b))) n += 'note: not valid UTF-8 — invalid bytes shown as ⟦0xNN⟧, a literal ⟦ as ⟦⟦\n';
  return n;
}

/** Lines of a text; a trailing newline yields a final '' so newline-at-EOF changes stay visible. */
function toLines(text) {
  return text === '' ? [] : text.split('\n');
}

/** Line-level edit script: [' '|'-'|'+', line][]. LCS on the differing middle; whole-block replace if huge. */
function lineOps(a, b) {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const A = a.slice(p, a.length - s);
  const B = b.slice(p, b.length - s);
  const n = A.length;
  const m = B.length;
  const mid = [];
  if (n && m && n * m <= LCS_MAX_CELLS) {
    const w = m + 1;
    const L = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) L[i * w + j] = A[i] === B[j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (A[i] === B[j]) mid.push([' ', A[i++]]), j++;
      else if (L[(i + 1) * w + j] >= L[i * w + j + 1]) mid.push(['-', A[i++]]);
      else mid.push(['+', B[j++]]);
    }
    while (i < n) mid.push(['-', A[i++]]);
    while (j < m) mid.push(['+', B[j++]]);
  } else {
    for (const l of A) mid.push(['-', l]);
    for (const l of B) mid.push(['+', l]);
  }
  return [...a.slice(0, p).map((l) => [' ', l]), ...mid, ...a.slice(a.length - s).map((l) => [' ', l])];
}

/** Unified-diff hunks with PATCH_CONTEXT lines of context around every change. */
function hunks(ops) {
  let oldNo = 1;
  let newNo = 1;
  const rows = ops.map((o) => {
    const r = { o, oldNo, newNo };
    if (o[0] !== '+') oldNo++;
    if (o[0] !== '-') newNo++;
    return r;
  });
  const changed = rows.flatMap((r, k) => (r.o[0] === ' ' ? [] : [k]));
  let out = '';
  for (let k = 0; k < changed.length; k++) {
    const start = Math.max(0, changed[k] - PATCH_CONTEXT);
    let end = Math.min(rows.length - 1, changed[k] + PATCH_CONTEXT);
    while (k + 1 < changed.length && changed[k + 1] - PATCH_CONTEXT <= end + 1) end = Math.min(rows.length - 1, changed[++k] + PATCH_CONTEXT);
    const slice = rows.slice(start, end + 1);
    const olds = slice.filter((r) => r.o[0] !== '+');
    const news = slice.filter((r) => r.o[0] !== '-');
    const os = olds.length ? olds[0].oldNo : slice[0].oldNo - 1;
    const ns = news.length ? news[0].newNo : slice[0].newNo - 1;
    out += `@@ -${os},${olds.length} +${ns},${news.length} @@\n${slice.map((r) => `${r.o[0]}${r.o[1]}\n`).join('')}`;
  }
  return out;
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
  validateConfig,
  validatePlan,
  validateReview,
  validateVerification,
  acceptanceCriteria,
  diffManifests,
  fingerprintOf,
  sha256,
  _patch: { lineOps, hunks, filePatch, decodeBytes },
};
