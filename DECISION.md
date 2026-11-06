# holden — decision record

Settled 2026-09-05 in one grill session between the operator and Claude (Fable 5.1). One line
per decision, with its reason. Nothing here is a plan.

## Why

- D01 GSD is replaced, not updated. It was abandoned upstream (May 2026); the npm
  package is unmaintained. The updater and its session hook were disabled the same day.
- D02 The process must scale with the risk of the work, not with the phase. GSD ran research,
  plan-check, verify, Nyquist, security and UI agents on every phase. Review is now a tier chosen per phase.
- D03 Git and the code are the source of truth. `.planning` artefacts are dated records of their
  own time, never current state; nothing in a phase directory is rewritten after the fact.
- D04 Skills and rules are written in plain imperative sentences without emphasis. Current
  Anthropic guidance says newer models over-trigger on "CRITICAL / MUST / ALWAYS" and follow
  instructions more literally, so shouting causes the wandering it was meant to prevent.

## Install

- D05 Global install shared by all repos on the machine, as one git clone
  with symlinks into `~/.claude/skills`, `~/.claude/agents` and hook paths in `settings.json`.
  Reason: many repos use it; one copy, one history, one link script for a new machine.
- D06 Each repo carries `.holden/config.yaml` only: parallel waves on/off, model per agent,
  paths that default to Codex review, test commands, deploy command.
- D07 Collisions are handled per component, because Claude Code resolves them differently:
  a personal (global) skill overrides a project skill of the same name, a project agent overrides
  a personal agent, and hooks from every source all run. Conversion inventories skills, agents
  and hooks separately and records an explicit keep / rename / remove for each collision. The
  precedence is confirmed empirically during the link step, not taken from docs or memory.

## Hooks

- D08 Keep three: the context monitor (warns the agent when context is low), the injection
  scanner on Read (advisory), and the statusline. Drop the prompt guard and the five hooks that
  were opt-in behind flags never set (session-state, phase-boundary, validate-commit,
  workflow-guard, read-guard).
- D09 The statusline gets compacted: context percentage first, then the rest degrades as the
  terminal narrows. It reads `state.yaml` and counts `asks.yaml`.

## Agents

- D10 Four agents: researcher, planner, executor, reviewer. The verifier folds into the
  executor's closing rulings list; plan-checker, Nyquist, security, UI researcher and UI checker
  are gone.
- D11 Model per agent is config: executor defaults to Sonnet, the others to the session model.
  The grill can raise a phase's executor model when the work is judgment-heavy.
- D12 Review is a tier: none, self (a fresh Claude reviewer reading the plan or diff cold), or
  Codex. The grill asks it as its final question and persists it as `review_tier` in the phase's
  `state.yaml` entry and in the `DECISION.md` header, in the same write. `/h-plan` and
  `/h-execute` read it from there. Config lists paths whose default tier is Codex.
  Amended 2026-09-05: two tiers per phase, `review.plan` and `review.diff`, because the plan
  review is where Codex found the blockers and a Codex diff read of a plan-exact, proof-backed diff is
  mostly cost. `codex_paths` raises the plan tier alone; the diff tier defaults to self and the
  grill recommends codex for it when the diff touches a migration or a contract. The grill also
  lists the four agent models with the config default and recommends a per-phase override
  when the work warrants one; the overrides live in the entry's `models:` map.

## Commands (prefix `/h-`, prefix subject to Codex veto)

- D13 `/h-grill` interviews one question at a time, each with a recommended answer; facts are
  looked up, never asked. It classifies the ask (quick task / phase), creates the phase directory
  and state entry when it is a phase. Its closing order is fixed: ask which decisions get
  promoted to the repo ledger, ask the review tier, then write `DECISION.md`, the ledger
  promotions and the state entry once, together. Re-run on an existing phase reads its
  `DECISION.md` first. UI branch: look up existing conventions, ask whether they apply as-is or
  change; if change, ask whether Claude decides or the operator names a pattern.
- D14 `/h-plan` runs researcher then planner from `DECISION.md`. Plan format is slim: a few XML
  section tags, and per task the exact files, the concrete change, a verification command with
  expected output; a per-plan do-not list. No threat model, must-have truths or key links.
- D15 `/h-execute` runs the executor per plan with a progress ledger that survives compaction and
  a closing "rulings I made" list (what was decided on the operator's behalf, why, and what it
  costs if wrong). Diff review at the persisted tier. After the last plan of a phase lands it
  runs `h-test --full` once, records pass/fail on the phase's state entry, and writes the test
  stamp only on pass (this is the "after a phase lands" half of D26).
