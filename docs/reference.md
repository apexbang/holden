# holden reference

How holden works in detail. The agents read this file, so it stays exact and complete. Start with the [README](../README.md) if you're new.

## Install

Clone this repo anywhere and run `bin/link`. The install is global. `bin/link` links
`~/.claude/holden` to the clone, symlinks the skills, agents and detach helpers (`detach`,
`detach-wait`, `detach-seen`, into `~/.claude/bin`), and wires the hooks into
`~/.claude/settings.json`. Every prompt refers to a holden file as `~/.claude/holden/...`, so it
doesn't matter where the clone sits. If you move it, run `bin/link` again. A cloud session runs
the same `bin/link`.

Each repo carries only `.holden/config.yaml`. A repo script that calls a holden tool defaults to
`$HOME/.claude/holden/bin`.

## Requirements

You need Linux (WSL works) with Node 22 or later, git, bash, python3, `flock`, `setsid` and
`setpriv`. Codex and tmux are optional. `bin/link` moves any GSD install aside, so read it first
if you have one.

## Releasing

Run holden from one clone and edit it in another, so a change reaches your other repos only when
you release it. `bin/link` in the installed clone sets up `~/.claude/holden`. From the clone you edit:

```
bin/h-test --full
bin/h-release --dry-run
bin/h-release
```

`bin/h-release` copies `agents`, `bin`, `docs`, `hooks`, `lib`, `skills`, `templates`, `tests`,
`DECISION.md`, `LICENSE` and `README.md` into the installed copy and commits them there. It leaves
`.planning/`, `.holden/`, `docs/CONTEXT.md`, `.gitignore` and everything else that copy records. Each
file is renamed into place, so a running script keeps the old file. It refuses a dirty clone, code
with no passing full suite, a running Codex round and an uncommitted change to a file it would
touch. If skills, agents or hooks were added or removed, run `bin/link` in the installed copy, then
restart open sessions.

## Models

You choose an agent's model in one place, `models:` in `.holden/config.yaml`. There is one key
per agent (`researcher`, `planner`, `executor`, `reviewer`, `tracer`, `auditor_map`, `auditor`,
`verifier`), and the value is `haiku`, `sonnet`, `opus`, `fable` or `inherit`. The skill that
spawns an agent reads the key and passes the resolved value to the Agent tool's `model` on every
spawn.

`inherit` means the session's own model, capped at Opus. A Sonnet or Opus session passes its own
model, and a Fable or Mythos session passes `opus`. An agent only runs on Fable in three cases:
`fable` is written in the config, the operator names it for that run (in the phase entry's
`models:` map or in the prompt), or a quick falls back to it. When `codex-limits --check` is not
`ok`, `/h-quick` runs its cold read and its diff review on Fable by itself, and records the
check's line in the quick's state entry (`skills/h-quick/SKILL.md` steps 4, 6 and 9). The
`model:` line in `agents/*.md` is the fallback for an agent spawned by hand outside a skill, and
it never says `inherit`.

A phase entry's `models:` map holds only the keys the grill raised or lowered for that phase. A
missing key means the config value.

Each phase has two review tiers, `review.plan` and `review.diff` (none, self, codex). They
default from the config's `review.plan_tier` and `review.diff_tier`, and `review.codex_paths`
raises the plan tier alone. Entries written before 2026-09-05 carry the older `review_tier` (one
tier for both stages) and `executor_model`, and should be read that way.

## Tests in a proof worktree

`bin/h-test` proves a commit in a temporary worktree at its parent, so the worktree starts with
nothing the checkout built: no `node_modules`, no virtualenv. `tests.worktree_setup` lists
commands to run there first, and in every executor worktree. `$REPO` is set to the main checkout
(`ln -s $REPO/client/node_modules client/node_modules`).

If a targeted rule's runner is rooted in a subdirectory, use `{files_rel:<prefix>}` instead of
`{files}`. It strips the prefix from each path, so `npm --prefix client test -- {files_rel:client/}`
gets paths the client's test runner can resolve.

A proof also runs the tests that read a changed file by name as text. Any test file holding the
file's basename as a quoted path (`'App.svelte'`, `"integration-points.md"`) runs at the commit,
and if one is red there but green at the parent, the proof fails. The record lists these as
`readers`.

