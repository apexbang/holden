# Writing for the agents

Rules for editing `agents/*.md`, `skills/*/SKILL.md` and `templates/*`. Distilled from Matt
Pocock's `productivity/writing-for-agents` (mattpocock/skills) and Anthropic's prompting and
skill-authoring best practices (platform.claude.com, read 2026-10-14), kept to what holden's
own record has shown to matter.

- Every step ends on a completion criterion the agent can check: done or not done, and
  exhaustive ("every hub run through the tool", not "readers considered"). A vague bound
  invites stopping early; that is the "rule present, nothing written" failure by name.
  The strongest fix is a write the agent has to make: a ledger field, a pasted tool output, a
  list with a line per item.
- Steering by prohibition drags the forbidden behaviour into context. Say what to do; keep a
  "never" only where the action is destructive.
- An instruction the model follows by default is a no-op: it costs context and changes
  nothing. Delete it. The test is whether the sentence changes behaviour against the prompt
  without it.
- One meaning, one place. A rule restated in two files drifts; the environment (config keys,
  `--help`, the template) is a source of truth a prompt should point at, not repeat.
- A short word the model already thinks with beats a paragraph: red, tight, frontier, ruling,
  hub. Use it consistently and it does the work at every site.
- The reviewer imposes standards; the executor carries the context pressure. A rule about how
  code should look goes to the reviewer prompt, not the executor's.
- Keep a file short enough that every line is read. Push reference material behind a pointer
  that says when to follow it.
- One condition or action per sentence, about 25 words. A sentence that carries a condition,
  an action and six members is where a clause gets skipped; Anthropic's test is a colleague
  with no context following it. In 2026-10 the planner's median was 25 words, 16 of 50
  sentences ran past 40, and PLAN.md's Edges sentence ran to 184.
- A set of members is a list, one member per line, not a comma chain. Lists are for
  completeness, so prose stays prose where order and completeness do not matter.
- Give the reason with the rule when the reason is not obvious; the agent can then apply it to
  a case the rule did not name.
- No date that expires ("until 2026-10-06"). It turns into dead text the day it passes. A
  dated fact goes in the ledger or observations.md; the prompt keeps the rule.
- Not the humanizer. holden's text has almost no AI tells; its fault is overload, and the
  humanizer's rules against lists and bold suit essays, not prompts.