- D16 Parallel waves are a per-repo setting. When on: plans in one wave declare disjoint files,
  executors never run tree-wide git commands (only `git add` of own paths and `git commit`), and
  only one plan per wave may run the test suite where the repo has a single test database.
- D17 `/h-test` proves a change without `git stash` (stash is repository-global across
  worktrees and would remove the new test along with the change, making "red" vacuous). Proof
  of a commit C with parent P: create a temporary worktree at P, apply only C's test-file hunks,
  run the named tests and require red; then run them at C and require green; record both refs,
  commands and exit codes in the executor ledger; remove the worktree. Uncommitted changes are
  proved the same way against a temporary commit. `--refactor` accepts green at P and green at
  C for behaviour-preserving changes and records the exemption. `--full` runs the repo's full
  suite and on pass writes `.holden/test-stamp` holding the HEAD sha, a hash of the dirty tree
  (empty when clean), and the time.
- D18 `/h-review` runs the self or Codex tier on a plan or a diff. `bin/codex-review` has `--out-dir`, `--diff base..head`,
  its read-only sandbox and its two-round cap unchanged.
- D19 `/h-quick` keeps GSD quick's user-facing behaviour (run / list / status / resume of a small
  tracked task with an atomic commit) but is ported to holden's planner and executor and to
  `state.yaml`; it never calls a deleted agent or reads STATE.md. `/h-handoff` replaces pause and
  resume (see D32). `/h-status` prints the statusline content, open asks, any pending handoff,
  and a recommended boundary move (see D33). `/h-milestone new|pause|resume|close` (see D25, D36).
- D20 Undo of a phase creation is a git revert; redo is `/h-grill` on the phase.

## State

- D21 `state.yaml`: milestone, current phase, and one entry per phase (number, slug, status,
  dates, deploy id, one-line goal). Replaces STATE.md and ROADMAP.md.
- D22 `ledger.md`: durable decisions that constrain future phases, one entry each with reason,
  evidence pointer and date. Promoted from phase `DECISION.md` files by the grill's last question.
- D23 `asks.yaml`: open asks, one entry each: id, status, one sentence, pointer. History lives in
  the pointed-to document, never in the ask or in CLAUDE.md.
- D24 CLAUDE.md holds principles and pointers only, target under 1,500 words. The memory index is
  trimmed the same way.
- D25 Milestone = named group of phases in `state.yaml`. Close moves its phase directories to the
  archive, computes the old-to-new path map, rewrites every pointer in `asks.yaml`, `ledger.md`,
  `state.yaml` and CLAUDE.md that the map touches, in the same commit, and aborts the whole move
  unless every pointer in those files resolves afterwards. It writes one paragraph to
  `ledger.md`. No audit agent, no PROJECT.md rewrite.

## Tests and deploy (one repo's specifics, expressed as config where possible)

- D26 The full suite is a gate, never a loop: at deploy and after a phase lands.
- D27 The repo's linters join the deploy gate ahead of the suites, pinned and declared. Blocking is the default. `--lint-advisory` exists for exactly one deploy: it consumes
  a marker (`.holden/lint-bootstrap`, with the tool versions it covers) and is
  rejected once the marker is gone, so the existing warning backlog can be seen once without
  being fixed first and never silenced again.
- D28 deploy.sh checks that a deploy is safe now before running tests. A stamp is consumed only
  when all of these hold, each checked by the script (today it only warns about unpushed
  commits, and `--confirmed` bypasses even that): the working tree is clean; local HEAD equals
  the freshly fetched `origin/master`; and the stamp's code-tree hash (the tracked tree with
  `tests.stamp_ignore` paths removed: planning, docs, markdown) equals HEAD's, so a docs-only
  commit after the suite ran does not invalidate it (found in Stage 1 verification: the
  `landed` state commit always followed the stamp). Deploy then sends
  that exact sha to the remote and, after the remote update, reads back the remote HEAD and
  aborts unless it matches. Any other state runs the suites, and a mismatch after the remote
  update is a failed deploy, not a warning.

## Conversion

- D29 Existing phase directories are untouched. Conversion generates `state.yaml`, `ledger.md`
  and `asks.yaml`; STATE.md and ROADMAP.md move to the archive with a frozen-as-of header.
- D30 One repo converts first, the doc is written from that, the operator converts the others
  one by one.
- D31 This design and plan get a Codex review before anything is built. Exception recorded:
  `bin/codex-review` was written before round 1 because the review could not
  run without it; it is a pre-review prototype and T1 audits it against D18 rather than
  trusting it.

- D34 The Codex round cap is two by script, and the operator may authorise more. Claude
  recommends a further round only when the previous one produced a BLOCKER or changed a
  decision; a round that returns nothing above INFO ends the review, and Claude says so rather
  than offering another. Each extra round is run by explicit `CODEX_REVIEW_MAX_ROUNDS` override
  and recorded in the review directory, so the count is always visible. Reason: the cap makes
  stopping mechanical against a reviewer that is adversarial by design, while still letting
  bedrock work (this design, locks, deploys) buy the extra scrutiny it earns.

