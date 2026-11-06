---
name: h-status
description: Where we are and what to run next, from state.yaml, asks.yaml, the handoff, the test stamp and git.
argument-hint: ""
allowed-tools:
  - Read
  - Bash
---

Read `.planning/state.yaml`, `.planning/asks.yaml`, `.holden/handoff.md`,
`.holden/test-stamp`, and `git status --short` plus `git log --oneline -5`. Print, in
under twenty lines:

- Milestone and its goal (or "none open"); any paused milestones by name and paused date;
  current phase, its status, its review tier.
- Whether a handoff is pending, when it was written, and how many commits landed since its
  State line (`git log --oneline <its HEAD>..HEAD`).
- Whether the test stamp matches HEAD with a clean tree.
- Open asks: count, and the red ones by id and sentence.
- Uncommitted changes, if any.
- Packages in flight and deferred stamps: `~/.claude/holden/bin/h-queue status --summary`,
  printed as it is. A second line, `stamps: <m> missed, <p> pending`, appears when a
  doc's stamp waits; `h-queue stamps` lists them. `/h-queue` has the package list.
- Leftover holden branches and worktrees: `~/.claude/holden/bin/h-worktree list`. Anything it
  prints that `h-queue status` does not list as a package, and that is outside an executing
  phase, is shown with `h-worktree sweep` as the thing to run.
- Answers no session will read: `~/.claude/holden/bin/detach-orphans`, printed as it is. Each
  line is a detached run that finished, unseen, after its session went away.
- A deployed phase with no diff review. Its entry has `deploy` set, a `review:` map with
  a diff tier other than `none`, and no `review.diff_done`, which `/h-execute` step 7
  writes when the phase lands. An entry with no `review:` map predates the diff review
  and counts as waived; `bin/h-scratch-pass` writes `review.diff_done: waived` into it.
  An entry landed before the key existed counts as reviewed while its directory still
  holds a diff review report (`DIFF-CODEX-REVIEW-r*.md` or `<NNN>-REVIEW-self*-r*.md` of
  kind diff); `bin/h-scratch-pass` writes the key in the commit that deletes the report.
  Print "<NNN> deployed, diff review not run" and put
  `/h-review diff <base>..HEAD <NNN>` first in what to run next. The code is live before
  a cold reader saw it; that is the fact the line exists to show, not a gate.
- What to run next:
  - `/h-grill` if no phase is grilled
  - `/h-plan <NNN>` if grilled
  - `/h-execute <NNN>` if planned or executing
  - `/h-milestone close` if every phase in the milestone is landed
  - otherwise the next grill

  With no milestone open and one or more paused, add `/h-milestone resume <name>` (or `new`)
  to the list.

End with one line naming the next session move and why, in this order: continue, clear, handoff, subagent, compact (see `~/.claude/holden/docs/phase-boundaries.md`).
