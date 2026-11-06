---
name: h-review
description: Review plans, a diff, or a design at the self or codex tier; bounded rounds, findings in one shape.
argument-hint: "plan <NNN> | diff <base>..<head> <NNN> | design <files...> [--tier self|codex] [--round N]"
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Grep
  - Glob
  - Agent
---

Review at the tier given. Without one, take the phase's `review.plan` or `review.diff` from
state.yaml by kind; design reviews use `review.plan`. Without that, take the config's
`review.plan_tier` or `review.diff_tier`. Entries written before 2026-09-05 carry one
`review_tier` for both kinds.

## Self tier

Spawn `holden-reviewer` with:
- `kind`: plan, diff, or design (a decision record checked against the code it cites, output
  `DESIGN-REVIEW-self-r<N>.md`)
- the files or diff range
- the DECISION.md path
- the phase directory for output
- the round number; from round 2, also the previous round's report and its
  `<NNN>-REVIEW-RESPONSE-r<N-1>.md`
- the repo's standing rules (CLAUDE.md, `.claude/rules/`)
- the model from the phase entry's `models.reviewer`, falling back to the config's
  `models.reviewer`, resolved per docs/reference.md § Models (`inherit` is the session model capped at
  Opus)

Read only the verdict line it returns; the report is in the phase directory.

For a diff, when the config's `review.diff_axes` is `two`, spawn two reviewers at once instead:
one with `axis: standards` and one with `axis: decision`, same inputs otherwise. The verdict is
REVISE when either says so. The report to the operator prints both verdict lines with their
axis, never a merged ranking.

A diff review gets the phase's plan-review adjudication (`<NNN>-REVIEW-ADJUDICATION.md`) as
context when it exists: codex through `--context`, self in the prompt. Name each item it marks
In scope, later, and each item an older adjudication deferred to the diff review. The report's
Coverage answers each one by name.

## Codex tier

Run `~/.claude/holden/bin/codex-review --kind <plan|diff|design> ...`. Its arguments by kind:
- `--kind plan`: the positional argument is the **phase**, not a file list (`codex-review
  --kind plan 041`). It resolves `.planning/phases/<N>-*` and needs no `--out-dir`. A file list
  there exits 1 with the usage text and writes no report.
- `--kind design`: `--files f1 f2`.
- `--kind diff`: `--diff base..head`.

`--round N` runs a second round. It needs a `<prefix>CODEX-RESPONSE-r1.md` written first, saying
what changed. The prefix carries the kind (`<NNN>-PLAN-`, `DIFF-` or `DESIGN-`), so the kinds sit
apart in one phase directory. The script refuses round 3; a third round needs the operator's
word and an explicit `CODEX_REVIEW_MAX_ROUNDS` override.

The script's exit code is the gate, not the report file:
- on exit 0 it publishes `<prefix>CODEX-REVIEW-r<N>.md`
- on any other exit it leaves an earlier round's file in place, untouched

Check the exit code. On a non-zero exit, stop and tell the operator the run failed. Do not read
the report file that is there as this round's result.

A codex run takes up to 25 minutes, so it goes through the detach harness. Never run it inline,
with a hand-rolled `nohup`, or with a trailing `&`.
1. `~/.claude/bin/detach <name> "<command>"`
2. In the SAME response, a background Bash task: `~/.claude/bin/detach-wait <name> 1800`.
3. On wake, read the output and act on the EXIT code.
4. Then `~/.claude/bin/detach-seen <name>`.

The harness culls background tasks under memory pressure, so the waiter can be killed. The run
itself is unaffected: re-arm the waiter and do not relaunch the review. Do not substitute a
Monitor; the stop hook checks for a live waiter by name. The same applies to any long run this
skill triggers; `/h-execute` states it for `h-test --full`.

## Watching a run

A consult or a review runs as a live Codex thread the operator can watch in Codex's own TUI.
Inside tmux (`$TMUX` set) it opens as a background window, stepped to with prefix n / prefix p.
Outside tmux it opens in the detached session `codex`, so the reply that launches the run says
`tmux attach -t codex`. The window closes when the round ends. Pressing Esc in it interrupts the
turn, which fails the round: no report, and the exit code says so. The run's output also has a
`watch:` line with the command to attach by hand.

## A thread Codex proposes

