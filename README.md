# holden

A planning and execution workflow for Claude Code.

You tell Claude what you want. holden has it question you until nothing is assumed, plan the work,
build it in separate git worktrees and prove each change with a test that fails without it. What
was decided and why stays in the repo, so the next session doesn't start from nothing.

It's named for the judge: whatever exists without his knowledge exists without his consent, and
everything he sees goes into the ledger before the original is destroyed.

## How it works

For a real feature, you run three commands:

```
/h-grill    Claude interviews you, one question at a time, and writes down the decisions
/h-plan     researches the code and writes the plans
/h-execute  agents build the plans, each change proved by a test
```

For something small, `/h-quick` does it in one go: one goal, one failing test, the smallest change
that turns it green. `/h-status` tells you where you are and what to run next.

A few things it does along the way:

- A change only counts as proved when its test is red at the parent commit and green at the new
  one.
- Plans that don't depend on each other can run at once, each in its own worktree. A merge only
  goes through when the tests pass on the merged code.
- Codex can give a second opinion on plans and diffs. You can watch it work live in a tmux window.
  It's optional.
- When an agent's prompt wasn't good enough, holden records the gap, and gaps that keep coming back
  turn into prompt edits.

## Install

You need Linux (WSL works) with Node 22 or later, git, bash, python3, `flock`, `setsid` and
`setpriv`. Codex and tmux are optional.

```
git clone https://github.com/apexbang/holden.git
cd holden
bin/link
```

`bin/link` installs into `~/.claude` with symlinks, so the clone can live anywhere. Restart any open
Claude Code sessions afterwards. If you have a GSD install, read `bin/link` first, because it moves
GSD aside.

## Set up a repo

From the root of your repo:

```
mkdir -p .holden .planning
cp ~/.claude/holden/templates/config.yaml .holden/config.yaml
cp ~/.claude/holden/templates/state.yaml ~/.claude/holden/templates/asks.yaml ~/.claude/holden/templates/ledger.md .planning/
```

Then edit `.holden/config.yaml` to name your test commands, and replace the example entries in the
`.planning` files. Commit them, and run `/h-status` in Claude Code.

Moving from GSD? Follow `docs/converting-a-gsd-repo.md` instead.

## Commands

| Command | What it does |
|---|---|
| `/h-grill` | Interviews you until a plan has nothing silently assumed |
| `/h-plan` | Researches and plans a grilled phase |
| `/h-execute` | Builds a planned phase |
| `/h-quick` | Makes one small change, from a failing test to green |
| `/h-status` | Shows where you are and what to run next |
| `/h-review` | Reviews plans, a diff or a design |
| `/h-test` | Proves a change, or runs the full suite |
| `/h-diagnose` | Works through a bug that resists a first look |
| `/h-trace` | Maps every path to a feature's effect |
| `/h-audit` | Audits a repo for security and correctness bugs |
| `/h-ask` | Asks Codex a question |
| `/h-codex` | Shows your Codex plan's usage |
| `/h-queue` | Lists the work in flight |
| `/h-milestone` | Opens, pauses, resumes or closes a milestone |
| `/h-handoff` | Writes a handoff for the next session |
| `/h-learn` | Records what went wrong in a phase, as prompt gaps |

## Good to know

holden was built for one person's repos, so expect rough edges. Running plans in parallel is off
until you turn it on in `.holden/config.yaml`.

For the details, see `docs/reference.md`. `DECISION.md` has what was decided and why.

## License

MIT, see `LICENSE`.
