# Grill with codex

Read this when `/h-grill` runs with `--with-codex`, or when the operator says "grill with
codex", at the start or mid-grill. It replaces the one-question loop for the decisions on the
sheets. Everything else in `/h-grill`'s `SKILL.md` holds: the fact rules, the settled-tree
summary and the closing.

Codex gives an independent second read. It answers the decision list; only the gatherer builds
or extends that list.

## Who does what

- Gatherer and Claude side: the main session. With `--fable`, or when the operator says "use
  fable", one Fable subagent does both: the Agent tool with `subagent_type: general-purpose`
  and `model: fable` (docs/reference.md § Models in `~/.claude/holden`). This needs `SendMessage` among
  your tools, since later rounds continue that subagent's conversation. Without it, the main
  session does both; tell the operator so in one line before § 1.
- Codex side: one `codex-ask --sheet` call. Drill-downs, hash it out and the second sheet are
  follow-ups in that conversation.
- Reconciler: the main session.

## Files

The consult's slug is `<YYYY-MM-DD>-grill-<topic>`, the topic in lower-case words joined by
`-`. When a folder or an inbox file under `<main>/.holden/codex-ask/` already starts with that
slug, add `-2`, or the next free number. `<main>` is the main checkout,
`dirname "$(git rev-parse --path-format=absolute --git-common-dir)"`.
- `<main>/.holden/codex-ask/.inbox/<slug>-list.md`: the decision list as sent.
- `<main>/.holden/codex-ask/.inbox/<slug>-CLAUDE-r1.md`: the first Claude sheet, until
  Codex's run ends.
- `<main>/.holden/codex-ask/<slug>/`: the consult folder. `codex-ask` writes `Q-r<N>.md`,
  `A-r<N>.md` and `session` there. The grill adds:
  - `CLAUDE-r<N>.md`: each Claude-side round, numbered 1, 2, 3 in the order written
  - `RECONCILED-r<N>.md`: each reconciled view, N the Codex round it lines up

## 1. Gather

The gatherer builds the decision list. Before writing it, it runs the fact checks of
`SKILL.md` § The interview for every decision on the frontier:
- `~/.claude/holden/bin/h-radius <hub>` for each hub a decision names, its output pasted
  under the decision as `Touches:`
- each every, always, only or never, checked against its members
- the timing of each reading a decision relies on

Each result is an F-entry on the list. Glossary terms, what users lose and needs from the
world go on the list as decisions. Ledger promotion, review tiers, models and the milestone
stay for closing.

The list file has three parts:
- `## Settled`: only when the mode starts mid-grill. One line per settled decision, as
  context both sides read and do not answer.
- `## Decisions`: the frontier, in the order to answer. Per decision: `### Dxx <title>`, the
  question in one sentence, the options when there are any, `Prerequisites:` with the Dxx it
  depends on or `none`, and `Facts:` with its F-ids.
- `## Facts`: every F-entry the decisions cite, as `F<nn> <claim>. Source: <path:line or URL>`.

The list holds no pick and no recommendation, so each side answers blind to the other.
Done when every frontier decision has a block and every cited F-id is under `## Facts`.

## 2. Send the sheets

1. Launch Codex's sheet through detach:
   `~/.claude/bin/detach ask-<slug> "~/.claude/holden/bin/codex-ask --sheet --slug <slug> --file <list file>"`.
   In the SAME response, a background Bash task: `~/.claude/bin/detach-wait ask-<slug> 1800`.
   The operator can watch it: `/h-review` § Watching a run says what to tell them.
2. While it runs, the Claude side writes its sheet to the inbox's `<slug>-CLAUDE-r1.md`. It
   answers from the list file alone, in the format of
   `~/.claude/holden/templates/answer-sheet.md`. The main session writes it before reading
   anything Codex returns. A Fable subagent gets the two paths, writes the file and returns
   its path. Done when the sheet has one block per decision under `## Decisions`.
3. On wake, act on the `EXIT` line, then run `~/.claude/bin/detach-seen ask-<slug>`:
   - `EXIT 0`: move the Claude sheet into the consult folder as `CLAUDE-r1.md`, read
     `A-r1.md`, and go to § 3.
   - `EXIT 5`: § Codex unavailable.
   - `EXIT 2`: the slug is taken. Add `-2`, or the next free number, to the slug, rename the
     two inbox files to match, and repeat step 1.
   - any other: the run failed. Quote the output's last lines, and offer a re-run of step 1
     or Claude only (§ Codex unavailable). A failed run keeps its folder, so the re-run takes
     the next free number on the slug, as `EXIT 2` does.

## 3. The reconciled view

