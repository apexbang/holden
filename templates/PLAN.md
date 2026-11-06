---
phase: 1
plan: 1
depends_on: []           # plans this one builds on; it starts only after they have landed. [] = none
files:                   # every file this plan may touch; plans may share a file when neither builds on the other, but not a test file or a docs/ file
  - path/to/file.py
  - tests/test_file.py
reads:                   # files this plan's change depends on but does not write (a signature it calls, a fixture it parses); at landing a change to one since the base is reviewed
  - path/to/dependency.py
stamps:                  # docs whose verification list names a file this plan changes; the owning task checks the doc and the orchestrator writes its stamp after landing; [] when none; a doc listed only here is not in files
  - docs/doc.md
produces:                # what a later plan of this phase uses: `path:function`, table.column, setting key, route
  - path/to/file.py:new_function
consumes: []             # what this plan uses that another plan of this phase produces; each needs depends_on on it
runs_tests: true         # with tests.single_test_db, only one plan that runs tests is in flight at a time
---
# Phase 1 Plan 1: short name

<objective>
One paragraph: what this plan makes true, argued from DECISION.md (cite D-ids).
</objective>

<do_not>
- Boundaries that matter for this plan, one line each. Copied from the repo's standing rules
  where relevant (for example: do not run the bare test suite; do not touch prod).
- Never hardcode one tenant's value; a per-tenant fact is a column or a setting, or it follows
  the repo's existing convention. (Always present.)
</do_not>

<tasks>
### Task 1: name
- Files: `path/to/file.py`, `tests/test_file.py`, `stamp: docs/doc.md`
- Pins: `git grep -n -e <each symbol, literal value, route or signature the task changes> --
  <test patterns>` at the base commit, pasted. Each hit is in Files as changing, or a guard
  with its because: an old value, a whole-answer compare, a stub or monkeypatch of a changed
  signature, a direct call to an endpoint that gains a refusal.
- Change: the concrete change, specific enough that there is one way to do it. Name the
  function, the field, the value. If a pattern is copied, quote the lines copied, including
  their cleanup, and say which parts change.
- Members: each guarantee (at most, never, always, only) or set (any, every, each state) the
  decision or this Change states. For each:
  - the sentence, quoted
  - the grep that lists its members, pasted
  - one line per member, with the line that enforces it and the test that fails without it

  Also:
  - a set the decision names by its owner (this worker's jobs) is selected by the owner's
    key, not by an attribute the owner shares with others (an address)
  - a line a user reads that says every or all is checked against each state the decision
    names
  `n/a: <why>` when the task states neither; `h-plans` refuses a task without the line.
- Edges: every way this change can be bypassed or fail, one sub-bullet each, as `<input> ->
  <outcome>; code: <path:function that makes the outcome true>; test: <test name>; red if: <the
  one-line mutation that turns that test red, named, not run>; fails: <the assertion that goes
  red, and the test input that reaches the mutated line>`, or `<input> -> <outcome>;
  untested: <why>`. Cover:
  - the function's early returns
  - a rejection from each call it makes; for git or another child process:
    - a non-zero exit, which a gate that reads it refuses on
    - each exit code a launched tool returns, and what it leaves behind (a folder, a claimed
      name)
    - a failure after it publishes: the caller reads HEAD before it reports what was committed
    - an empty path list, a HEAD with no commit, output read raw
    - in a read-only diagnostic: the failure printed as a line, and the command finishes
  - a missing, wrong-type or partial input, each with a refusal test:
    - the emptiest real inputs: a blank file, whitespace only, a directory
    - a missing key told apart from a falsy one (`== null`, never `||`)
    - characters a check accepts that the next call refuses (`isdigit` and `int`)
    - a bad input and a blank one that parse to the same value
    - each value a helper returns, None included, inside the text that wraps it
    - for a file edited by hand, the type of every key
  - each clause of a filter or a loader's check: its own Edge, so removing it goes red
  - a lookup that trusts an earlier row: the oldest row it accepts
  - a second concurrent caller
  - another path into the same work, local ones included
  - every other site in the file the same rule governs
  - anything this feature writes to a key it reads
  - a stop between two transactions of one write: what a retry on the same key finds and
    answers
  - a delete of a row whose existence the change reads
  - state that outlives one mount, request or session, through each way it restarts:
    - a second mount, in each starting state
    - a document reload, with the state empty at the first call after it
    - a logout or a tenant switch, for the state's contents as well as its timers
    - a setting read at start that changes while the state is live
  - every place the request can be answered (shared hooks in the gate's check order, error
    handlers), with the new check placed in that order
  - every recovery path over what this change writes:
    - the deploy's rollback and restore, working from a copy or record taken before the
      change, never inferring "new" from a missing backup
    - queued work across a switch back
    - an undo, finding what it wrote by the written value
    - a backfill or repair: an input that is late, missing, older than its window or
      failing transiently, with time-stamped state read as of each event
    - any window between a land and the migration it needs
  `none: <why>` only for a pure rename or move.
- Reaches: the production `path:function` that will execute what this task adds (a new
  function's caller, the write path that must call a validator, the state-machine field a
  manual action advances), or `n/a: <the existing call path this task edits>`.
- Verify: `pytest tests/test_file.py -q` -> expected: N passed, and the new test fails when
  the change is reverted (h-test proves this).
- Catches: per test the Verify names:
  - the one-line wrong implementation it fails on
  - the seed row or fixture input that drives it through the changed line, with values read
    from the fixture file at the base commit (its seeds and unique constraints)
  - for a seed near a threshold, the computed value beside the threshold
  - where it decides the result, the run it observes (SSR or hydrated, the session timezone,
    a tenant with or without a time zone)
  - one of:
    - proof: red at the base commit because `<path:line>` there makes <the assertion> fail
    - guard: green there because `<path:line>` already does <x>, red only if the change
      over-fires
  A test that passes with the change wrong is not a proof. These pass that way:
  - a match on source text
  - a result the code also gives when a setting is ignored
  - a delivery through any channel but the one the objective names; one test per named
    channel delivers through it alone
  - a render test whose fixture never makes the piece under test render
  - a call that skips the production entry point (the render job, the mounted component)
  - one assertion over a value computed in two places, or by two detectors; each computation
    gets its own, and a union of detectors gets a case only ours catches
  - a rule enforced in two languages and tested on one side; tabulate both rule sets and test
    each row on both sides
  - an input the named wrong implementation refuses too
  - a test of a later check whose input fails an earlier check first
  - a guard whose fixture is built from the value under change
  - a test named for two outcomes that asserts one; each outcome gets its own assertion
  - a layout, scroll or history value jsdom gives the same on both sides
  "n/a" for a task with no test.
- Measured: for any verify that asserts a count or an output, one of:
  - `$ <the Verify's command, byte for byte>` run at the base commit as it stands, and what it
    printed (strip what differs between runs, a nonce or a timestamp)
  - `about N` and the command, for a value that depends on this phase's code; the executor
    measures it
  A setting the result relies on: the output with it and without it, both pasted. "n/a" when
  the verify is a test run.
- Commit: `feat(1-1): short subject`

### Task 2: name
...
</tasks>

<done_when>
- The observable condition that closes the plan, one line per condition.
</done_when>
