---
name: h-diagnose
description: Diagnose a bug that resists a first look; a red loop before any theory, ranked hypotheses before any probe, then hand the loop to /h-quick or /h-grill as the proof.
argument-hint: "<symptom, as the operator saw it>"
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Grep
  - Glob
  - Agent
---

The man who believes the secrets of the world are forever hidden lives in mystery and
fear. Nothing is known about a bug until a loop has seen it go red. Read the repo's
`docs/CONTEXT.md` and the ledger entries for the area first. Then work the three steps in
order, and do not skip one without saying so and why. Redact every secret in anything you
show.

## 1. Build the loop

One command that drives the real code path and asserts the operator's exact symptom, so it
goes red on this bug and green when it is fixed. In order of preference:
1. a failing test at the nearest seam
2. a curl or HTTP script against the dev server
3. a CLI run against a fixture, diffed against a known-good output
4. a replayed captured payload
5. a throwaway harness around one function
6. a bisection harness between two known states
7. a differential run of two versions
8. a human clicking, as the last resort; then the script drives the human

Then tighten it:
- faster: skip unrelated setup
- sharper: assert the symptom, not "did not crash"
- deterministic: pin time, seed, isolate the filesystem

A flaky bug gets a higher reproduction rate, not a clean repro: loop it a hundred times, add
stress, narrow the timing.

Done when you can paste the command and the red run you already made. If you catch yourself
reading code to build a theory before that command exists, stop: that is the failure this
skill prevents. If no loop can be built, say so, list what you tried, and ask the operator for
an environment or a redacted capture.

## 2. Minimise

Cut inputs, callers, config, data and steps one at a time. Rerun the loop after each cut, and
keep only what keeps it red. Done when every remaining element is load-bearing. Confirm it
reproduces the operator's failure and not a neighbouring one.

## 3. Hypothesise, then show the operator

Three to five ranked hypotheses before testing any. Each carries its prediction: "if X is the
cause, changing Y makes the loop go green" or "makes it worse". One with no prediction is a
vibe; sharpen it or drop it. Show the ranked list and wait: the operator often re-ranks it in
one line.

Then test them in order. Write each one the loop refutes as a fact, with the probe and the
result: "H2 refuted: pinning the cache TTL left the loop red, so not the cache." A refuted
hypothesis is evidence too; it stops the next session from chasing the same dead end.

Find where the bug came from. Run `git log -L` or `git blame` on the lines the fix will change,
then find the phase or quick that shipped them; the commit subject carries its number. A bug
shipped by a phase whose review passed is a defect found after a PASS. Append one line for it
to `~/.claude/holden/observations.md`, in /h-learn's format, against the agent /h-learn's
collect rules name.

## Handing off

The loop is the proof.
- When the cause is in hand and the fix fits a quick's size limit (`skills/h-quick/SKILL.md`
  step 0 in `~/.claude/holden`), run `/h-quick`. The loop is its red test: h-test must see
  it red at the parent and green at the commit.
- When the fix needs a decision, run `/h-grill` with these as facts (they become F-entries):
  the loop, the minimised repro, the confirmed hypothesis and the refuted ones.

Either way, the commit message states the hypothesis that held. Every probe you added is
tagged `[DIAG-<4 hex>]` and removed before the hand-off; grep the tag to prove it.

End with one line naming the next session move and why, in this order: continue, clear, handoff, subagent, compact (see `~/.claude/holden/docs/phase-boundaries.md`).
