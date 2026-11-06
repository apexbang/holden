---
name: h-ask
description: Ask Codex one question, or follow up in the same Codex conversation; shows Codex's answer verbatim, then one line of this session's take. Use when the operator wants a second, independent read from Codex.
argument-hint: "<question> | --continue <slug> <follow-up> [--model M] [--effort E]"
allowed-tools:
  - Bash
  - Read
  - Write
---

A consult is one question to Codex through `~/.claude/holden/bin/codex-ask`, with follow-ups in
the same Codex conversation. It is an independent read, not a review: Codex answers, and the
operator rules.

1. Make the question's file from the repo root:
   `mkdir -p .holden/codex-ask/.inbox && mktemp --suffix=.md .holden/codex-ask/.inbox/ask-XXXXXX`.
   It prints `.holden/codex-ask/.inbox/ask-<id>.md`, a name no other consult holds.
   `ask-<id>` is this consult's detach name in steps 2 and 3. Write in the file:
   - the operator's question, in their words
   - the paths, `path:line` cites and facts the question turns on

   Leave your own view and pick out of it. Codex's answer is worth comparing only when it
   did not see yours. A follow-up gets its own file and `<id>` the same way.
2. Launch it through detach, since a consult runs up to 15 minutes, or 25 on a grill sheet:
   - a question: `~/.claude/bin/detach ask-<id> "~/.claude/holden/bin/codex-ask --file <file>"`
   - a follow-up: `~/.claude/bin/detach ask-<id> "~/.claude/holden/bin/codex-ask --continue <slug> --file <file>"`
   - add `--model <m>` or `--effort <e>` when the operator gave one

   In the SAME response, a background Bash task: `~/.claude/bin/detach-wait ask-<id> 1800`.
   The operator can watch Codex work: `/h-review` § Watching a run says what to tell them.
3. On wake, act on the output's `EXIT` line, then run `~/.claude/bin/detach-seen ask-<id>`:
   - `EXIT 0`: the `answer:` line names the answer file. Read it.
   - `EXIT 5`: Codex is unavailable. Quote the `codex limits before:` line, and offer what
     `/h-review` § Codex availability offers for that verdict: `exhausted`, wait for the reset;
     `no-plan`, renew; `unreadable`, fix it and re-check. Stop there.
   - any other: the consult failed. Quote the output's last lines, and stop.
4. Reply with these three parts, in this order:
   - the answer file's text, whole and verbatim
   - one line: `Take: agree | differ | not sure — <clause>`; a difference names the claim
     you dispute and your own `path:line`
   - the `slug:` line's slug, as `/h-ask --continue <slug> <follow-up>`
5. The answer may end with one or both of these, and you act on them without the operator:
   - `## Thread to follow`: Codex proposes a line beyond the question. Decide alone. Follow it
     when it bears on what the operator is doing: a follow-up as in step 2, saying so. Otherwise
     one line in the reply saying why not.
   - `## Questions back`: answer from the code in a follow-up. Put a question to the operator
     only when it is theirs to settle.

The records stay in `.holden/codex-ask/<slug>/`: each round's `Q-r<N>.md` as sent and
`A-r<N>.md`, and `session`, which `--continue` resumes by its id.
