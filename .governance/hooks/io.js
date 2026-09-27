'use strict';
// Minimal Claude Code hook I/O helpers.

const fs = require('fs');

/** The hook's JSON input, or null if it can't be read. Callers decide what failing closed means for them. */
function readInput() {
  try {
    const input = JSON.parse(fs.readFileSync(0, 'utf8'));
    return input && typeof input === 'object' && !Array.isArray(input) ? input : null;
  } catch {
    return null;
  }
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj));
  process.exit(0);
}

function decide(event, permissionDecision, reason) {
  emit({ hookSpecificOutput: { hookEventName: event, permissionDecision, permissionDecisionReason: reason } });
}

module.exports = { readInput, emit, decide };
