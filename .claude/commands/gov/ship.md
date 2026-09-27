---
description: SHIP phase — release what was approved and close the task
---
Finish the governed workflow in the SHIP phase (see AGENTS.md).

1. `.governance/bin/gov check ship`. If it fails, stop and tell me exactly what's missing. If only my approval is missing, ask me for it.
2. Commit the changes with a message that references the task id. Open a PR (preferred) or push, as the plan says.
3. `.governance/bin/gov ship <PR URL or commit SHA>`.
4. Give me a release summary: what changed, the evidence (`gov log`), anything not verified, and the rollback plan.
