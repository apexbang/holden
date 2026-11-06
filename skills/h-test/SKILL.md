---
name: h-test
description: Prove a change with a test that depends on it (red at parent, green at commit, no stash), or run the full suite and stamp the tree.
argument-hint: "[<commit>] [--uncommitted] [--tests f1 f2] [--refactor] | --full"
allowed-tools:
  - Bash
  - Read
---

Run `~/.claude/holden/bin/h-test` with the arguments given (default `--uncommitted` when the
tree is dirty, `HEAD` otherwise). Show the verdict line and, on refusal or failure, the last
lines of the failing run.

Explain the verdict in one sentence:
- `proved`: the named tests fail without the change and pass with it.
- `proved-refactor`: tests pass at both ends; the change is behaviour-preserving by claim.
- `refused: tests pass without the change`: the test does not depend on the change; the test
  or the change is wrong. Do not proceed as if tested.
- `refused: no test changed`: add a test, or use `--refactor --tests <files>` if the change
  preserves behaviour.
- `--full` pass: the stamp at `.holden/test-stamp` now names this exact tree; deploy may
  skip the suites while it matches.
  A `--full` that reports `the tree changed during the run` stamped nothing: something landed or
  edited a code file meanwhile; run it again under `h-queue freeze`. A commit touching only
  `stamp_ignore` paths (a `.planning/` metadata commit) does not void the run; the stamp then
  names the new HEAD.
- exit 75: the machine's test mutex stayed busy for 9 minutes (another repo's suite); run the
  same command again. Neither red nor a failed attempt.

End with one line naming the next session move and why, in this order: continue, clear, handoff, subagent, compact (see `~/.claude/holden/docs/phase-boundaries.md`).
