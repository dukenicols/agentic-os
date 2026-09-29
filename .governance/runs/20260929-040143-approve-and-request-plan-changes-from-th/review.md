# Review: approve and request plan changes from the fleet UI

Reviewer: gov-reviewer
Verdict: PASS

## Files reviewed
- fleet/lib/approver.js: unchanged since round 3. Scrypt with `timingSafeEqual`, an atomic 0600 write, and `reserve()` counted before the await. Correct.
- test/approve-expect.test.js:
  - New tests cover invalid UTF-8 (0xFF/0xFE, a literal `⟦0xFF⟧` vs the byte 0xFF, Latin-1, U+FFFD vs 0xFF).
  - A 500-case byte-level property test checks that distinct buffers always give a visible +/- line.
  - Symlinks are checked not to be followed.
  - The clean filter is now a working one, and the unused import is gone.
  - Good.
- test/fleet-approvals.test.js: broad coverage of AC2–AC8. Unchanged in substance.
- test/fleet-ui-render.test.js: new test that the diff view classifies lines by position and reveals CR. It runs the page's own code. Good.
- .governance/bin/gov: `diff --patch` delegates to `Gov.patch`, and `option()` is strict. Fine.
- .governance/lib/core.js:
  - `filePatch`/`decodeBytes` now render text without loss. Escaped mode is injective (a literal ⟦ is doubled, and escapes always start `⟦0x`).
  - Surrogate, overlong and out-of-range sequences are escaped byte by byte. I checked 200k random buffers from a hostile alphabet and found 0 collisions.
  - The "BYTES DIFFER" note is present as a safety net.
  - A symlink is detected with lstat and never followed.
  - A race where a file vanishes before lstat throws, which fails closed (gov exits non-zero and the UI returns 409).
- fleet/README.md: accurately describes the byte-level diff, the escaping, CR handling and symlinks. Small structural NIT below.
- fleet/bin/fleet: `passphrase` refuses to run under CLAUDECODE or without a TTY, reads hidden input twice, and writes 0600. Fine.
- fleet/lib/decide.js: feedback is gated to PLAN, filtered by taskId and hash, and bounded by MAX_FEEDBACK_RUNS. Correct.
- fleet/lib/runner.js: feedback is fenced and closing tags are neutralised. Fine.
- fleet/lib/server.js:
  - The authorize order is unchanged and correct.
  - GET `/approval` holds the lock and re-checks the fingerprint after reading the diff.
  - The indentation of the `try` block is fixed.
- fleet/lib/state.js: adds the `feedback: []` default. Fine.
- fleet/lib/tick.js: counts revision runs for each served request. Fine.
- fleet/ui/index.html:
  - `diffView` is now a small state machine (list → header → hunk). Hunk content always carries a ` `/`+`/`-` prefix, so only a real `diff --gov` line can start a header.
  - CR is revealed and `note:` lines are styled as warnings.
  - There is no innerHTML.
- test/fleet-helpers.js: records an allow-listed env plus `leaked` and `secretSeen` booleans, and no values. The vacuous-pass gap is closed.
- test/fleet-server.test.js: the 405 test is updated to the documented rule, as the plan's Scope said.
- test/fleet-tick.test.js: the AC8 test asserts `secretSeen === true` and `leaked === false`. The timeout test now uses a 3 s timeout, asserts that the grandchild started, and polls for its exit. This goes beyond the letter of AC9, but it was made at review request and strengthens the tests. Note it in verification.md, as planned.

## Plan conformance
The change implements the approved scope:
- core `--expect`/`--via`/`planHash`;
- the approver and `fleet passphrase`;
- the two POST endpoints with their checks in the stated order, plus GET `/approval` and GET `/diff`;
- feedback flowing into decide and the prompt;
- the UI panel and the README.

The byte-level `gov diff --patch` rewrite, the symlink handling and the diff classification fix accepted review findings under AC7's "approve only what was on screen" intent. They are not scope creep. The edit to test/fleet-tick.test.js is the only deviation from AC9's letter; it is acceptable and must be recorded in verification.md. The guard for `$FLEET_HOME` writes in the pre-tool-use hook stays deferred, as agreed.

