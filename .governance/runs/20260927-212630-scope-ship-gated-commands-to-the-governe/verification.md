# Verification: Harden the guards (the cross-repo release exemption is dropped)

All test evidence below comes from `gov run test` → evidence #30 (`npm test`, 40/40 pass, logs/test-005.log). Build evidence: #26. Independent review: #28 (PASS, round 5).

- AC1: PASS — evidence: tests "AC1: no cross-repo exemption — releases are gated in any directory" (other-repo `cd`, `git -C`, gh, a worktree of the repo placed elsewhere) and "AC1: in SHIP with a passing gate, releases are allowed" in test/guards.test.js (gov evidence #30)
- AC2: PASS — evidence: test "AC2: the built-in release detector sees through flags and indirection" in test/guards.test.js, which covers every deny/allow case listed in the plan plus the review #20 aliases and direct `hasBuiltinRelease` assertions (gov evidence #30)
- AC3: PASS — evidence: test "AC3: the tamper check denies every known quote/comment trick" in test/guards.test.js (gov evidence #30)
- AC4: PASS — evidence: test "AC4: invalid or wrongly shaped config fails closed everywhere" in test/guards.test.js: 6 corrupt configs × {gov exit 2 with a one-line message, Edit/Write/MultiEdit/NotebookEdit/Bash deny, Read allow, SessionStart error, Stop no block} (gov evidence #30)
- AC5: PASS — evidence: test "AC5: guard errors and unreadable input fail closed" in test/guards.test.js: Edit and Bash crash deny, and 3 bad-stdin forms × 3 hooks (gov evidence #30)
- AC6: PASS — evidence: test "AC6: a cwd outside the governed tree falls back to CLAUDE_PROJECT_DIR" in test/guards.test.js (gov evidence #30)
- AC7: PASS — evidence: test "AC7: installs always protect the framework code, whatever the source config says" in test/guards.test.js, plus test/install.test.js (gov evidence #30)
- AC8: PASS — evidence: test "AC8: .idea is ignored and untracked" in test/guards.test.js; `git ls-files .idea` is empty (gov evidence #30)
- AC9: PASS — evidence: test "AC9: stop does not block when only human approvals are missing" in test/guards.test.js: missing and stale plan approvals, missing ship approval, and the stale ship approval classified `human` via `gates().ship.human` and `blockers()` (gov evidence #30)
- AC10: PASS — evidence: test "AC10: an unknown mode denies instead of asking" in test/guards.test.js (gov evidence #30)
- AC11: PASS — evidence: README.md sections "Release commands are gated everywhere" (table matches `RELEASES`) and "Known limits". Independent review #28 and round 4 checked both against the code and probed every listed limit example (gov evidence #28)
- AC12: PASS — evidence: `gov run build` evidence #26 (14 JS + 3 JSON, 0 failed) and `gov run test` evidence #30 (40/40)

## Not verified
- Tests ran only on macOS (Darwin 24.6) with Node 22.23. Linux and Node 18/20 were not run. `Object.hasOwn` needs Node ≥ 16.9, which is within `engines` (≥ 18).
- AC9: a ship approval that is stale *on its own* can't happen, because it only goes stale when code changes, which also makes build, review and test stale. So Stop correctly blocks in that case. The test checks the human classification directly instead.
- The live Claude Code session was exercised informally throughout this task: the hooks blocked and allowed my own commands as expected. That isn't recorded as evidence.

## Follow-ups (documented, out of scope)
- Case-insensitive path protection (README Known limits).
- Nested governed root selection (README Known limits).
- Path-normalising tamper check (README Known limits).
- `WRITE_OP` `install` false positive.
- Manifest `__proto__`/`in` edge cases in core.js (review #28 NIT).
- README.md:155 line wrap (review #28 NIT).
- The Stop hook can't tell that a reviewer subagent is already running, so it blocks once per stop while waiting.
