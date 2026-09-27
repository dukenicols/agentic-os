#!/usr/bin/env node
'use strict';
// PreToolUse guard: phase-gated edits, protected/secret paths, dangerous shell, ship-gated commands.

const path = require('path');
const { Gov, matchPath } = require('../lib/core');
const { readInput, decide } = require('./io');

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const GOV_INVOCATION = /(^|[\s/])gov(\.js)?\s+(start|status|check|advance|back|run|record|diff|ship|abort|log|help)\b/;
const WRITE_OP = /(>{1,2}|\btee\b|\bsed\s+(-[a-zA-Z]*\s+)*-i|\bperl\s+-[a-zA-Z]*i|\brm\b|\bmv\b|\bcp\b|\btruncate\b|\bchmod\b|\bchown\b|\bln\b|\bdd\b|\binstall\b|\bgit\s+(checkout|restore|rm|mv)\b|writeFile|\.write\()/;

function evaluate(input, gov) {
  const mode = gov.config.mode;
  if (mode === 'off') return null;
  const tool = input.tool_name;
  const ti = input.tool_input || {};

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

function checkBash(gov, command) {
  if (/(^|[\s/;&|])gov(\.js)?\s+approve\b/.test(command) || /\bapprove\s+(plan|ship)\b/.test(command)) {
    return deny('Approvals are human-only. Ask the human to run `gov approve <plan|ship>` in their own terminal.', true);
  }

  for (const rule of gov.config.guardrails?.bashDeny || []) {
    if (new RegExp(rule.pattern, 'i').test(command)) return deny(`Blocked by guardrail: ${rule.reason}`);
  }

  const segments = command.split(/&&|\|\||;|\||\n/).map((s) => s.trim()).filter(Boolean);
  for (const seg of segments) {
    if (GOV_INVOCATION.test(seg)) continue;
    const cleaned = seg.replace(/\d?>&\d|&>\s*\/dev\/null|\d?>\s*\/dev\/null/g, '');
    const tokens = cleaned.split(/[\s=<>'"`]+/).filter(Boolean);
    const touchesSecret = tokens.some((t) => isSecret(gov, t.replace(/^\.\//, '')));
    if (touchesSecret) return deny('Command references a secret file. Agents never read or write secrets.', true);
    if (!WRITE_OP.test(cleaned)) continue;
    const touchesGoverned = tokens.some((t) => {
      const rel = t.replace(/^\.\//, '');
      return isProtected(gov, rel) || /(^|\/)\.governance\/(runs|state\.json)/.test(rel);
    });
    if (touchesGoverned) {
      return deny('Command would modify governance files or recorded evidence. Use `gov` subcommands; config changes belong to a human.', true);
    }
  }

  const gated = (gov.config.guardrails?.shipGated || []).find((p) => new RegExp(p, 'i').test(command));
  if (gated) {
    const task = gov.task();
    if (!task || task.phase !== 'ship') {
      return deny(`Release commands (push/PR/publish/deploy) only run in the SHIP phase. Current: ${task ? task.phase : 'no task'}.`);
    }
    const g = gov.gates(task);
    if (!g.ship.ok) return deny(`Ship gate not satisfied:\n- ${g.ship.missing.join('\n- ')}`);
  }
  return null;
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

module.exports = { evaluate };

if (require.main === module) {
  const input = readInput();
  const gov = Gov.open(input.cwd);
  if (!gov) process.exit(0);
  const verdict = evaluate(input, gov);
  if (!verdict) process.exit(0);
  const decision = verdict.hard || gov.config.mode === 'enforce' ? 'deny' : 'ask';
  decide('PreToolUse', decision, `[governance] ${verdict.reason}`);
}
