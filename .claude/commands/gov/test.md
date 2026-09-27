---
description: TEST phase — prove every acceptance criterion with evidence
---
Continue the governed workflow in the TEST phase (see AGENTS.md).

1. `.governance/bin/gov status`. Advance from REVIEW if its gate passes. Otherwise stop and report.
2. `.governance/bin/gov run test`. If anything fails, report the failure output honestly. Fixing it means code changes, so build and review must be redone.
3. Write `.governance/runs/<task>/verification.md` using `.governance/templates/verification.md`: one line per AC with PASS and a concrete evidence pointer. List anything unverified under "Not verified".
4. `.governance/bin/gov record verification`, then `.governance/bin/gov advance`.
5. Ask me to run `gov approve ship` in my own terminal, and show me `gov log`.
