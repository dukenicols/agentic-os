# Review: Scope ship-gated commands to the governed repo

Reviewer: gov-reviewer
Verdict: PASS

## Files reviewed
- test/guards.test.js — AC2 now has allow cases for `constructor`, `Constructor` and `__proto__`, plus direct `hasBuiltinRelease` assertions. Those assertions would fail if the lowercasing, the `=` split or the `hasOwn` fix were reverted.
- .gitignore — No change since round 4. Still correct.
- .governance/bin/gov — No change since round 4. Still correct.
- .governance/config.json — No change since round 4.
- .governance/hooks/io.js — No change since round 4. Still correct.
- .governance/hooks/pre-tool-use.js — The `RELEASES` lookup is now guarded by `Object.hasOwn` (line 146). It is correct, and `Object.hasOwn` is available on the `engines` minimum (Node >=18). There are no other user-indexed object lookups in the hook.
- .governance/hooks/session-start.js — No change since round 4. Still correct.
- .governance/hooks/stop.js — No change since round 4. Still correct.
- .governance/lib/core.js — No change since round 4. There is one old prototype edge case, outside this delta (NIT below).
- README.md — The nested-root limit now says the agent can create a nested config itself. That is accurate: I checked that `sub/.governance/config.json` matches no protected or framework pattern.
- scripts/install.js — No change since round 4. Still correct.
- test/helpers.js — No change since round 4. Still correct.
- .idea/.gitignore — Untracked on purpose (AC8).
- .idea/material_theme_project_new.xml — Untracked on purpose (AC8).
- .idea/vcs.xml — Untracked on purpose (AC8).

## Plan conformance
The delta has only the three fixes that round 4 asked for: the `hasOwn` guard, the test additions and one README clause. It adds nothing else and doesn't change any plan decisions.
- `npm test`: 40/40 pass.
- `npm run build`: 14 JS + 3 JSON checked, 0 failed.

## Previous findings
I ran every probe through `evaluate()` against `Gov.open(sandbox())` (no task), and also through `hasBuiltinRelease()` directly. Release words were built by concatenation.
- **MAJOR (`RELEASES` hit inherited `Object.prototype` properties): resolved.**
  - These are now ALLOW and `hasBuiltinRelease` returns false for each, with no exception: `grep -rn constructor src/`, `git log -S Constructor`, `grep CONSTRUCTOR x`, `echo __proto__`, `__PROTO__ x`, `constructor <push>`, `__proto__ <push>`, `/x/constructor <push>`, `toString hasOwnProperty valueOf`.
  - Mixed commands are still caught: `constructor && git <push>` and `git commit -m "x constructor" && git <push>` are DENY.
  - The live session hook also allowed my `grep` commands containing `constructor` and `__proto__`. In round 4 such commands failed closed.
- **NIT (two AC2 deny cases were masked by the config regexes): resolved.** `test/guards.test.js:112-114` asserts `hasBuiltinRelease(...) === true` directly for `GIT push`, `vercel --prod=true`, `vercel --target=production`, `docker build --push .` and `gh pr new`. Line 115 asserts false for `grep constructor`. I got the same results by hand.
- **NIT (the README didn't say the agent can create a nested governed root): resolved** (README.md:153-155). The clause is accurate.

## Findings
- NIT: README.md:155 isn't wrapped like the lines around it (about 120 columns, against about 80 elsewhere). It's cosmetic only.
- NIT (outside this delta; optional follow-up): `.governance/lib/core.js:157-161` builds the manifest in a plain `{}`.
  - A file named `__proto__` at the repo root is assigned through the `__proto__` setter, which silently ignores a string value. The file is therefore left out of the fingerprint.
  - Also, `diffManifests` uses `k in a` (line 610), which misclassifies a newly added file named e.g. `toString` as "modified".
  - Both are contrived and older than this change. `Object.create(null)` (or a `Map`) would close both.
