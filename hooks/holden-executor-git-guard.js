#!/usr/bin/env node
'use strict';
// holden hook: PreToolUse on Bash, Write and Edit, declared in agents/holden-executor.md's frontmatter so it runs
// only inside an executor. The executor prompt already bans these commands; GSD's executors had
// the same kind of ban in prose and still stashed, reset, left files in .git and rebuilt work
// from lost-found. This makes the ban a refusal the executor sees, with what to do instead.
// Branches and worktrees belong to bin/h-worktree, which the orchestrator runs; an executor that
// needs one changed stops and reports blocked.
const fs = require('fs');

// Split a command line into simple commands: quotes kept together, separators ; & | && || newline,
// subshell and substitution brackets. Rough by design; it only has to see what a command runs.
// A heredoc body is data (a commit message, a ledger line), so it is skipped, not parsed.
function segments(line) {
  const out = []; let cur = [], tok = '', q = null, had = false, pending = [];
  const endTok = () => { if (had) cur.push(tok); tok = ''; had = false; };
  const endSeg = () => { endTok(); if (cur.length) out.push(cur); cur = []; };
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (!q && c === '<' && line[i + 1] === '<' && line[i + 2] !== '<') {
      const m = line.slice(i + 2).match(/^-?\s*(['"]?)([A-Za-z_][\w-]*)\1/);
      if (m) { pending.push(m[2]); i += 1 + m[0].length; continue; }
    }
    if (!q && c === '\n' && pending.length) {
      endSeg();
      for (const delim of pending) {
        const lines = line.slice(i + 1).split('\n'); let used = 0, k = 0;
        for (; k < lines.length; k++) { used += lines[k].length + 1; if (lines[k].trim() === delim) break; }
        i += used;
      }
      pending = []; continue;
    }
    if (q) { if (c === q) q = null; else if (c === '\\' && q === '"' && i + 1 < line.length) tok += line[++i]; else tok += c; continue; }
    if (c === "'" || c === '"') { q = c; had = true; continue; }
    if (c === '\\' && i + 1 < line.length) { tok += line[++i]; had = true; continue; }
    if (c === '`' || c === '(' || c === ')' || c === ';' || c === '|' || c === '&' || c === '\n') { endSeg(); continue; }
    if (c === '$' && line[i + 1] === '(') { endSeg(); i++; continue; }
    if (c === '>' || c === '<') { endTok(); cur.push(c); continue; }
    if (/\s/.test(c)) { endTok(); continue; }
    tok += c; had = true;
  }
  endSeg();
  return out;
}

const WRAPPERS = new Set(['sudo', 'env', 'command', 'time', 'nice', 'nohup', 'xargs', 'exec', 'timeout', 'stdbuf', 'ionice', 'h-machine']);
// Wrapper options that take a value as the next word (timeout -s KILL, nice -n 5, env -u X, sudo -u x).
const VALUE_OPTS = new Set(['-s', '--signal', '-k', '--kill-after', '-n', '--adjustment', '-u', '--unset', '-g', '--group', '-C', '--chdir', '-c', '-t', '-I', '-L', '-P', '-d', '-E']);
const isGitPath = t => /(^|\/)\.git(\/|$)/.test(t);
const WRITERS = new Set(['rm', 'mv', 'cp', 'touch', 'tee', 'ln', 'mkdir', 'chmod', 'truncate', 'rmdir', 'install', 'rsync']);

function gitVerdict(argv) {
  let i = 1;
  while (i < argv.length && argv[i].startsWith('-')) {
    const a = argv[i];
    if (a === '--git-dir' || a.startsWith('--git-dir=') || a === '--work-tree' || a.startsWith('--work-tree=')) return 'git --git-dir/--work-tree points git at another repository or tree';
    if (a === '-C' || a === '-c') i += 2; else i++;
  }
  const sub = argv[i], rest = argv.slice(i + 1);
  const has = (...f) => rest.some(a => f.includes(a));
  switch (sub) {
    case 'worktree': return rest[0] === 'list' ? null : 'git worktree: a run at another commit is `~/.claude/holden/bin/h-test --scratch <ref> [--patch <file>] --ledger <ledger> -- <command>`, which makes, records and removes its own worktree; plan worktrees belong to h-worktree';
    case 'branch': {
      const listing = ['--list', '-l', '--show-current', '-a', '--all', '-r', '--remotes', '-v', '-vv', '--verbose', '--contains', '--merged', '--no-merged', '--points-at', '--format', '--sort', '--no-color', '--color'];
      const destructive = ['-d', '-D', '-m', '-M', '-c', '-C', '-f', '--delete', '--move', '--copy', '--force', '-u', '--set-upstream-to', '--unset-upstream', '--edit-description'];
      if (rest.every(a => listing.includes(a.split('=')[0]) || a.startsWith('--format=') || a.startsWith('--sort='))) return null;
      if (has('--list', '-l') && !rest.some(a => destructive.includes(a.split('=')[0]))) return null;
      if (has('--contains', '--merged', '--no-merged', '--points-at') && !has('-d', '-D', '-m', '-M', '-c', '-C', '-f', '--delete', '--move', '--copy', '--force', '-u', '--set-upstream-to')) return null;
      return 'git branch that creates, moves or deletes: branches belong to h-worktree';
    }
    case 'switch': return 'git switch: you commit on the branch you were given';
    case 'checkout': {
      if (has('-b', '-B', '--orphan', '--detach')) return 'git checkout -b/-B/--orphan/--detach: branches belong to h-worktree';
      const dd = rest.indexOf('--');
      if (dd >= 0) return rest.slice(dd + 1).some(a => a === '.' || a === ':/' || a === '*' || a === './') ? 'git checkout of the whole tree discards every uncommitted change: restore the paths you changed, by name' : null;
      if (has('-p', '--patch')) return null;
      return 'git checkout without --: switching or creating branches belongs to h-worktree (restoring a file is `git checkout -- <path>`)';
    }
    case 'merge': case 'rebase': case 'cherry-pick': case 'pull': return `git ${sub}: merging belongs to h-worktree land`;
    case 'stash': return 'git stash: the stash is shared by every worktree; commit your own paths instead';
    case 'reset': {
      if (has('--hard', '--soft', '--keep', '--merge') || rest.some(a => /^(HEAD[~^]|[0-9a-f]{7,40}$|ORIG_HEAD|@\{)/.test(a))) return 'git reset that moves HEAD or discards work: fix forward with a new commit';
      return rest.some(a => !a.startsWith('-') && a !== 'HEAD') ? null : 'git reset with no path unstages the whole index: unstage your own paths with `git restore --staged <path>`';
    }
    case 'clean': return 'git clean: removes files you did not create';
    case 'restore': return rest.some(a => a === '.' || a === ':/' || a === '*') ? 'git restore of the whole tree: restore the paths you changed, by name' : null;
    case 'add': return has('-A', '--all', '.', ':/', '-u', '--update') ? 'git add of the whole tree: add each of your own paths by name' : null;
    case 'commit': return has('--amend') ? 'git commit --amend rewrites a commit the ledger may already name' : (has('--all') || rest.some(a => /^-[A-Za-z]*a[A-Za-z]*$/.test(a)) ? 'git commit -a: add each of your own paths by name' : null);
    case 'push': return 'git push: executors never push';
    case 'update-ref': case 'symbolic-ref': case 'filter-branch': case 'filter-repo': case 'replace': case 'gc': case 'prune': return `git ${sub}: executors never rewrite refs or objects`;
    case 'reflog': return has('expire', 'delete') ? 'git reflog expire/delete destroys recovery points' : null;
    default: return null;
  }
}

// Where a simple command's own argv starts, past assignments and wrappers (timeout 60, env X=1).
function argStart(seg) {
  let i = 0, wrapped = false;
  for (;;) {
    const t = seg[i]; if (t === undefined) return i;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) { i++; continue; }
    if (WRAPPERS.has(t.split('/').pop())) { wrapped = t.split('/').pop(); i++; continue; }
    // bin/h-machine: `run [--label <text>] -- <command>`; before the option line below, which would
    // take --label for a flag and its value for the program.
    if (wrapped === 'h-machine' && (t === 'run' || t === '--')) { i++; continue; }
    if (wrapped === 'h-machine' && t === '--label') { i += 2; continue; }
    if (wrapped && t.startsWith('-')) { i += VALUE_OPTS.has(t) ? 2 : 1; continue; }
    if (wrapped === 'timeout' && /^\d+(\.\d+)?[smhd]?$/.test(t)) { i++; wrapped = true; continue; }
    return i;
  }
}

// A test run, by its runner. Only these are refused in the background: a device install or a
// server a plan starts may run there.
const RUNNERS = new Set(['pytest', 'py.test', 'vitest', 'jest', 'mocha', 'h-test', 'tox', 'nox', 'playwright']);
function isTestRun(line, depth = 0) {
  for (const seg of segments(line)) {
    const argv = seg.slice(argStart(seg)); if (!argv.length) continue;
    if (argv.length === 1 && /\s/.test(argv[0]) && depth < 3 && isTestRun(argv[0], depth + 1)) return true;
    const prog = argv[0].split('/').pop(), a1 = argv[1] || '';
    if (RUNNERS.has(prog)) return true;
    if (/^python[\d.]*$/.test(prog) && a1 === '-m' && /^(pytest|unittest)$/.test(argv[2] || '')) return true;
    if (['npx', 'bunx', 'pnpx'].includes(prog) && RUNNERS.has(a1)) return true;
    if (['npm', 'yarn', 'pnpm', 'bun'].includes(prog) && argv.slice(1).some(a => /^(test|t)(:|$)/.test(a))) return true;
    if (['go', 'cargo', 'make'].includes(prog) && a1 === 'test') return true;
    if ((prog === 'bash' || prog === 'sh' || prog === 'zsh') && depth < 3) { const c = argv.findIndex(a => /^-\w*c$/.test(a)); if (c >= 0 && argv[c + 1] && isTestRun(argv[c + 1], depth + 1)) return true; }
  }
  return false;
}

function verdict(line, depth = 0) {
  for (const seg of segments(line)) {
    const i = argStart(seg);
    const env = seg.slice(0, i).find(t => /^(GIT_DIR|GIT_WORK_TREE|GIT_INDEX_FILE|GIT_COMMON_DIR)=/.test(t));
    if (env) return `${env.split('=')[0]}= points git at another repository, tree or index`;
    const argv = seg.slice(i); if (!argv.length) continue;
    // One quoted word as the whole command is a shell string: bin/h-machine runs `h-machine run --
    // 'git merge x'` through bash -lc, so it is judged as typed.
    if (argv.length === 1 && /\s/.test(argv[0]) && depth < 3) { const v = verdict(argv[0], depth + 1); if (v) return v; }
    const prog = argv[0].split('/').pop();
    // writes into .git: a redirection target or a file tool's argument
    for (let k = 0; k < seg.length; k++) if (seg[k] === '>' && seg[k + 1] && isGitPath(seg[k + 1])) return `writing into .git (${seg[k + 1]}): nothing but git itself writes there`;
    if (WRITERS.has(prog)) {
      const operands = []; for (let k = 1; k < argv.length; k++) { if (/^--(exclude|include|filter)$/.test(argv[k])) { k++; continue; } if (!argv[k].startsWith('-')) operands.push(argv[k]); }
      const written = ['cp', 'rsync', 'install', 'ln'].includes(prog) ? operands.slice(-1) : operands;
      if (written.some(isGitPath)) return `${prog} on a path in .git: nothing but git itself writes there`;
    }
    if (prog === 'sed' && argv.some(a => a === '-i' || a.startsWith('-i')) && argv.slice(1).some(isGitPath)) return 'sed -i on a path in .git: nothing but git itself writes there';
    if (prog === 'git') { const v = gitVerdict(argv); if (v) return v; }
    if ((prog === 'bash' || prog === 'sh' || prog === 'zsh') && depth < 3) { const c = argv.indexOf('-c') >= 0 ? argv.indexOf('-c') : argv.findIndex(a => /^-\w*c$/.test(a)); if (c >= 0 && argv[c + 1]) { const v = verdict(argv[c + 1], depth + 1); if (v) return v; } }
    if (prog === 'eval' && depth < 3) { const v = verdict(argv.slice(1).join(' '), depth + 1); if (v) return v; }
    // bin/h-queue `lock|freeze [opts] -- <command>` runs the command through bash -lc (phase 002 D04's
    // route for every main-checkout commit), so it is judged as typed.
    if (prog === 'h-queue' && ['lock', 'freeze'].includes(argv[1]) && depth < 3) { const d = argv.indexOf('--'), rest = d < 0 ? [] : argv.slice(d + 1); if (rest.length) { const v = verdict(rest.length === 1 ? rest[0] : rest.join(' '), depth + 1); if (v) return v; } }
  }
  return null;
}

if (require.main === module) {
  let input = '';
  try { input = fs.readFileSync(0, 'utf8'); } catch (e) { process.exit(0); }
  let data; try { data = JSON.parse(input); } catch (e) { process.exit(0); }
  const ti = data.tool_input || {};
  // The file tools write too: a path in .git is refused the same as a shell write there.
  if (data.tool_name === 'Write' || data.tool_name === 'Edit') {
    const p = String(ti.file_path || '');
    if (!isGitPath(p)) process.exit(0);
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny',
      permissionDecisionReason: `holden executor guard: ${data.tool_name} on a path in .git (${p}): nothing but git itself writes there. If the plan cannot be finished without it, stop and report blocked with what you needed.` } }) + '\n');
    process.exit(0);
  }
  if (data.tool_name !== 'Bash') process.exit(0);
  const cmd = String(ti.command || '');
  const why = verdict(cmd) || (ti.run_in_background === true && isTestRun(cmd) ? 'a background test run: run tests in the foreground under `timeout <secs>` and read the result when it returns' : null);
  if (!why) process.exit(0);
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny',
    permissionDecisionReason: `holden executor guard: ${why}. If the plan cannot be finished without it, stop and report blocked with what you needed.` } }) + '\n');
  process.exit(0);
}
// bin/h-queue lock reads segments and argStart to find the paths a wrapped command stages (phase 002 D04).
module.exports = { verdict, isTestRun, segments, argStart };