Line the two sheets up by Dxx. Write the view to `RECONCILED-r<N>.md` in the consult folder,
N the Codex round, and show it to the operator. It has four parts:
1. An overview of at most 8 lines: where the sides agree and where they split.
2. `Agreed:` the IDs where both sides pick the same choice, IDs only.
3. `Differ:` one line per difference:
   `Dxx Codex: <pick> | Claude: <pick> | Rec: <pick>, because <clause>`. When the item differs
   only because a root it depends on split, add `follows from Dyy`.
4. `Not decided:` one line per item a side marked `Not my call`:
   `Dxx <side>: not my call, <clause> | Rec: <pick>, because <clause>`.

Label each pick with its side; your own view appears only as `Rec:`. Every difference gets its
own line, however many there are. Two picks that differ stay apart even when one wording could
cover both: the ruling is the operator's.
Done when every Dxx on the list sits in exactly one of `Agreed:`, `Differ:` and `Not decided:`.

## 4. Settling

The operator answers in prose, as in any grill. Map each remark to its Dxx:
- "yes" to the agreed items confirms all of them at once.
- A ruling settles its item.
- A tentative remark ("probably x") stays tentative until the settled-tree summary confirms it.
- A drill-down on an item is a follow-up to Codex (§ Follow-ups) or a question to the Claude
  side. Show Codex's answer verbatim.
- "Hash it out" on named items: § Hash it out.
- "Sketch both": the grill's one sketch round (`SKILL.md` § The interview).

A ruling against a side's pick on a root voids that side's answers on every decision that
depends on the root: one that lists it under `Prerequisites:`, and, repeating until no new
decision is added, one that lists a decision already voided. Then:
1. Send those decisions to both sides as a second sheet, with the ruling stated: a follow-up
   to Codex, and the Claude side's next `CLAUDE-r<N>.md`.
2. Reconcile the second sheet as in § 3.
3. Ask anything still open one question at a time, as in `SKILL.md` § The interview.

A grill sends a second sheet once at most. When every item is settled, present the settled
tree as `SKILL.md` says and go to its closing, whose step 6 copies the consult folder.

## Hash it out

Run it only when the operator asks, on the items they name. Per item, one exchange is:
1. Each side gets the other's current position on the item, quoted word for word.
2. Each side keeps or changes its pick. A side that changes names the fact, `path:line` or
   case that moved it.

Stop an item as converged when both picks match: report the pick and what moved whom. After
the third exchange, stop it as still split: report each side's final line and your `Rec:`.
Each exchange is a round on disk: Codex's `Q-r<N>.md` and `A-r<N>.md`, and the Claude side's
next `CLAUDE-r<N>.md`.

## Follow-ups

A follow-up to Codex goes in a new inbox file, `<slug>-r<N>.md`, N the next Codex round. Launch
it as in § 2 step 1, with `--continue <slug>` in place of `--sheet --slug <slug>`:
`~/.claude/bin/detach ask-<slug>-r<N> "~/.claude/holden/bin/codex-ask --continue <slug> --file <file>"`.
It runs on the sheet's model, effort and 25 minutes, read from `session`. In the SAME
response, a background Bash task: `~/.claude/bin/detach-wait ask-<slug>-r<N> 1800`. On wake,
act on the `EXIT` line, then run `~/.claude/bin/detach-seen ask-<slug>-r<N>`:
- `EXIT 0`: read the file the `answer:` line names.
- `EXIT 5`: § Codex unavailable.
- any other: the round failed. Quote the output's last lines, and offer the same `--continue`
  launch again (codex-ask picks the next round itself) or Claude only. Never start a new sheet
  for it: that is a new conversation.

A sheet or a follow-up may end with `## Thread to follow` or `## Questions back`. The main
session settles them as `/h-ask` step 5 says, with a follow-up here; a question that is a product
call goes to the operator as a grill question.

The Claude side's next round:
- The main session answers in its own conversation.
- A Fable subagent: send it the round with `SendMessage`, `to` set to its agent id, so it
  keeps its context. A new subagent would have its answers but not the reasoning behind them.

## Codex unavailable

`codex-ask` exits 5 when `codex-limits --check` is not ok. Quote its `codex limits before:`
line, and offer the choices `/h-review` § Codex availability lists for that verdict: wait for
the reset, renew, fix and re-check for `unreadable`, or Claude only. Waiting, renewing or
fixing repeats the launch that exited 5 afterwards: § 2 step 1 for the first sheet, the same
`--continue` launch for a follow-up. Claude
only means the grill goes on as the one-question interview of `SKILL.md`, with the Claude
sheet's picks as your recommendations. With one sheet there is no reconciled view.
