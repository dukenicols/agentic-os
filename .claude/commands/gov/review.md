---
description: REVIEW phase — independent review by the gov-reviewer subagent
---
Continue the governed workflow in the REVIEW phase (see AGENTS.md).

1. `.governance/bin/gov status`. Advance from BUILD if its gate passes. Otherwise stop and report.
2. Spawn the `gov-reviewer` subagent. Ask it to review the active task's diff against its plan.
3. Write its output verbatim to `.governance/runs/<task>/review.md`, then run `.governance/bin/gov record review`.
4. If the verdict is CHANGES_REQUESTED: fix the findings, `gov run build`, and repeat from step 2. Never edit the verdict yourself.
5. On PASS: `.governance/bin/gov advance` and summarize the findings.