## Findings
Round-5 findings, checked against the code:
- [x] MAJOR (round 5): the diff hid byte changes that are not valid UTF-8. Fixed.
  - Code: .governance/lib/core.js `filePatch`/`isUtf8`/`decodeBytes` (around lines 671-713). The "could not be verified" fallback also escapes (line 676).
  - Reproduction: the round-5 reproduction now gives `-⟦0xFF⟧` / `+⟦0xFE⟧` with a "not valid UTF-8" note.
  - Tests: test/approve-expect.test.js:181 and :201.
- [x] NIT (round 5): `diffView` classified lines by prefix. Fixed with the parser state at fleet/ui/index.html:341-356, tested at test/fleet-ui-render.test.js:155.
- [x] NIT (round 5): CRLF→LF was invisible. Fixed: CR renders as `⟦U+000D⟧` in the diff (fleet/ui/index.html:353). A BOM change is also visible, because U+FEFF is Cf and gets revealed.
- [x] NIT (round 5): symlinks were followed. Fixed at .governance/lib/core.js:202-204. The link target is shown, not the target's content. See the new NIT below on the remaining gap.
- [x] NIT (round 5): the `leaked` check could pass vacuously. Fixed with `secretSeen` (test/fleet-helpers.js:44-45, test/fleet-tick.test.js:185).
- [x] NIT (round 5): unused `Gov` import and a non-working clean filter. Fixed at test/approve-expect.test.js:129-132.
- [x] NIT (round 5): the `/approval` `try` block was not indented. Fixed in fleet/lib/server.js.
- [ ] NIT (round 2, deferred follow-up as agreed): the governance pre-tool-use hook does not guard writes under `$FLEET_HOME` (for example `approver.json`).
- [ ] NIT (round 5, still open): trailing-whitespace-only changes render as `-a ` / `+a`, which look identical. Probe: `filePatch('ws', 'a \n', 'a\n')`. This is low impact, since whitespace rarely changes behaviour. Marking trailing whitespace in `diffView` would make it explicit.

New findings:
- NIT: symlink target content is disclosed but never shown, while the fingerprint hashes it.
  - `manifest()` (.governance/lib/core.js:161) follows symlinks. `patch` (:202-204) prints only `note: symbolic link to "<target>"; target content not shown`.
  - Case 1: the agent adds `lib/x.js -> ../dist/x.js`, where `dist/` is gitignored. The content that will run is never on screen.
  - Case 2: a symlink's target content changes but the link does not. It shows as `M` with the same note as before.
  - This is not a BLOCKER or MAJOR because the note is explicit, the UI styles it as a warning, and the README says so.
  - Follow-up: include the target's sha256 (old → new) in the note. When the resolved target is a regular file inside the repo root and not a `secretPaths` match, show its content like any other file.
- NIT: a path containing `\n` can forge diff structure.
  - `filePatch` interpolates `rel` verbatim into `diff --gov a/${rel} b/${rel}` and the `---`/`+++` lines (.governance/lib/core.js:672, :687). The `A/M/D` list in .governance/bin/gov does the same.
  - `git ls-files -z` returns such names. Probe: `filePatch('x\ndiff --gov a/README.md b/README.md', '', 'evil\n', {added:true})` shows `+evil` under a line that reads as a README.md header.
  - Impact is misattribution only: all content is still displayed, and a file with that name is unlikely to be loaded by anything.
  - Fix: JSON-quote any path that contains control characters or `⟦`, in both the header and the list.
  - Related, pre-existing: `listFiles()` decodes git output as UTF-8, so on Linux a file whose name is not valid UTF-8 becomes U+FFFD, fails `readFileSync`, and silently drops out of the manifest and the diff. Worth a follow-up.
- NIT: fleet/README.md:156-166. The sentences about the ship diff (its construction, the escaping, symlinks) sit under the "**Plan:**" sub-bullet. They belong under "**Ship:**".

Tests: `node --test test/*.test.js` gave 140/140 passing. My own checks:
- 200k random-buffer injectivity check of `decodeBytes(…, true)`: 0 collisions.
- Probes of BOM, CR, trailing whitespace, EOF newline and a newline-in-path via `filePatch`: results as described above.