Some proofs don't fit the red/green run, such as a parent plus only some test cases, or a change
that is itself a test file. For those, use `h-test --scratch <ref> [--patch FILE] --ledger FILE --
<command>`. It runs the command in a throwaway worktree at `<ref>` (setup, then the patch),
records the exit code in the ledger and removes the worktree. Executors can't make worktrees
(the guard refuses `git worktree` except `list`), so this is their only way to run code at
another commit.

A proof worktree lacks a few things, which matters when you write a plan's Verify:
- Gitignored files (a `data/` directory, an `.env`). Name them in a command by the main
  checkout's absolute path.
- A dev server that accepts the symlinked `node_modules`. Some resolve it to its real path and
  refuse it (Vite's serving allow list). Prove a spec such a server serves, red and green, in the
  main checkout. The repo's `.holden/config.yaml` says which specs those are.
- The full output of `--scratch`. The ledger keeps only its last 12 lines, so if a record needs
  all of it, tee the command into a file.

## Any language

holden works in any language. A repo in Python, JS/TS, Go, Rust or C needs config only, never a
change to holden.

`tests.targeted` and `tests.full` name the runners. `tests.deps` names a check per dependency
manifest (`go.mod`, `Cargo.toml`, `package.json`, `requirements*.txt`), and `h-test --deps` runs
it from the manifest's own directory. h-test knows the count lines, the failing test names and
the "failed on a missing name or a failed build" messages of those five languages. A repo on
anything else adds regexes under `tests.summary`, `tests.failed` and `tests.missing_name`.

h-radius reads the comment markers of the common languages and takes reference extensions from
the repo's own files. It finds importers through Python imports, quoted paths (JS, C includes),
Rust `mod` and `use`, and a directory import (Go packages, JS index files). A tool that needs to
know a language reads it from config or from built-in defaults covering all five, never from one
stack.

## Parallel plans

With `parallel_waves: true`, /h-execute runs every plan whose `depends_on` have landed at once,
up to `worktrees.max`. Each executor gets its own worktree on `holden/<NNN>-<NN>` under
`~/.cache/holden/wt/<repo>-<hash>/`. `bin/h-plans <phase dir>` prints the graph and its errors,
and the orchestrator schedules from `--ready`.

`bin/h-worktree` owns every branch and worktree. Its commands:
- `preflight`: a fresh worktree runs `tests.worktree_setup` and `worktrees.smoke`. Set the smoke
  to something that touches imports and the test DB.
- `land`: merges in a throwaway worktree, re-runs the ledger's proved tests there and
  fast-forwards only when green. Exit 3 is a conflict, 4 is red, 5 means the branch moved, 6 means
  the fast-forward was refused over uncommitted changes, and 75 means a lock stayed busy (land
  again).
- `add`, `range`, `drop`, `remove`, `check <NNN>`, `list` and `sweep`.

Nothing is forced. A worktree with uncommitted work or an unmerged branch is listed, never
removed.

The executor's frontmatter hook (`hooks/holden-executor-git-guard.js`) refuses the git commands
that belong to h-worktree. Agent definitions load at session start, so a session opened before an
agent file changed runs the old one. The hook doesn't refuse `git -C <main checkout> commit` from
a worktree executor. Such a commit reaches the main branch without its plan gate. The executor
prompt forbids it, and the phase diff review over the whole range will still see it.

Before you turn this on, a repo needs test runs that are safe side by side: separate database
names per worktree, and no shared scratch path.

## Packages

With `concurrency: true` in `.holden/config.yaml` (the main checkout's; a worktree's copy is
never read), every unit of work that lands on its own is a package: a phase plan, a quick, or an
inline fix. Each runs in its own worktree on `holden/<id>` and has a record in `<git common
dir>/holden-registry.json`. Only `bin/h-queue` writes that record, under a short flock.

- `h-queue admit` reserves the files a package declares (`files:` and `reads:` in its plan). It
  refuses the shared files (see Shared files), which only a metadata transaction commits. It
  applies the manifest rule to the whole repo at admission, at `extend`, and to a manifest found
  in the landing diff. It takes the base SHA under the landing lock. For `--kind quick` it prints
  `importer roots: ...` of `--writes` before the worktree line, as a warning against a quick's
  size limit (see Quick or phase).
- Reservations conflict only between owners (a phase against a quick). Rank decides who waits and
  who yields: a phase's packages rank above quicks, and the earlier admission above the later.
  The lower one is dropped, with its head in its ledger and a patch of uncommitted work beside it.
  It's then parked and re-run from scratch on the new master.
- `h-queue land` holds the landing lock from the candidate merge through the tests to the
  fast-forward. It merges the submitted SHA, re-runs the package's proved tests and those of every
  package landed since its base, and writes a landing receipt that survives the branch's deletion.
- `h-queue lock -- <cmd>` holds the same lock around a main-checkout commit of other paths, after
  replaying an interrupted metadata transaction. `h-queue meta commit` holds it around a metadata
  transaction (see Shared files). `h-queue freeze [--expect <sha>] -- <cmd>` holds it around the
  final suite and the deploy.
- Every test run on the machine, in every repo, takes one mutex under `~/.cache/holden/`. An
  executor runs a Verify under it with `h-machine run -- <cmd>`. Exit 75 means run it again.
- A package silent for 60 minutes on its heartbeat and its session transcript is stale, and it
  yields when another package needs its file. `h-queue wait` gives up after 4 hours, and the
  operator is asked.
- The statusline shows `▶n ⏸n ⚠n` per repo with packages. `/h-queue` lists them.

Lock order is the landing lock, then the registry lock or the test mutex, never the reverse.
`h-queue -h` lists the commands and exit codes.

## Shared files

A shared file is a tracked metadata file that every session of a repo edits. The list is `SHARED`
in `bin/h-queue`:
- `.planning/state.yaml`
- `.planning/asks.yaml`
- `.planning/OPEN-ASKS.md`
- `.planning/ledger.md`
- `.holden/radius.yaml`
- `.holden/config.yaml`
- `docs/CONTEXT.md`
- `CLAUDE.md`

A holden command changes one of these through a metadata transaction, on private copies, never in
the working tree:
1. `h-queue meta open <shared file>...` makes a token. It prints `token <token>`, one
   `work <path> <copy>` line per file, and `new <dir>`. It takes no lock.
2. Read each work copy, then Edit it. A line ending `(absent at HEAD)` has no copy yet, so Write
   the file at that path to create it.
3. Make any new directory whose name carries a number or id not yet claimed (a grilled phase, a
   new quick) under the `new` dir, at its repo path.
4. `h-queue meta commit <token> -m "<message>"` publishes the change as one commit. Add
   `--add <path>` for each owner-unique path of the tree that goes with it, such as a planned
   phase dir or a quick's dir, and the check flag the site names.
5. Act on the printed line:
   - `committed <sha> <subject>` (exit 0): done. The tree holds the change.
   - `conflict in <path>: open again and redo the edit` (73): another session changed the same
     lines. Open a new token on the same files. Move everything under the old token's `new` dir
     into the new one's, since it may be the only copy. Redo the edits in the new work copies,
     commit the new token, then run `h-queue meta abort <old token>`.
   - `uncommitted change in <path>: commit or discard it` (73): the tree holds an edit no
     transaction made. Stop and show the operator `git diff HEAD -- <path>`.
   - Another 73 line is the site's own check. If the site names it, do what the site says. If the
     line itself carries a move (`open again`, `run h-queue meta commit <token> again`), make it.
     Otherwise stop and show the operator the line.
   - `no such token: open again` (1): the token is gone. Start again at 1.

`h-queue meta open --stamps <doc>...` opens any file tracked at HEAD the same way. The
orchestrator uses it to write a doc's stamp right after a package lands. The stamp is merged
against HEAD under the landing lock and is never left as an edit in the main checkout. Step 5's
lines apply to it, and an uncommitted change to the doc refuses the commit, as it does for a
shared file.

If the Edit tool refuses a work copy, run `h-queue meta abort <token>` and report it. Nothing has
left the token.

Every other commit in the main checkout runs under the landing lock, as
`h-queue lock -- 'git add <own paths> && git commit -m "<message>"'`. `lock` replays an
interrupted transaction first, and no transaction publishes while it runs. `lock` refuses a
command that stages a shared file and prints the `meta commit` form.

`h-queue status` lists a token older than 24 hours. A token may hold the only copy of a session's
edit, so only run `h-queue meta abort <token>` on one after reading its work copies.

If a doc's verification list names a file a package changes, the orchestrator stamps the doc after
the landing. The executor never does. The executor records a `stamp: <doc> task <N>: <entry>`
line in its ledger. The orchestrator then writes the stamp through `meta open --stamps` and
appends `stamped: <doc> <sha>`. `h-queue stamps` lists each entry of a completed task not yet
stamped: `pending:` while its ledger has no `## Result`, `missed:` after. `h-queue status` and
`/h-status` print their count when there is one.

## Scratch records

`bin/h-scratch-pass` deletes the scratch records of finished work: the files of a landed or
archived phase, or a complete or landed quick, that nothing reads once the work is done. Run it
under the landing lock, one scope per commit: `h-queue lock -- h-scratch-pass <path>...`.
`--dry-run` prints the same report and writes nothing. It acts on each such entry of
`.planning/state.yaml` whose `dir:` is the path or lies under it, wherever the directory sits. An
entry with no `dir:` is skipped and named.

At the top of the directory it keeps `DECISION.md`, `FACTS.md`, `HUMAN-UAT.md` and `CONTEXT.md`,
bare or behind the directory's own prefix (`005-DECISION.md`), and `ledger.md`, `state.yaml` and
`asks.yaml` bare. It also keeps a file an open `observations.md` line cites, and a file that a
shared file or another directory's kept record names by path or by file name. A name with no
phase or quick prefix keeps a file only in a directory its line names. Everything else goes,
subdirectories included.

A directory is held back whole in any of these cases:
- `/h-learn` hasn't run for its phase.
- A ledger it would delete holds a pending or missed stamp.
- Its diff review is neither done nor waived.
- A file it would delete has an uncommitted change.

A phase with no observations line counts as learned if it landed before its repo's first line.
The diff review is done when the entry's `review.diff_done` says so. For an entry from before that
key, the pass writes it in the same commit, from the diff review report. It writes `waived` for a
`diff: none` tier, for a phase with no `review:` map and for a quick with no `goal:`.

If it empties a quick or archived phase directory, it removes that directory with its entry's
`dir:`, unless a quick's key would then repeat another entry's, in which case the quick keeps its
`dir:`. A landed phase it would empty is held. Each commit's message names its parent and the
recovery, `git checkout <parent> -- <path>`. Nothing is copied elsewhere, because git history is
the archive. `h-milestone close` never calls it, since `/h-learn review` runs after the close
commit.

## Learning

`observations.md` records where an agent's prompt wasn't enough. It has one line per gap,
attributed to the agent, with the sentence that would have prevented it and a path to the
evidence. `/h-execute` appends to it after every landed phase through `/h-learn <NNN>`.
`/h-milestone close` runs `/h-learn review`, which turns gaps that recur across phases into prompt
edits, one yes per edit, one agent per session.

`bin/h-prune` works the other way. `--open` lists the open lines by agent, and `--quiet` lists
sentences earlier edits added that are still in place twenty phases on, as delete candidates.

The file is global on purpose. The threshold is recurrence across repos, and a per-repo file would
show every gap as firing once. See decision D35.

## Blast radius

Whatever reads a hub without the ledger's knowledge reads it without consent.

`bin/h-radius <hub>` answers "who reads this" for a function, column, setting key, event, route or
file. It reports three things:
- Readers found by mechanical search: code, SQL and migrations, tests, the integration index, and
  importers and co-changed files for a path.
- Readers from the repo's curated map `.holden/radius.yaml`, which are the ones grep can't find: a
  webhook branch, a dynamic key, a sibling repo.
- The kinds it found nothing for, listed as claimed absent, so that a miss is stated as a claim.

The grill runs it when a decision names a hub and pastes the output as the decision's `Touches:`
block. The researcher runs it again on everything the plan adds, and the reviewer runs it on
whatever the diff changes the shape of. `/h-learn` grows the map: a reader that a review or the
operator names and the research missed becomes a map entry the same turn.

`--check-map` flags entries whose file or function is gone. `--check-refs` lists comment path
references that moved or died, which the executor fixes in the commit that touches the file.
`--check-ids` refuses a phase, quick or decision id that a change adds in a comment, docstring or
test name. Docs, `.claude/rules`, `.planning/` and vendored or built trees (`node_modules/`,
`dist/`, `build/`, `vendor/`, at any depth) are exempt. It reads the working tree against HEAD, or
`--range <a>..<b>`, and exits 1 on a hit.

## Facts and words

`<NNN>-FACTS.md` holds every fact the grill looked up, one entry each, with the file or URL that
owns it. The decision record cites entries, and a claim with no entry is a question. The
researcher re-verifies each entry before reading code.

`docs/CONTEXT.md` is the repo's glossary: one entry per term, with its meaning here and the
readings it displaces, and no implementation. The grill adds a term when a question turns on one
and challenges a term used against its entry. The researcher and planner read it first.

Promotion to the ledger takes one test with three parts: hard to reverse, surprising without
context, a real trade-off. This comes from Pocock's `research` and `domain-modeling` skills.

## Quick or phase

A quick is one goal, stated by a red test, and the smallest change that turns it green. The main
session writes both inline, unless the operator hands the change to one executor. A quick gets no
research pass, no DECISION.md, no plan and no planner, because the orchestrator is already in the
code when it opens. It gets these instead:
- a triage grep through the ledger, the asks and every decision record, before it opens
- one verdict-only cold read of the goal, its red test and why it's safe, before the change
- one Codex diff review after the change, whose open BLOCKER stops the landing

When Codex can't run, Fable reads and reviews, and the state entry records why. The record is the
commit body (the goal, the smallest change, why it's safe, each finding's disposition) and the
state entry (`goal:`, the commit shas, the verdicts). If a change's only assertion would just
restate it, such as prose, styling or a label, write "no useful test" and say how it was checked.

The size limit counts behaviour, not files. A quick has one goal whose behaviour shows from one
entry point (one route, one screen or component, one worker cycle), at most one additive contract
change, at most one migration, and no other repo's code. `h-queue admit` prints the importer roots
of the files a quick writes as a hint. A file count measured docs and tests, and design-review
blockers clustered on interactions between parts that run apart.

The escalation rule is mechanical. A quick that would amend a phase decision which already carries
an `Amended` paragraph is not a quick, and the move is a short grill on that decision. Behind the
rule: three quicks on 2026-09-07 each amended one decision of a phase, and the Codex diff review
then found the decision itself inconsistent.

## Diagnosis

`/h-diagnose <symptom>` is for a bug that resists a first look. It builds a red-capable loop before
any theory and minimises it until every element is load-bearing. It then shows the operator three
to five ranked hypotheses with their predictions before any probe. `/h-quick` or `/h-grill`
inherits the loop as its proof. This comes from Pocock's `diagnosing-bugs`.

## Tracing

`/h-trace <feature>` maps every way a feature's effect happens at one commit, before the feature
is decided again. One `holden-tracer` finds the exits (the last step before the effect leaves the
code: a write, an outbound call, a render, a timer) and proves the list complete with `h-radius`
and labelled search hits. One tracer per caller then walks each path back to its entry point, with
the gates in order. The main session reruns the searches and reads each path's first gate before
trusting the merge.

If the repo's config names a `prod_read` command (read-only at the database), the main session adds
volumes per path and outcomes rebuilt as of each event. The trace lands in
`.planning/traces/<slug>-<date>.md` as facts for `/h-grill`, with recommendations kept apart.
Tracers run on Sonnet by default (`models.tracer`).

## Auditing

`/h-audit [<slice> ... | all]` audits the repository as it stands, not a diff, for security and
correctness bugs and for operational gaps (backups, alerting, secret rotation, rate limits).

The main session sizes the repo and sends one `holden-auditor` per chunk of about 350 files to map
its surfaces, plus one for the gaps, on Haiku (`models.auditor_map`). It reruns every search
command the map agents pasted. It then cuts slices by entry point and import reach, with shared
files audited once, and ranks them by exposure: no login, login, operator. `bin/h-agent-return`
copies each return into the map from the agent's transcript, so it's never retyped.

One auditor per slice then reviews it by bug class on Sonnet (`models.auditor`), each finding with
its path from source to sink. One verifier per slice on Opus (`models.verifier`) walks every
finding again and writes the slice file: confirmed, rejected with what stops it, or needs proof.
The main session checks every high, every verdict that overturned the auditor and one rejection
per slice, and writes the open work into `asks.yaml`. A rejection carries into the next run while
its cited lines are unchanged.

A map lands in `.planning/audits/<date>-<sha7>/`. Later slice runs reuse it while it's current: no
file added or removed since, its search commands giving the same counts at HEAD, and under 90 days
old. Each confirmed finding gets a fix brief for `/h-quick`, stated in terms of the code, with the
probe evidence left in the slice file.

GSD's `map-codebase` is the ancestor. Its concerns file was refreshed by carrying old claims
forward, so an audit never reads an earlier finding as fact. Verification follows Trail of Bits'
`fp-check`.

## Review axes

`review.diff_axes: two` runs the self diff review as two agents: `standards` (the repo's rules and
the defects visible by reading) and `decision` (the diff against DECISION.md and the readers).
They're reported side by side and never reranked, so neither masks the other. The default is
`one`. This comes from Pocock's `code-review`.
