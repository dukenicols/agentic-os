# Plan: approve and request plan changes from the fleet UI

## Goal
Let the human review and act on pending gates from the fleet web UI instead of an SSH terminal:
read the plan (rendered markdown), approve it, or request changes with a comment; read the diff,
review and verification, and approve ship. Every UI action requires a passphrase, so an agent on the
same server can't approve anything by calling the local UI. Every approval is bound to the exact
plan text or tree the human saw.

## Scope
In scope:
- **gov core** (`.governance/lib/core.js`, `.governance/bin/gov`):
  - `gov approve <plan|ship> --expect <hash> [--via <channel>]`.
    - For plan: approve only if `<hash>` equals sha256 of the current plan.md.
    - For ship: approve only if `<hash>` equals the current tree fingerprint.
    - `--via` (`^[a-z0-9-]{1,32}$`) is recorded in the ledger entry.
  - Without these flags behaviour is unchanged. Agents still can't approve (CLAUDECODE check unchanged).
  - `gov status --json` gains `planHash` for the active task.
  - `gov help` documents `--expect`; fleet uses that text to detect support.
- **fleet**:
  - `fleet/lib/approver.js`: scrypt passphrase hash (store + verify), plus an in-memory failure rate limiter.
  - `fleet/bin/fleet passphrase`: interactive, hidden input, entered twice. Refused without a TTY or under CLAUDECODE.
    Writes `~/.agentic-os/approver.json` (0600) with salt + hash + params only.
  - `fleet/lib/server.js`:
    - `GET /api/projects/:name/approval` returns the pending gate and the plan hash or tree fingerprint to approve, plus whether UI approval is supported.
    - `GET /api/projects/:name/diff` returns `gov diff --patch`, capped in size.
    - `POST /api/projects/:name/approve` takes `{gate, expect, passphrase}`.
    - `POST /api/projects/:name/feedback` takes `{text, expect, passphrase}`.
    - POSTs only on those two routes, only with `Content-Type: application/json` and an `Origin` matching the Host. Every other non-GET stays 405.
    - The approve path, all checked against fresh state:
      1. passphrase;
      2. rate limit;
      3. the project is awaiting that gate right now (fresh `gov status`, not the UI cache);
      4. `expect` matches;
      5. the repo's gov supports `--expect`;
      6. take the project lock, so no fleet agent is running;
      7. spawn `gov approve <gate> --expect <h> --via fleet-ui` as a human process (scrubbed env).
  - `fleet/lib/state.js` / `tick.js` / `decide.js` / `runner.js`:
    - Feedback is stored per project in fleet state as `{at, text, planHash}`.
    - While the plan still has that hash, decide returns `continue` in PLAN instead of `await-human`.
    - The continue prompt includes the feedback, fenced as data.
    - When plan.md changes, the feedback is no longer pending. It stays in history.
  - `fleet/ui/index.html`:
    - A small markdown renderer that builds DOM nodes with `textContent` only (headings, lists, checkboxes, code, bold).
    - An approval panel:
      - plan: rendered plan, short hash, "Aprobar plan", and a "Pedir cambios" textarea;
      - ship: diff, review, verification and gates tabs, fingerprint, "Aprobar ship".
    - A passphrase field that is cleared after every submit and never stored.
    - The inbox gets a "Revisar" button that opens the panel, and the UI shows the feedback history.
  - `fleet/README.md`: set the passphrase, the UI approval flow, repos must re-run `install.sh` to get `--expect`, and the threat model.
- **tests**: core tests for `--expect`, `--via` and `planHash`; fleet tests for approver, endpoints, feedback → decide/prompt, and the UI markup.
  - `test/fleet-server.test.js` "every non-GET is refused with 405" is updated to the new rule: only the two POST routes accept POST.
- Commit the previous task's ship record (its `ledger.jsonl`/`task.json` under `.governance/runs/20260929-032313-…`) with this change.

Out of scope:
- passkeys/WebAuthn (follow-up);
- UI login sessions (the passphrase is typed per action);
- requesting changes at ship;
- running agents as a separate Unix user (follow-up; see Risks);
- changing AGENTS.md (protected);
- upgrading agentic-os in the other repos (human step, documented).

## Acceptance Criteria
- AC1: `gov approve plan --expect <h>` succeeds only when `<h>` is the sha256 of the current plan.md. `gov approve ship --expect <fp>` succeeds only when `<fp>` is the current tree fingerprint. A mismatch errors with no ledger entry. `--via fleet-ui` appears in the ledger approval entry. Without the flags, behaviour and existing tests are unchanged, and CLAUDECODE still blocks approval. `gov status --json` includes `planHash`.
- AC2: `fleet passphrase` refuses to run without an interactive TTY or with CLAUDECODE set. It writes `approver.json` with mode 0600 containing only the algorithm parameters, salt and hash. Verification accepts the right passphrase and rejects others using a constant-time compare.
- AC3: `POST /approve` records an approval (ledger `via: fleet-ui` + fleet `approved` event) only when all of these hold:
  - the passphrase is correct;
  - the project is currently awaiting that gate;
  - `expect` equals the current plan hash (plan) or tree fingerprint (ship);
  - no agent holds the project lock;
  - the repo's gov supports `--expect`.

  Each failed condition returns a distinct 4xx and writes no ledger entry. It also fails closed (no approvals) when `approver.json` is missing.
