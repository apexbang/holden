'use strict';
// The harness every test of phase 001 uses: each test builds its own throwaway repo under the tmp
// dir with its own cache and Claude config dirs, so registries, worktrees and locks never touch
// the real ones.
const fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process');

const BIN = path.join(__dirname, '..', '..', 'bin');
const STATE = path.join(__dirname, '..', '..', 'templates', 'state.yaml');

function sh(cmd, cwd, env) { return cp.execSync(cmd, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
const q = s => `'${String(s).replace(/'/g, `'\\''`)}'`;

// Every repo this process made goes when it exits; the worktrees and caches live inside it.
const made = [];
process.on('exit', () => { for (const d of made) try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} });

function makeRepo({ concurrency = true, files = { 'a.txt': 'a\n', 'b.txt': 'b\n' }, setup = [] } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'holden-t-')));
  const root = path.join(dir, 'repo');
  made.push(dir);
  for (const d of [root, path.join(dir, 'cache'), path.join(dir, 'claude', 'projects', '-tmp-repo')]) fs.mkdirSync(d, { recursive: true });
  const env = { ...process.env, XDG_CACHE_HOME: path.join(dir, 'cache'), CLAUDE_CONFIG_DIR: path.join(dir, 'claude'), CLAUDE_CODE_SESSION_ID: 'sess-1', HOME: process.env.HOME };
  // An outer `h-test --full` may hold the machine mutex or the landing lock; the repo under test is not its.
  for (const k of ['HOLDEN_MUTEX_HELD', 'HOLDEN_LANDING_HELD', 'HOLDEN_TEST_CRASH_AT']) delete env[k];
  fs.writeFileSync(path.join(dir, 'claude', 'projects', '-tmp-repo', 'sess-1.jsonl'), '{}\n');
  const all = {
    '.holden/config.yaml': ['holden: 1', `concurrency: ${concurrency}`, 'parallel_waves: false', 'tests:',
      '  test_file_patterns: ["tests/**"]', '  targeted:', '    - match: "tests/**"', '      run: "sh {files}"',
      `  worktree_setup: [${setup.map(s => JSON.stringify(s)).join(', ')}]`, '  full: ["sh tests/full.sh"]',
      '  stamp_ignore: [".planning/**", ".holden/**", "**/*.md"]', ''].join('\n'),
    '.gitignore': '.holden/*\n!.holden/config.yaml\n',
    '.planning/state.yaml': fs.readFileSync(STATE, 'utf8').replace(/^project: .*$/m, 'project: t'),
    'tests/full.sh': '#!/bin/sh\nexit 0\n',
    'tests/ok.sh': 'exit 0\n',
    ...files,
  };
  for (const [rel, content] of Object.entries(all)) { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), content); }
  sh('git init -q -b master && git config user.email t@x && git config user.name t', root, env);
  sh(`git add -- ${Object.keys(all).map(q).join(' ')} && git commit -q -m init`, root, env);
  return { dir, root, env };
}

function run(bin, args, { cwd, env, input } = {}) {
  const r = cp.spawnSync(process.execPath, [path.join(BIN, bin), ...args], { cwd, env, encoding: 'utf8', input });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

// The same, not waiting: for a test that acts while the command runs (a lock held, a holder killed).
function start(bin, args, { cwd, env } = {}) {
  const child = cp.spawn(process.execPath, [path.join(BIN, bin), ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const res = { child, out: '' };
  child.stdout.on('data', d => { res.out += d; });
  child.stderr.on('data', d => { res.out += d; });
  res.done = new Promise(r => child.on('close', code => r({ code, out: res.out })));
  return res;
}

function writePlan(dir, name, { files, reads = [], plan = 1 }) {
  const list = (k, xs) => xs.length ? `${k}:\n` + xs.map(x => `  - ${x}`).join('\n') : `${k}: []`;
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, name);
  fs.writeFileSync(f, ['---', 'phase: 1', `plan: ${plan}`, 'depends_on: []', list('files', files), list('reads', reads),
    'produces: []', 'consumes: []', 'runs_tests: true', '---', '# t', '<objective>x</objective>', ''].join('\n'));
  return f;
}

// The shape bin/h-worktree ledgerTests reads: `h-test: ` then JSON with a proved verdict and tests.
function writeLedger(file, tests) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '# Executor ledger\n' + `h-test: ${JSON.stringify({ verdict: 'proved', tests })}\n`);
  return file;
}

function commitFile(root, rel, content, msg, env) {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content);
  sh(`git add -- ${q(rel)} && git commit -q -m ${q(msg)}`, root, env);
  return sh('git rev-parse HEAD', root, env);
}

// The worktree bin/h-worktree made for package id: <cache>/holden/wt/<repo>-<hash>/<id>.
function worktreeOf(id, env) {
  const base = path.join(env.XDG_CACHE_HOME, 'holden', 'wt');
  const hits = fs.existsSync(base) ? fs.readdirSync(base).map(d => path.join(base, d, id)).filter(d => fs.existsSync(d)) : [];
  if (hits.length !== 1) throw new Error(`expected one worktree for ${id}, found ${hits.length}`);
  return hits[0];
}

function onBranch(root, id, rel, content, msg, env) { return commitFile(worktreeOf(id, env), rel, content, msg, env); }

module.exports = { makeRepo, run, start, sh, writePlan, writeLedger, commitFile, onBranch, worktreeOf };
