# fleet — the governed workflow, running continuously across your repos

`fleet` is a supervisor that runs on a server (for example an Ubuntu home-server). Every 10 minutes it:

1. reads `gov status --json` in every registered repo,
2. reads that repo's Asana project for incomplete tasks in the **Agente** section,
3. decides what to do next, then either starts or continues a headless Claude Code session
   (`claude -p`), or waits for you.

Agents move through PLAN → BUILD → REVIEW → TEST on their own. They **stop at the human gates**:
`gov approve plan` and `gov approve ship` are still yours, run in a terminal on the server.
A read-only web UI shows every repo's phase, missing evidence, pending approvals, and live run logs.

```
Asana "Agente" section ─▶ fleet tick (systemd timer) ─▶ claude -p in repo ─▶ gov gates
                                   │                                            │
                                   └──── ~/.agentic-os/{state.json,events.jsonl,runs/} ◀┘
                                                        │
                                              fleet serve (read-only UI)
```

## Decisions per repo, each pass

| Repo state | Action |
|---|---|
| paused (`fleet pause`), or `gov status` fails | nothing (shown in the UI) |
| no active task, queue has a task fleet never took | **start**: agent runs `gov start`, writes plan.md, stops |
| no active task, queue empty | idle |
| active task started by fleet, only human approval missing (plan/ship) | **await-human**, listed in the approval inbox |
| active task started by fleet, ship approved | idle: releasing (push, PR, `gov ship`) is yours |
| active task started by fleet, anything else | **continue** from the current phase |
| active task you started by hand | idle: fleet leaves your task alone |
| daily run cap reached or N consecutive failed runs | paused until tomorrow / `fleet resume` |

A start run can be cut off (reboot, kill) before fleet records its task. On the next pass, fleet
adopts the task that run opened, or forgets the attempt if it never opened one.
A misnamed Asana section is reported as an error, never shown as an empty queue.

Every Asana task is started **once**. If the governed task is aborted, fleet won't restart it by
itself. Move the task out of the section, or open a new task.

## Server setup (Ubuntu)

1. **Install the tools**: Node ≥ 18 and Claude Code, then log in once interactively (`claude`) as the
   same user the services will run as.
2. **Clone the repos** you want driven, e.g. under `~/repos/`, and make sure `git push` / `gh` work non-interactively
   (SSH key or `gh auth login`).
3. **Install agentic-os into each repo** (once per repo; commit the result):
   ```sh
   git clone https://github.com/dukenicols/agentic-os ~/agentic-os
   ~/agentic-os/install.sh ~/repos/patasarribatravel
   ```
   Check `.governance/config.json` has the right build/test commands.
4. **Asana**: create one project per repo, with a section named **Agente**. Only tasks in that
   section are picked up. Create a Personal Access Token (Asana → My settings → Apps → Developer apps).
