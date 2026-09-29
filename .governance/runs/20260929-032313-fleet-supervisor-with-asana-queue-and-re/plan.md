# Plan: fleet supervisor with Asana queue and read-only UI

## Goal
Run the governed workflow continuously across several repos (patasarribatravel, orb-trader,
blackbox, trading, nicolasduque.com; forja later) from an Ubuntu home-server. A supervisor pulls
agent-marked tasks from Asana (one Asana project per repo), drives headless Claude Code through
PLAN→BUILD→REVIEW→TEST, parks each task at the human gates (`gov approve plan|ship`), and a
read-only web UI shows everything that is happening — so the human sees problems early in development.

## Scope
In scope (all new code lives in this repo, zero npm dependencies, Node ≥ 18, same style as `.governance/`):
- `fleet/lib/registry.js` — load + validate `~/.agentic-os/fleet.json` (path overridable by `FLEET_HOME`):
  projects `{ name, path, asanaProjectGid, enabled, allowedTools[] }`, `asana.section` (default `"Agente"`),
  limits `{ maxConcurrent, maxRunsPerProjectPerDay, maxConsecutiveFailures, runTimeoutMinutes }`.
  Invalid config fails closed (no runs), mirroring `Gov` config handling.
- `fleet/lib/asana.js` — minimal Asana REST client using global `fetch`; token from env `ASANA_TOKEN`
  only (never written to disk by fleet, never passed to the agent). Read-only in v1: list incomplete tasks
  in the configured section of a project, read task name/notes/permalink.
- `fleet/lib/decide.js` — pure function: (`gov status --json` output, fleet state for project, queue head,
  limits) → one action: `start <asana task>` | `continue` | `await-human <plan|ship>` | `idle` | `paused <reason>`.
- `fleet/lib/runner.js` — spawns `claude -p` in the project dir with a fixed prompt (continue per AGENTS.md;
  for `start`, the Asana task title/notes/link as the request), `--output-format stream-json`,
  `--permission-mode acceptEdits`, per-project `--allowedTools`; never `--dangerously-skip-permissions`.
  Per-project lock file, timeout, stdout/stderr streamed to `~/.agentic-os/runs/<project>/<runId>.log`.
- `fleet/lib/state.js` — `~/.agentic-os/state.json` (Asana task ↔ gov task mapping, daily run counts,
  consecutive failures) and append-only `~/.agentic-os/events.jsonl` (tick, run-start, run-end, awaiting, paused, error).
- `fleet/lib/server.js` — `node:http` server, read-only: `GET /` (single self-contained HTML page),
  `GET /api/fleet` (every project: phase, gates + missing evidence, awaiting approval, Asana task link,
  last run, queue length), `GET /api/projects/:name/files/:plan|review|verification` (markdown of the
  active task), `GET /api/runs/:project/:runId/log` (log tail), `GET /api/events` (SSE stream of events.jsonl).
  Binds `127.0.0.1` by default (`--host` to change); no mutating endpoints.
- `fleet/bin/fleet` — CLI: `fleet tick` (one pass over all projects), `fleet serve [--host --port]`,
  `fleet status` (terminal summary incl. approval inbox), `fleet pause|resume <project>`.
- `fleet/systemd/` — templates: `agentic-fleet-tick.service` + `.timer` (every 10 min), `agentic-fleet-ui.service`;
  env via `EnvironmentFile=~/.agentic-os/fleet.env` (holds `ASANA_TOKEN`; created by the human).
- `fleet/README.md` — server setup: install Node + Claude Code, clone repos, run `install.sh` in each repo
  (incl. patasarribatravel), create Asana projects + "Agente" section, write fleet.json/fleet.env, enable units,
  reach the UI via SSH tunnel/Tailscale, approve via SSH with `gov approve`.
- `scripts/check.js` — include `fleet/` JS files in the parse check. `package.json` — add `fleet` bin.
- `test/fleet-*.test.js` — tests for the above (Asana mocked via a stub `fetch`, `claude` via a fake executable on PATH).

Out of scope (follow-ups): approving from the UI; writing back to Asana (comments / completing tasks);
multiple concurrent tasks per repo (worktrees); cloud execution; installing agentic-os into the other repos
or provisioning the server (human operational steps, documented in the README); forja (does not exist yet);
changes to `.governance/` core, hooks, AGENTS.md.