- AC4: After 5 failed passphrases within 15 minutes, approve and feedback return 429 for 15 minutes. Each failure emits an event, and the event never contains the passphrase.
- AC5: `POST /feedback` with the correct passphrase and the current plan hash stores the comment. The next `fleet tick` returns `continue` (not `await-human`) for that plan, and the prompt contains the comment inside a fence. After plan.md changes, the feedback is no longer pending and the task awaits approval again.
- AC6: Only `POST /api/projects/:name/approve|feedback` accept POST. Those require `Content-Type: application/json` and an `Origin` whose host matches the allowed Host; otherwise the response is 403 or 415. All other non-GET methods and routes return 405. The Host check still applies.
- AC7: The UI renders plan/review/verification markdown as formatted text built with DOM/`textContent` (no `innerHTML` in the page). It offers approve plan, request changes, and approve ship with the relevant documents, diff and gates, shows the result of each action, and clears the passphrase field after every submit.
- AC8: The passphrase never appears in fleet state, events, logs, API responses, or the ledger, and the page never writes it to `localStorage` or `sessionStorage`.
- AC9: `npm run build` and `npm test` pass. Existing tests are unchanged apart from the documented 405-rule update.

## Approach
1. Core: parse `--expect`/`--via` in `bin/gov`. `Gov.approve(phase, { expect, via })` reads plan.md or computes the fingerprint once, compares, then appends. `status --json` adds `planHash`. Add tests to `test/core.test.js` or `test/workflow.test.js` (AC1).
2. `fleet/lib/approver.js`:
   - `hashPassphrase`/`verifyPassphrase` use scrypt with N=2^15, r=8, p=1 and a 16-byte salt, compared with `timingSafeEqual`;
   - `loadApprover(home)`;
   - `RateLimiter(5, 15 min)`.
   - Add `fleet passphrase` with hidden TTY input. Tests (AC2, AC4).
3. Server POST routes with the checks in the order listed under Scope. Spawn gov with a scrubbed env. Tests use sandboxes: a gov that supports the flag, and an old gov copy without it (AC3, AC6, AC8).
4. Feedback:
   - stored with `state.update`;
   - `decide` gets `planHash` and `pendingFeedback`;
   - `prompt` adds a fenced feedback block.

   Tests (AC5).
5. UI: markdown renderer, approval panel, inbox button, result messages. Test for markup, no `innerHTML`, and no storage writes, plus a manual Chrome check against a sandbox fleet (AC7, AC8).
6. README, then `gov run build`/`gov run test` (AC9).

## Risks
- **Weaker "human in a terminal" rule.** Approving becomes possible from a browser. Mitigated by the passphrase, hash/fingerprint binding (you approve exactly what you saw), the lock (no fleet agent mid-run), Origin/Host/content-type checks, and the rate limit.
- **Same-user threat model.** The honest limit: agents run as the same Unix user as the UI. They can't use the passphrase, which is stored only as an scrypt hash, and they can't trivially `curl` an approval. An agent that already executes arbitrary code as that user could still:
  - overwrite `approver.json` or the fleet/gov code itself;
  - do the same to a repo's `.governance/lib`, which already defeats terminal-only approval today.

  The README will say this plainly. The real fix is running agents as a separate Unix user (follow-up).
- **TOCTOU.** A manually driven interactive session (not fleet) could edit plan.md between the check and the write. `--expect` is checked inside `gov approve` right before the ledger append, so the recorded approval always matches the hash the human saw. Otherwise it fails.
- **Old gov copies.** Repos with an older installed gov silently ignore unknown flags. Fleet detects `--expect` support from `gov help` and refuses UI approval with a clear message ("re-run install.sh") instead of approving unchecked.
- **Brute force.** Rate limit plus scrypt cost. The UI is bound to localhost/Tailscale anyway.
- **Scrypt blocking.** Scrypt verification (~50–100 ms) runs async (`crypto.scrypt`), so it does not block the event loop.

## Rollback
Revert the commit or PR. Core changes are additive (optional flags, an extra JSON field). Removing them
only removes UI approval; terminal `gov approve` keeps working. On the server, delete
`~/.agentic-os/approver.json` to disable UI approvals immediately without a code change: the server fails
closed when it is missing.
