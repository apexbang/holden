---
name: h-queue
description: The packages in flight in this repo: one line each with what it waits on and what happens next, then the recent decisions (yields, stale packages, landings, refusals).
argument-hint: ""
allowed-tools:
  - Bash
  - Read
---

Run `~/.claude/holden/bin/h-queue status` from the repo. Print its output as it is:

- one line per package: kind, owner, state, what it waits on and since when, what happens
  next, worktree path and diff stat
- then one line per metadata token older than 24 hours, with the `h-queue meta abort` command
  that deletes it
- then, when a deferred stamp waits, `stamps: <m> missed, <p> pending; h-queue stamps
  lists them`
- then `recent:`, the last decisions

After it, print one line for the operator:

- a package marked `stuck`, or whose last event is `gave-up`, is theirs to decide (D04: waiting
  or parked over 4 hours). On a stuck parked package of a quick, the status line names
  `h-queue retire <id> --reason <text>`: it forgets a package that will never run again and
  keeps its patch and ledgers (`bin/h-queue` `status` and `retire`)
- a `stale` package yields when another package needs its file, or `h-queue resume <id>`
  re-admits it now
- a metadata token older than 24 hours holds a session's unpublished edit to a shared file
  (docs/reference.md § Shared files in `~/.claude/holden`). Its copies are under
  `<git common dir>/holden-meta/<token>/work/`. The operator reads them first, then runs the
  abort or not; nothing deletes one on its own (D07).
- a `stamps:` line with missed above 0: a package landed and its doc's stamp was not
  written. `h-queue stamps` names the ledger, the doc and the task; `/h-execute` step 4's
  stamping (`skills/h-execute/SKILL.md` in `~/.claude/holden`) writes it.

Nothing here edits the registry. `status` only reads it, with two pieces of bookkeeping that are
not decisions: clearing a freeze whose process died, and replaying a pending metadata journal
while the landing lock is free.

End with one line naming the next session move and why, in this order: continue, clear, handoff, subagent, compact (see `~/.claude/holden/docs/phase-boundaries.md`).
