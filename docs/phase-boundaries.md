# Session boundaries

At the end of any chunk of work, pick the next move in this order. The first yes wins.

1. Continue. The next step needs this session as a primary source (an implementation wants
   the reasoning behind its design verbatim, not a summary), or there is enough context left
   for it. Costs nothing, loses nothing; rule it out first.
2. Clear. Nothing in this session matters to what comes next. Cheapest move; the session
   stays resumable. Wrong call costs the "why", which no diff gives back.
3. Handoff. The work travels: another harness, another directory, another person, or a side
   task forked mid-phase. Buys portability. If nothing travels, skip it.
4. Subagent. The task is scoped tightly enough to run unattended and report back. Leaves this
   session untouched.
5. Compact. Relevant context, same place, and the operator stays in the loop. Last resort,
   with an instruction naming what the summary must keep, because a summary that flattens a
   decision produces a session that is confidently wrong about it.

Every holden command ends with one line naming the move it recommends and why.
Adapted from Matt Pocock's ask-matt/PHASE-BOUNDARIES.md.
