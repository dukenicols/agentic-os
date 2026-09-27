#!/usr/bin/env node
'use strict';
// PreToolUse guard: phase-gated edits, protected/secret paths, dangerous shell, ship-gated commands.

const path = require('path');
const { Gov, matchPath } = require('../lib/core');
const { readInput, decide } = require('./io');

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const GOV_EXECUTABLE = /^(\S*\/)?gov(\.js)?$/;
const WRITE_OP = /(>{1,2}|\btee\b|\bsed\s+(-[a-zA-Z]*\s+)*-i|\bperl\s+-[a-zA-Z]*i|\brm\b|\bmv\b|\bcp\b|\btruncate\b|\bchmod\b|\bchown\b|\bln\b|\bdd\b|\binstall\b|\bgit\s+(checkout|restore|rm|mv)\b|writeFile|\.write\()/;

// Built-in release detector: program → subcommand word sequences. Words may sit between them (flags and
// their values), so `git -c k=v push` or `kubectl -n prod apply` can't slip past. Always on; the config's
// shipGated regexes are added on top.
const RELEASES = {
  git: [['push']],
  gh: [['pr', 'create'], ['pr', 'new'], ['pr', 'merge'], ['pr', 'ready'], ['release', 'create'], ['release', 'new']],
  npm: [['publish']],
  pnpm: [['publish']],
  yarn: [['publish']],
  terraform: [['apply'], ['destroy']],
  kubectl: [['apply'], ['delete'], ['rollout']],
  docker: [['push'], ['--push']], // `docker build --push`, `docker buildx build --push`
  vercel: [['--prod'], ['--target', 'production'], ['promote']],
};

function evaluate(input, gov) {
  const tool = input.tool_name;
  const ti = input.tool_input || {};
  if (gov.configError) {
    // Fail closed: a broken config must never mean "no rules". Reads stay open so the human can be helped.
    return EDIT_TOOLS.has(tool) || tool === 'Bash' ? deny(`${gov.configError} Ask the human to fix it.`, true) : null;
  }
  if (gov.config.mode === 'off') return null;

  if (EDIT_TOOLS.has(tool)) return checkEdit(gov, ti.file_path || ti.notebook_path);
  if (tool === 'Read' || tool === 'Grep' || tool === 'Glob') return checkRead(gov, ti.file_path || ti.path);
  if (tool === 'Bash') return checkBash(gov, String(ti.command || ''));
  return null;
}

// ---------------------------------------------------------------------- edits

function checkEdit(gov, file) {
  if (!file) return null;
  const abs = path.resolve(gov.root, file);
  const rel = path.relative(gov.root, abs).split(path.sep).join('/');
  if (rel.startsWith('..')) return null; // outside the project: Claude Code's own permissions apply

  if (isSecret(gov, rel)) return deny(`${rel} is a secret file. Agents never read or write secrets.`, true);
  if (isProtected(gov, rel)) return deny(`${rel} is governance-owned. Only a human may change it.`, true);

  const task = gov.task();
  const runs = '.governance/runs/';
  if (rel.startsWith(runs)) {
    const [id, ...restParts] = rel.slice(runs.length).split('/');
    const name = restParts.join('/');
    if (!task || id !== task.id) return deny('Only the active task’s run directory is writable.', true);
    if (restParts.length !== 1 || !name.endsWith('.md')) {
      return deny(`${name} is recorded evidence. Evidence is produced by \`gov\`, never written by hand.`, true);
    }
    return null;
  }

  if (!task) {
    if ((gov.config.allowWithoutTask || []).some((p) => matchPath(p, rel))) return null;
    return deny('No active governed task. Start one first: .governance/bin/gov start "<title>" — then write and get the plan approved.');
  }
  if (task.phase === 'plan') {
    return deny(`Task is in PLAN. Code edits are blocked until the plan is approved and you run \`gov advance\`. Edit ${gov.rel(path.join(task.dir, 'plan.md'))} instead.`);
  }
  if (task.phase === 'ship') {
    return deny('Task is in SHIP: the tree is frozen to what was approved. To change code: `gov back build` (all later evidence must be redone).');
  }
  return null;
}

function checkRead(gov, file) {
  if (!file) return null;
  const rel = path.relative(gov.root, path.resolve(gov.root, file)).split(path.sep).join('/');
  if (!rel.startsWith('..') && isSecret(gov, rel)) return deny(`${rel} is a secret file. Agents never read secrets.`, true);
  return null;
}

// ---------------------------------------------------------------------- shell

function checkBash(gov, rawCommand) {
  const command = rawCommand.replace(/\\\r?\n/g, ' '); // line continuations join words
  if (/(^|[\s/;&|])gov(\.js)?\s+approve\b/.test(command) || /\bapprove\s+(plan|ship)\b/.test(command)) {
    return deny('Approvals are human-only. Ask the human to run `gov approve <plan|ship>` in their own terminal.', true);
  }

  for (const rule of gov.config.guardrails?.bashDeny || []) {
    if (new RegExp(rule.pattern, 'i').test(command)) return deny(`Blocked by guardrail: ${rule.reason}`);
  }

  // Tamper and secret checks. A segment that failed to split (stray quote, comment) is checked as a whole: stricter.
  const segments = splitSegments(command);
  for (const seg of segments) {
    const cleaned = seg.replace(/\d?>&\d|&>\s*\/dev\/null|\d?>\s*\/dev\/null/g, '');
    const tokens = cleaned.split(/[\s=<>'"`]+/).filter(Boolean);
    const touchesSecret = tokens.some((t) => isSecret(gov, t.replace(/^\.\//, '')));
    if (touchesSecret) return deny('Command references a secret file. Agents never read or write secrets.', true);
    if (!WRITE_OP.test(cleaned)) continue;
    const targets = GOV_EXECUTABLE.test(tokens[0] || '') ? tokens.slice(1) : tokens; // the gov binary itself is not a target
    const touchesGoverned = targets.some((t) => {
      const rel = t.replace(/^\.\//, '');
      return isProtected(gov, rel) || /(^|\/)\.governance\/(runs|state\.json)/.test(rel);
    });
    if (touchesGoverned) {
      return deny('Command would modify governance files or recorded evidence. Use `gov` subcommands; config changes belong to a human.', true);
    }
  }

  // Release commands are ship-gated wherever they run: there is deliberately no "other repo" exemption.
  const patterns = (gov.config.guardrails?.shipGated || []).map((p) => new RegExp(p, 'i'));
  const isRelease = [command, ...segments].some((text) => patterns.some((re) => re.test(text))) || segments.some(hasBuiltinRelease);
  if (isRelease) {
    const task = gov.task();
    if (!task || task.phase !== 'ship') {
      return deny(`Release commands (push/PR/publish/deploy) only run in the SHIP phase, in any directory. Current: ${task ? task.phase : 'no task'}. To release another repo, ask the human to run it.`);
    }
    const g = gov.gates(task);
    if (!g.ship.ok) return deny(`Ship gate not satisfied:\n- ${g.ship.missing.join('\n- ')}`);
  }
  return null;
}

/** Does this segment (or a quoted command inside it, e.g. `bash -c '…'`) run a built-in release command? */
function hasBuiltinRelease(text) {
  const words = [];
  for (const raw of shellWords(text) || text.split(/\s+/)) {
    if (/\s/.test(raw)) {
      if (hasBuiltinRelease(raw)) return true; // nested command string: checked on its own
      words.push(null); // opaque at this level, so `git commit -m "push it"` is not a push
      continue;
    }
    const word = raw.replace(/^[^\w./-]+|[^\w./=-]+$/g, ''); // `$(git` → git, `push)` → push
    if (word.startsWith('-') && word.includes('=')) words.push(...word.split(/=(.*)/s, 2)); // --target=production
    else words.push(word);
  }
  return words.some((w, i) => {
    // Program names compare case-insensitively: macOS runs `GIT push` as git.
    const name = w && path.basename(w).toLowerCase();
    const sequences = name && Object.hasOwn(RELEASES, name) ? RELEASES[name] : null; // not `constructor`, `__proto__`, …
    return sequences && sequences.some((seq) => isSubsequence(seq, words.slice(i + 1)));
  });
}

function isSubsequence(seq, words) {
  let k = 0;
  for (const w of words) if (w === seq[k] && ++k === seq.length) return true;
  return false;
}

/** Split a shell command at &&, ||, ;, | and newlines that are outside quotes. */
function splitSegments(command) {
  const out = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === '\\' && quote === '"' && i + 1 < command.length) cur += c + command[++i];
      else {
        if (c === quote) quote = null;
        cur += c;
      }
      continue;
    }
    if (c === '\\' && i + 1 < command.length) {
      cur += c + command[++i];
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    const two = command.slice(i, i + 2);
    if (two === '&&' || two === '||') {
      out.push(cur);
      cur = '';
      i++;
    } else if (!quote && (c === ';' || c === '|' || c === '\n')) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** Words of a segment with simple '…' / "…" quoting; null on an unterminated quote. */
function shellWords(seg) {
  const words = [];
  let cur = null;
  let quote = null;
  for (const c of seg) {
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      cur = cur ?? '';
    } else if (/\s/.test(c)) {
      if (cur !== null) words.push(cur);
      cur = null;
    } else cur = (cur ?? '') + c;
  }
  if (quote) return null;
  if (cur !== null) words.push(cur);
  return words;
}

// -------------------------------------------------------------------- helpers

function isSecret(gov, rel) {
  if ((gov.config.secretAllow || []).some((p) => matchPath(p, rel))) return false;
  return (gov.config.secretPaths || []).some((p) => matchPath(p, rel));
}

function isProtected(gov, rel) {
  return (gov.config.protectedPaths || []).some((p) => matchPath(p, rel));
}

/** hard=true denies regardless of mode (tamper / secrets / approvals). */
function deny(reason, hard = false) {
  return { reason, hard };
}

module.exports = { evaluate, splitSegments, shellWords, hasBuiltinRelease };

if (require.main === module) {
  let input = null;
  try {
    input = readInput();
    const gov = input && (Gov.open(input.cwd) || Gov.open(process.env.CLAUDE_PROJECT_DIR));
    if (!input) {
      // We can't tell which tool this is, so we can't safely allow it.
      decide('PreToolUse', 'deny', '[governance] unreadable hook input, failing closed.');
    } else if (gov) {
      const verdict = evaluate(input, gov);
      if (verdict) {
        const decision = verdict.hard || gov.config.mode !== 'advisory' ? 'deny' : 'ask';
        decide('PreToolUse', decision, `[governance] ${verdict.reason}`);
      }
    }
    process.exit(0);
  } catch (err) {
    // A crashing hook is non-blocking in Claude Code, i.e. "allow". Never let an error mean allow.
    if (EDIT_TOOLS.has(input?.tool_name) || input?.tool_name === 'Bash') {
      decide('PreToolUse', 'deny', `[governance] guard error, failing closed: ${err.message}`);
    }
    process.exit(0);
  }
}
