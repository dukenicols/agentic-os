# Verification: approve and request plan changes from the fleet UI

Evidence: `gov run test` → `npm test` exit 0, 140/140 (evidence #27, logs/test-006.log); `gov run build` exit 0 (evidence #23); independent review PASS, round 6 (evidence #25). Suite was also run 6× by hand after the last change: 140/140 each time.

- AC1: PASS — evidence: test-006.log (test/approve-expect.test.js):
  - "AC1: status --json includes the plan hash"
  - "AC1: approve plan --expect succeeds only for the current plan hash, and records --via"
  - "AC1: approve ship --expect succeeds only for the current tree fingerprint"
  - "AC1: without flags approval behaves as before; agents still cannot approve"
  - "AC1: malformed flags are rejected without recording anything" (incl. `--expect=`)
  - All pre-existing core/workflow tests still green.
- AC2: PASS — evidence: test-006.log
  - "AC2: passphrase is stored only as an scrypt hash, 0600, and verifies in constant time"
  - "AC2: `fleet passphrase` refuses without a TTY or inside an agent session"
- AC3: PASS — evidence: test-006.log (test/fleet-approvals.test.js):
  - "AC3: GET approval returns the pending plan, its exact text and hash"
  - "AC3: correct passphrase + current hash approves the plan, via fleet-ui, as the human"
  - "AC3: each failed condition returns its own 4xx and records nothing": 401 wrong passphrase, 409 not awaiting, 412 hash mismatch, 400 bad gate, 404 unknown project, 423 lock held.
  - "AC3: the plan changing after it was loaded voids the approval"
  - "AC3: fails closed without a passphrase, inside an agent session, or with an old gov": 503, 503, 426.
  - "AC3: approves ship bound to the tree fingerprint; the diff is served for review"
  - "a diff too large to show in full cannot be approved from the UI" (413).
- AC4: PASS — evidence: test-006.log
  - "AC4: the rate limiter blocks after 5 failures for 15 minutes"
  - "AC4: 5 wrong passphrases lock out approvals and feedback with 429; failures are logged without the passphrase"
  - "AC4: a parallel burst of wrong passphrases cannot outrun the rate limit": 30 parallel guesses → exactly 5×401 + 25×429.
  - "a correct passphrase does not consume the attempt budget"
- AC5: PASS — evidence: test-006.log
  - "AC5: feedback is stored against the plan hash, makes the next tick revise the plan, and clears once the plan changes": the comment is fenced and cannot close the fence.
  - "AC5: feedback needs the passphrase, a non-empty comment, and the current plan"
  - "AC5: feedback no longer applies once the plan is approved (approval supersedes it)"
  - "AC5: feedback the agent does not act on goes back to the human after 2 runs"
  - "AC5: feedback from another task with identical plan text is ignored"
- AC6: PASS — evidence: test-006.log
  - "AC6: POST only on approve/feedback, only same-origin JSON; everything else stays 405": 403 missing/foreign/null Origin, 415 non-JSON incl. `application/json-seq`, 400 bad/null body, 413 oversize body, 421 bad Host, 405 elsewhere.
  - "AC6: every non-GET request is refused with 405 (except the two passphrase-protected POST routes)"
  - "requests with an unexpected Host header are refused (DNS rebinding)"
- AC7: PASS — evidence: test-006.log (fleet-approvals + fleet-ui-render tests) and a manual Chrome check, detailed below
  - test-006.log: "AC7: the page offers approve / request changes / ship review, builds DOM safely and never stores the passphrase" (no innerHTML/insertAdjacentHTML/document.write).
  - test/fleet-ui-render.test.js, which runs the page's own md/rawView/diffView against hostile documents:
    - "exact-text view shows every character; invisible ones are made visible"
    - "formatted view keeps fence lines, comments inside fences, and caps indentation"
    - "astral and property-based invisibles are revealed…"
    - "diff view classifies by position…; CR is revealed"
    - "the approval panel defaults to the exact text"
  - The diff the human approves is built from verified bytes:
    - "diff shows real changes despite clean filters, assume-unchanged, skip-worktree and replace refs"
    - "…base cannot be verified…"
    - "…not valid UTF-8, unambiguously"
    - "property: distinct byte strings always produce a visible change"
    - "symlinks are shown as their target, never followed"
  - Manual check in Chrome on sandbox fleets (server run inside the agent session, so approvals correctly refused):
    - plan panel with rendered/exact text, sha256 and HTML-comment warning;
    - form with passphrase, approve and request-changes;
    - passphrase field cleared after submit, server refusal shown;
    - ship panel with embedded coloured diff, review, verification and fingerprint;
    - no approval was recorded in the sandbox ledger.
- AC8: PASS — evidence: test-006.log
  - "AC8: the passphrase appears nowhere: state, events, logs, ledger, responses" (scans FLEET_HOME and the repo's run files).
  - The page test asserts no localStorage/sessionStorage/indexedDB/cookie use.
- AC9: PASS — evidence: gov evidence #23 and #27, details below
  - gov evidence #23 (`npm run build` exit 0) and #27 (`npm test` 140/140).
  - Existing tests changed only as follows:
    1. test/fleet-server.test.js 405 test updated to the new rule, as the plan's Scope said.
    2. test/fleet-tick.test.js, at review request, in two places:
       - the AC8 test now asserts the `secretSeen`/`leaked` probe instead of scanning the recorded env;
       - the pre-existing flaky "timeout also kills processes the agent started" test uses a 3 s timeout and polls for the grandchild's exit.
    3. test/fleet-helpers.js: the fake `claude` records only an allow-list of variables. It previously dumped the full developer environment into logs.

## Not verified
- A real approval end-to-end through the browser. Approvals are correctly disabled in a server started from inside an agent session, and I must not approve. The approve and feedback POST paths are covered by in-process tests with approvals enabled, but you have not yet clicked "Aprobar" in a real browser against a real server.
- `fleet passphrase` interactive hidden input on a real TTY (only its refusals are tested).
- Ubuntu/systemd and real repos with a re-installed gov (`install.sh`) supporting `--expect`.

## Known follow-ups (not fixed; reviewed as NIT)
- Guard writes under `$FLEET_HOME` (approver.json) in the governance pre-tool-use hook.
- Symlink targets: show the target's sha256, and its content when it is a non-secret file inside the repo.
- JSON-quote paths containing control characters in `gov diff` headers and the A/M/D list. Also: file names that aren't valid UTF-8 drop out of the manifest (pre-existing).
- Mark trailing-whitespace-only changes in the diff view.
- README: move the ship-diff sentences under the "Ship" bullet.
- Also: during this task, the fake `claude` test helper printed the developer environment into test failure output. That exposed GITLAB_AUTH_TOKEN and DATABENTO_API_KEY in the session transcript (not in the repo or git history). The helper is fixed and the temp dirs were deleted, but the human should rotate both credentials.
