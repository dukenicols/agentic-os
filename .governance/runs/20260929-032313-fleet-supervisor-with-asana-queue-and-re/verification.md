# Verification: fleet supervisor with Asana queue and read-only UI

Evidence: `gov run test` → `npm test` exit 0, 96/96 tests (evidence #15, logs/test-003.log); `gov run build` exit 0 (evidence #11); review PASS round 3 (evidence #13).

- AC1: PASS — evidence: test-003.log "AC1: missing fleet.json fails closed", "AC1: invalid fleet.json lists every problem and performs no runs" (9 invalid shapes, CLI exits 2, fake claude never called), "AC1: a valid config loads with defaults applied".
- AC2: PASS — evidence: test-003.log "AC2: queue returns only incomplete tasks from the configured section of the project" (stubbed fetch; only that project's section read, completed tasks dropped), "AC2: token comes only from ASANA_TOKEN…", "AC2: fleet tick without ASANA_TOKEN exits with an error before any run", plus "a project without the configured section is an error, not an empty queue".
- AC3: PASS — evidence: test-003.log "AC3: start…", "AC3: idle…", "AC3: continue in build, review and test", "AC3: continue in plan while the plan itself is unfinished", "AC3: await-human plan…", "AC3: await-human ship…", "AC3: paused when the project is paused / daily run cap is hit / consecutive failures reach the limit". Note: once ship is approved, decide returns idle (release is the human's), as required by the plan's goal; tested in "once ship is approved fleet stops".
- AC4: PASS — evidence: test-003.log "AC4: never more than maxConcurrent agents at once" (peak 2 of 5 with maxConcurrent 2), "AC4: a project whose lock is held is skipped, not run twice", "AC4: start → task mapped; the same Asana task is never started again", "the lock stays held while the recorded agent is alive, even if the supervisor died".
- AC5: PASS — evidence: test-003.log "AC5: runner invokes claude -p in the project dir with allowed tools and no permission bypass", "AC5: runner kills the agent at the timeout", "the timeout also kills processes the agent started", "AC5: tick records run-start and run-end with exit code and duration, and a per-run log".
- AC6: PASS — evidence: test-003.log "AC6: /api/fleet reports phase, gates with missing evidence, awaiting approval, and the Asana link", "AC6: serves plan/review/verification markdown and run log tails; 404s otherwise", "AC6: streams existing and new events over SSE", "AC6: every non-GET request is refused with 405" (incl. HEAD), "AC6: the CLI binds 127.0.0.1 by default". Manual: `curl` against `fleet serve` on the current tree → `/` 200, bad Host 421.
- AC7: PASS — evidence: test-003.log "AC7: the page renders projects, approval inbox, live feed and drill-down without reloads" (served page wires /api/fleet polling, EventSource, drill-down endpoints; no external assets). Manual check in Chrome on the current tree against real local repos (agentic-os, orb-trader, trading, patasarribatravel): cards render with live phase/gates (agentic-os shown in `test` with plan/build/review green), error card for the repo without agentic-os, no console errors; drill-down dialog with gate details verified in the earlier manual check. The live feed's DOM update on new SSE events was not exercised in a browser; the SSE stream itself is covered by the AC6 test.
- AC8: PASS — evidence: test-003.log "AC8: the Asana token never reaches the agent env, logs, events or state" (fake claude records its env; FLEET_HOME scanned for the token), "AC8: no API response contains the Asana token", "AC8: Asana errors never include the token".
- AC9: PASS — evidence: gov evidence #11 (`npm run build` exit 0, 27 JS + 3 JSON) and #15 (`npm test` exit 0, 96/96, existing core/guards/hooks/install/workflow tests unchanged and green).

## Not verified
- Real Asana API (all Asana tests use a stubbed fetch) and a real `claude -p` headless run (tests use a fake executable). First real run happens on the server.
- Ubuntu/systemd execution of the units (`agentic-fleet-tick.timer`, `agentic-fleet-ui.service`); written against systemd user-unit conventions but not started on a Linux host.
- The `fleet tick` SIGINT/SIGTERM/SIGHUP handlers end-to-end (only `killAllAgents` is unit-tested).

## Known follow-ups (review round 3 NITs, not fixed)
- Stop scheduling new jobs during the 3 s grace period after a signal.
- Stale-lock reclaim is a narrow TOCTOU (reclaim via rename would close it).
- A lock from before a reboot can be pinned by pid reuse (remedy: `rm ~/.agentic-os/locks/<project>.lock`).
- Signal exit codes (143/129 instead of 130 for SIGTERM/SIGHUP).
