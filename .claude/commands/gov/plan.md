---
description: PLAN phase — open a governed task and write its plan
argument-hint: <what you want built or changed>
---
Start the PLAN phase of the governed workflow (see AGENTS.md) for: $ARGUMENTS

1. Run `.governance/bin/gov status`. If a task is already active, tell me instead of starting another.
2. Run `.governance/bin/gov start "<concise title>"`.
3. Read the relevant code before planning. Ask me any clarifying questions now.
4. Fill in every section of the scaffolded plan.md, with numbered, testable acceptance criteria (`- AC1: ...`).
5. Run `.governance/bin/gov check plan`. The only remaining item should be human approval.
6. Show me the plan and ask me to run `gov approve plan` in my own terminal. Then stop.
