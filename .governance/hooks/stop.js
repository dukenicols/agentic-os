#!/usr/bin/env node
'use strict';
// Stop gate: the agent may not end its turn with the current phase un-evidenced
// unless it is only waiting on a human approval. Fires at most once per stop
// (stop_hook_active) so it can never trap the session.

const { Gov } = require('../lib/core');
const { readInput, emit } = require('./io');

function evaluate(input, gov) {
  if (gov.configError || gov.config.mode === 'off' || input.stop_hook_active) return null;
  const task = gov.task();
  if (!task) return null;

  const blockers = gov.blockers(task);
  if (!blockers.length || blockers.every((b) => b.human)) return null; // done, or only waiting on a person
  const missing = blockers.map((b) => `[${b.phase}] ${b.message}`);

  return (
    `[governance] Task "${task.title}" is in ${task.phase.toUpperCase()} and its gate is not evidenced:\n` +
    missing.map((m) => `  - ${m}`).join('\n') +
    `\n\nEither produce the missing evidence now (see \`.governance/bin/gov status\`), or, if you are ` +
    `blocked or need the human, say so plainly: name the phase, what is missing, and why. ` +
    `Do not describe this phase as done, fixed, or passing.`
  );
}

module.exports = { evaluate };

if (require.main === module) {
  try {
    const input = readInput();
    if (!input) process.exit(0); // unreadable input: never trap the session
    const gov = Gov.open(input.cwd) || Gov.open(process.env.CLAUDE_PROJECT_DIR);
    if (!gov) process.exit(0);
    const reason = evaluate(input, gov);
    if (reason) emit({ decision: 'block', reason });
  } catch {
    process.exit(0); // never trap the session on a hook error
  }
}
