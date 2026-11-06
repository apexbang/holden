# holden glossary

One entry per term that this repo uses in a way a newcomer would misread. Definition first,
one or two sentences, what it is and not what it does; then the readings it displaces. No
implementation detail: a term's code lives in the code, its decisions in the ledger. The grill
adds a term when a question turns on one and challenges the operator when they use a term
against its entry. The researcher and planner read this file before the code.

## Language

**package**:
One unit of work that lands on its own: a phase plan, a quick, or an inline fix, with its own
worktree and branch.
_Not_: a phase (a phase is several packages), an npm or Python package.

**admission**:
The registry accepting a package and reserving the files it declared it will write.
_Not_: starting the executor (a package can be admitted and not yet running), approval by the operator.

**reservation**:
The files a package may write, held from admission until it lands, yields or is dropped.
_Not_: a lock on reading, a lease per edit, a lock held by a session.

**rank**:
The order that decides who waits and who yields when two packages want the same file: a phase's
packages above quicks, the earlier admission above the later.
_Not_: priority of an ask, importance to the operator.

**yield**:
A package giving way to a higher-ranked one: its branch is dropped with the head recorded, it is
parked, and it re-runs its plan from scratch on the new master.
_Not_: pausing a running agent, merging the new master into the branch.

**parked**:
A package that is waiting to be admitted again and holds nothing.
_Not_: blocked (blocked waits on the operator), stale.

**stale**:
A package whose own commands and whose session transcript have been silent for 60 minutes.
_Not_: slow, a long test run (that writes the transcript), dropped.

**freeze**:
A command running while it holds a repo's landing lock, so nothing lands and no metadata is
committed until it ends; used for the final suite and the deploy.
_Not_: a code freeze, pausing workers (they keep editing; only test runs wait on the test mutex).

**landing receipt**:
The registry's record of one landing: submitted SHA, target SHA, candidate SHA, proved tests;
kept after the branch is deleted.
_Not_: the executor ledger, the `Landed:` line in it.

**inline fix**:
A fix the operator asks for in passing ("just fix it") while a phase or quick runs, owned by that
phase or quick, with no plan file and no review tier of its own. (Rewritten in phase 005.)
_Not_: a quick, which is its own owner and has its own red test and review even when the main
session makes it inline; a follow-up ask.

**ledger**:
`.planning/ledger.md`, the durable decisions; or an executor's `<NNN>-<NN>-LEDGER.md`, its task
log. Never the package queue, which is `/h-queue`.
_Not_: the registry, the queue view.

**shared file**:
A tracked metadata file that every session of a repo edits, such as `.planning/state.yaml` or
`.planning/asks.yaml`; the list is the shared-files rule.
_Not_: an owner-unique path (a phase or quick directory, a trace file), a file a package writes.

**metadata transaction**:
One session's change to shared files, made on private copies and published as one commit
against HEAD under the landing lock.
_Not_: a package (it has no worktree or branch), a lock hold around an in-place edit.

**consult**:
A bounded, resumable exchange with Codex through `codex-ask` to settle one question; Codex may
ask for context or propose a related thread, and its answer gives a pick, options and cites.

_Not_: a review (a review returns findings and a verdict), a grill, a free-running Codex worker.

**answer sheet**:
One side's answers to a grill's decision list, one block per decision (a pick with confidence and
reasons, or "Not my call"), written without seeing the other side's.
_Not_: the DECISION.md (only the operator's rulings make that), a review report.

**reconciled view**:
Two answer sheets lined up as an overview, the agreed IDs, the differences and the items not
decided, with the reconciler's recommendation on each difference.
_Not_: a merged answer (it never folds a difference into an agreement), the settled tree.

**hash it out**:
A bounded exchange, on items the operator names, in which each side sees the other's position
quoted word for word; it ends converged or still split after at most 3 exchanges per item.

_Not_: the blind first answer, a review round.

**stamp**:
A doc's verification header (for example `verified`, `verified_against`) saying which change it
was last checked against; its format is the repo's own docs rule.
_Not_: the test stamp (`.holden/test-stamp`), a commit sha alone.

**deferred stamp**:
A stamp entry an executor records in its ledger (`stamp: <doc> task <N>: <entry>`) instead of
writing it, for the orchestrator to write right after the package lands.
_Not_: a stamp-only edit in `files:`, a doc edit.

**quick**:
A small tracked change with one goal, stated by a red test, whose behaviour shows from one entry
point; its record is the commit body and its state entry.
_Not_: a small phase, a plan without research, a file count.

**red test**:
The test written before the change that states a quick's goal: red at the parent, green at the
commit.
_Not_: the test stamp, a test added after the change to cover it.

**product call**:
A choice about what the product should do that the code and the facts cannot settle, asked of the
operator.
_Not_: a fact the session can look up, a technical choice between two ways of doing the same thing.

**scratch record**:
A planning file read only while its phase or quick runs, such as a plan, a gate, an executor
ledger or a review.
_Not_: a decision record (DECISION.md, a GSD-era CONTEXT.md), FACTS.md, HUMAN-UAT.md, a shared file.

**thread proposal**:
Codex's request, in its own words, that the main session decide whether it may pursue a line
beyond what it was asked, in a consult or a review.
_Not_: a question back (which asks for context to answer what was asked), a finding, an approval
request from Codex's sandbox.
