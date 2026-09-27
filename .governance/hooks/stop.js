#!/usr/bin/env node
'use strict';
// Stop gate: the agent may not end its turn with the current phase un-evidenced
// unless it is only waiting on a human approval. Fires at most once per stop
// (stop_hook_active) so it can never trap the session.

const { Gov } = require('../lib/core');
const { readInput, emit } = require('./io');

function evaluate(input, gov) {
  if (gov.config.mode === 'off' || input.stop_hook_active) return null;
  const task = gov.task();
  if (!task) return null;

  const missing = gov.canLeave(task);
  if (!missing.length) return null;
  const onlyHumans = missing.every((m) => /human approval/.test(m));
  if (onlyHumans) return null;

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
  const input = readInput();
  const gov = Gov.open(input.cwd);
  if (!gov) process.exit(0);
  const reason = evaluate(input, gov);
  if (reason) emit({ decision: 'block', reason });
}
