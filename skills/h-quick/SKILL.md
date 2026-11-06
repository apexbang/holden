---
name: h-quick
description: One goal stated by a red test, the smallest change that turns it green, a cold read before the change and a Codex diff review after it, made inline by the main session; list, status and resume.
argument-hint: "<task description> | list | status <slug> | resume <slug>"
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Grep
  - Glob
  - Agent
---

A quick lives in `<paths.quick>/<id>/` and in the `quick` list of `.planning/state.yaml`. It is
one goal, stated by a red test, and the smallest change that turns it green. One cold read
comes before the change and one diff review after it. The main session writes the test and the
change itself. A quick writes no DECISION.md and no PLAN.md, and spawns no planner. Its record
is the commit body (§ The commit body) and the state entry. Its directory holds only scratch:
the ledger, the review reports, a saved patch.

Anything that needs a decision goes through /h-grill. Step 0 is the check.

Names used below:
- `<id>`: the quick's id, `<YYMMDD>-<slug>`, which is its directory's name
- `<dir>`: `<paths.quick>/<id>` in the main checkout
- the switch: `concurrency` in `.holden/config.yaml`. With it on, the quick is a package and
  works in its own worktree; with it off, there is no package.
- `<root>`: where the work happens: the package's worktree with the switch on, the main
  checkout with it off
- `<scratch>`: `<root>/.holden/quick/<id>/`, gitignored. It holds the goal file, commit
  messages and patches, which no commit carries. `mkdir -p` it, and the main checkout's
  `.holden/quick/<id>/` with the switch on, before the first write to either.
- `<files>`: every file the quick's red tests and change touch; `<goal files>` is one goal's
  share of them
- `<repo>`: the main checkout's directory name, in detach names

`<files>` never holds a shared file (docs/reference.md § Shared files in `~/.claude/holden`). A shared
file changes only through a metadata transaction.

## list, status, resume

`list`: print the `quick` entries from state.yaml: id, date, status, slug. Stop.

`status <slug>`: print the entry. For each sha in its `commits:`, print
`git show --stat --format='%h %s%n%n%b' <sha>`. When `<dir>/LEDGER.md` exists, print its
last lines. Stop.