5. **Fleet config**:
   ```sh
   mkdir -p ~/.agentic-os && chmod 700 ~/.agentic-os
   printf 'ASANA_TOKEN=%s\n' '<your PAT>' > ~/.agentic-os/fleet.env && chmod 600 ~/.agentic-os/fleet.env
   ```
   `~/.agentic-os/fleet.json`:
   ```json
   {
     "asana": { "section": "Agente" },
     "limits": { "maxConcurrent": 2, "maxRunsPerProjectPerDay": 12, "maxConsecutiveFailures": 3, "runTimeoutMinutes": 45 },
     "projects": [
       {
         "name": "patasarribatravel",
         "path": "/home/duke/repos/patasarribatravel",
         "asanaProjectGid": "1218413571037400",
         "allowedTools": ["Read", "Grep", "Glob", "Edit", "Write", "Task",
                          "Bash(.governance/bin/gov status)", "Bash(.governance/bin/gov start:*)",
                          "Bash(.governance/bin/gov advance)", "Bash(.governance/bin/gov run:*)",
                          "Bash(.governance/bin/gov record:*)", "Bash(.governance/bin/gov diff:*)",
                          "Bash(git status)", "Bash(git diff:*)", "Bash(git log:*)"]
       }
     ]
   }
   ```
   `allowedTools` is the headless permission allowlist for that repo. A tool that isn't listed is refused,
   and the agent will stall on it (visible as failed runs in the UI). The repo's governance hooks still
   apply on top: no push before ship approval, no secrets, no destructive commands. Fleet never
   releases anything. After you approve ship, you push, open the PR, and run `gov ship`.

   **Be honest with yourself about what the allowlist grants.** `gov run build|test` runs the repo's
   build and test commands, and the agent can edit that code. So in practice the agent can execute
   arbitrary code as the service user, and the same goes for broad rules like `Bash(npm:*)`,
   `Bash(node:*)` or `Bash(git:*)`. That user can read `~/.agentic-os/fleet.env` (the Asana token)
   and `~/.ssh`. For stronger isolation, run the agents as a dedicated Unix user, or in a container,
   without access to those files.
6. **Try one pass by hand**, then enable the services:
   ```sh
   set -a; . ~/.agentic-os/fleet.env; set +a
   ~/agentic-os/fleet/bin/fleet tick
   ~/agentic-os/fleet/bin/fleet status

   mkdir -p ~/.config/systemd/user
   cp ~/agentic-os/fleet/systemd/* ~/.config/systemd/user/
   systemctl --user daemon-reload
   systemctl --user enable --now agentic-fleet-tick.timer agentic-fleet-ui.service
   sudo loginctl enable-linger "$USER"   # keep user services running without a login session
   ```
   If node or claude is not in `/usr/local/bin` or `~/.local/bin` (nvm, for example), fix `PATH=` in the unit files.

## The UI

`fleet serve` listens on `127.0.0.1:7420` and has **no authentication**. It is read-only: GET only,
no approvals, no Asana access. Don't bind it to a public interface. From your laptop:

```sh
ssh -N -L 7420:127.0.0.1:7420 home-server   # then open http://localhost:7420
```

Or, with Tailscale, run it with `--host <tailscale-ip>`. Then open it at `http://<tailscale-ip>:7420`.
To block DNS rebinding, the server only answers requests addressed to that IP, `localhost`,
`127.0.0.1` or `[::1]`. A MagicDNS name gets a 421 response.

The UI shows:
- one card per repo: phase, the five gates, Asana task, queue size, last run;
- a highlighted **approval inbox** with the exact command to run;
- a live activity feed (runs starting and ending, failures, pauses, approvals needed);
- a detail view with the plan, review, and verification documents and a live, readable transcript of each run.

## Approving, pausing

```sh
cd ~/repos/<repo> && .governance/bin/gov status      # read the plan / evidence first
cd ~/repos/<repo> && .governance/bin/gov approve plan   # or: approve ship
~/agentic-os/fleet/bin/fleet pause <repo> "reason"     # stop runs for a repo
~/agentic-os/fleet/bin/fleet resume <repo>             # resume (resets the failure counter)
```

## Files

`~/.agentic-os/` holds `fleet.json` (config), `fleet.env` (token, only read by the tick service),
`state.json` (task mapping, counters), `events.jsonl` (activity feed), `runs/<repo>/<runId>.log`
(Claude stream-json transcripts), and `locks/`.

## Security notes

- The Asana token is read from the environment by `fleet tick` only. It is removed from the
  environment given to `claude` and never written to state, events, or logs.
- Asana task text goes to the agent as a *request*, framed as not overriding AGENTS.md. Anyone
  who can edit tasks in those Asana projects can steer what the agent attempts. The governance
  hooks and your plan/ship approvals are the backstop.
- Budget: `maxRunsPerProjectPerDay`, `maxConsecutiveFailures`, and `runTimeoutMinutes` cap spend.
