'use strict';
// The supervisor's whole policy, as one pure function: given a repo's `gov status --json`, the fleet's
// memory of that repo, and its Asana queue, what should happen this tick?

const HUMAN_GATES = new Set(['plan', 'ship']);
const MAX_FEEDBACK_RUNS = 2;

/**
 * @param {object} a
 * @param {object} a.status   parsed `gov status --json` ({ task, gates }) or { error }
 * @param {object} a.pstate   fleet state for the project (see state.js)
 * @param {Array}  a.queue    Asana tasks, head first
 * @param {object} a.limits   registry limits
 * @param {string} a.today    YYYY-MM-DD
 * @returns {{action: 'start'|'continue'|'await-human'|'idle'|'paused', ...}}
 */
function decide({ status, pstate, queue = [], limits, today }) {
  if (pstate.paused) return { action: 'paused', reason: pstate.pausedReason || 'paused by human' };
  if (!status || status.error) return { action: 'paused', reason: `gov status failed: ${status?.error || 'no output'}` };

  const task = status.task;
  let run;
  if (task) {
    if (pstate.current?.govTaskId !== task.id) {
      return { action: 'idle', reason: `active task ${task.id} was not started by fleet; leaving it to the human` };
    }
    const g = status.gates?.[task.phase];
    // Changes the human requested on this exact plan text of this task, not yet addressed. Only while the
    // plan is unapproved (an approval supersedes the request) and for a bounded number of revision runs
    // (if the agent keeps not changing the plan, it goes back to the human).
    const feedback =
      task.phase === 'plan' && status.planHash && g && !g.ok
        ? (pstate.feedback || []).filter((f) => f.planHash === status.planHash && f.taskId === task.id && (f.runs || 0) < MAX_FEEDBACK_RUNS)
        : [];
    const humanOnly = HUMAN_GATES.has(task.phase) && g && g.missing.length && g.missing.length === (g.human || []).length;
    if (humanOnly && !feedback.length) {
      return { action: 'await-human', gate: task.phase, taskId: task.id };
    }
    // Releasing (push, PR, `gov ship`) is the human's job: fleet stops once ship is approved.
    if (task.phase === 'ship' && g && !g.missing.length) {
      return { action: 'idle', reason: 'ship approved — release is yours: push/PR, then `gov ship <ref>`' };
    }
    run = { action: 'continue', taskId: task.id, phase: task.phase, ...(feedback.length ? { feedback } : {}) };
  } else {
    const mapped = pstate.mappings || {};
    const next = queue.find((t) => !(t.gid in mapped));
    if (!next) return { action: 'idle', reason: queue.length ? 'every queued task was already taken' : 'queue empty' };
    run = { action: 'start', asanaTask: next };
  }

  if ((pstate.consecutiveFailures || 0) >= limits.maxConsecutiveFailures) {
    return { action: 'paused', reason: `${pstate.consecutiveFailures} consecutive failed runs — check the logs, then \`fleet resume\`` };
  }
  if ((pstate.runsByDay?.[today] || 0) >= limits.maxRunsPerProjectPerDay) {
    return { action: 'paused', reason: `daily run cap (${limits.maxRunsPerProjectPerDay}) reached` };
  }
  return run;
}

module.exports = { decide, MAX_FEEDBACK_RUNS };
