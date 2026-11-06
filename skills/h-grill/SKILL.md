---
name: h-grill
description: Interview the operator one question at a time until a plan or design has nothing silently assumed; creates the phase and writes its DECISION.md.
argument-hint: "<topic> | <phase number> | <phase number> <topic to reopen> [--with-codex [--fable]]"
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Grep
  - Glob
  - Agent
---

Interview the operator until you reach a shared understanding, then record it. The design is a
tree: every decision branches into the decisions that hang off it. Work the frontier, the
decisions whose prerequisites are settled, one question at a time.

## Start

1. Read each of these that exists:
   - `.holden/config.yaml`
   - `.planning/state.yaml`
   - `.planning/ledger.md`
   - `.planning/asks.yaml`
   - `docs/CONTEXT.md` (the glossary)

   If the argument is a phase number, read that phase's DECISION.md and FACTS.md first. Treat
   its decisions as settled unless the operator reopens one. When `state.yaml` has a
   `milestone` open, read the DECISION.md of each entry in `phases` carrying that milestone's
   name. A decision here that touches what one of them settled cites that entry.
2. Classify the ask out loud in one sentence. The operator can override.
   - NOT A CODE CHANGE: a request finished by editing a tenant's uploaded file, a row of their
     data, or a document, where no code that runs for anyone else would change. Check this
     first. Say so, do the thing, hand over the artefact, and stop: no phase, no directory, no
     interview. The test is "would this still be needed if the tenant uploaded a different
     file?" A repo whose standing rules push toward building the general capability makes
     this the easy failure to miss. An interview is the most expensive place to miss it:
     grilling a one-off artefact edit manufactures a feature out of it.
   - A quick task: one goal whose behaviour shows from one entry point, within the size
     limit of `skills/h-quick/SKILL.md` step 0 in `~/.claude/holden`. Say "this is a quick
     task" and stop; the operator runs /h-quick.
   - A phase: go on to the interview.
3. If the ask touches a user-facing surface, look up the conventions that already exist for it
   before asking anything: design docs, rules files, the component it would sit beside.
4. With codex: when the argument carries `--with-codex`, or the operator says "grill with
   codex" now or later, read `skills/h-grill/with-codex.md` in `~/.claude/holden` and run
   the grill as it says. `--fable`, or "use fable", puts the gathering and the Claude sheet
   on a Fable subagent.

## The interview

- One question per message. Give the question, then your recommended answer with its reason.
  Wait for the answer.
- Facts are your job. If a question needs something from the filesystem, a log, a database you
  may read, or the web, look it up (a subagent is fine). Ask the operator only the decision.
  - Every fact you look up becomes an entry in a running list: `F<nn> <claim>. Source: <path:line
    or URL and version>`. The list is written to `<NNN>-FACTS.md` at closing.
  - The settled tree cites entries, never bare claims. A claim you did not look up is a
    question.
  - A fact a subagent found is cited by the file the subagent read, not by the subagent.
- Blast radius is a scoping input. A hub is a function, column, setting key, event or route.
  When a decision names one, run `~/.claude/holden/bin/h-radius <hub>` before the decision
  settles. Paste its output as the decision's `Touches:` block, with its three lists:
  - readers found by search
  - readers found in the repo's `.holden/radius.yaml` map
  - kinds claimed absent

  Say the reader count to the operator with the question; a count that surprises them reopens
  the decision. A decision that adds or changes a column makes its table a hub, and a test
  pinning the table's column set is one of its readers. The tool's list is the claim; never
  "check the readers" by judgment. Whatever exists in the tree without the ledger's knowledge
  exists without its consent.
- A sentence that says every, always, only or never about a set is checked against each member
  before it settles. The members come from a search or the `Touches:` list, never from the
  first site found. Name each member it does not hold for in the decision's `Exceptions:`
  line, or change the sentence. Cases:
  - every request a client sends: each place that builds one, checks and preflights included
  - when the system does something (prints, sends, moves): every caller of the function that
    does it, run through h-radius as a hub
  - tests a decision adds to the full suite: each kind, with its measured or estimated wall
    time, and whether the mechanism that keeps it cheap (a cache, a tag, a parallel run)
    applies to that kind. Say the suite's wall time before and after to the operator with the
    question; test time is a cost the operator weighs.
