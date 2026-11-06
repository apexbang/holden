---
name: h-handoff
description: Write a handoff for the next session (what it is for, what was decided, what is in flight, what to run), or read the pending one.
argument-hint: "[what the next session is for] | read"
allowed-tools:
  - Read
  - Write
  - Bash
---

`read`: print `.holden/handoff.md` if it exists, then the phase entry it names from
state.yaml. Then say what changed since it was written. Run `git log --oneline <its HEAD>..HEAD`
and print the count and up to fifteen subjects. Compare the phase status it records with the
status in state.yaml now. When commits landed or the status moved, say so first, in one line,
before the handoff's own next step: that step may be done already. A handoff with no HEAD line
predates this check; say that, and give its age. Stop.

Otherwise write `.holden/handoff.md` from `~/.claude/holden/templates/handoff.md` so a
fresh session can continue. Fill the State line from `git rev-parse --short HEAD`, the branch,
and the current phase's number and status in state.yaml. Then write:
- what the next session is for, from the argument or your best statement of it
- what was decided this session
- what is in flight, and its exact next step
- which files to read first
- which /h- command to run next
- what not to do

Reference specs, plans, ledgers, commits and diffs by path or hash; do not repeat their
content. Redact anything that looks like a credential. Keep it under sixty lines. The file is
gitignored; it is for the next session, not for history.

End with one line naming the next session move and why, in this order: continue, clear, handoff, subagent, compact (see `~/.claude/holden/docs/phase-boundaries.md`).
