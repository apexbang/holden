---
phase: 1
slug: example-phase
review:
  plan: self
  diff: self
models: {}              # per-phase overrides of config models:, only the keys that differ
decided: 2026-01-01
promoted: []            # decision ids promoted to ledger.md, e.g. [D03]
---
# Phase 1: example-phase — decision record

Settled by /h-grill. One line per decision with its reason. The planner reads this file and
nothing else about intent.

## Goal
One sentence: what is true when this phase is done.

## Decisions
- D01 What was decided. Because: why. Facts: F01, F02.
  Relies on: F03 | nothing existing (what existing code, a server, a spec or a query already does)
  Breaks when: <input, moment or path that would make it false> -> F-entry showing it cannot happen | the decision's answer (one per case)
  Touches: `<hub>` — <n> readers by search, <m> in the map, absent: <kinds> (h-radius, pasted)
  Exceptions: <each member an every, always, only or never in this decision does not hold for, from the search> | none
- D02 ...

A decision that names a hub (a function, column, setting key, event or route) carries the
`h-radius` output for it, pasted, before the decision settled. A fact the decision rests on is
an entry in `<NNN>-FACTS.md`; a claim with no entry is a question, not a decision.

`Relies on` names the facts that quote the existing behaviour a decision leans on:
- a guarantee, a clock, a matcher or a key
- a caller or a failure branch
- a WHERE clause

`Breaks when` takes one case per input, moment or path that would make the decision false, such
as:
- an early return in the function it relies on
- a refusal the path checks at the time it runs
- a client still holding what the old version served
- a value stored beside the one it reads

## Needs from the world
- Person, device or site the phase needs, who provides it and by when; "nothing" is a value.

## What users lose
- Each number, screen, route or action removed or made redundant, and the decision that removes
  it; "nothing" is a value.

## Conventions that apply (UI or otherwise)
- Follows: path to the convention, or "none".

## Out of scope
- What was explicitly excluded, so the planner does not add it back.

## Review
- Tier: self. Because: ...