A report may end with `## Thread to follow`, a line Codex saw beyond the review. Handle the
findings first, then decide alone, without the operator. Follow it when it bears on this change:
write what to follow in a file, then launch through detach as above,
`~/.claude/holden/bin/codex-review --follow <report> --file <file>`. It resumes the report's
thread and writes `<report minus .md>-thread<K>.md` beside the report. It is not a round: the
report stays as published and the cap is unchanged. Sort what it finds like any finding. Not
following it is one line in your reply saying why. A quick's re-read proposes none.

## Codex availability

Run `~/.claude/holden/bin/codex-limits --check` before any Codex run. Run it too wherever
holden is about to recommend or raise the codex tier (`/h-grill` closing step 2, `/h-plan` step
4). It costs no model tokens. Its first word and exit code are the verdict:
- `ok` (0): go ahead. Tell the operator in one line that a Codex review is starting, and quote
  the figures. When the 5-hour or weekly window is at 80% or more, say so in that line.
- `exhausted` (3), `no-plan` (4) or `unreadable` (1): **stop and ask the operator**; never fall
  back silently. `codex-review` runs the same check and exits 5 without reviewing, so a skipped
  check still stops here.

A quick is the one exception: `/h-quick` falls back to Fable by itself and records the
check's line in the quick's state entry (`skills/h-quick/SKILL.md` steps 4, 6 and 9 in
`~/.claude/holden`). Phases keep this ask.

Ask the question in prose, with a recommendation:
- **exhausted**: which window is spent and when it resets, in the operator's local time. Choices:
  - wait for the reset: stop, and name the command to re-run after it
  - fall back to Claude for this review
  - use a reset credit, if the line lists one; the operator does that, never spend one yourself

  Recommend waiting when the reset is under an hour away and nothing is blocked on the review;
  otherwise the fallback.
- **no-plan**: the account may not use Codex, most likely a lapsed subscription. This reading is
  inferred from the account fields and has not been seen on a real lapse. Choices: renew (the
  operator does it and says so; then re-run the check and carry on), or fall back to Claude.
- **unreadable**: quote the reason (codex missing, not logged in, no answer). Choices: fix it
  and re-check, or fall back to Claude.

Falling back means the self tier for this review only. Set the phase's `review` entry for
this review's kind (`plan` or `diff`) to `self`, with the reason and the date ("codex
exhausted 2026-09-23, operator chose self"), in one transaction (docs/reference.md § Shared files in
`~/.claude/holden`):
`~/.claude/holden/bin/h-queue meta open .planning/state.yaml`, set it in the work copy and in
the DECISION.md, then
`~/.claude/holden/bin/h-queue meta commit <token> -m "docs(<NNN>): <kind> review self" --add <the DECISION.md>`.
Then run the self tier as written above. Waiting or renewing changes nothing on disk.

Every codex run also writes `codex limits before:` and `codex limits after:` lines to its log.
When you report the result, quote the `after` line.

## Findings and rounds

Both tiers write the same shape: verdict, findings by severity with where / defect / evidence /
fix, could-not-verify, coverage.

A design review keeps these steps after a REVISE, because its subject is the decisions and the
operator settles those:
1. List the blockers to the operator, one line each, with your proposed disposition.
2. Apply the accepted ones.
3. Write the response file, one line per fix: what changed, and the command that proves it, run
   on the base tree, with its result, or `unrun: <why>`.
4. Run one more round.
5. Adjudicate what remains yourself and write it to `<phase dir>/<NNN>-REVIEW-ADJUDICATION.md`:
   accepted, rejected with reason, or deferred with where.

A plan or diff review runs the findings step after every round that has any finding, whatever
the verdict. A PASS with WARNINGs or INFOs runs it too. The step:
1. Open the round's response file: codex `<prefix>CODEX-RESPONSE-r<N>.md`, self
   `<NNN>-REVIEW-RESPONSE-r<N>.md`. A finding with a line there is handled; skip it. A session
   that resumes after a crash starts here.
2. Before acting on a finding with no line, look for work a crashed session already did: a
   commit `git log --oneline -F --grep "<finding title>"` finds, or an ask whose history in
   `.planning/OPEN-ASKS.md` names the finding. Write the missing line instead of doing it twice.
3. Give each other finding, BLOCKER, WARNING and INFO alike, the first disposition below that
   fits. Severity is the reviewer's guess at impact; what binds the phase decides.
4. Act on it as its disposition says, and add its line to the response file as soon as it is
   handled.
5. Ask the operator about every Promise and every deploy blocker in one message, after the rest
   are handled. Give one line each, with what it binds or breaks and your recommendation.

The step is done when every finding of the round has its line.

