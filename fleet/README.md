# fleet — the governed workflow, running continuously across your repos

`fleet` is a supervisor that runs on a server (for example an Ubuntu home-server). Every 10 minutes it:

1. reads `gov status --json` in every registered repo,
2. reads that repo's Asana project for incomplete tasks in the **Agente** section,
3. decides what to do next, then either starts or continues a headless Claude Code session
   (`claude -p`), or waits for you.

Agents move through PLAN → BUILD → REVIEW → TEST on their own. They **stop at the human gates**:
plan and ship approval are still yours. You can give them from the web UI (with your passphrase),
or with `gov approve` in a terminal on the server. The UI also shows every repo's phase, missing
evidence, and live run logs, and lets you send a plan back with comments.

```
Asana "Agente" section ─▶ fleet tick (systemd timer) ─▶ claude -p in repo ─▶ gov gates
                                   │                                            │
                                   └──── ~/.agentic-os/{state.json,events.jsonl,runs/} ◀┘
                                                        │
                                              fleet serve (UI: watch, approve, request changes)
```

## Decisions per repo, each pass

| Repo state | Action |
|---|---|
| paused (`fleet pause`), or `gov status` fails | nothing (shown in the UI) |
| no active task, queue has a task fleet never took | **start**: agent runs `gov start`, writes plan.md, stops |
| no active task, queue empty | idle |
| active task started by fleet, only human approval missing (plan/ship) | **await-human**, listed in the approval inbox |
| plan awaiting approval, and you requested changes on this exact plan text | **continue**: the agent revises plan.md with your comments |
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
   Check `.governance/config.json` has the right build/test commands. Re-running `install.sh` on a
   repo upgrades its gov. UI approvals need a gov that supports `gov approve --expect`; older copies
   are refused with a message telling you to re-run it.
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
6. **Set your approval passphrase** (interactive, over SSH; at least 12 characters):
   ```sh
   ~/agentic-os/fleet/bin/fleet passphrase
   ```
   Only an scrypt hash is stored, in `~/.agentic-os/approver.json` (0600). Without it, the UI shows
   everything but can't approve anything. Run it again to change the passphrase. Delete the file to
   turn UI approvals off.
7. **Try one pass by hand**, then enable the services:
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

`fleet serve` listens on `127.0.0.1:7420`. Reading needs no authentication. The only two writes
(approve a gate, request plan changes) need your passphrase. It never talks to Asana. Don't bind it
to a public interface. From your laptop:

```sh
ssh -N -L 7420:127.0.0.1:7420 home-server   # then open http://localhost:7420
```

Or, with Tailscale, run it with `--host <tailscale-ip>`. Then open it at `http://<tailscale-ip>:7420`.
To block DNS rebinding, the server only answers requests addressed to that IP, `localhost`,
`127.0.0.1` or `[::1]`. A MagicDNS name gets a 421 response.

The UI shows:
- one card per repo: phase, the five gates, Asana task, queue size, last run;
- a highlighted **approval inbox**: "Revisar" opens the approval panel (the terminal command is shown too);
- a live activity feed (runs starting and ending, failures, pauses, approvals needed, approvals given);
- a detail view:
  - the plan, review, and verification documents, rendered as formatted text;
  - the diff under review;
  - a live, readable transcript of each run.

### Approving from the UI

- **Plan.** The panel shows the exact plan text and its sha256. You can:
  - **Aprobar plan**: approve it.
  - **Pedir cambios**: send a comment instead. On the next pass the agent revises plan.md with your
    comments, then waits for you again. Earlier comments stay visible, marked pending or addressed.
- **Ship.** Review the **diff**, **review** and **verification** tabs, then **Aprobar ship**.
  Approving ship publishes nothing. Pushing, opening the PR, and `gov ship` stay yours.

What protects an approval:

- **Your passphrase** is asked on every action. The page clears the field after each submit and
  never stores it.
