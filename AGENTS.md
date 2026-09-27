# AGENTS.md — Governed Workflow

This repository is governed. Every change goes through five phases —
**PLAN → BUILD → REVIEW → TEST → SHIP** — and **no phase is done without evidence**.
Evidence is produced by the `gov` CLI, bound to the exact state of the code it
was produced on, and written to a tamper-evident ledger. Hooks enforce this; the
rules below explain it so you can work *with* the gates instead of against them.

CLI: `.governance/bin/gov` (below written as `gov`). Run `gov status` whenever unsure.

---

## The one rule

> **A claim without evidence is not a result.**

Never say something is done, fixed, working, passing, reviewed, or safe unless
`gov` has recorded evidence for it on the current tree. If evidence is missing,
say exactly what is missing. "It should work" is a hypothesis, not a status.

Evidence goes stale automatically: build, review, test, and ship approval are
bound to a fingerprint of the working tree. Change one byte of code and they
must be redone. This is intentional — do not look for ways around it.

---

## The five phases

### 1. PLAN — decide before touching code
```
gov start "<short title>"
```
Fill in `.governance/runs/<task>/plan.md`. Every section is required:
Goal, Scope, Acceptance Criteria, Approach, Risks, Rollback.

- Read the relevant code first. Plans are grounded in what exists, not guesses.
- Acceptance criteria are numbered (`- AC1: ...`), observable, and testable.
  Each one will need its own evidence in TEST.
- Keep scope tight. Out-of-scope items go in the Scope section, not the diff.
- Then **stop and ask the human to run `gov approve plan`** in their terminal.
  You cannot approve your own plan; the hook will block you. Show them the plan.

Code edits are blocked in this phase. After approval: `gov advance`.

**Evidence:** complete plan.md + human approval of that exact plan text.

### 2. BUILD — implement the approved plan, nothing else
- Make the smallest change that satisfies the acceptance criteria.
- Follow existing patterns, naming, and style in the surrounding code.
- If the plan turns out to be wrong, **stop**: `gov back plan`, revise, re-approve.
  Do not silently drift from the approved plan.
- Write or update tests alongside the code.
- `gov run build` — runs the configured build/lint/typecheck commands and records
  exit codes and logs. Fix failures and re-run until green. Then `gov advance`.

**Evidence:** a non-empty diff + every configured build command exiting 0 on the current tree.

### 3. REVIEW — a second pair of eyes, not your own
- Spawn the **`gov-reviewer`** subagent (fresh context, read-only). Do not review
  your own work in the main context and call it a review.
- Save its output verbatim to `.governance/runs/<task>/review.md`, then `gov record review`.
- The review must name every changed file, state `Verdict: PASS` or
  `Verdict: CHANGES_REQUESTED`, and list findings as `- [ ] BLOCKER:` / `MAJOR:` / `NIT:`.
- On CHANGES_REQUESTED: fix, `gov run build`, and review again. A PASS with an
  unticked BLOCKER is rejected. Never edit the reviewer's verdict.

**Evidence:** a recorded PASS review covering every changed file, on the current tree.

### 4. TEST — prove each acceptance criterion
- `gov run test` — runs the configured test commands and records results.
- Write `.governance/runs/<task>/verification.md`: one line per AC,
  `- AC1: PASS — evidence: <test name / gov evidence #N / log excerpt>`.
  Each AC needs a concrete pointer. If you could not verify something, list it
  under "Not verified" and tell the human — do not mark it PASS.
- `gov record verification`, then `gov advance`.
- Any code change here invalidates build and review too. Re-run them.

**Evidence:** passing test runs + every AC mapped to evidence, on the current tree.

### 5. SHIP — release only what was approved
- The tree is frozen. Ask the human to run `gov approve ship`.
- Only now are release commands allowed: `git push`, `gh pr create/merge`,
  `npm publish`, deploys. Prefer opening a PR over pushing to a default branch.
- Summarize for the human: what changed, the evidence (`gov log`), anything
  not verified, and the rollback plan.
- `gov ship <PR URL or commit SHA>` closes the task.

**Evidence:** all four prior gates green on the current tree + human ship approval + a ship record.

---

## Guardrails (enforced by hooks)

| You cannot | Why |
|---|---|
| Edit code with no active task, or during PLAN or SHIP | Plan first; ship exactly what was approved |
| Run `gov approve` | Approvals are the human's signature |
| Write ledger, logs, `task.json`, `state.json`, or governance config/hooks | Evidence is produced by `gov`, never by hand |
| Edit `AGENTS.md`, `CLAUDE.md`, `.claude/settings*.json` | The rules don't rewrite themselves |
| Read or write `.env`, keys, credentials | Secrets never enter the context |
| `git push`, open/merge PRs, publish, deploy before SHIP | Nothing leaves the machine un-gated |
| Force-push, `reset --hard`, `clean -f`, `--no-verify`, `sudo`, `curl \| sh`, destructive SQL | Irreversible or bypasses checks |

If a guard blocks you, **do not try to route around it** (different tool, shell
redirection, renaming, scripts that write the file for you). Read the reason,
then either fix the underlying issue or ask the human.

## Working norms

- **Ask, don't assume,** when requirements are ambiguous — in PLAN, not mid-BUILD.
- **Stay in scope.** Unrelated fixes you notice go in your summary as follow-ups.
- **Report honestly.** Failing tests, skipped steps, and unverified criteria are
  reported plainly, with the output. Never hide or soften a failure.
- **One task at a time.** `gov abort "<reason>"` if a task is abandoned.
- **Reversibility first.** Prefer changes that are easy to roll back; call out
  anything that isn't (migrations, data deletes, public API changes) in Risks.

## Quick reference

```
gov start "<title>"      # PLAN: scaffold plan.md
gov status               # where am I, what's missing
gov advance              # next phase (all gates so far must pass)
gov back <phase>         # go back when the plan or code needs rework
gov run build|test       # execute + record evidence
gov diff [--patch]       # what changed since the task started
gov record review|verification
gov ship <ref>           # close after human ship approval
gov log [--verify]       # the evidence ledger / integrity check
```
Templates: `.governance/templates/`. Slash commands: `/gov:plan`, `/gov:build`,
`/gov:review`, `/gov:test`, `/gov:ship`.
