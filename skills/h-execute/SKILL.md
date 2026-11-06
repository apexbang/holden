---
name: h-execute
description: Execute a planned phase plan by plan with executors, ledgers and rulings; runs the full suite once after the last plan lands.
argument-hint: "<phase number> [--plan NN] [--no-review]"
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Grep
  - Glob
  - Agent
---

Execute a phase's plans.

1. Read `.holden/config.yaml` (the main checkout's; `concurrency` and `parallel_waves` come
   from there) and the phase entry in `.planning/state.yaml`. The phase must be `planned` or
   `executing`. Run `~/.claude/holden/bin/h-plans <phase dir>`; an `error:` line stops here,
   because the plans changed since /h-plan. Set `status: executing` in a metadata transaction
   (docs/reference.md § Shared files in `~/.claude/holden`):
   `~/.claude/holden/bin/h-queue meta open .planning/state.yaml`, set it in the work copy, then
   `~/.claude/holden/bin/h-queue meta commit <token> -m "docs(<NNN>): executing"`.
   When the entry has `landed:` set to a date and the phase directory holds a diff review
   report (step 6 names the files), go to step 6.
2. Spawning an executor. Its prompt carries:
   - the plan path
   - the DECISION.md path
   - the ledger path `<phase dir>/<NNN>-<NN>-LEDGER.md`, absolute, in the main checkout
   - the repo root
   - with `concurrency` true, `package: <NNN>-<NN>`, the id `h-queue admit` took. The executor
     asks `h-queue extend` with it (`agents/holden-executor.md`); without it, it asks nothing.
   - the model from the phase entry's `models.executor`, falling back to the config's
     `models.executor`, resolved per docs/reference.md § Models (`inherit` is the session model capped
     at Opus)

   Nothing from this session's history goes into the prompt. On each return, read only the
   ledger's `## Result` and `## Rulings I made` sections.

   A `blocked` return stops the phase: start no new plan, let the running ones return, report
   what the executor found, and wait for the operator. Do not fix a running executor's work in
   this session; re-spawn it with the answer. The fixes this session makes are step 5's and the
   review's in-scope fixes in step 6, after every plan has landed.
