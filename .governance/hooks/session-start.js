#!/usr/bin/env node
'use strict';
// SessionStart: put the live governance state in front of the agent.

const { Gov, PHASES } = require('../lib/core');
const { readInput, emit } = require('./io');

function context(gov) {
  const lines = [`# Governance (mode: ${gov.config.mode})`, 'Rules: AGENTS.md. CLI: .governance/bin/gov'];
  const task = gov.task();
  if (!task) {
    lines.push('No active task. Before changing any code: `.governance/bin/gov start "<title>"`.');
    return lines.join('\n');
  }
  const g = gov.gates(task);
  lines.push(`Active task: "${task.title}" (${task.id}) — phase ${task.phase.toUpperCase()}`);
  for (const p of PHASES) {
    lines.push(`- ${g[p].ok ? '[x]' : '[ ]'} ${p}${g[p].ok ? '' : ': ' + g[p].missing.join('; ')}`);
  }
  return lines.join('\n');
}

module.exports = { context };

if (require.main === module) {
  const input = readInput();
  const gov = Gov.open(input.cwd);
  if (!gov) process.exit(0);
  emit({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context(gov) } });
}
