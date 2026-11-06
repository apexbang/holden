# Converting a GSD repo to holden

Written from the first conversion of a real repo. Every step below was run there. Ask the operator for a go before step 1: the conversion rewrites CLAUDE.md and deploy.sh.

## Precedence facts (measured 2026-09-05 on Claude Code 2.1.261)

Same-named components at personal (`~/.claude`) and project (`<repo>/.claude`) level:

| Component | Winner | How measured |
|---|---|---|
| Skill | personal | `/h-prec-test` returned the personal body's word |
| Agent | project | Agent tool with a same-named agent returned the project body's word |
| Hook | both run | per Claude Code hooks reference; hooks merge across sources |

So for every repo, take three inventories separately and write a disposition for each entry:

1. `<repo>/.claude/skills/*`: keep (no collision with an `h-*` name), rename, or remove. A
   project skill cannot shadow a holden skill; a stale copy of a GSD skill here is dead weight.
2. `<repo>/.claude/agents/*`: keep, rename, or remove. A project agent named like a holden
   agent (`holden-*`) WOULD shadow it; rename or remove.
3. `<repo>/.claude/settings.json` hooks and `<repo>/.claude/hooks/*`: any GSD hook here still
   runs beside holden's. Remove them.

Check `git ls-files .claude` as well as `ls .claude`: a repo can ignore `.claude/*` except
`rules/` and still have a force-added skill, so the tracked set and the on-disk set can differ.

## Before you start

- Back up the repo (`zip` of the tree) and confirm `git status` is clean apart from `.holden/`.
- Count phases the way T8 will: distinct phase directories under `.planning/phases/` plus every
  `.planning/milestones/*-phases/` (or wherever the repo archives them), excluding quick tasks.
  Use a pattern that accepts lettered and dotted numbers (`12B`, `7.1`, `01`): a strict
  three-digit pattern undercounts. Zero-padded directories (`01-foundation`) are matched to
  the roadmap's unpadded `Phase 1`. The generated `number:` is unpadded.
- Note which archived milestones lack a `vX.Y-ROADMAP.md`; their phases get a slug-derived goal.

## Steps, one commit each

### T8: state.yaml

Run `~/.claude/holden/bin/gsd-state --repo <repo> --milestone-opened <date> --dry-run` and read
its report before writing. It derives, per phase directory: number and slug from the directory
name; `archived` for anything under a milestone archive, else `landed` / `executing` / `planned` /
`grilled` from PLAN and SUMMARY counts, `deferred` for an empty directory or a roadmap title
marked obsolete/superseded/backlog; milestone from the ROADMAP `## Milestones` ranges, its
`### vX.Y` sections (bounded at the first numbering gap), `### Progress` tables, and parent inheritance for `N.M` and `NNNx` phases;
title from `### Phase N:` headings (three or four hashes, optional parenthetical) or the checkbox
list; created and landed dates from one `git log --name-status -M` pass, ignoring renames so an
archive move never counts as landing. Milestone-less phases stay `null`; do not invent one.


Verify: the phase count equals the recount; `node -e` with `lib/yaml-lite.js` parses the file;
spot-check five entries against the roadmap's shipped dates; the statusline renders the current
phase. Then `git add .planning/state.yaml` and commit. STATE.md and ROADMAP.md stay until T12.

### T9: asks.yaml

Extract every ask line from CLAUDE.md (`- 🔴/🟡/🟢/⚪/⏳ **lead** ... → pointer`). For each, write by
hand: an id (the OPEN-ASKS.md anchor when it has one, otherwise a new slug), a status
(`open` / `shipped-awaiting-check` / `deferred`), a priority from the colour (hourglass lines
become white), one sentence, and `since`. Move the full line verbatim into its OPEN-ASKS.md section
under a "line as it stood on <date>" paragraph; create a section for asks that pointed at a design
doc, with a "Design / ask document" line, so the pointer always targets OPEN-ASKS.md. Replace the
CLAUDE.md section with a two-line pointer and reword the OPEN-ASKS.md header rule.


Verify: a script resolves every `pointer` (file exists, `## anchor` present) and yaml-lite parses
the file; the statusline shows the ask count. The operator spot-checks the sentences.

### T10: ledger.md

Read the CLAUDE.md standing rules and every project/feedback memory file (not just the index
lines). Promote what constrains future phases: product and technical decisions with their reason.
Keep process rules about how Claude works in CLAUDE.md, and people/hardware facts in memory. Do not
write an entry for a mechanism that is not built yet; add it in the commit that builds it.