3. The plan gate runs after an executor returns done, before anything builds on its plan.
   Spawn `holden-reviewer` with `kind: plan-diff` and:
   - the plan's commit range
   - the plan file
   - the DECISION.md path
   - the ledger path
   - the phase directory
   - the model `sonnet`, unless the phase entry's `models.reviewer` says otherwise

   It reads the ledger as claims and the diff as the evidence, and writes
   `<NNN>-<NN>-GATE-r1.md`. When it returns, `test -s` that file. If it is missing, re-spawn the
   reviewer once, saying the report file is the gate; a second miss stops the phase.

   On REVISE, re-spawn the same executor on its plan (in its worktree, when it has one), with
   the report path as the one thing to address. It resumes from the ledger, fixes, and commits.
   Then one re-review, `-r2`. Rule on whatever remains, write the ruling in the ledger under
   `## Gate rulings`, and continue. Only a finding that needs a structural change (the
   executor's own stop rule) stops the phase.

   The gate sees one plan; the diff review in step 6 still sees the whole range. Nothing builds
   on a plan the ledger has not seen.
4. Run the plans. Below, `landed` is the plans done so far and `running` the ones in flight,
   each a comma list of plan numbers. A plan is in `running` from its executor's spawn until it
   has landed or been dropped, gate and land included: land re-runs tests, and `single_test_db`
   counts them. Take the first branch that matches:
   - `concurrency` true (whatever `parallel_waves` says): every plan is a package in its own
     worktree. Here a plan is in `running` from its first `admit` until it has landed or been
     dropped, parked and waiting included, so `--ready` never prints it twice. A plan has at
     most one background `h-queue wait` at a time, and no executor while that wait runs. Run
     `h-worktree sweep` and `h-worktree preflight` as the `parallel_waves` branch below says.
     Then loop:
     1. `h-plans <phase dir> --ready --landed <landed> --running <running> --serial <serial>`
        prints the plans that may start. For each, run `~/.claude/holden/bin/h-queue admit
        <NNN>-<NN> --kind plan --owner phase:<NNN> --plan <plan path> --ledger <ledger path>`.
        - 0: the last line is the worktree path. Spawn the executor in the background with it
          as the repo root.
        - 70: it is parked behind another owner's package, named in the output. Run
          `~/.claude/holden/bin/h-queue wait <NNN>-<NN>` as a background Bash task. By its
          exit code:
          - 0: its last line is the worktree path; spawn the executor then.
          - 74: it waited four hours. Print `h-queue status`, tell the operator which package
            holds what, and start no plan until they answer.
          - 1: stop and report its output.

          To narrow the parked plan (say, to drop a file the holder has), first stop its
          background `h-queue wait` task. Then edit the plan and run this sub-step's admit
          again with the same flags. With `--plan`, a parked package's admit reserves the
          plan's `files:` and `reads:` as they are now, and prints `narrowed <NNN>-<NN>:
          dropped <paths>` for what it no longer holds. Act on that admit's exit code as
          above, and spawn on its output alone: on 70 that is a fresh background wait. A
          wait left running would find the package admitted, print the same worktree and
          exit 0, and a second executor would start on it.
        - 1 or 75 (refused, or the landing lock stayed busy for 4 hours): stop and report its
          output.
     2. An executor returns `done`, `done with deviations`, `blocked`, `waiting` or `yielded`.
        - `waiting`: run `h-queue wait <NNN>-<NN>` as a background task. On 0, re-spawn the
          same executor on its worktree; it resumes from its ledger. On 74 or 1, as in sub-step
          1.
        - `yielded`: run `h-queue yield <NNN>-<NN> --reason "<the executor's Yielded line>"`,
          then `h-queue wait <NNN>-<NN>` as a background task. On 0, spawn a fresh executor on
          the printed worktree with a fresh ledger; it runs the plan from scratch on the new
          master. A `blocked` return saying the plan no longer holds there goes to the
          operator (D05). To narrow the yielded plan before it re-runs, do as sub-step 1's 70
          paragraph says: stop this background wait first.
        - `done`: `h-worktree range <NNN>-<NN>` is the gate's range; a refusal means it
          committed nothing, so treat it as blocked. Gate it (step 3), then run
          `~/.claude/holden/bin/h-queue land <NNN>-<NN> --ledger <ledger>`. It takes the
          repo's landing lock and merges the branch head by SHA in a throwaway worktree. It
          re-runs the ledger's proved tests and those of every package landed since this
          one's base, fast-forwards, and writes the landing receipt. By exit code:
          - 0: landed. Stamp it (below), then loop.
          - 3 (conflict) or 4 (red on the merged tree): run `h-queue drop <NNN>-<NN> --reason
            "<conflict on FILES | red on the merged tree: TESTS>"`, add the plan to `serial`,
            and loop. It re-runs alone from a fresh worktree and ledger once nothing else is
            in flight. `h-queue status` shows its `drops`; a plan dropped twice stops the
            phase.
          - 5 or 75: land again.
          - 6 or 1: stop and report its output; landing again cannot help.
          - 70: an undeclared path in its diff is held by a lower package. Run `h-queue wait
            <NNN>-<NN>` as a background task, then land again.
          - 71: as `yielded`.
          - 76: a declared read changed on master since the plan's base. Spawn
            `holden-reviewer` with `kind: reads`, the plan file, the DECISION.md, the ledger,
            the `range:` line the output printed, and the model step 3 names for the gate. Its
            ruling line decides:
            - `HOLDS`: run `h-queue land <NNN>-<NN> --ledger <ledger> --reads-hold "<its
              sentence>"`.
            - `YIELD`: as `yielded`.
            - `BLOCKED`: stop and report its sentence to the operator.
     3. When every plan has landed, run `h-worktree check <NNN>`. For each plan it lists as a
        branch or worktree, run `h-worktree remove <NNN>-<NN>`. A package it lists as `parked`
        or `waiting` is not finished: the phase stops there with `/h-queue`'s line for it.

   - `concurrency` false and `parallel_waves` false: take the first line of
     `~/.claude/holden/bin/h-plans <phase dir> --ready --landed <landed>`. Run its executor in
     the main checkout, gate it, stamp it (below), and repeat until the command prints
     nothing. The range the gate sees is the executor's `Commits:`.
   - `concurrency` false and `parallel_waves` true: first run
     `~/.claude/holden/bin/h-worktree sweep`, which clears leftovers of other phases; report
     what it lists as not removable. Then run `h-worktree preflight`. A failed preflight stops
     the phase with its output: the repo cannot run a fresh worktree yet. The operator either
     fixes that or sets `parallel_waves: false`. Then loop:
     1. `h-plans <phase dir> --ready --landed <landed> --running <running> --serial <serial>`
        prints the plans that may start now. For each, run `h-worktree add <NNN>-<NN>`; its
        last line is the worktree path. A line `resumed` before it means a worktree from an
        earlier session, and the executor resumes from its ledger. Spawn the executor in the
        background with that path as the repo root. Start every printed plan before waiting.
     2. When an executor returns done, `h-worktree range <NNN>-<NN>` is the gate's range. A
        refusal means it committed nothing; treat it as blocked. Gate it (step 3), then run
        `h-worktree land <NNN>-<NN> --ledger <ledger>`. It merges in a throwaway worktree,
        re-runs the ledger's proved tests on the merged tree, and only then fast-forwards the
        main branch. A failure leaves the main checkout as it was. By exit code:
        - 0: landed. Stamp it (below), then loop. An exit 0 that prints `worktree ... kept`
          or `branch kept` has landed; the leftover is sub-step 3's to clear.
        - 3 (conflict) or 4 (red on the merged tree): run `h-worktree drop <NNN>-<NN> --ledger
          <ledger> --reason "<conflict on FILES | red on the merged tree: TESTS>"`, add the
          plan to `serial`, and loop. It re-runs alone from a fresh worktree and ledger once
          nothing else is in flight. A plan dropped twice stops the phase.
        - 5 or 75 (the main branch moved, or a lock stayed busy): land again.
        - 6 (the fast-forward was refused: the main checkout holds uncommitted changes to
          files the plan changes) or 1: stop and report its output; landing again cannot help.
     3. When every plan has landed, run `h-worktree check <NNN>`. For each plan it lists, run
        `h-worktree remove <NNN>-<NN>`. Report what that refuses (uncommitted work, an unmerged
        branch), and the phase stops there: a phase with a holden branch or worktree left has
        not landed.

   Stamping a landed package. Run it before anything else lands, so each doc's stamp
   follows landing order. `<id>` is the package's id: `<NNN>-<NN>`, a
   quick's id, or a fix's `<NNN>-fix<K>`.
   1. Run `~/.claude/holden/bin/h-queue stamps --ledger <ledger>`. `stamps: none` means
      there is nothing to stamp: stop here. Otherwise each `missed:` or `pending:` line
      names a doc, a task and that task's entry. An `unreadable:` line goes to the
      operator, and the stamping waits for their answer.
   2. The base is the `<base7>` of the ledger's first `Task N: complete (commits
      <base7>..<head7>)` line whose two shas differ. With no such line, step 3 re-checks
      every doc.
   3. Note HEAD as `<checked>`. For each doc, run `git log --no-merges --format='%h %s'
      <base>..HEAD -- <doc>`:
      - a commit with the subject `docs(<id>): stamps`: an earlier session stamped the doc
        and stopped before step 7. Append step 7's line with that commit's sha, and leave
        the doc out of steps 4 to 6.
      - a commit outside every `<base7>..<head7>` range of the ledger
        (`git rev-list <base7>..<head7>` lists one range): another package stamped or
        edited the doc since this package's base. Re-check the stamped sections this
        package's entries cover against HEAD, and correct an entry that no longer holds.
      - otherwise the entries stand as recorded.
   4. Run `~/.claude/holden/bin/h-queue meta open --stamps <doc>...` with every doc left.
   5. In each work copy, write the doc's stamp from its entries, in the order step 1
      listed them, as the repo's docs rule says. That rule is the CLAUDE.md or
      `.claude/rules/` file that names the stamp keys. Change only the stamp lines. A repo
      with entries and no such rule: run `h-queue meta abort <token>` and ask the operator.
   6. Run `~/.claude/holden/bin/h-queue meta commit <token> -m "docs(<id>): stamps"
      --checked <checked>`. Under the landing lock it refuses (73, `changed since
      <checked>`) when a commit since `<checked>` touched one of the docs: run `h-queue
      meta abort <token>` and start again at step 3. Act on any other line as docs/reference.md §
      Shared files in `~/.claude/holden` says.
   7. For each doc stamped, append `stamped: <doc> <sha7>` to the ledger, `<sha7>` from the
      `committed <sha7>` line. Run step 1 again: it prints `stamps: none`.

   Never run `git merge`, `git worktree` or `git branch -d/-D` yourself in this skill. Every
   branch and worktree change goes through `h-worktree` (which `h-queue` calls), and it refuses
   rather than forces.
5. After the last plan has landed, run the full suite under the freeze, detached:
   `~/.claude/bin/detach <repo>-<NNN>-full "~/.claude/holden/bin/h-queue freeze --label 'full
   suite <NNN>' -- ~/.claude/holden/bin/h-test --full --ledger <phase dir>/<NNN>-FULL-SUITE.log"`.
   Then run `~/.claude/bin/detach-wait <repo>-<NNN>-full 3600` as a background Bash task.
   `detach` stays outside `freeze`, so the process holding the landing lock encloses the suite.
   No landing and no metadata commit happens while it runs.

   Each write to the phase entry in this step is its own transaction, committed at once:
   `h-queue meta open .planning/state.yaml`, write the work copy, then
   `h-queue meta commit <token> -m "docs(<NNN>): full suite <pass | fail | local>"`. An edit
   left in the tree would block every session's metadata commit until step 7.
   - On pass, the log's last `h-test:` line carries `stamp.sha`. Write `full_suite: pass`,
     `tested: <that sha>` and `landed: <date>` on the phase entry, in a transaction (above).
   - On a line `the tree changed during the run`, nothing was stamped: run this step again.
   - On fail, write `full_suite: fail` in a transaction (above). This session makes a fix
     with one obvious shape (a stale pin, a renamed import) in a file `h-queue status` shows
     no other owner holding.
     With `concurrency` true it is an inline fix package owned by this phase:
     1. `~/.claude/holden/bin/h-queue admit <NNN>-fix<K> --kind fix --owner phase:<NNN>
        --writes <files> --ledger <phase dir>/<NNN>-fix<K>-LEDGER.md`, K counting from 1. Exit
        70 means another owner holds a file: `h-queue wait`, or ask the operator.
     2. Edit in the worktree it prints. Run `~/.claude/holden/bin/h-radius --check-ids <files>`
        in the worktree and fix each `IDS` line. Prove with `cd <worktree> &&
        ~/.claude/holden/bin/h-test --uncommitted --ledger <ledger>`. When the fix changes a
        file a doc's verification list names, check the doc now, before the commit, as
        `agents/holden-executor.md` step 4 in `~/.claude/holden` says. A sentence that no
        longer holds is an edit in this fix: `h-queue extend <NNN>-fix<K> <doc>` first, then
        edit it.
     3. Commit there: `git -C <worktree> add <files> && git -C <worktree> commit -m
        "fix(<NNN>): <what>"`.
     4. When step 2 checked a doc, append to the fix ledger `stamp: <doc> task 1: <entry>`.
        Then append `Task 1: complete (commits <base7>..<head7>)` and `## Result`, before
        the land, so a session that dies after the land leaves a `missed:` line, never a
        `pending:` one.
     5. Land with `h-queue land <NNN>-fix<K> --ledger <ledger>`, acting on the codes of
        step 4. On 0, stamp it as step 4's stamping says.

     Record it under the owning plan's `## Gate rulings`, then run this step again. With
     `concurrency` false, make the fix in the main checkout and, after
     `~/.claude/holden/bin/h-radius --check-ids <files>` exits 0, prove it with h-test. When the
     fix changes a file a doc's verification list names, check the doc before the commit, as
     sub-step 2 says. Commit it under the landing lock:
     `~/.claude/holden/bin/h-queue lock -- 'git add <files> && git commit -m "fix(<NNN>): <what>"'`.
     When that check ran, write the fix ledger `<phase dir>/<NNN>-fix<K>-LEDGER.md` as
     sub-step 4 says, and stamp it as step 4's stamping says. Record it the same way.
   - A failure that needs a choice is reported with its failing command, and the phase stays
     `executing`.

   Do not start the diff review while the suite runs. Poll and kill by pid file, or by a
   pattern your own polling command cannot contain. `pgrep -f` or `pkill -f` on a name that
   appears in your own command line matches the poll itself and kills your own shell.

   In a cloud session (`CLAUDE_CODE_REMOTE` is set), skip this run. Write `full_suite: local`
   in a transaction (above), and say in the report that the full suite runs locally before
   the deploy.
   `.holden/test-stamp` is gitignored, so a cloud stamp never reaches the deploy gate.
