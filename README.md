# agentic-os — evidence-gated governance for AI coding agents

A drop-in framework that runs Claude Code (or any agent that reads `AGENTS.md`)
through five phases — **plan → build → review → test → ship** — where no phase
counts as done without evidence. The rules live in `AGENTS.md`; Claude Code hooks
enforce them.

```
 PLAN ──approve──▶ BUILD ──▶ REVIEW ──▶ TEST ──▶ SHIP ──approve──▶ shipped
 plan.md           build     independent  tests +     frozen tree,
 + human sign-off  commands  subagent     AC-by-AC    push/PR/deploy
                   exit 0    review PASS  evidence    unlocked
```

## Install

```sh
git clone https://github.com/dukenicols/agentic-os ~/agentic-os
~/agentic-os/install.sh /path/to/your/repo            # or --mode advisory
```

The installer copies `.governance/`, writes or extends `AGENTS.md`, adds `@AGENTS.md`
to `CLAUDE.md`, installs the `gov-reviewer` subagent and `/gov:*` commands, and
merges hooks into `.claude/settings.json` without touching your existing settings.
It detects build/test commands for npm/pnpm/yarn/bun, Cargo, Go, Python and Make.
Check `.governance/config.json`, commit, and restart Claude Code.

Requires Node ≥ 18. No dependencies.

## Using it

In Claude Code: `/gov:plan add rate limiting to the login endpoint`, then
`/gov:build`, `/gov:review`, `/gov:test`, `/gov:ship`. Or just ask for the change —
the hooks will steer the agent into the workflow.

As the human, you do two things, **in your own terminal**:

```sh
.governance/bin/gov approve plan    # after reading plan.md
.governance/bin/gov approve ship    # after reading gov status / gov log
```

`gov status` shows where a task is and exactly what evidence is missing:

```
Task   fix add  (20260927-212314-fix-add)
Phase  review   mode: enforce   tree: 0a437fda9f5a   changed files: 1

  ✔ plan
  ✘ build
      · `node check.js` passed on an older tree — code changed since, re-run
  ✘ review  ◀
      · code changed after review — review is stale
  ✘ test
      · `node test.js` never run via `gov run test`
      · no verification recorded: map every AC to evidence in verification.md, then `gov record verification`
  ✘ ship
      · build gate failing
      · review gate failing
      · test gate failing
      · human approval: run `gov approve ship` in your own terminal
```

## What counts as evidence

| Phase | Gate |
|---|---|
| plan | `plan.md` has Goal, Scope, numbered Acceptance Criteria, Approach, Risks, Rollback; no `_TBD_`; **human approval of that exact text** (hash-bound) |
| build | non-empty diff; every configured build command exited 0 via `gov run build` **on the current tree** |
| review | `review.md` from the independent reviewer: `Verdict: PASS`, names every changed file, no open `[ ] BLOCKER` — recorded on the current tree |
| test | every configured test command exited 0 on the current tree; `verification.md` maps **every AC** to PASS + an evidence pointer |
| ship | all of the above still valid + **human ship approval** on the current tree |

Three properties do most of the work:

- **Evidence is tree-bound.** A content fingerprint of the working tree is
  stamped on every run, review, verification, and ship approval. Edit one byte
  after review and build, review, and test all go stale. Commits don't matter;
  content does.
- **Evidence is produced, not written.** `gov run` executes the configured
  command itself and records exit code, log, and log hash. The agent can't
  substitute `true` for `npm test`, and hooks block it from writing the ledger.
- **The ledger is hash-chained.** `.governance/runs/<task>/ledger.jsonl` is
  append-only; any edit breaks the chain and voids all evidence (`gov log --verify`).

## Guardrails (hooks)

| Hook | Enforces |
|---|---|
| `PreToolUse` | no code edits without a task, or during PLAN/SHIP · governance files, ledger, and `AGENTS.md`/`CLAUDE.md`/settings are read-only to the agent · no reading/writing secrets · no `gov approve` from the agent · destructive shell commands blocked (force-push, `reset --hard`, `--no-verify`, `sudo`, `curl \| sh`, `DROP TABLE`, …) · push/PR/publish/deploy only once the ship gate passes |
| `Stop` | the agent can't end a turn with the current phase un-evidenced, unless it's only waiting on a human approval; fires once per stop so it can't loop |
| `SessionStart` | injects the live task and gate status into context |

**Modes** (`.governance/config.json` → `mode`): `enforce` denies; `advisory`
asks the human instead; `off` disables. Tampering, secrets, and approvals are
denied in every mode except `off`. An unknown mode is treated as `enforce`.

**Fail closed.** If `config.json` is invalid JSON or has the wrong shape (for
example a list that isn't an array of strings, or a regex that doesn't
compile), nothing falls back to defaults. `gov` refuses to run, and edits and
shell commands are denied until a human fixes the file; reads stay allowed. If
the guard itself hits an unexpected error, it denies edits and shell commands
rather than letting them through. The same goes for hook input it can't parse.

