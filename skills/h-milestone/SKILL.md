---
name: h-milestone
description: Open a milestone (name and goal), pause the open one to open another first, resume a paused one, or close one (archive its phases with pointer rewrite, one ledger paragraph).
argument-hint: "new <name> <goal> | pause <reason> | resume <name> | close"
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
---

One milestone is open at a time: `milestone` in `.planning/state.yaml`. Others can wait in
`paused_milestones`, a list of `{name, goal, opened, paused}`; a missing key is an empty list.

`new <name> <goal>`: if a milestone is open, stop and say so: close it, or pause it first. Never
overwrite the open one. If `<name>` is already a paused milestone or the `milestone:` of any
phase, stop: close archives by name, so a reused name would sweep another milestone's phases.
Otherwise set `milestone` (name, goal, opened date) in a metadata transaction (docs/reference.md § Shared
files in `~/.claude/holden`): `~/.claude/holden/bin/h-queue meta open .planning/state.yaml`,
set it in the work copy, then
`~/.claude/holden/bin/h-queue meta commit <token> -m "docs: open milestone <name>"`.
Phases join a milestone one at a time, when `/h-grill` writes its name onto the phase entry.
Nothing is reserved in advance, and phases outside it can be grilled and land meanwhile. To move
an existing phase in or out, change its `milestone:` field the same way, with
`-m "docs: phase <NNN> milestone <name>"`.

`pause <reason>`: the open milestone waits while another runs. A milestone must be open;
`<reason>` is the operator's, in their words. Open a transaction:
`~/.claude/holden/bin/h-queue meta open .planning/state.yaml .planning/ledger.md`. Then, in the
work copies:
1. Append `{name, goal, opened, paused: <today>}` to `paused_milestones` and set `milestone:
   null`. Its phases keep their `milestone:` field; nothing moves and nothing is archived.
2. Write one paragraph to ledger.md as `## L<next> (<date>) Milestone <name> paused`:
   - why
   - which of its phases landed
   - any of its phases not landed; they keep their name and can still land, so list them and
     the pause hides nothing

   Commit: `~/.claude/holden/bin/h-queue meta commit <token> -m "docs: pause milestone <name>"`.

`resume <name>`: `<name>` must be in `paused_milestones`, and no milestone may be open (pause or
close the open one first; say which). Open a transaction on `.planning/state.yaml`. In the work
copy, move the entry back to `milestone` with its original `opened` date, drop `paused`, and
remove it from the list. No ledger entry; the pause paragraph already says why it waited.
Commit: `~/.claude/holden/bin/h-queue meta commit <token> -m "docs: resume milestone <name>"`.

`close`: every phase in the current milestone must be `landed`; otherwise list the ones that
are not and stop. The close is one metadata transaction, published as one commit:
1. `~/.claude/holden/bin/h-queue meta open .planning/state.yaml .planning/asks.yaml .planning/ledger.md .planning/OPEN-ASKS.md CLAUDE.md`.
2. Run `~/.claude/holden/bin/h-milestone-close --token <token>` from the repo root. It writes
   into the token, never into the tree. It:
   1. computes the path map: each phase dir to `<paths.archive>/<milestone>/<phase dir name>`
   2. checks in advance that every pointer the map touches, in the work copies of asks.yaml,
      ledger.md, state.yaml and CLAUDE.md, would resolve after the move
   3. copies each phase dir from HEAD under the token's `new` dir at its archive path, lists
      the old dir in the token's `remove` file, rewrites the pointers, and marks the phases
      `status: archived`
   4. checks again against the end state, and undoes its own writes if the second check fails

   On the first check's failure it exits non-zero, writes nothing, and prints the unresolved
   pointers. Run `h-queue meta abort <token>` and stop.
3. Write one paragraph to ledger.md's work copy as `## L<next> (<date>) Milestone <name>
   closed`: what shipped, what was deliberately left, where the archive is. This is the one
   thing the operator reads; make it true and short. The script rewrites pointers in four
   files only, so rewrite by hand, in OPEN-ASKS.md's work copy, each pointer into a moved
   phase dir.
4. Clear `milestone` in state.yaml's work copy.
5. Commit: `~/.claude/holden/bin/h-queue meta commit <token> -m "docs: close milestone <name>"`.
   Act on these lines here instead of docs/reference.md § Shared files step 5:
   - `uncommitted change in <phase dir>` (73): the tree holds a file there that HEAD lacks or
     that differs from HEAD. Show it to the operator, who commits or discards it; then commit
     again.
   - `conflict in <path>`, `<phase dir> changed at HEAD since the token opened`, or `<file>
     names <phase dir>, which this commit removes` (73): HEAD changed under the close. Start
     again at step 1 in a new token, and let step 2 copy the phase dirs from HEAD again
     instead of moving the old `new` dir across. Redo steps 3 and 4, commit, then run
     `h-queue meta abort <old token>`.
6. Run `/h-learn review`: the agent with the most open lines in
   `~/.claude/holden/observations.md` gets at most ten prompt-edit proposals, one yes or no
   each. The other agents wait for their own session. Its commits land in the holden repo, not
   here. It runs after the close commit, so no proposal round sits beside an open token.
7. If `paused_milestones` is not empty, name them and say `/h-milestone resume <name>` picks
   one up.

End with one line naming the next session move and why, in this order: continue, clear, handoff, subagent, compact (see `~/.claude/holden/docs/phase-boundaries.md`).