6. Unless `--no-review` is given or the phase's `review.diff` is `none`, run `/h-review diff
   <base>..<head> <NNN>` over the phase's commit range at that tier.
   - The review's in-scope fixes are part of the phase. This session makes them, as step 5's
     inline fix packages when `concurrency` is true, and they land before `status: landed`.
     A fix that changes a file a doc's verification list names is stamped as step 5's fixes
     are, with either switch.
   - A diff review report in the phase directory means an earlier session died in this step.
     The reports are `DIFF-CODEX-REVIEW-r*.md`, and `<NNN>-REVIEW-self*-r*.md` whose first line
     is `# Self review (diff), round <N>`. Resume its last round from the response file instead
     of starting round 1 again.
   - The phase is landed only when no finding waits on the operator. Until then it stays
     `executing`, and step 7 waits.
7. Run `~/.claude/holden/bin/h-queue stamps`. A `missed:` line naming a ledger of this phase
   is stamped first, by step 4's stamping with that ledger. A `pending:` or `unreadable:` line
   naming a ledger of this phase goes to the operator, and step 7 waits for the answer: every
   plan has landed, so nothing of this phase is still running. Then set `status: landed` and, under the entry's `review:` map, `diff_done:`:
   `<YYYY-MM-DD> <verdict>`, today's date and the first word of the verdict line of step
   6's last round (`PASS`, `REVISE`), or `waived` when step 6 did not run (`--no-review`,
   or a `diff: none` tier). `/h-status` and `bin/h-scratch-pass` read the field once the
   report files may be gone. Commit both with the phase directory: ledgers (dropped ones
   and fix ledgers too), reads rulings and gate reports.
   `~/.claude/holden/bin/h-queue meta open .planning/state.yaml`, set both in the work copy, then
   `~/.claude/holden/bin/h-queue meta commit <token> -m "docs(<NNN>): landed" --add <phase dir>`.
   When a decision of the DECISION.md says an ask goes to `shipped-awaiting-check` when
   the phase lands, open `.planning/asks.yaml .planning/OPEN-ASKS.md` in the same
   `meta open`, set that ask's `status: shipped-awaiting-check` in the work copy, and add
   under its OPEN-ASKS.md entry a paragraph `Shipped <date> as phase <NNN>`, what landed
   and what check it awaits.
8. Run `/h-learn <NNN>`. It reads the phase's review findings, deviations and rulings, and
   appends one line per gap to `~/.claude/holden/observations.md`, against the agent that let
   it through. Include its lines in the report.
9. Report in under fifteen lines:
   - commits per plan
   - any plan dropped at land, and why
   - the full-suite result
   - the review verdict
   - the complete list of rulings from every ledger, in order

   The rulings list is the one thing the operator reads; do not summarise it.

End with one line naming the next session move and why, in this order: continue, clear, handoff, subagent, compact (see `~/.claude/holden/docs/phase-boundaries.md`).
