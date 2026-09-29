'use strict';
// Fleet memory: $FLEET_HOME/state.json (per-project mapping, counters, last snapshot) and an append-only
// $FLEET_HOME/events.jsonl that the UI streams.

const fs = require('fs');
const path = require('path');

const EMPTY_PROJECT = () => ({
  paused: false,
  pausedReason: null,
  current: null, // { asanaGid, asanaName, asanaUrl, govTaskId, startedAt }
  mappings: {}, // asanaGid → govTaskId, for every Asana task fleet ever started
  runsByDay: {},
  consecutiveFailures: 0,
  lastRun: null, // { runId, action, exitCode, timedOut, durationMs, at }
  last: null, // snapshot from the latest tick: { action, reason, queue, queueError, at }
});

class FleetState {
  constructor(home) {
    this.home = home;
    this.file = path.join(home, 'state.json');
    this.eventsFile = path.join(home, 'events.jsonl');
    this.data = this.load();
  }

  load() {
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return { projects: d.projects || {} };
    } catch {
      return { projects: {} };
    }
  }

  reload() {
    this.data = this.load();
    return this;
  }

  project(name) {
    this.data.projects[name] = { ...EMPTY_PROJECT(), ...(this.data.projects[name] || {}) };
    return this.data.projects[name];
  }

  /**
   * Read-modify-write one project against the file as it is *now*, so a long tick never writes back a
   * stale copy over what another process (e.g. `fleet pause`) changed meanwhile. Returns the fresh project.
   */
  update(name, fn) {
    this.reload();
    const ps = this.project(name);
    fn(ps);
    this.save();
    return ps;
  }

  /** Atomic write: readers (the UI) never see a half-written file. */
  save() {
    fs.mkdirSync(this.home, { recursive: true });
    const tmp = `${this.file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2) + '\n');
    fs.renameSync(tmp, this.file);
  }

  event(type, data = {}) {
    fs.mkdirSync(this.home, { recursive: true });
    const e = { at: new Date().toISOString(), type, ...data };
    fs.appendFileSync(this.eventsFile, JSON.stringify(e) + '\n');
    return e;
  }

  runLogPath(project, runId) {
    return path.join(this.home, 'runs', project, `${runId}.log`);
  }
}

function readEvents(file, { from = 0, limit = Infinity } = {}) {
  let text;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      if (size <= from) return { events: [], offset: Math.min(from, size) };
      const buf = Buffer.alloc(size - from);
      fs.readSync(fd, buf, 0, buf.length, from);
      text = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { events: [], offset: from };
  }
  // Only consume complete lines; a partial trailing line is picked up next time.
  const end = text.lastIndexOf('\n') + 1;
  const events = text
    .slice(0, end)
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  return { events: events.slice(-limit), offset: from + Buffer.byteLength(text.slice(0, end)) };
}

module.exports = { FleetState, readEvents };
