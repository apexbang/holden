---
name: h-learn
description: Turn what went wrong in a landed phase into one line per gap against the holden agent that let it through; review those lines into prompt edits.
argument-hint: "<phase number> | trace <slug>-<date> | audit <date>-<sha7> | review"
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Grep
  - Glob
---

The agents' prompts are frozen text; the phases they run leave a record of where the text was
not enough. This command reads that record and feeds it back. The file is
`~/.claude/holden/observations.md`, one line per gap, shared by every repo on the machine.

## `<phase number>`: collect

Read these from the phase directory named in `.planning/state.yaml`, or the archive if it has
moved:
- every review file (`*REVIEW*-r*.md`) at BLOCKER or WARNING
- the `*-REVIEW-ADJUDICATION.md` rejections
- every `Deviation:` and `Ruling:` line in the `*-LEDGER.md` files
- the research file's "Could not find" list

A reader the research missed, named by a review finding or an operator correction, is a map
gap before it is a prompt gap. In the same turn:
1. Open the map in a transaction (docs/reference.md § Shared files in `~/.claude/holden`):
   `~/.claude/holden/bin/h-queue meta open .holden/radius.yaml`. Add the entry to its work copy
   (Write the copy when its line says `(absent at HEAD)`): hub, path, function, condition,
   phase.
2. Commit it: `~/.claude/holden/bin/h-queue meta commit <token> -m "docs(<NNN>): radius map"`.
3. Run `~/.claude/holden/bin/h-radius --check-map`. It reads the tree's map, so it runs after
   the commit. Fix a dead reference it prints with a new transaction, the same way.

Then write the observation line as usual, naming the map entry.

## `trace <slug>-<date>`: collect

Read `<paths.traces>/<slug>-<date>.md` (default `.planning/traces/`):
- every Verification line marked not matched, or re-issued
- every Corrections line
- every Not covered item that a correction later showed was coverable

An exit or caller that `h-radius` missed is a map gap, handled as above. Write the lines as
below, with `<slug>` in the `<NNN>` slot.

## `audit <date>-<sha7>`: collect

Read every file in `<paths.audits>/<date>-<sha7>/` (default `.planning/audits/`):
- every map Verification line whose counts differ
- every finding Verification line with cited lines not matched
- every rejected finding whose stop sits on its own cited path
- every Corrections line

Write the lines as below, with `audit <date>-<sha7>` in the `<NNN>` slot.

## Naming the agent

For each item name the one agent that should have prevented it:
- researcher: the fix cites code the RESEARCH.md never mentioned (a file, a function, a
  branch, a rejection path), or a "could not find" that existed.
- planner: a verify step wrong at the base commit; a name, path or task-boundary mismatch; a
  deviation the executor resolved from a fact the research already held.
- grill: a decision the research or the review showed the code contradicts; a ruling the
  operator later reversed.
- executor: a deviation that changed behaviour with no ruling recorded; a finding against
  code the plan specified correctly.
- reviewer: a finding the adjudication rejected; a defect found after a PASS.
- tracer: a `path:line` that did not match on the spot read; an exit, caller or gate a later
  step or the operator found on the path it walked.
- h-trace: a step the skill's own text should have caught, run by the orchestrator: an outcome
  reported without its bound, a prod query the route refused.
- auditor: a map count that differed on rerun; a cited line that did not match; a finding
  rejected for a check on its own cited path; a bug found later in its slice under a class its
  clean line covered. In verify mode: a verdict the main session's check changed, or a
  verdict a later correction reversed.
- h-audit: a step the skill's own text should have caught, run by the orchestrator: a finding
  confirmed that a later correction rejected, a gap reported not found that exists.

Before writing the Prevents-it sentence, search for one that already covers the gap: the
agent's prompt, its template, and the tools it runs (`bin/h-plans`, `bin/h-test`, the guard
hook). When one does, the line ends with `Existing: <path:line>`. Done when every line you add
either carries an Existing pointer or you searched and found none.