- A decision that states a technical constraint carries its reason in the same line: "no
  root-installed dependency", not "pure Python". A reviewer can then test a candidate against
  the intent rather than the words.
- Timing and existing mechanisms, before the decision settles:
  - For each reading a decision relies on, write when it is taken relative to the event it
    claims to measure. Check that against the phase's own timing facts.
  - For a timer or sweep, what happens when it runs late or not at all is a question.
  - A decision that leans on or widens an existing mechanism names two things in its Relies on
    line: the key the mechanism matches on, and what the rows it already wrote become when a
    later step refuses.
- Before the tree closes, ask what the phase needs from a person, a device or a site, who
  provides it and by when. The answer is the record's `Needs from the world` line. A step only
  the main session may take (prod) names the record that closes it, such as a HUMAN-UAT PASS.
- Before the tree closes, ask what users lose. Each number, screen, route or action a decision
  removes or makes redundant is its own decision, asked, with what replaces it or "nothing". A
  rule that deletes by a condition lists every item it matches at the base. Name any item that
  is the last way to do something (delete a record, an erasure) and ask about it alone. The
  answers are the record's `What users lose` section.
- Words are decisions too. When the operator uses a term the glossary defines differently, say
  so before going on ("the glossary says archive keeps the record; you seem to mean delete.
  Which?"). When a question turns on a term the glossary lacks, settle the term as its own
  question. Add it to the running glossary list with a definition of one or two sentences and
  the readings it displaces. Glossary entries carry no implementation.
- Each answer reshapes the tree: settled decisions unblock the questions that depended on
  them. Ask the next one whose prerequisites are all settled.
- For the surface branch, ask whether the existing conventions apply as-is or something
  changes. If something changes, ask whether you decide it or the operator names a pattern.
  Some questions no convention covers, and their answer is a visual preference: which of
  several layouts, not what kind of screen. Show those instead of describing them:
  - two or three sketches as one local HTML file in the phase directory
  - print a link the operator's machine can open (on WSL, `wslpath -w <file>`); never a published artifact
  - at most one sketch round per phase
  - the chosen sketch stays in the directory, and the decision cites it as a fact
- Do not answer your own questions, offer unrequested alternatives, or accept a vague answer as
  settled. Do not bundle questions.
- The frontier is empty when every branch is visited and nothing is silently assumed. Then
  present the settled tree in one compact summary and ask for confirmation before writing.

## Closing, in this order

1. Ask which decisions constrain future phases and should be promoted to `ledger.md`.
   Recommend a decision only when all three parts of this test hold:
   - hard to reverse
   - surprising without context
   - the result of a real trade-off

   For each decision you leave out, name the part that fails.
2. Ask the two review tiers in one question, each none, self or codex, with a recommendation
   for both.
   - Plan tier: codex when any file the phase will touch matches `review.codex_paths` in the
     config; self otherwise; none for docs-only. The plan review is where Codex pays off,
     since the executor works from the plan and each task carries a proof.
   - Diff tier: the config's `review.diff_tier` (self). Codex when the diff will touch a
     migration or a cross-repo contract, or the executor will have to rule on things the plan
     cannot settle.

   When either recommendation is codex, run the Codex availability check first (`/h-review` §
   Codex availability). On anything but `ok`, recommend self for that tier and say why in the
   question. Offer the choices that section lists: wait for the reset, renew, or Claude only.
3. Ask the models in one question. List researcher, planner, executor and reviewer, each with
   its config default. Recommend raising or lowering any of them for this work, with the
   reason:
   - raise the researcher when the surface is wide or unfamiliar
   - raise the executor when tasks need judgment rather than plan-exact edits
   - raise the reviewer when the diff tier is self on judgment-heavy code
   - lower the planner for a one-plan phase with a fully settled shape

   When nothing warrants a change, state the defaults and move on. Name Fable only when you are
   actually recommending it for this phase, never as a standing line. `inherit` never resolves
   above Opus (docs/reference.md § Models).
4. Ask the milestone only when `state.yaml` has one open: does this phase belong to it? Default
   yes when the phase serves the milestone's goal, no otherwise. An unrelated fix grilled
   mid-milestone stays out, or it blocks `/h-milestone close`. With no milestone open, say so
   and write `null` without asking. A paused milestone takes no phases; work for it means
   resuming it first (`/h-milestone resume`). `/h-milestone close` archives exactly the phases
   carrying its name, so a phase left `null` by mistake is never archived with the rest.
5. Before writing, fill each decision's `Relies on:` and `Breaks when:` lines. Every behaviour
   the decision leans on, in existing code, a server, a spec or a query, is an F-entry quoting
   the line that does it. The template's `Relies on` note lists the kinds. One you cannot cite
   becomes the next question, not a decision.
6. Then write everything once, together, in one metadata transaction (docs/reference.md § Shared files
   in `~/.claude/holden`). Open it first:
   `~/.claude/holden/bin/h-queue meta open .planning/state.yaml .planning/ledger.md docs/CONTEXT.md`.
   Then write:
   - the phase directory under the printed `new` dir, at `<paths.phases>/<NNN>-<slug>/`; NNN
     is the highest integer phase number + 1 (decimal and lettered inserts such as 12.1 or
     18a do not count), zero-padded to three digits
   - in it, `<NNN>-DECISION.md` from `~/.claude/holden/templates/DECISION.md`, with `review`
     (plan and diff tiers), `models` (only the overrides) and `promoted` filled, and every
     `Touches:` block pasted
   - in it, `<NNN>-FACTS.md` from `templates/FACTS.md`, with the running fact list
   - the new glossary terms, appended to docs/CONTEXT.md's work copy; when its line says
     `(absent at HEAD)`, Write that copy from `templates/CONTEXT.md` first
   - the phase entry in state.yaml's work copy, with status `grilled` and `milestone` the
     name from step 4 or `null`, and `current_phase` updated
   - the promoted entries, appended to ledger.md's work copy with the next L-numbers
   - when the grill ran with codex, the consult folder of the slug whose sheet reached `EXIT 0`
     (it holds `A-r1.md`):
     `mkdir -p <phase dir>/inputs && cp -r <main>/.holden/codex-ask/<consult slug> <phase dir>/inputs/codex-ask-<consult slug>`,
     `<phase dir>` being the one under the `new` dir. `cp -r` makes every file regular,
     which `h-queue meta commit` requires. A grill that went Claude only before any `EXIT 0`
     has no consult folder; copy its inbox `<slug>-CLAUDE-r1.md` to `<phase dir>/inputs/` instead.

   One commit, under the landing lock, which re-reads the number:
   `~/.claude/holden/bin/h-queue meta commit <token> -m "docs(<NNN>): decision record for <slug>" --next-phase <NNN>`.
   The line `next phase is <free>, not <NNN>` (73) means another session took `<NNN>`
   meanwhile. Renumber inside the token, then run the commit again with `--next-phase <free>`:
   - rename the directory under `new` to `<free>-<slug>`, and each `<NNN>-` file in it
   - in those files: the frontmatter `phase:`, the `# Phase` title, and each `<NNN>-` file
     name they cite
   - in state.yaml's work copy: the entry's `number`, its `dir`, and `current_phase`
   - in ledger.md's work copy: the Evidence path of each entry this grill appended
   - in CONTEXT.md's work copy: the `(Phase <NNN>.)` tag of each term this grill added

   Every other `<NNN>` stays as written: a cited line such as `:002` or a date is not this
   phase's number.

   The line `conflict in .planning/state.yaml` (73) usually means another grill took
   `<NNN>` first, since both add an entry at one place. Redo it in a new token as docs/reference.md
   § Shared files step 5 says, moving the phase directory across. Then renumber it in the
   new token, as above, when HEAD's next number changed.

Reopening a phase (`/h-grill <NNN> <topic>`) edits its DECISION.md in place, marks changed
decisions as superseded rather than deleting them, and commits through
`~/.claude/holden/bin/h-queue lock -- 'git add <the DECISION.md> && git commit -m "docs(<NNN>): <what reopened>"'`.

End with one line naming the next session move and why, in this order: continue, clear, handoff, subagent, compact (see `~/.claude/holden/docs/phase-boundaries.md`).