`resume <slug>`: find the entry.
- With the switch on, run `~/.claude/holden/bin/h-queue resume <id>`. It records the head and
  a patch of uncommitted work, moves the ledger to `<dir>/LEDGER-dropped-r<n>.md`, and admits
  the package again on a fresh worktree, printed last. The `recorded: head <sha7>, patch
  <path>` line names the patch. In the new worktree:
  1. When `<main checkout>/.holden/quick/<id>/goal.md` exists (step 4), `mkdir -p
     <worktree>/.holden/quick/<id>` and copy it there.
  2. When the recorded head is not `none`, replay every commit of the dropped branch, goal
     commits and step 7's fix and `docs(<id>): review` commits alike: for each sha of `git
     rev-list --reverse <head7> --not HEAD`, run in the main checkout, in order, run `git -C
     <worktree> cherry-pick --allow-empty <sha>`. When the sha is the `<c7>` of a dropped
     ledger's `Task <N>: complete (commits <p7>..<c7>)` line, prove it again with `cd
     <worktree> && ~/.claude/holden/bin/h-test HEAD --ledger <dir>/LEDGER.md`, unless the goal
     has a no-test claim, and append its `Task <N>: complete` line with the new range.
  3. When the patch is not `none`, run `git -C <worktree> apply <patch>`. It holds the red
     tests and changes not yet committed.
  4. When a cherry-pick stops on a conflict, run `git -C <worktree> cherry-pick --abort`. When
     step 2 or 3 fails, stop and tell the operator which commit or patch did not apply.
- With the switch off there is no package. When `<dir>/<id>.patch` exists (§ Stop), run
  `git apply <dir>/<id>.patch` in the main checkout. Otherwise the quick's files are in the
  checkout as the last session left them.
- An old-shape quick, whose directory holds a PLAN.md, resumes the same way. Read its PLAN.md
  as notes on what was to be built.

Then read the ledger's last lines for where the quick stopped, and go on at that step.

## A quick

Steps 0 to 10 run in order. In a batch (step 0), steps 3 to 5 run once per goal, goal 1
first, and step 6 starts after the last goal's step 5.

0. Triage: is this a quick? Grep the topic's words (the function, the table, the dial, the
   surface) through:
   - `.planning/ledger.md`
   - `.planning/asks.yaml`
   - every `*DECISION.md` and every GSD-era `*-CONTEXT.md` under `<paths.phases>`,
     `<paths.quick>` and `<paths.archive>`, at any depth:
     `grep -rilE '<words>' --include='*DECISION.md' --include='*-CONTEXT.md' <each of the three that exists>`

   Read what comes back. Two rules decide, no judgment:
   - FIRST, before the other: is this a change to the CODEBASE at all? Some requests are
     finished by editing a tenant's uploaded file, a row of their data, or a document, where no
     code that runs for anyone else would change. Such a request is neither a quick nor a grill.
     Do the thing, hand over the artefact, and stop: open no directory, write no state entry,
     spawn nothing. The test is "would this still be needed if the tenant uploaded a different
     file?" If no, there is nothing to plan. A repo whose standing rules push toward building
     the general capability makes this the easy failure to miss, so it is checked first and
     explicitly.
   - A quick that would amend a phase decision which already carries an `Amended` paragraph
     is not a quick. Stop and say so: the decision was under-grilled. The move is `/h-grill`
     on that one decision (a short grill, the phase's own record), not a third amendment. The
     operator can overrule in the same turn; the overrule goes in the commit body.

   Print what the grep found in three lines at most: which records, and what they settled.

   Then hold the request to the size limit. A quick:
   - has one goal
   - shows that goal's behaviour from one entry point: one route, one screen or component,
     or one worker cycle. Adapters and storage that only carry the change follow along.
   - changes at most one contract, and only by adding to it
   - adds at most one migration: a forward file and its rollback
   - changes no other repo's code; an ask to that repo is fine

   There is no file count. Name the entry point in one line of your reply; it goes in the
   goal file and the commit body. A request over the limit is not a quick: name the limit it
   crosses, and the move is `/h-grill`. The operator can overrule in the same turn; the
   overrule goes in the commit body.

   Ask the operator each product call you can name now: a choice about what the product
   should do that the code and the facts cannot settle. Ask before any test is written. The
   answer goes in the commit body. An answer that should hold beyond this quick also goes in
   `.planning/ledger.md`, through a metadata transaction.

   For each goal, write down one of:
   - its red test: the file, and the assertion that goes red. A goal whose change has
     behaviour a test can state (logic, data, state, a branch, a computed value) has one.
   - `no useful test: <why>; checked by: <how>`. This fits only when the one assertion would
     restate the change: prose, styling, layout, a colour, a label. `<how>` is a screenshot
     through `/run`, a look, or a grep.

   A batch is several goals in one quick. It needs all of these:
   - each goal would pass the size limit alone
   - each goal has its own red test or no-test claim, and its own commit
   - no commit depends on another; two goals that touch one function are one goal, or two
     quicks

   Number the goals 1 to K. Goal N's commit is ledger task N.
1. Make the slug from the description: lowercase, hyphens, at most 40 characters. The quick's
   id is `<YYMMDD>-<slug>`, the directory's name. That one value is the entry's `id:`, the
   `--next-quick` value below, and the package id in step 2; `h-queue meta commit` keys a quick
   by its directory's name. A repo whose older entries carry numbered ids keeps them; a new
   entry still takes `<YYMMDD>-<slug>`. Open a metadata transaction (docs/reference.md § Shared files in
   `~/.claude/holden`): `~/.claude/holden/bin/h-queue meta open .planning/state.yaml`. Then:
   - create the directory under the printed `new` dir, at `<paths.quick>/<id>`. It stays
     empty: a quick writes no record file.
   - add the entry to state.yaml's work copy: `{id, slug, status: planned, date, dir, goal}`.
     `goal:` is the goal in one double-quoted line; a batch joins its goals with `; `.
   - commit both; the commit also checks under the landing lock that the id is new:
     `~/.claude/holden/bin/h-queue meta commit <token> -m "docs(quick): <slug> opened" --next-quick <id>`

   Opening several quicks in one turn: commit each quick's transaction before you open the
   next quick's. Two tokens opened from one HEAD both edit state.yaml's `quick` list, and the
   second commit refuses with `conflict in .planning/state.yaml: open again and redo the edit`
   (73).

   The line `quick <id> already exists at HEAD` (73) means another session took the id today.
   Run `h-queue meta abort <token>`, choose another slug, and start step 1 again. A line ending
   `pass --next-quick <name>` (73) means the entry's `id:` is not its directory's name: run
   `h-queue meta abort <token>` and start step 1 again with the id above.
2. With the switch on, admit the package: `~/.claude/holden/bin/h-queue admit <id> --kind
   quick --owner quick:<id> --writes <files> --ledger <dir>/LEDGER.md`. Add `--reads <paths>`
   for files the change calls into or copies a pattern from and does not write. By exit code:
   - 0: the last line is the worktree, `<root>` from here on. The line `importer roots: ...`
     before it lists the top-level directories whose code imports a file of `--writes`. Hold
     it against the entry point you named. A root that reaches the change other than through
     a shared module is a second entry point. A second entry point stops the quick (§ Stop),
     unless the operator overrules in this turn; the overrule goes in the commit body. The
     line is a hint: a shared module reaches every root, and a dynamic import reaches none.
     The diff review is the check.
   - 70: the same line comes before `parked`. Run `h-queue wait <id>` as a background Bash
     task; it prints the worktree when the package is admitted. On 74, tell the operator what
     holds the file (`/h-queue`) and stop.
   - 1 naming a shared file: drop it from `--writes`, make that edit in step 9's transaction,
     and admit again.

   A file found later goes through `~/.claude/holden/bin/h-queue extend <id> <path>` before
   its first edit. On 0 it is yours. On 70, run `h-queue wait <id>` as a background Bash task
   and go on when it prints `granted`. On 71, a phase needs the file: run `h-queue yield <id>
   --reason "<its line>"`, then `h-queue wait <id>` in the background, and restore the work in
   the worktree it prints as `resume` does.

   With the switch off there is no admit, and `<root>` is the main checkout.
3. Write the goal's red test in `<root>`. Run it once through
   `~/.claude/holden/bin/h-machine run -- <the tests.targeted command for it>`, and see it
   fail on its assertion. A failure on an import or a missing name is not red yet: fix the
   test. A red test that cannot be written without a product call asks it now, as step 0
   does. A goal with a no-test claim writes no test.
4. Before the goal's change, get one cold read. Append the goal to `<main
   checkout>/.holden/quick/<id>/goal.md` in this shape:

   ```
   ## Goal <N>: <one sentence>
   Entry point: <the route, the screen or component, or the worker cycle>
   Red test: <path>: <the assertion that goes red> | no useful test: <why>; checked by: <how>
   Safe because: <why the smallest change cannot break another reader>
   Product calls: <question> -> <answer>, one per line, or none
   ```

   With the switch off that file is `<scratch>goal.md`. With it on, copy it to
   `<scratch>goal.md` after each append. The main checkout's file is the one that counts: it
   is gitignored, so no commit carries it, and a drop that removes the worktree and its
   `<scratch>` leaves it for `resume` to copy back.

   Write the question file `<scratch>read-<N>.md`: the prompt below, then the goal's section
   of `goal.md`, then each red test file whole. Run `~/.claude/holden/bin/codex-limits --check`.
   - `ok` (exit 0): run `~/.claude/bin/detach <repo>-<id>-read<N> "cd <root> &&
     ~/.claude/holden/bin/codex-ask --file <scratch>read-<N>.md"`. In the SAME response, run
     `~/.claude/bin/detach-wait <repo>-<id>-read<N> 1800` as a background Bash task. On wake,
     act on the `EXIT` line, then run `~/.claude/bin/detach-seen <repo>-<id>-read<N>`:
     - `EXIT 0`: read the answer file the `answer:` line names. A `## Questions back` or
       `## Thread to follow` at its end is yours to settle, as `/h-ask` step 5 says.
     - `EXIT 5`: Codex is unavailable; fall back as below.
     - any other: quote the output's last lines and stop.
   - any other verdict: spawn one general-purpose subagent with model `fable`, the question
     file's text as its whole prompt. Keep the check's line as the fallback reason. When
     Fable cannot run either, stop and ask the operator.

   The prompt:

   ```
   Read this quick cold, before its change is made. Reply with one line, PASS or REVISE, then
   at most five lines, one per point, each with the path:line or the command it rests on.
   Write no file.

   REVISE when any of these holds:
   - the red test can pass without the change the goal needs, or fails for a reason other
     than the goal
   - a claim under "Safe because" is false in the code, or leaves a window open: a step that
     can die between a before and an after it names
   - the goal's behaviour shows from more than the one entry point named
   - a "no useful test" claim hides behaviour a test could state: a condition, a computed
     value, a change of state
   - the goal turns on a product call the operator was not asked
   ```

   On REVISE, answer each point before the change: fix the test or the goal, or write in the
   commit body why not. There is no second cold read.