Append one line per item to `observations.md`:

```
- <date> <repo> <NNN> <agent>: <what happened, one sentence>. Prevents it: "<one sentence in
  the agent's voice, as it would sit in the prompt>". Evidence: <absolute path>[ Existing: <path:line>]
```

A phase with nothing to add gets `- <date> <repo> <NNN>: clean`; the clean count is the
denominator. Do not write an item twice; grep the file for the phase first. Report the lines
you added, verbatim. Commit in `~/.claude/holden`, under that repo's landing lock:
`cd ~/.claude/holden && ~/.claude/holden/bin/h-queue lock -- 'git add -f observations.md && git commit -m "learn(<repo> <NNN>): <count> lines"'`.

## `review`: propose prompt edits

Read `~/.claude/holden/docs/prompt-writing.md` first; every sentence you propose is held to
it. `~/.claude/holden/bin/h-prune --open` prints the open lines and the count per agent.

One agent per session: the one with the most open lines, unless the operator names another.
The other agents' lines wait for their own session. Read only that agent's lines
(`h-prune --open <agent>`).

Measure the agent's prompt first: word count, median sentence and longest sentence. A sentence
over about 30 words, or a set of members written as a comma chain, gets a prose proposal of its
own. It keeps every claim and reports the numbers before and after.

Start with clusters, before any proposal. Group the agent's open lines by the existing
sentence they point at (`Existing:`) or the gap they share, and show the groups. For a line
with no pointer, search the agent's prompt, its template and its tools first. Two lines on the
same gap from different phases make a proposal; one line waits unless the operator asks for it.

Each proposal is one of three kinds, written on it:
- Rewrite: an existing sentence covers the gap but its scope did not reach this case. Show the
  old sentence, the new one, and the word change. Keep each concrete case as an item in a
  list; do not fold the cases into one abstract word.
- Mechanism: an existing sentence reached the case and the agent did not follow it. A louder
  sentence will not help. Propose a check in a tool, a template field or a hook.
- New: no sentence covers the gap. Say what you searched. Classify the fix as one of:
  - a navigation pointer
  - an automated check
  - a rule for the reviewer
  - a template field
  - a tool-economy change
  - a no-op to delete
  - access to information the agent did not have

  A prompt sentence is the last of these.
- Delete: a sentence an earlier learn edit added that may no longer earn its place.
  `h-prune --quiet <agent>` lists them: still in the file, twenty or more phases old. Quiet is
  not useless, because a sentence that works leaves no trace. Propose a delete only when you
  can name why it is safe: a tool or template now enforces it, another sentence covers it, or
  the model does it without being told. Show the sentence and the reason.

At most ten proposals per session; the rest wait. For each, show the lines it rests on, the
exact text, and the section of `agents/<agent>.md`, `skills/<skill>/SKILL.md` or
`templates/*` it goes into; read that file first. Standards belong to the reviewer, which reads
a diff with no context pressure, not to the executor. Check each sentence against the phase
that motivated it: would the agent, reading it, have done otherwise.

Ask yes or no per proposal. On yes edit the file, then mark each line it rests on
`struck (<sha7>)`. On no mark them `declined: <reason>`. One commit per accepted proposal in
`~/.claude/holden`, under its landing lock:
`cd ~/.claude/holden && ~/.claude/holden/bin/h-queue lock -- 'git add -f <the edited file> observations.md && git commit -m "learn(<agent>): <subject>"'`.
An evidence path that no longer resolves is
looked for under the repo's archive by phase directory name; if still absent, the line stands
on its sentence.

Report in under ten lines: proposals made by kind, accepted, declined, the word change in each
file you edited, and lines still waiting by agent.

End with one line naming the next session move and why, in this order: continue, clear, handoff, subagent, compact (see `~/.claude/holden/docs/phase-boundaries.md`).