The dispositions, in this order:
1. Rejected: the finding is wrong on the evidence; the code does not say what it claims.
2. Promise: the fix would change, drop or contradict something that binds the phase, or it
   needs a decision the record does not have. What binds the phase:
   - an entry of its DECISION.md's Decisions
   - a line of its Out of scope
   - a line of its What users lose
   - an entry of `.planning/ledger.md`, and any record an entry says binds
3. In scope, now: the fix makes the code do what the record already says, or fixes a defect in
   what this phase changed. In a plan review the fix is an edit to the plan.
4. In scope, later: in a plan review, an in-scope finding that only code can settle.
5. Deploy blocker outside the scope: the finding is about code or behaviour the phase did not
   set out to change, and it makes a deploy unsafe, as data loss, a broken write path or a
   security hole does.
6. Outside the scope: everything else.

The order is the rule: a finding that is in scope and touches what binds the phase is a Promise.
A fix that breaks a promise needs the operator's word; any other fix in scope does not. An INFO
whose fix is neither cheap nor in scope is Rejected as not worth a change, or becomes an ask.

Each line of the response file reads `<kind> r<N> [<SEVERITY>] <finding title>: <disposition>:
<what was done>`. The kind matters at the self tier, where plan and diff reviews share the
file's name. What was done, by disposition:
- Rejected: why the finding is wrong.
- Promise, and deploy blocker: what it binds or breaks, your recommendation, and `asked`. When
  the operator answers, act on the answer and add a second line with it.
- In scope, now, in a diff review: fix the code and prove it with `~/.claude/holden/bin/h-test
  --uncommitted`. Run `~/.claude/holden/bin/h-radius --check-ids <files>` first when the fix adds a
  comment, docstring or test name. With `concurrency: true` in `.holden/config.yaml`, the fix is an inline fix
  package owned by the phase under review, made and landed as `/h-execute` step 5's fix shape
  says (`skills/h-execute/SKILL.md` in `~/.claude/holden`). Otherwise commit it alone in the
  main checkout, under the landing lock:
  `~/.claude/holden/bin/h-queue lock -- 'git add <files> && git commit -m "fix(<NNN>): <kind> review r<N>: <finding title>"'`.
  When the fix changes a file a doc's verification list names, it is stamped as `/h-execute`
  step 5's fix shape says.
  The line
  gives the commit (for a package, the landing's `landed ... as <sha>` line) and the h-test
  verdict, or `unrun: <why>`.
- In scope, now, in a plan review: edit the plan. The line names the plan and the task.
- In scope, later: the check that will answer it: the diff review, an execution task, or a UAT
  row.
- Outside the scope: add an ask in a transaction (docs/reference.md § Shared files in `~/.claude/holden`):
  `~/.claude/holden/bin/h-queue meta open .planning/asks.yaml .planning/OPEN-ASKS.md`. Add the
  ask to asks.yaml's work copy in the shape of `templates/asks.yaml`, with its history in
  OPEN-ASKS.md's work copy naming the finding and the review file. Commit both; the commit
  checks that the id appears once:
  `~/.claude/holden/bin/h-queue meta commit <token> -m "docs(<NNN>): ask <id>" --ask-once <id>`.
  The line `ask <id> appears <n> times in asks.yaml` (73) means the id is taken: choose
  another id in both work copies and commit again. The response line gives the ask id.

Run one more round after a REVISE, or when a fix changed a decision. Start it only once the
findings step is done: `bin/codex-review` accepts any response file that exists.

Recommend a further round only when the last one produced a blocker or changed a decision;
otherwise say the review is closed.

After the last round, add the adjudication to `<phase dir>/<NNN>-REVIEW-ADJUDICATION.md` under a
heading `## Plan review` or `## Diff review`. Create the file when it is missing, and keep what
is there: the diff review and /h-learn read the plan review's part. List every finding of every
round with its disposition, by the six names above, and what was done.

A codex round 3 is the operator's call. Stop before adjudicating and ask when round 2 did any
of these:
- left a blocker open
- raised a new one
- made fixes that changed a decision or rewrote a write path

Yes runs round 3 (`CODEX_REVIEW_MAX_ROUNDS=3`, after `<prefix>CODEX-RESPONSE-r2.md`); no
adjudicates. The one exception is an operator who has said to run it through without stopping until
deploy. Then decide round 3 yourself by the same test, write the reason in the adjudication,
and go on.

End with one line naming the next session move and why, in this order: continue, clear, handoff, subagent, compact (see `~/.claude/holden/docs/phase-boundaries.md`).