5. Make the smallest change that turns the goal's red test green. The operator may say to
   hand the change to a background `holden-executor`. Only then spawn one, once for the whole
   quick, with:
   - the goal file `<scratch>goal.md` and each red test's path
   - the ledger `<dir>/LEDGER.md` and the repo root `<root>`
   - `package: <id>` with the switch on
   - the model from `models.executor`, resolved per docs/reference.md § Models in `~/.claude/holden`

   It runs this step for each goal and returns; go on at step 6. Otherwise, for goal N:
   1. First run `~/.claude/holden/bin/h-radius --check-ids <goal files>` from `<root>`; on
      exit 1, fix each `IDS` line (the reason in words, `ledger.md Lnnn` when one binds) and
      run it again. Then take a snapshot from `<root>`: `~/.claude/holden/bin/h-snapshot <goal files>`. With the
      switch off, from goal 2 on, add `--base <goal N-1's snapshot>`, since nothing is
      committed yet. It prints `<base>..<snapshot>`, the goal's change as a range. When it
      prints `nothing changed`, the goal's files hold no change: make the change, or drop the
      goal.
   2. Prove it: `cd <root> && ~/.claude/holden/bin/h-test <snapshot> --ledger <dir>/LEDGER.md`.
      It runs the test hunks red at `<base>` and the snapshot green. A goal with a no-test
      claim skips this; check it as its claim says.
   3. When the change touches a file a doc's verification list names, check the doc now, as
      `/h-execute` step 5's fix shape says (sub-step 2, `skills/h-execute/SKILL.md` in
      `~/.claude/holden`). Append `stamp: <doc> task <N>: <entry>` to the ledger.
   4. With the switch on, write `<scratch>goal-<N>.msg` in § The commit body's shape and
      commit: `git -C <root> add <goal files> && git -C <root> commit -q -F
      <scratch>goal-<N>.msg`. Append `Task <N>: complete (commits <base7>..<head7>)` to the
      ledger.
      With the switch off, commit nothing yet. Save the patch, `git diff --binary
      <base>..<snapshot> > <scratch>goal-<N>.patch`, write `<scratch>goal-<N>.msg`, and append
      `Snapshot: goal <N> <base7>..<snapshot7>` to the ledger.
