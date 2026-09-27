'use strict';
// Minimal Claude Code hook I/O helpers.

const fs = require('fs');

function readInput() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch {
    return {};
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