## Session boundaries (added after Codex round 1, from Pocock's handoff and ask-matt)

- D32 `/h-handoff` writes a handoff for the next session: what the next session is for, what was
  decided, what is in flight, and which holden commands to run next. It references specs, plans,
  commits and diffs by path instead of repeating them, and redacts secrets. It saves to
  `.holden/handoff.md` (not the OS temp dir, since our handoffs travel to the next session in the
  same repo); `/h-status` reports a pending handoff by time.
- D33 Every holden command ends with one line recommending the boundary move, in this order:
  continue (next step needs this session as a primary source, or there is room), clear (nothing
  here matters next), handoff (work travels to another harness, directory or person), subagent
  (task can run unattended), compact (last resort, with an instruction naming what the summary
  must keep). The reference text lives in `docs/phase-boundaries.md`. No router skill is
  installed; `/h-status` is the router.

- D35 (2026-09-06) The agents learn from the phases they ran. `/h-learn <NNN>` reads a landed
  phase's review findings, executor deviations and rulings and writes one line per gap to
  `observations.md` in this repo, attributed to the agent whose prompt let it through, with a
  sentence that would have prevented it. `/h-execute` calls it after landing; `/h-milestone
  close` calls `/h-learn review`, which turns lines that recur across phases into prompt edits,
  one yes per edit. The file is one and global because the threshold is recurrence, and a
  per-repo file makes every gap look like it fired once. Reason: one phase left a Codex blocker
  (research had not traced an endpoint's rejection paths) and an executor deviation (a
  verify count predicted, not measured) on disk, both fixed in the plan, neither in the prompt
  that produced it. Considered and rejected: rebelytics' task-observer, an always-on
  observation skill; it watches the whole session and contradicts D02 and D04, where holden's
  agents already write the evidence into named sections that a read at a known point can use.

- D36 (2026-09-25) A milestone can be paused. One stays open (`milestone`); `/h-milestone pause
  <reason>` moves it to `paused_milestones` with its goal and opened date, writes a ledger
  paragraph saying why, and leaves its phases and their `milestone:` field untouched;
  `/h-milestone resume <name>` puts it back. `new` refuses while a milestone is open and refuses
  a name already used, since close archives by name. A paused milestone takes no new phases.
  Reason: a repo had a milestone open when other work turned urgent; the only way to open it was overwriting the milestone slot by hand,
  which loses the open milestone's goal and date and leaves nothing that says it is waiting.
  This is milestone pause, unrelated to the session pause that `/h-handoff` replaced (D19).
- D37 (2026-09-26) Plans run by dependency, not by file, each in its own worktree; this replaces
  D16's disjoint-files wave. A plan declares `depends_on` from what it builds on (a signature,
  table, setting key or route another plan adds or changes), with `produces`/`consumes` that
  `bin/h-plans` checks against it; plans sharing a file with no dependency may run at once, and
  a plan changing a dependency manifest runs alone. With `parallel_waves` on, h-execute starts
  every plan whose dependencies have landed (up to `worktrees.max`, one test-running plan at a
  time under `single_test_db`), each executor in `holden/<NNN>-<NN>` under
  `~/.cache/holden/wt/`. After its gate, `h-worktree land` merges in a throwaway worktree
  (merge commits, so ledger hashes stay true), re-runs the ledger's proved tests on the merged
  tree, and only then fast-forwards the main branch. A conflict or a red merge drops the branch
  (head hash in the ledger) and the plan re-runs alone on the merged tree; no agent resolves a
  conflict by hand. Only `h-worktree` creates, merges or deletes branches and worktrees, nothing
  is forced, and a hook in the executor's frontmatter refuses branch, worktree, merge, stash,
  reset, clean and `.git` writes. A phase with a holden branch or worktree left has not landed.
  Reason: one phase ran seven plans in seven waves because each shared a file, and GSD's
  executors left stashes, stale branches, a file in `.git` and a `lost-found` recovery behind.
  Sources: Pocock `in-progress/implement-spec` (frontier scheduling, merge on completion);
  Superpowers (Consumes/Produces pre-flight scan, the range guard, merge-verify-remove order;
  it runs no implementers in parallel). With `parallel_waves` off nothing changes but the
  order, which now comes from `depends_on` (or from `wave` in plan sets written before D37).

Holden runs on itself: new decisions go through /h-grill into
`.planning/phases/<NNN>-<slug>/`, and durable ones into `.planning/ledger.md`.