6. Review the whole quick once. The range:
   - with the switch on: `<base>..<head>`, `<base>` from the admit line and `<head>` from
     `git -C <root> rev-parse HEAD`
   - with it off: goal 1's `<base>` to goal K's snapshot

   When `<dir>/QUICK-CODEX-REVIEW-r1.md` or `<dir>/REVIEW-self-r1.md` already exists (a resumed
   quick), read it and go on at step 7; `codex-review` refuses a second first review.

   Run `~/.claude/holden/bin/codex-limits --check`.
   - `ok` (exit 0): run `~/.claude/bin/detach <repo>-<id>-review "cd <root> &&
     ~/.claude/holden/bin/codex-review --kind quick --diff <range> --context
     .holden/quick/<id>/goal.md --out-dir <main checkout>/<dir>"`. Arm the waiter, wake, read
     the exit code and run `detach-seen` as `/h-review` § Codex tier says
     (`skills/h-review/SKILL.md` in `~/.claude/holden`). On exit 0 the report is
     `<dir>/QUICK-CODEX-REVIEW-r1.md`; a `## Thread to follow` in it goes as `/h-review`
     § A thread Codex proposes says. On exit 5, fall back as below. On any other exit, stop
     and tell the operator the run failed.
   - any other verdict: spawn `holden-reviewer` yourself, with `kind: quick`, the range, the
     goal file, `<dir>` for output, the repo's standing rules (CLAUDE.md, `.claude/rules/`),
     and model `fable`. The report is `<dir>/REVIEW-self-r1.md`. Keep the check's line as the
     fallback reason. When Fable cannot run either, stop before step 8 and ask the operator.
