---
name: h-trace
description: Map every path to a feature's effect at one commit, with the gates on each path, then, where the repo allows a prod read, what each path did in prod. The output is facts for /h-grill, not a decision.
argument-hint: "<feature, as the operator would name it>"
allowed-tools:
  - Read
  - Write
  - Bash
  - Grep
  - Glob
  - Agent
---

Before a feature that grew over many phases is decided again, get the whole picture at one
commit. Find every way the effect happens and the gates on each way. Where prod data exists,
find which gate each real event passed and what came of it. You never edit code and never
write to a database. Read `.holden/config.yaml` and the repo's `docs/CONTEXT.md` first. Note
`git rev-parse HEAD` and today's date; the trace is stamped with both.

The tracers run on `models.tracer`, resolved per docs/reference.md § Models. Tracers only read code; the
prod steps run here, in the main session, under the repo's own rules.

## 1. Find the exits

Spawn one `holden-tracer` in exits mode, with the feature, the sha and the operator's words for
it. Wait for its return.

Done when the return has an exit list, a search-term table with every hit labelled or listed as
unexplained, and a chokepoint line.

## 2. Fan out per path

Spawn one `holden-tracer` in path mode for each caller of each exit. Run them in parallel, at
most six in flight. When there are more than twelve callers, group callers that share an entry
module into one tracer, so no tracer gets more than three.

Done when every caller from step 1 belongs to exactly one tracer's return, as a walked path or
an unwalked one.

## 3. Merge

Write the trace from the returns. Use the format below. One table row per path. An unwalked
path keeps its row, with the step where it stopped and why.

Done when every exit, path, search term, unexplained hit and not-covered item from the returns
appears in the file.

## 4. Verify

Check the tracers' work before going on. Tracers return wrong line numbers often enough that
this step is never skipped.
- Rerun every search term and paste the hit counts. A count that differs from the tracer's is a
  gap; find the missing hits and label them.
- Open every unexplained hit and label it, or leave it listed as unexplained.
- Open the first gate and the dedup line of every path at its `path:line`. A mismatch sends
  that path back to a tracer once, with the defect. A second mismatch marks the path's
  confidence low, with the defect.

Done when the verification section lists every search term with both counts, and every path
with its two reads marked matched or not.

## 5. Volumes (needs prod_read)

Run the prod steps through the config's `prod_read` command only. See § prod_read when the key
is missing. Write every query as a read. For each path:
- how many times it fired
- first and last seen
- the count per tenant

List the paths that never fired. A built path with zero prod events is a finding. When the data
cannot tell two paths apart (the same write, no source column), say so in Not covered; do not
split the count by guess.

For UI, count what drives the gates (how many records would show the control), unless the repo
has client telemetry.

Done when every path has a volume line, a zero, or a not-distinguishable line.

## 6. Outcomes (needs prod_read)

Before any outcome figure, find what bounds each measure (moved, answered, used, changed). Grep
the code that writes or limits it:
- caps, clamps and refusals
- branches that skip the field
- client-side limits, which the server never sees

For each bound, run `git log -L` on its lines. The oldest commit is where it came from; its
subject names the phase or quick, whose DECISION.md says why. Write both beside the bound.

A bound on a traced path that no tracer reported is a gate the tracer missed. Add it to that
path's row and to Verification.

A measure that is bounded, or cannot move on some branch, is limited by design. Report it as
that, with the `path:line`, and split the events by that branch. It is never a finding.

Say what each bound hides. A clamp that logs nothing means the events cannot tell "the value
was in range" from "the value was clamped".

Per path, sort the real events by the gate branch they took and by what came of them (for
example answered, ignored, or failed). This needs a script written for this feature. Write it
into the trace's folder and keep it.

Rebuild the state as of each event; never read today's state. The fields the gates read change
over time, so reading them now puts events in the wrong branch. When no history exists to
rebuild a gate's input, say so for that gate and leave its branch unsorted.

Report every figure with its denominator.

Done when every measure has a bounds line (`path:line` with its commit, or none found), and
every path's events are sorted or say which gate could not be rebuilt.

## prod_read

Holden is global, and each repo has its own route to prod and its own rules for it. The route
lives in the repo's `.holden/config.yaml` as `prod_read:`. It is a command that takes SQL on
stdin. It must be read-only at the database, not by discipline: a read-only role or a replica.
A session setting such as `default_transaction_read_only` is weaker, because a statement can
turn it off; say so when that is all the route has. Such a route also refuses temp tables, so
write outcome queries as CTEs, or pull the rows and process them locally.

When the key is missing:
1. Look for a route the repo already uses: CLAUDE.md, `.claude/rules/`, the memory index, and
   scripts that read prod.
2. If you find one, propose the exact `prod_read:` line with a read-only guard added. Ask once.
   Writing the key is a config change and needs the operator's yes.
3. If you find none, or the operator says no, skip steps 5 and 6. Record that under Not
   covered.

Never guess a host, user or database name.

## Output

Write `<paths.traces>/<slug>-<date>.md`, defaulting to `.planning/traces/`. Scripts from step 6
go in `<paths.traces>/<slug>-<date>/`.

A rerun at a new sha writes a new dated file and never rewrites an old one. A correction at the
same sha, by the operator or a later step, amends the file in place. Each correction adds a line
under Corrections: who caught it, what was wrong, what changed in the file, the commit. /h-learn
reads Verification and Corrections, so a correction made only in prose is lost to it.

The file holds aggregates only. Never write a phone number, name, address or other personal
value into it; a tenant appears by its id.

```
# Trace: <feature>
<date> at <sha>
## Exits
- <kind> `path:line` <what it writes or sends>
- Chokepoint: `path:line` <name> | none: <why>
## Paths
| # | Entry | Gates, in order | Switches | Dedup | Exit | Confidence |
## Unwalked
- <caller> `path:line`: stopped at <step>: <reason>
## Completeness
- Search terms: `<term>` tracer <n>, rerun <n>
- Unexplained hits: `path:line` <the line>
- h-radius: <claimed absent, per hub>
## Verification
- Path <#>: first gate matched | not: <defect>; dedup matched | not: <defect>; re-issued <n>
## Volumes
- Path <#>: <n> events, <first> to <last>; per tenant <id: n, ...> | never fired | not distinguishable
## Outcomes
- Bound: <measure> `path:line` <cap, clamp or skip>; since <sha> <phase or quick>: <why>; hides <what>
- Path <#>, <branch>: <n> of <denominator> <outcome> | limited by design: <bound>
## Not covered
- <what, and why>
## Corrections
- <who>: <what was wrong>; <what changed in the file> (<sha>)
## Recommendations
Proposals, not facts. /h-grill takes the sections above as given and these as proposals.
- ...
```

Commit the file and its script folder through the lock:
`~/.claude/holden/bin/h-queue lock -- 'git add <trace file> <script folder> && git commit -m "docs(trace): <slug>"'`.
A correction commits the same way as `docs(trace): <slug>, <what changed>`.

## Report

Report in under ten lines:
- the path to the trace
- exits, paths and unwalked counts, and whether a chokepoint exists
- the search terms whose rerun count differed
- the paths that never fired
- whether steps 5 and 6 ran, and if not, why

End with one line naming the next session move and why, in this order: continue, clear, handoff, subagent, compact (see `~/.claude/holden/docs/phase-boundaries.md`).
