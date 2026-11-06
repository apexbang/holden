---
name: h-audit
description: Audit a repository at one commit for security and correctness bugs and operational gaps; agents map, review and verify by slice, the main session checks the rulings that matter and files the open work as asks.
argument-hint: "[<slice> ... | all]"
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Grep
  - Glob
  - Agent
---

Audit the repository as it stands, not a diff. Agents map its surfaces, review it slice by
slice, and verify each slice's findings. You check the verifiers' rulings that matter most and
own the result, because a finding nobody checked costs more than no finding. You never edit
code. Read `.holden/config.yaml` and the repo's `docs/CONTEXT.md`
first. Note `git rev-parse HEAD` and today's date; the audit is stamped with both.

The map and gaps agents run on `models.auditor_map`, default `haiku`. Slice audits run on
`models.auditor`, default `sonnet`. Verifiers run on `models.verifier`, default `opus`. All
resolve per docs/reference.md § Models. The map agents list and count; they never judge a finding.

Without arguments, run steps 1 to 4, report the slices, and stop for the operator to pick.
With slice names, run every step for up to six of them, in the order given. With `all`, take
up to six in rank order that have no slice file in the map's folder. The rest run as further
runs, one per session. The limit that matters is each agent's 200k context, not yours: keep
slices inside the cap in step 4 and agents inside their budgets.

## 1. Size

Take the latest run folder's `map.md` when it has a Slices section, and check it is current
at HEAD. A map goes stale through change, not age, so measure the change:
- Structure: `git diff --name-status <map sha> HEAD -- . ':!.planning'` shows no file added,
  deleted or renamed. A new file can be a new surface.
- Surfaces: every search command in the map's Verification gives its recorded rerun count at
  HEAD. The map is those commands, so equal counts mean the surfaces it lists have not moved,
  even inside edited files. Run them in one loop that prints `<n> of <n> match` and the
  commands that differ, not each command's output.
- Age: the map is under 90 days old, a backstop for changes the commands would not see.

When all three hold, reuse it. A reused map without a Lines column gets one first: `wc -l`
over each slice's non-test files, written into the Slices table. A slice over 3,000 lines is
split then, by step 4's rules. Without arguments, report its slices and stop; otherwise go to
step 5. When only surface counts differ, map again the chunks whose commands moved, then rerun
steps 3 and 4. When structure or age fails, map from scratch into a new folder. Paste the three
checks into the map's Verification either way.

A `map.md` without a Slices section is from a stopped run: keep its chunk returns and map only
the chunks it lacks.

Otherwise count tracked files per top-level directory with `git ls-files`, leaving out
`.planning/`. Set aside directories that hold no code: images, fonts, other assets, SQL
migrations, docs. They are listed in `map.md` as stores with their file count, and no map agent
reads them.

Cut the rest into chunks along directory lines, at most about 350 files each. A repository
under that is one chunk. A directory over it is split by its subdirectories. Haiku map agents
peaked at 98k to 114k tokens of their 200k on chunks of 150 to 334 files, so 350 leaves room
for the return.

Done when every tracked file outside `.planning/` is in one chunk or one set-aside directory.

## 2. Map

Spawn one `holden-auditor` in map mode per chunk, with the sha and the chunk's paths. Spawn
one more in gaps mode for the whole repository. Run at most six at once; start the next as
one returns.

Append each return to `map.md` as it arrives, under `## <chunk>` or `## Gaps`, before checking
it. A stopped run then keeps what came back. Copy it with
`~/.claude/holden/bin/h-agent-return <output-file> --demote 1 >> map.md`, where `<output-file>`
is the path in the task notification. Retyping a return costs context and alters it.

A return that lists files under Could not search gets one more map agent on those files
alone. Files under No hits were searched and hold nothing the map lists, so they get none.

Done when every chunk has a return, every Could not search list was sent once, and the gaps
return is in `map.md`.

## 3. Verify the map

The map agents are a cheap model, so their counts are checked before any slice is built on
them.
- Rerun every search command exactly as the agent pasted it, and record both counts. A count
  that differs is a defect; find the missing hits and label them.
- Check that each term's label counts add up to its hit count.
- Check that every count the return states matches the list it gives.
- Open every unexplained hit and label it, or leave it listed as unexplained.
- Rerun the commands behind every gap answered "not found", plus one spelling of your own.

Done when the map's Verification lists every search command with both counts, and every gap
item with its rerun.

## 4. Slice

