---
description: BUILD phase — implement the approved plan and record build evidence
---
Continue the governed workflow in the BUILD phase (see AGENTS.md).

1. `.governance/bin/gov status`. If the phase is PLAN and the plan is approved, run `.governance/bin/gov advance`. Otherwise stop and tell me what's missing.
2. Implement exactly the approved plan, including tests. If the plan is wrong, stop and propose `gov back plan`.
3. `.governance/bin/gov run build`. Fix failures and re-run until every command exits 0.
4. `.governance/bin/gov advance`, then report what changed (`gov diff`) and the build evidence numbers.