### T11: CLAUDE.md and the memory index

Rewrite CLAUDE.md as: what the product is, where things live (state, asks, ledger, handoff,
commands, rules, archive), the first principle, how to work here, product rules that keep being
rediscovered with their ledger ids, and the Open Asks pointer. Target under 1,500 words.
  Verify with a script that every backticked path resolves (skill names and globs
will show as misses; read the list). Trim MEMORY.md to rules, quick reference, feedback pointers,
and project entries the repo cannot hold; drop GSD-specific entries; leave the memory files.

### T12: archive, config, inventory

`git mv` STATE.md and ROADMAP.md to `.planning/archive/gsd-<date>/` and prepend a frozen-as-of
note (after the YAML front matter in STATE.md). Write `.holden/config.yaml` from the template:
waves off, executor sonnet, `codex_paths` for your riskiest paths (locks, migrations, deploy), `tests.full` as the repo's real full gate, `single_test_db`, `deploy`. Add to
`.gitignore`:

```
.holden/*
!.holden/config.yaml
```

(handoff, test stamp and lint marker are local). Record the three `.claude` inventories with a
disposition each in the commit message.  Grep for other
references to STATE.md/ROADMAP.md; historical prose in docs stays, code comments are fine.

### T13: deploy.sh and tooling

Pin `ruff` in `requirements-dev.txt` and `svelte-check` (plus `typescript`, its peer) in
`client/package.json` with a `check` script; install both; run each once to size the backlog
before deciding anything.  Create `.holden/lint-bootstrap` (untracked) naming
the tool versions. Rewrite `scripts/deploy.sh` in this order: lint (blocking; the
advisory flag consumes the marker and is refused without it), stamp check (clean tree, HEAD equals
fetched origin/master, stamp taken clean, code-tree hash equal via `h-test --code-tree`) else
`h-test --full`, ship preconditions, exit-10 gate, remote checkout of the exact sha with a
`REMOTE_HEAD=` read-back compared locally. Drop `--skip-tests`. Keep `DEPLOY_SSH` and `HOLDEN_BIN`
overridable so a harness can fake ssh.

Verify with a harness: a throwaway repo with a bare origin, fake `ssh`/`ruff`/`npm` on PATH, a stub
full-suite command, and one scenario per gate above. Wrap it in a pytest test so
`h-test` can prove the commit (red at the parent because the old script fails the scenarios).
Update the repo's testing rule and add the ledger entry for the gate in the same commit.

## Variations seen in a second conversion

A site with no git remote, deployed by rsync of a built tree, broke several T13 assumptions, so
read the doc above as one instance, not the rule:

- **No remote, no push check.** The stamp is consumed on a clean tree with a matching code-tree hash;
  the sha travels as a file (`build/DEPLOY_SHA`, written after the build, rsynced, read back over ssh).
- **The lint backlog can be a permanent accepted class.** A repo may carry no `@types/node` on purpose, so
  `svelte-check` always reports `node:fs` / `process` / `async_hooks` errors in scanners and config.
  The gate filters that class by message and blocks on anything else; the advisory marker then covers
  only the real findings. Decide the class from the repo's own recorded floor.
- **Put the harness under `tests/`.** With the harness in `scripts/`, the parent-commit run
  is red only because the harness file is missing. Under `tests/` it is a test file, h-test applies it
  at the parent, and the OLD deploy script is what fails the scenarios, which is the proof you want.
- **A vitest wrapper needs its own timeout** (default 5 s) and
  belongs in a config that depends on the sibling repo loudly (`test:xrepo`), not in the unit tree.
- **The interactive prompt goes.** A `read -p` gate became the exit-10 gate; `--yes` is rejected
  with a message rather than silently ignored.
- **`h-milestone-close` rewrites pointers in four files only.** OPEN-ASKS.md pointers into a phase
  directory are rewritten by hand in the same commit.
- **Zero-padded phase directories** are matched by `gsd-state` since this conversion (see T8).
- **Small repos** may have no `.claude` inventory at all. Closing the open-but-complete milestone during the conversion (after T12, before
  T13) was cleaner than leaving GSD's "in progress" contradiction in place.

## After

Write the handoff, and tell the operator the two things that need a decision: the lint backlog the
advisory flag exposes once, and any phases the generator left without a milestone.

## Mirror check

If two repos show identical phase counts and archive layouts, confirm with `git remote -v` and `git log -1`
in both before converting either; convert the canonical one and point the mirror at it.