Cut slices from the merged entry points. A slice is one surface an outsider or a timer reaches:
a route group, the webhooks, the jobs, one daemon, the host config. It holds those entry points
and the server files they reach by import. Its budget is its own non-test lines plus the
shared files its own files import directly, together at most about 3,000 (`wc -l`). An agent
reads both, so both set its context: a 6,300-line slice peaked its auditor at 203k, and a
1,976-line slice whose paths ran through 4,000 lines of shared ops code peaked its auditor at
186k and its verifier at 194k. A surface over the cap splits along its entry points or
directories.

Build the reach with a script over the imports, written to the scratchpad. These rules keep one
slice from swallowing the rest:
- Reach stops at another slice's entry point. A hook that starts a worker does not pull the worker
  into the hook's slice.
- A dispatcher's imports are not followed: a CLI or router whose job is to call every command.
  Each command is its own entry point.
- Client templates (`.svelte`, `.vue`, `.jsx`, Jinja) are left out of the reach. List the ones
  that render raw HTML (`{@html}`, `v-html`, `dangerouslySetInnerHTML`, `|safe`) under the
  slice that serves them, for the injection class.

Then place what the reach leaves over:
- A store goes with the slice whose entry points write it. Migrations go with the slice that
  holds the schema code.
- A file reached from more than one slice is shared. Shared files are audited once, as shared
  slices split by directory at about 3,000 lines each. The other slices get them as read-only
  context. For each shared file, list the slices and files that import it.
- A server file no slice reaches is listed as unsliced. One with no importer outside tests is
  flagged as possibly dead.

Rank the slices by exposure, then by commits in the last year (`git log --since=1.year
--format=%h -- <files> | wc -l`):
1. reachable without a login: public routes, webhooks, ingest endpoints
2. reachable with a login: admin and user routes
3. operator and host: ops, deploy, jobs, host config
4. shared slices

Done when every entry point belongs to exactly one slice, every slice has its line count and
is under the cap, every shared file sits in one shared slice with its importers, and every
unsliced server file is listed.

## 5. Audit the slices

Spawn one `holden-auditor` in audit mode per slice, with the sha, the slice's entry points, its
files, the shared files, and the report path `<scratchpad>/<slice>-audit.md`. A shared slice
has no entry points of its own; pass its importers instead, so the auditor can judge who
controls each input. Run them in parallel, at most six in flight.

The auditor writes its report to that path and returns one line, so the report never passes
through your context. As each returns, go to step 6 for that slice.

A report whose Not covered lists entry points the auditor stopped before, at its tool-call
budget, gets one more auditor on those entry points alone, with the same report path and
`-2` added. Its verifier reads both reports.

Done when every slice has a report file, and every stopped report has its follow-up.

## 6. Verify each slice

Spawn one `holden-auditor` in verify mode per report, on `models.verifier`. Pass:
- the sha and the slice name
- the report's path, the slice's files and the shared files
- the latest earlier file for a slice of the same name, in this folder or an earlier one
- the output paths: `<slice>.md` in the map's folder, and `fixes/<slice>-<n>.md`

A verifier reads, probes on the terms in its verify mode, and writes both files. Its return is
a summary. Run at most six in flight, auditors and verifiers together.

A summary that lists findings the verifier stopped before, at its budget, gets one more
verifier on those findings alone. It appends to the same slice file and briefs.

Done when every slice has a slice file, a brief per confirmed finding, and a summary with
nothing left unverified.

## 7. Check

You own the verdicts, so check the ones that matter most. From each summary, take:
- every high finding
- every verdict marked overturned: the verdict changed between confirmed, rejected and needs
  proof, or either side rated the finding high. A rating moved between low and medium is not
  an overturn; in two runs the check changed none of 16 verdicts, and rating moves were most
  of what it read.
- one rejection per slice, the one whose stop is least obvious

For each, read only that finding's section of the slice file (`sed -n` from its heading to the
next) and its cited lines, then walk the path yourself, as the verify mode says. A whole slice
file costs context the check does not use. Where you agree, add `checked by the main session` to its Verification line. Where you disagree, your
ruling stands. Amend the finding and its brief, and add a Corrections line naming the main
session.

Done when every item above has a check line or a correction.

## 8. Asks

Open a transaction for the asks (docs/reference.md § Shared files in `~/.claude/holden`):
`~/.claude/holden/bin/h-queue meta open .planning/asks.yaml .planning/OPEN-ASKS.md`. Write the
open work into asks.yaml's work copy, in its shape (`templates/asks.yaml`), with
`status: open` and `since: <date>`. Group below high, so the list stays one a reader can scan:
- each high finding: `id: audit-<slice>-<n>`, red, the defect in one sentence, pointer to its
  brief