**Release commands are gated everywhere.** A push, PR, publish or deploy only
runs in the SHIP phase with a passing ship gate. That holds whatever directory
the command runs in, including other repos. There is deliberately no "other
repo" exemption. Deciding safely that a command doesn't act on the governed
repo turned out to require modelling git (worktrees, `.git` files), gh (URLs)
and the shell exactly, and every attempt failed open somewhere. To release
another repo from a governed session, the human runs the command, or opens a
session in that repo.

A built-in detector recognises these whatever flags sit between the program
and its subcommand (`git -c k=v push`, `kubectl -n prod apply`), and inside
`bash -c '…'` or `$(…)`:

| Program | Release subcommands |
|---|---|
| `git` | `push` |
| `gh` | `pr create`/`pr new`, `pr merge`, `pr ready`, `release create`/`release new` |
| `npm`, `pnpm`, `yarn` | `publish` |
| `terraform` | `apply`, `destroy` |
| `kubectl` | `apply`, `delete`, `rollout` |
| `docker` | `push`, and `--push` (as in `docker build --push`) |
| `vercel` | `--prod`, `--target production`, `promote` |

Program names match case-insensitively, and `--flag=value` counts the same as
`--flag value`. The `shipGated` regexes in `config.json` are checked on top of
it. The detector errs strict: an unquoted `git commit -m push` counts as a push.

**Known limits.** These are guardrails, not a sandbox:
- The tamper check matches paths as text. Writes that spell a protected path
  differently get through: `.governance//state.json`, an absolute path, a
  glob, brace expansion, `cd .governance && rm …`, `node -e`, `find -delete`.
  Use filesystem permissions if you need a hard guarantee.
- The release detector only knows the programs and subcommands in the table
  above, plus your `shipGated` patterns. Some things aren't recognised:
  - other release tools: `cargo publish`, `helm upgrade`, `glab mr create`, `gh api …/merge`, …
  - git aliases (including your `~/.gitconfig`), shell functions and variables (`$G push`)
  - escaped or computed words (`gi\t push`, `git "$(echo push)"`)
  - encoded commands piped to a shell

  Add patterns for tools you use.
- Release logic inside project scripts (`npm run deploy`, `make release`) is not
  inspected. Keep release commands where the gate can see them.
- A push from another clone of the same remote isn't linked to this repo.
- Path protection compares paths as written. On a case-insensitive filesystem
  (macOS by default), `.GOVERNANCE/config.json` or `.Env` reach the protected
  file under a different spelling. This applies to the Edit/Write tools as
  well as to the shell. *(Planned fix: normalise to the real on-disk path.)*
- The hook picks the governed root from the command's working directory first.
  If that directory is inside a *different* governed repo, that repo's rules
  apply instead. That includes a nested `.governance/config.json` the agent
  creates itself, which no protected pattern covers. *(Planned fix: also evaluate against the session project and
  take the stricter verdict.)*

Destructive-command, secret and approval rules apply everywhere.

Everything is configurable in `.governance/config.json`: commands, which
approvals are required, fingerprint ignores, protected and secret paths,
blocked shell patterns, and ship-gated commands.

## Threat model — be clear about what this is

This framework is built for the failure modes agents actually have: claiming
success without running anything, reviewing their own work, drifting from the
plan, "fixing" a test after the review, skipping hooks, pushing too early.
It makes those paths **blocked, or at least visible**. See the known limits above.

It is **not** a sandbox against a deliberately adversarial agent. Shell-level
checks are pattern-based. A determined process could write the ledger from a
script it generated, and the chain would detect edits but not a wholesale
rewrite. Approvals are protected by the hooks and by refusing `CLAUDECODE`
sessions, not by cryptography. For hard isolation, pair this with Claude Code's
sandboxing, branch protection, and required CI checks. The ship gate is designed
to sit *in front of* those controls, not replace them.

## Layout

```
AGENTS.md                      the rules the agent follows
CLAUDE.md                      @AGENTS.md
.claude/settings.json          hooks + deny rules
.claude/agents/gov-reviewer.md independent read-only reviewer
.claude/commands/gov/*.md      /gov:plan … /gov:ship
.governance/bin/gov            CLI
.governance/lib/core.js        fingerprints, ledger, gates
.governance/hooks/             PreToolUse, Stop, SessionStart
.governance/templates/         plan / review / verification
.governance/runs/<task>/       plan.md, review.md, verification.md, ledger.jsonl, logs/
```

## Developing

```sh
npm run build   # syntax/JSON check
npm test        # workflow, hooks and installer tests, each in a throwaway git repo
```

This repo governs itself: with `.claude/settings.json` active, changes to the
framework go through the same five phases.
