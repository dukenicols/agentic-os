# Plan: Harden the guards (the cross-repo release exemption is dropped)

**Revision 4.** Reviews #8 and #14 rejected revisions 2 and 3. Both times the cause was the same feature: exempting release commands that "act outside the governed repo". Each version failed open in new ways. Review #14 found worktrees and `.git` files that make an outside directory *be* the governed repo, gh URLs that name it without any path, and `cd` forms the shell resolves differently from the guard. A sound exemption would need to model git, gh, npm and the shell exactly.

**Decision (needs human approval):** drop the exemption. Every release command is ship-gated, wherever it runs. Releasing another repo from a governed session is done by the human, or from a session in that repo. The original trigger (pushing the blog branch) is covered by that. Everything else this task fixed is kept, and review #14 confirmed it correct.

## Goal
1. **No cross-repo exemption.** Release commands are gated regardless of directory, and this is documented.
2. **Release detection that flags between program and subcommand can't evade.** Review #14 got these through: `git --work-tree . push`, `git -c x.y="a b" push`, `terraform -chdir=infra apply`, `kubectl -n prod apply`, `docker --context prod push`, `npm --workspace a publish`, `gh pr -R o/x create`.
3. **Tamper check:** keep the quote-aware fixes from revision 3 (review #14 confirmed them), and describe the remaining token-based limits honestly.
4. **Fail-closed config:** keep (confirmed).
5. **Fail-closed hooks:** keep the crash handling. Add fail-closed for malformed hook input, and for a hook `cwd` outside the governed tree (fall back to `CLAUDE_PROJECT_DIR`).
6. **Installer, Stop approvals, unknown mode, `.idea`:** keep (confirmed).

## Scope
In scope:
- `.governance/hooks/pre-tool-use.js`: delete the exemption code (`releaseExempt`, `pointsInside`, `isInside`, `existingDir`, `userPath`, `withoutGitGlobals`, `EXEMPT_FORBIDDEN`, `RELEASE_PROGRAMS`, `REPO_SELECTING_FLAG`). Add a built-in, word-based release detector. Harden input and root handling.
- `.governance/hooks/io.js`, `stop.js`, `session-start.js`: malformed input handling.
- `test/guards.test.js`: rewrite for revision 4, filling the test gaps review #14 listed.
- `README.md`: replace "Releases in other repos" with the no-exemption rule and the known limits.

Out of scope, recorded as follow-up tasks in the README's limits section:
- **Path-normalising tamper check** (review #14 MAJOR, pre-existing): `rm .governance//state.json`, absolute paths, globs, brace expansion, `cd .governance && rm …`, `node -e`, `find -delete`. The real fix is filesystem-level protection or path resolution, which is a separate design.
- **`WRITE_OP` matching `install` inside file names** (pre-existing false positive).
- **Releases via project scripts** (`npm run deploy`, `make release`) and **from another clone of the same remote.** These aren't visible to a command-level guard.

## Acceptance Criteria
- AC1: No exemption. With no task, these are denied: `cd <out> && git push -u origin x`, `git -C <out> push origin x`, `cd <out> && gh pr create --draft --fill`, and `cd <out>/worktree-of-repo && git push`. In SHIP, with a passing ship gate and human approval, `git push` is allowed (the existing hooks test).
- AC2: A built-in release detector (always on, independent of config) denies, with no task:
  - git with global flags: `git --work-tree . push`, `git --namespace x push`, `git --config-env user.name=HOME push`, `git -c x.y="a b" push`, `git -C . push`, `git --no-pager push`, `git --git-dir .git push`, `git \`+newline+`push`
  - other programs with global flags: `terraform -chdir=infra apply`, `kubectl -n prod apply -f k.yaml`, `docker --context prod push img`, `npm --workspace a publish`, `gh pr -R o/x create`, `gh pr merge https://github.com/o/x/pull/1`, `vercel deploy --prod`
  - indirection: `bash -c 'git -C x push'`, `echo $(git -C . push)`, `env git push`, `/usr/bin/git push`

  It does not flag `git status`, `git log --oneline`, `git commit -m "push the fix"`, `git config push.default simple`, `npm test`, `npm run build`, or `gh pr view 1`. The config `shipGated` regexes still apply on top.
- AC3: The tamper check denies every revision 3 case: separators inside quotes, the `#` and `$'…'` merges, `echo "x || y" > .governance/state.json`, writes to the ledger, and `gov status; rm …` / `gov status > .governance/state.json`. `gov run build 2>&1 | tail -20` and `gov status > status.txt` are allowed.
- AC4: An invalid or wrongly shaped config fails closed. This covers every revision 3 case plus a `bashDeny` entry with no `pattern`. Edit, Write, MultiEdit, NotebookEdit and Bash are denied, reads are allowed, `gov` exits 2 with a one-line message, SessionStart shows the error, and Stop doesn't block.
- AC5: Guard errors fail closed:
  - An exception while evaluating Edit or Bash denies.
  - Unparseable hook input denies for every tool.
  - Stop and SessionStart exit 0 on unparseable input.
- AC6: If the hook's `cwd` is outside any governed tree but `CLAUDE_PROJECT_DIR` is governed, the hook uses `CLAUDE_PROJECT_DIR`. For example, an Edit to the repo's `app.js` with `cwd=/tmp` and no task is denied.
- AC7: Installs always protect `.governance/bin/`, `lib/` and `hooks/`.
- AC8: `.idea/` is untracked, with the exact `.gitignore` line.
- AC9: Stop doesn't block when only human approvals are missing, including a stale plan approval and a stale ship approval.
- AC10: An unknown `mode` value denies.
- AC11: The README states the no-exemption rule and the release detector, and lists the known limits (token-based tamper check, scripts, other clones), without over-claiming.
- AC12: The full test suite and the build check pass.

## Approach
1. **Remove the exemption code.** `checkBash` gates whenever `isRelease(command)` is true.
2. **Release detector:**
   - Tokenise each segment with the quote-aware `shellWords`, falling back to a whitespace split. Strip shell punctuation around words, such as `$(` and `` ` ``.
   - Re-tokenise any word that contains whitespace; this catches `bash -c '…'` bodies.
   - For each word whose basename is a release program, check whether the program's subcommand words appear later in the same word list, in order. Anything may sit between them, which defeats flags.
   - The table: git → `push`; gh → `pr create`/`pr merge`/`pr ready`/`release create`; npm/pnpm/yarn → `publish`; terraform → `apply`/`destroy`; kubectl → `apply`/`delete`/`rollout`; docker → `push`; vercel → `--prod`/`promote`.
   - It is OR-ed with the config regexes, which are tested against the raw segment and the whole command.
3. **Hook input:** `readInput` returns `null` on unparseable input. PreToolUse denies, and Stop and SessionStart exit 0. Resolve the root with `Gov.open(input.cwd) || Gov.open(CLAUDE_PROJECT_DIR)`.
4. **Tests:** rewrite `guards.test.js` for AC1–AC11, including the review #14 test gaps: a `bashDeny` entry with no `pattern`, MultiEdit/NotebookEdit, a Bash crash, Stop/SessionStart on bad input, and a stale ship approval.
5. **README.**
6. Build, then a fresh independent review.

## Risks
- **Over-blocking:** the detector flags `git commit -m push` (unquoted) and similar. That fails closed, and the human can run the command. Quoted messages are one word, so they aren't flagged (AC2).
- **Less convenience:** releasing other repos from a governed session now needs the human. That's accepted, deliberately.
- **Detector gaps:** a release program not in the table, or one invoked through a script. The config regexes remain for additions, and the limits are documented.
- **In this dev repo the guard is agent-editable** (human decision). Only review protects it.

## Rollback
Revert the commit(s). No data or state migrations.