7. Read the verdict and each finding. A finding with neither a command and its output nor a
   traced path counts as "Could not verify", whatever its severity. Give each finding one
   disposition, and write it in § The commit body's `Review:` lines:
   - fixed in scope
   - rejected, with the reason
   - asked of the operator, who rules. A finding outside the quick's scope may become an
     ask, through a metadata transaction.

   Make a fix as step 5 makes a change, sub-step 1's `--check-ids` run included. With the switch on it is its own commit in the
   worktree. With it off it is `h-snapshot --base <the last snapshot> <fixed files>`, saved
   as the next `goal-<N>.patch` and `.msg`. When a fix changes behaviour, its hunks get one
   re-read:
   - by Codex, when step 6 ran Codex: `codex-review --kind quick --reread --diff <the fixes'
     range> --context .holden/quick/<id>/goal.md --out-dir <main checkout>/<dir>`, through
     detach as step 6 runs it, named `<repo>-<id>-reread`. The range is `<head before the
     fixes>..<head after>`, or with the switch off the fix snapshot's printed range. The
     command quotes the first report's text in the prompt, so Codex reads it without opening
     `<dir>`.
   - by Fable, when step 6 fell back: `holden-reviewer` as step 6 spawns it, plus
     `reread: <dir>/REVIEW-self-r1.md`.

   In a batch, the fix's message names the goal it fixes, so the re-read reads the fix
   against that goal. There is no third read without the operator. An open BLOCKER after the
   fixes blocks step 8 until it is fixed, its goal is dropped, or the operator rules.

   To drop goal N from a batch:
   - with the switch on: `git -C <root> rebase --onto <goal N's commit>^ <goal N's commit>
     holden/<id>`. On a conflict, run `git -C <root> rebase --abort` and ask the operator.
     Remove goal N's `Task <N>: complete` line and its `h-test:` lines from the ledger. Rewrite
     each later goal's `Task` line with its new range, from `git -C <root> log --reverse
     --format=%h <base>..HEAD`.
   - with the switch off: `git apply -R <scratch>goal-<N>.patch` in the main checkout reverts
     its change. When that fails, ask the operator. Delete its patch and message, and remove
     its `Snapshot:` and `h-test:` lines from the ledger.

   The land or the lock commit then runs only the goals that stay.
8. Land or commit, only with no open BLOCKER.
   - With the switch on: append `## Result` to the ledger, then run
     `~/.claude/holden/bin/h-queue land <id> --ledger <dir>/LEDGER.md`. Act on its exit code
     as `/h-execute` step 4 does (`skills/h-execute/SKILL.md` in `~/.claude/holden`). A quick
     has no gate; 76 goes to the same reads ruling. On 0, stamp it (below). On `waiting` or
     `yielded`, act as that step does.
   - With the switch off: commit each goal and each fix in order, one under the landing lock
     each: `~/.claude/holden/bin/h-queue lock -- '~/.claude/holden/bin/h-snapshot commit
     <scratch>goal-<N>.patch -F <scratch>goal-<N>.msg'`. It commits exactly that patch on
     HEAD, built on a scratch index. Every other staged entry and the working tree stay as
     they are. By exit code:
     - 0: it prints `<p>..<c>`. Append `Task <N>: complete (commits <p7>..<c7>)` and go on
       with the next patch.
     - 1 with `the patch does not apply at HEAD`: HEAD, the index and the working tree are as
       they were. Commit nothing more, for this goal or any later one. The commits this step
       made before it stay. Run `git log --oneline <the step 6 range's base>..HEAD -- <goal
       files>`. Tell the operator that HEAD moved under the reviewed patch, and name each
       commit it lists that this step did not make. When it lists only this step's own, say
       that the patch's context held a dropped goal's lines. A new snapshot of goal N would need a fresh
       `h-test` proof and a new read, and step 7 allows no further read without the operator:
       the operator rules. Stop here, before `## Result`.
     - 3: the commit landed, and the main index kept its old entries for the goal's files. Run
       the `git reset -q HEAD -- <paths>` line it prints. Append the `Task <N>` line from its
       `committed <p7>..<c7>`, and go on with the next patch.
     - any other exit, or 1 with another line: commit nothing more, quote its output to the
       operator and stop. A shared file in the patch is refused here (1, `refusing: the patch
       changes shared files`).

     After the last patch, append `## Result` and stamp it (below).

   Stamping: run `~/.claude/holden/bin/h-queue stamps --ledger <dir>/LEDGER.md`. `stamps:
   none` ends the stamping. Any other line: follow `/h-execute` step 4's stamping from its
   sub-step 2, with `<id>` the quick's id.