- each slice with medium findings: `id: audit-<slice>-medium`, amber, "<n> medium findings in
  <slice>: <title>, <title>, ...", pointer to the slice file's Findings
- each needs proof: `id: audit-<slice>-proof-<n>`, amber, the question in one sentence,
  pointer to the slice file's Needs proof section
- the run's low findings: `id: audit-<folder>-low`, green, "<n> low findings across <slices>",
  pointer to the `fixes/` folder; a later run in the same folder updates the count and the
  slices

Asks come after step 7, so none rests on a verdict you have not seen. Update an ask whose id
exists rather than adding a second.

Done when every high, every slice with mediums, every needs proof, and the run's lows have an
ask.

## Output

A map lives in `<paths.audits>/<date>-<sha7>/`, defaulting to `.planning/audits/`, named for
the date and sha it was made at. Slice runs that reuse it write into the same folder: one
`<slice>.md` per slice, stamped with the HEAD it was audited at. A slice audited again in the
same folder writes `<slice>-<sha7>.md` and leaves the earlier file as it was. A new map is a
new folder; an old folder's files are never rewritten. A correction at the same sha, by the
operator or a later step, amends the file in place. Each correction adds a line under Corrections: who caught it, what was wrong, what
changed, the commit. /h-learn reads Verification and Corrections, so a correction made only in
prose is lost to it.

Each confirmed finding also gets a fix brief, `fixes/<slice>-<n>.md` in the same folder, for
/h-quick to take instead of the slice file. The verifier writes the slice file and the briefs
in the shapes in `agents/holden-auditor.md` § Return.

The files name code, never data. Never write a credential, token, phone number, name or other
personal value into them; quote the line that leaks one with the value replaced by `<redacted>`.

```
# Audit map
<date> at <sha>
## Chunks
- <paths>: <n> files
- Set aside: <directory>: <n> files, <what it holds>
## <chunk>
(the agent's return: entry points, stores, external services, configuration, dependencies,
host configuration, search terms, unexplained hits, no hits, could not search)
## Slices
| Slice | Exposure | Entry points | Files | Lines | Commits in a year |
## Shared
- `path`: <shared slice>; imported by <slice>: `path`, ...
## Unsliced
- `path`: <why no slice reaches it> | possibly dead: no importer outside tests
## Raw HTML in client templates
- `path:line`: <slice that serves it>
## Gaps
- <item>[: <thing>]: found in code `path:line` | documented `path:line` | not found: `<command>` | outside the repo: <where>
## Verification
- `<command>`: auditor <n>, rerun <n>; labels add up | not: <defect>
- Gap <item>: rerun `<command>`: <n> hits
## Not covered
- <what, and why>
## Corrections
- <who>: <what was wrong>; <what changed in the file> (<sha>)
```

Commit the folder, briefs included, with the asks' transaction:
`~/.claude/holden/bin/h-queue meta commit <token> -m "docs(audit): <slices>" --add <run folder>`.
A correction that changes an ask commits through a new transaction the same way, as
`docs(audit): <slice>, <what changed>`. One that changes only the run folder commits as
`~/.claude/holden/bin/h-queue lock -- 'git add <run folder> && git commit -m "docs(audit): <slice>, <what changed>"'`.

## Report

Report in under ten lines:
- the path to the run folder
- slices audited, and the rest in rank order
- confirmed findings by rating, with the highest one's title
- needs proof and rejected counts, and how many verdicts step 7 changed
- the asks written, by priority
- gaps answered "not found", and the "outside the repo" items as one question to the operator
- search terms whose rerun count differed

Each confirmed finding goes on to /h-quick with its fix brief, whose Test line is the quick's
red test. A finding whose fix is a decision goes to /h-grill, and so does one whose variants
show from more than one entry point (the size limit, `skills/h-quick/SKILL.md` step 0 in
`~/.claude/holden`). A needs proof finding goes to /h-diagnose, whose loop is the proof.

After a run without arguments, commit `map.md` as
`~/.claude/holden/bin/h-queue lock -- 'git add <run folder>/map.md && git commit -m "docs(audit): map"'`
and name clear as the next move. Mapping and slicing fill the context, and step 1 resumes from
the committed map at step 5.
After a slice run with slices left, name clear and the next six in rank order.

End with one line naming the next session move and why, in this order: continue, clear, handoff, subagent, compact (see `~/.claude/holden/docs/phase-boundaries.md`).
