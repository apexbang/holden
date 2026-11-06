---
name: h-codex
description: The Codex plan's live usage (5-hour and weekly limits, reset times, reset credits), and which holden runs used it. Use when the operator asks about Codex usage, limits or budget.
argument-hint: ""
allowed-tools:
  - Bash
  - Read
---

Run `~/.claude/holden/bin/codex-limits`. It reads the plan's live figures from `codex app-server`
in about a second and costs no model tokens. Tell the operator, in plain words and in local time:

- 5-hour window: percent used and when it resets.
- Weekly window: percent used and when it resets.
- Reset credits, if any: how many and when the first expires. Never spend one; that is the
  operator's call.
- If the line says `LIMIT REACHED`, lead with it.

If the operator asks what used it, the review logs hold a before/after pair per run:
`grep -h "codex limits" .planning/phases/*/*CODEX-REVIEW.log` in the current repo, newest last.
That covers the directories `bin/h-scratch-pass` has not reached. The pass deletes the logs
of the rest, and their pairs stay in git history:
`git log -p --reverse --format= -- '*CODEX-REVIEW.log' | grep '^+.*codex limits'`, oldest
first, which lists every committed pair, deleted logs included. Runs from before 2026-09-23
have no pair.

For a yes/no on whether Codex can be used right now, `codex-limits --check` prints `ok`,
`exhausted`, `no-plan` or `unreadable` first; what holden does with each is in `/h-review`
§ Codex availability.

If the command fails, say so with its message (codex missing from PATH, or the app server did not
answer) and stop; do not guess figures from old session files.