9. After step 8's stamping, so the committed ledger holds its `stamped:` lines, open a
   transaction: `~/.claude/holden/bin/h-queue meta open .planning/state.yaml`, adding
   `.planning/asks.yaml .planning/OPEN-ASKS.md` when this step changes an ask, and
   `.planning/ledger.md` for a lasting product call. In the work copies:
   - set the entry's `status:` to `complete`, or `blocked` and report why
   - add `commits:`, the quick's goal, fix and review commits in order. With the switch on,
     paste the `commits:` line `h-queue land` printed. With it off, write the `<c7>` of each
     `Task <N>: complete` line as a full sha, each double-quoted: `commits: ["<sha>",
     "<sha>"]`. An unquoted all-digit sha reads as a number. The open and close transactions'
     commits and the land merge are not in it.
   - add `cold_read:` and `review:`, each the reader and the verdict in one double-quoted
     line, with the fallback reason when Fable read: `"codex PASS"`, or
     `"fable REVISE (codex: <the check's line>)"`. `review:` adds the re-read's verdict when
     one ran.
   - add `findings:`, a block list with one double-quoted line per finding:
     `"[<severity>] <title> -> <disposition>"`
   - for a quick made from an /h-audit fix brief, update its ask when complete. A high's own
     ask (`audit-<slice>-<n>`) goes to `shipped-awaiting-check`. A grouped ask
     (`audit-<slice>-medium`, `audit-<folder>-low`) drops the fixed title and count, and goes
     to `shipped-awaiting-check` once none is left.

   Commit the directory with them:
   `~/.claude/holden/bin/h-queue meta commit <token> -m "docs(quick): <slug>" --add <dir>`.
   The review reports stay in `<dir>` as scratch.
