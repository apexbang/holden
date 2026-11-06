---
name: h-plan
description: Research and plan a grilled phase; runs the researcher then the planner, then the review tier the grill chose.
argument-hint: "<phase number> [--skip-research] [--no-review]"
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Grep
  - Glob
  - Agent
---

Turn a phase's DECISION.md into plan files.

1. Read `.holden/config.yaml` and the phase entry in `.planning/state.yaml`. The phase must
   be `grilled` (or `planned`, to re-plan). Read its DECISION.md.
2. Unless `--skip-research`, spawn `holden-researcher` with:
   - the DECISION.md path
   - the FACTS.md path beside it, when present
   - the phase directory
   - the model from the phase entry's `models.researcher`, falling back to the config's
     `models.researcher`, resolved per docs/reference.md § Models (`inherit` is the session model capped
     at Opus)

   Wait for the three-line return.
3. Spawn `holden-planner` with:
   - the DECISION.md path
   - the RESEARCH.md path
   - the config path
   - the template path `~/.claude/holden/templates/PLAN.md`
   - `models.planner`, resolved the same way (phase entry, then config)

   Wait for the return.
4. Read each plan once. Run `~/.claude/holden/bin/h-plans <phase dir>` and paste its output
   into the report.
   - Any `error:` line (a consumes with no depends_on on its producer, an unknown plan, a
     cycle) sends the planner back with that line.
   - For each `note:` that two plans share a file with no dependency, read both plans' Change
     lines for that file. If one uses what the other adds or changes, it is a missed
     dependency, and it goes back to the planner.

   Fix small things yourself; send the planner back for anything else with the specific defect.

   Then count the plans that share a file. When more than two plans touch one file, raise the
   phase's `review.plan` to `codex` before the review runs, and say so in the report. Raise it
   in one transaction (docs/reference.md § Shared files in `~/.claude/holden`):
   `~/.claude/holden/bin/h-queue meta open .planning/state.yaml`, set it in the work copy and
   in the DECISION.md, then
   `~/.claude/holden/bin/h-queue meta commit <token> -m "docs(<NNN>): plan review codex" --add <the DECISION.md>`.
   Codex is reserved for a migration, a contract, or this; the grill cannot see plan count, so
   the raise happens here.

   Before raising, and before step 5 runs a codex-tier review, run the Codex availability check
   (`/h-review` § Codex availability). On anything but `ok`, stop and ask as that section says.
   Do not raise, and do not start the review, until the operator has chosen.
5. Unless `--no-review` is given or the phase's `review.plan` is `none`, run `/h-review plan
   <NNN>` at that tier. On REVISE, fix the plans: edit them directly, or re-run the planner
   with the findings. Before round 2, grep every plan for each sentence a fix replaced,
   objective and out-of-scope lines included, and change every restatement. Then run round 2
   once. A codex round 3 follows `/h-review`'s round-3 rule.

   After the last round's edits, run `~/.claude/holden/bin/h-plans <phase dir>` again. An
   `error:` line is fixed in the plan, or sent back to the planner, before step 6 sets the
   phase `planned`.
6. Set the phase's `status: planned` and commit it with the phase directory, in one
   transaction: `~/.claude/holden/bin/h-queue meta open .planning/state.yaml`, set it in the
   work copy, then
   `~/.claude/holden/bin/h-queue meta commit <token> -m "docs(<NNN>): plans" --add <phase dir>`.
7. Report in under ten lines:
   - plan count and the `h-plans` layout
   - decisions covered versus total, from the planner's return
   - the review verdict
   - anything the research flagged as a contradiction

End with one line naming the next session move and why, in this order: continue, clear, handoff, subagent, compact (see `~/.claude/holden/docs/phase-boundaries.md`).