- **After 5 wrong passphrases** in 15 minutes, UI actions are refused for 15 minutes. Attempts are
  counted before they are checked, so a parallel burst can't get more guesses. The limit is global:
  anything on the server that makes 5 bad guesses also locks you out for 15 minutes. That fails
  closed, and the terminal keeps working.
- **What you approve is on screen.**
  - **Plan:** the panel opens on **Texto exacto**, which is every character of plan.md, uninterpreted.
    Characters that render as nothing or can smuggle hidden text (controls, bidi and zero-width
    marks, Unicode tag characters, variation selectors, private-use and unassigned code points) are
    shown as `⟦U+XXXX⟧`, and a warning flags them and any HTML comments. The ship panel shows review
    and verification the same way. The diff is not `git diff`: gov builds it from the worktree bytes
    (what the fingerprint hashes) and the base commit's content, accepted only if it matches the
    sha256 recorded at `gov start`. Repo-local git config, attributes, filters, replace refs, and
    index flags can't hide a change. If the old version can't be verified, the whole file is shown.
    Bytes that aren't valid UTF-8 are shown as `⟦0xNN⟧`, CR as `⟦U+000D⟧`. Symlinks are shown as
    their target path; the content they point to is never shown. **Vista formateada** is only a reading aid.
  - **Ship:** you see the diff, review and verification, read together with the fingerprint. If the
    diff is too large to show in full, the UI won't sign off on ship; do it in a terminal instead.
- **You approve exactly what you saw.** The approval carries the plan hash or tree fingerprint you
  loaded. gov checks it right before writing the ledger entry, and if anything changed since, the
  approval is refused. The ledger records it as `human:<user>` with `via: fleet-ui`.
- **No agent is mid-run.** An approval takes the repo's lock, so it is refused while fleet has an
  agent working there.
- **The requests come from the page itself.** Writes need `Content-Type: application/json` and an
  `Origin` equal to the Host, which blocks other sites and DNS rebinding.
- **An agent session can't approve.** A `fleet serve` started inside an agent session
  (`CLAUDECODE` set) refuses every approval.

## Approving from a terminal, pausing

```sh
cd ~/repos/<repo> && .governance/bin/gov status      # read the plan / evidence first
cd ~/repos/<repo> && .governance/bin/gov approve plan   # or: approve ship
~/agentic-os/fleet/bin/fleet pause <repo> "reason"     # stop runs for a repo
~/agentic-os/fleet/bin/fleet resume <repo>             # resume (resets the failure counter)
```

## Files

`~/.agentic-os/` holds `fleet.json` (config), `fleet.env` (token, only read by the tick service),
`approver.json` (scrypt hash of your passphrase),
`state.json` (task mapping, counters), `events.jsonl` (activity feed), `runs/<repo>/<runId>.log`
(Claude stream-json transcripts), and `locks/`.

## Security notes

- The Asana token is read from the environment by `fleet tick` only. It is removed from the
  environment given to `claude` and never written to state, events, or logs.
- Asana task text goes to the agent as a *request*, framed as not overriding AGENTS.md. Anyone
  who can edit tasks in those Asana projects can steer what the agent attempts. The governance
  hooks and your plan/ship approvals are the backstop.
- Budget: `maxRunsPerProjectPerDay`, `maxConsecutiveFailures`, and `runTimeoutMinutes` cap spend.
- **UI approvals and the same-user limit.** Agents run as the same Unix user as the UI.
  - What the passphrase stops: an agent can read `approver.json`, but only as a hash, so it can't
    `curl` an approval. That covers careless or prompt-injected agents.
  - What it doesn't stop: an agent that already runs arbitrary code as that user can rewrite
    `approver.json`, the fleet code, or a repo's `.governance/` code. Rewriting `.governance/`
    defeats terminal-only approval too.

  The real boundary is running agents as a separate Unix user, or in a container, that can't write
  those files.