## Acceptance Criteria
- AC1: `fleet` rejects an invalid or missing fleet.json with a clear error and performs no runs (fail closed); a valid config loads with defaults applied.
- AC2: Given a stubbed Asana API, the client returns only incomplete tasks from the configured section of the project's GID, and it reads the token only from `ASANA_TOKEN` (missing token → error, no run).
- AC3: The decision function returns: `start` when the repo has no active gov task and the queue is non-empty; `idle` when both are empty; `continue` in build/review/test (and in plan while the plan is unfinished); `await-human plan` when only human plan approval is missing; `await-human ship` in ship awaiting approval; `paused` when the project is paused, the daily run cap is hit, or consecutive failures reach the limit.
- AC4: `fleet tick` never starts a second run in a project that holds a lock, never exceeds `maxConcurrent`, and never re-starts an Asana task already mapped to a gov task.
- AC5: The runner invokes `claude -p` in the project directory with the configured allowed tools, without `--dangerously-skip-permissions`, kills it at the timeout, writes a per-run log, and records run-start/run-end (exit code, duration) in events.jsonl.
- AC6: `fleet serve` exposes `/api/fleet` with per-project phase, gate status + missing-evidence list, awaiting-approval flag and Asana link; exposes plan/review/verification markdown and run log tails; streams new events over SSE; binds 127.0.0.1 by default; every non-GET request returns 405.
- AC7: The UI page (`GET /`) renders the project list with phase, awaiting-approval highlighting, live event feed, and drill-down to plan/review/log, updating without a manual reload.
- AC8: The ASANA_TOKEN value never appears in fleet logs, events, state, API responses, or the environment passed to `claude`.
- AC9: `npm run build` and `npm test` pass, with existing tests unchanged and green.

## Approach
1. `registry.js` + tests (AC1).
2. `asana.js` with injectable `fetch` + tests (AC2, AC8).
3. `decide.js` pure function over `gov status --json` (existing output: `{task, gates:{<phase>:{ok,missing}}}`) + table tests (AC3).
4. `state.js` (atomic JSON write, jsonl append) and `runner.js` (spawn, lock via `O_EXCL` file, timeout, env scrubbed of `ASANA_TOKEN`) + tests with a fake `claude` script (AC4, AC5, AC8).
5. `bin/fleet` wiring `tick`, `status`, `pause|resume`; tick = for each enabled project → `gov status --json` (via the repo's own `.governance/bin/gov`) → decide → run (bounded concurrency) (AC4).
6. `server.js` + inline HTML/JS UI (no CDN, no build step), SSE by tailing events.jsonl + tests hitting an ephemeral port (AC6, AC7, AC8).
7. systemd templates, README, `scripts/check.js` + `package.json` updates (AC9).
Nothing irreversible: all additive files; no change to the governance core or existing behavior.

## Risks
- Headless agents burn tokens/money: mitigated by per-project daily run cap, consecutive-failure pause, timeout, and "only tasks in the Agente section".
- Headless permissions: too narrow → agent stalls (visible in UI as repeated failed runs); too broad → risk. Governance hooks still block push/secrets/destructive commands; no skip-permissions flag. Allowlist is per project and explicit.
- UI exposes plans/logs of private repos: bound to localhost by default; access via SSH tunnel/Tailscale. No auth in v1, so do not bind to a public interface.
- `claude -p` flags/stream format may change between Claude Code versions: runner only needs the exit code and raw log, not parsing, so drift is low-impact.
- Not verifiable here: real Asana API and real Ubuntu/systemd execution — tests use stubs; server bring-up is a manual step and will be listed under "Not verified".
- Rate limits on Asana API: one list call per project per tick (every 10 min) is far below limits.

## Rollback
All changes are new files under `fleet/` plus two small additive edits (`scripts/check.js`, `package.json`). Revert the commit/PR. On the server: `systemctl --user disable --now agentic-fleet-tick.timer agentic-fleet-ui.service` and delete `~/.agentic-os/`. Repos keep working with plain `gov`; any in-flight gov task can be finished manually or `gov abort`-ed.