10. Report in under ten lines: what triage found, who gave the cold read and the diff review
    and their verdicts, the commits, the h-test verdicts, the rulings.

## A fix the operator asks for

A fix the operator asks for while this quick runs (`just fix it`) is an inline fix owned by
the quick: `h-queue admit <id>-fix<K> --kind fix --owner quick:<id> --writes <files>
--ledger <dir>/fix<K>-LEDGER.md`. The edit, proof, commit, `h-queue land` and stamping follow
`/h-execute` step 5's fix shape (`skills/h-execute/SKILL.md` in `~/.claude/holden`). Run
`~/.claude/holden/bin/h-radius --check-ids <files>` before the commit. With
the switch off, edit in the main checkout and commit under the landing lock:
`~/.claude/holden/bin/h-queue lock -- 'git add <files> && git commit -m "fix(quick): <what>"'`.
Its stamping follows the same fix shape, with the ledger `<dir>/fix<K>-LEDGER.md`.

## Stop

A quick that outgrows the size limit midway stops, unless the operator overrules in the same
turn; the overrule goes in the commit body.
- With the switch on: run `~/.claude/holden/bin/h-queue yield <id> --reason "outgrew the
  quick size limit: <which limit>"`. It records the head and saves uncommitted work as a patch
  beside the ledger. Then run `~/.claude/holden/bin/h-queue retire <id> --reason "<the same>"`;
  it keeps the patch and the ledgers.
- With the switch off: run `~/.claude/holden/bin/h-snapshot <files>` from the main checkout.
  On exit 0, save `git diff --binary <its range> > <dir>/<id>.patch`; on `nothing changed`
  there is no patch. Then restore each tracked file of `<files>` with `git checkout HEAD --
  <file>`, and delete each file the quick added. The main checkout then holds no unreviewed
  change, and `resume` applies the patch onto the files as they were.

Then set the entry's status to `blocked` with the reason, in a transaction as step 9 opens it,
committed with `--add <dir>`. Hand `/h-grill` these as facts: each red test, the observed file
list, the patch, and the recorded head.

## The commit body

Each goal's commit and each fix commit:

```
<feat|fix>(<id>): <what changed, in a few words>

Goal: <one sentence>
Entry point: <the one named at triage>
Red test: <path> | No useful test: <why>; checked by: <how>
Change: <the smallest change, in one or two sentences>
Safe because: <why it cannot break another reader>
Cold read: <codex | fable (<fallback reason>)> <PASS | REVISE>; <the answer to each REVISE point>
Product calls: <question> -> <answer>
Overrule: <what the operator overruled, quoted>
Review: [<severity>] <title> -> fixed | rejected: <reason> | asked: <ruling>
```

`Product calls:`, `Overrule:` and `Review:` take one line each per item, and a line with
nothing to say is left out. With the switch on, the goal commits come before the review. The
`Review:` lines then go in the fix commit's body, or with no fix, in an empty commit:
`git -C <root> commit --allow-empty -q -F <msg>`, subject `docs(<id>): review`. A review
with no findings has no `Review:` lines and writes no commit; its verdict is the state entry's
`review:` line. With the switch off, each goal's message gets its own findings' lines before
step 8, and a finding of the whole batch goes in the last goal's message.

End with one line naming the next session move and why, in this order: continue, clear, handoff, subagent, compact (see `~/.claude/holden/docs/phase-boundaries.md`).
