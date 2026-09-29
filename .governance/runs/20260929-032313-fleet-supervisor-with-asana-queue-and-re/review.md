# Review: fleet supervisor with Asana queue and read-only UI

Reviewer: gov-reviewer
Verdict: PASS

## Files reviewed
- fleet/README.md — The Tailscale section now says the Host allowlist applies and that a MagicDNS name gets 421 (lines 114-116). The allowlist example and the code-execution warning are unchanged. OK.
- fleet/bin/fleet — `tick` installs one-shot handlers for SIGINT, SIGTERM and SIGHUP. Each sends SIGTERM to every agent, then SIGKILL after 3 s, then exits 130. The worker pool is not stopped during that window (NIT).
- fleet/lib/asana.js — Unchanged since round 2. Read-only, a missing section throws, and the token stays out of errors. OK.
- fleet/lib/decide.js — Unchanged. A null `govTaskId` is not ownership, fleet goes idle after ship approval, and the AC3 table holds. OK.
- fleet/lib/registry.js — Unchanged. Fails closed and validates names. OK.
- fleet/lib/runner.js — The lock now holds `<supervisor> <agent>`. It counts as held while either pid is alive, and reclaim re-checks the file content before removing it. `live` and `killAllAgents` are correct, and `finish` removes the child from `live`. The reclaim race is narrower but not closed. A pid reused after a reboot can pin the lock (NITs).
- fleet/lib/server.js — HEAD now gets 405 (every method except GET). URL parsing returns 400, the Host guard, the shared cache and the path validation are all intact. OK.
- fleet/lib/state.js — Unchanged. `update()` re-reads before each write, and writes are atomic. OK.
- fleet/lib/tick.js — `onSpawn: release.agent` is wired through to the runner. If `gov status` fails after a start run, the attempt is kept (`current` stays set with `govTaskId` null) and counted as a failure, and the next pass's `reconcile` resolves it. OK.
- fleet/systemd/agentic-fleet-tick.service — Unchanged. OK.
- fleet/systemd/agentic-fleet-tick.timer — Unchanged. OK.
- fleet/systemd/agentic-fleet-ui.service — Unchanged. Binds to localhost and holds no secrets. OK.
- fleet/ui/index.html — Unchanged. Links are https-only and everything is built with `textContent`. OK.
- test/fleet-config.test.js — Covers AC1, AC2 and AC8. OK.
- test/fleet-decide.test.js — Covers the AC3 table. OK.
- test/fleet-helpers.js — OK.
- test/fleet-server.test.js — The 405 test now includes HEAD (line 135). The AC7 test is still a string check, which is accepted as partial evidence. OK.
- test/fleet-tick.test.js — New tests:
  - the lock is held while the agent is alive (line 332);
  - the agent pid is recorded in the lock (line 345);
  - `killAllAgents` (line 359);
  - the `createdAt` guard with a matching title (line 371);
  - a `gov status` error keeps the attempt (line 383).

  The signal handlers in bin/fleet have no test (NIT).
- package.json — Adds the `fleet` bin. OK.
- scripts/check.js — Adds `fleet/bin/fleet` and `fleet/lib` to the parse check. OK.

`node --test test/*.test.js`: 96/96 pass. `npm run build`: 27 JS and 3 JSON files checked, 0 failed.

## Plan conformance
The change stays inside the approved scope: an Asana-queued supervisor, a runner, state, a read-only UI and systemd units, with zero dependencies and no change to the `.governance/` core. Fleet still stops at both human gates:
- `decide` returns idle once ship is approved (decide.js:31-33).
- The `continue` prompt forbids releasing (runner.js:65-67).

Everything added in this round is hardening that the round-2 review asked for: the agent pid in the lock, killing agents on a signal, the reclaim check, keeping the attempt when `gov status` fails, HEAD → 405, and the README note. None of it is new scope.

## Findings
Prior findings (round 2), checked in the code:
- [x] MAJOR: Interrupting a manual `fleet tick` left an orphaned agent and allowed a second run in the same repo. Fixed in two ways:
  - The lock now records the agent pid (runner.js:88, wired via tick.js:99 and runner.js:158). It stays held while either pid is alive (runner.js:100-104), so an orphan still blocks a second run.
  - `fleet tick` sends SIGTERM and then SIGKILL to every live agent group on SIGINT, SIGTERM or SIGHUP (bin/fleet:38-47, runner.js:117-131).

  Tests are at test/fleet-tick.test.js:332, 345 and 359.
- [x] NIT: A failed `gov status` after a start run orphaned the task it opened. Fixed: when `st.error` is set, `current` is kept with a null `govTaskId` (tick.js:145-146), and `reconcile` later adopts the task, only if its title matches, or clears it. Test is at test/fleet-tick.test.js:383.
- [x] NIT: The `createdAt >= startedAt` recovery rule had no test. Fixed: test/fleet-tick.test.js:371 uses a task whose title matches but which predates the attempt, so only the guard at tick.js:168 rejects it.
- [x] NIT: The two-reclaimer lock race. Mostly mitigated: reclaim re-reads the file and gives up if the content changed (runner.js:106-110), so the common case ("B already created a fresh lock") is handled. A narrow window remains; see the new NIT below.
- [x] NIT: HEAD was not refused. Fixed: every non-GET method gets 405 (server.js:61). Test is at test/fleet-server.test.js:135.
- [x] NIT: The README did not mention the Host check. Fixed at fleet/README.md:114-116.

New findings (round 3):
- NIT: **After a signal, the tick keeps scheduling jobs during the 3 s grace period.**
  - The handler at fleet/bin/fleet:39-46 kills the current agents, but the worker loop (tick.js:104-105) is still running. When the SIGTERMed agent's `close` fires, `execute` records the run and the worker takes the next pending job. `acquireLock` and `runAgent` then spawn a new agent in another project.
  - The SIGKILL timer does catch it, because it is in `live`. But after an explicit Ctrl-C, a fresh agent starts for a moment, and a `start` job leaves a `current` behind (which `reconcile` later clears).
  - The run the signal interrupted is also recorded as a failed run and bumps `consecutiveFailures`.
  - Fix: set a module-level `stopping` flag in the handler and have `runJob` or `worker` return early when it is set.
- NIT: **The reclaim check is still a TOCTOU.** Two reclaimers can both pass the re-read at runner.js:107 before either reaches `rmSync` at runner.js:111. The second one then deletes the lock the first just created. The window is now very small, and `OnUnitInactiveSec` prevents overlapping passes, so this is acceptable. Reclaiming with `rename` to a unique name would close it fully.
- NIT: **Pid reuse can pin a lock.** A lock left over from before a reboot holds two pids. If the OS reuses either one for an unrelated process, `isAlive` reports it as held (runner.js:104) until the file is deleted by hand, and the project is skipped as `locked` indefinitely. Consider also treating the lock as stale when its mtime predates the system boot time, or document `rm ~/.agentic-os/locks/<project>.lock` as the remedy.
- NIT: **The signal handlers have no test, and SIGTERM exits with the wrong code.** The handlers in fleet/bin/fleet:38-47 are untested; only `killAllAgents` is exercised. Also, exit code 130 is used for SIGTERM and SIGHUP too, where 143 and 129 are the conventional codes. This is cosmetic.
