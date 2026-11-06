'use strict';
// bin/h-snapshot: uncommitted work as a range, in throwaway repos (tests/fixtures/repo.js).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path'), cp = require('child_process');
const { makeRepo, run, sh, commitFile } = require('./fixtures/repo.js');

const RANGE = /^([0-9a-f]{40})\.\.([0-9a-f]{40})\n$/;
const write = (t, rel, s) => fs.writeFileSync(path.join(t.root, rel), s);
const git = (t, c) => sh(`git ${c}`, t.root, t.env);
function snap(t, args, opts = {}) {
  const r = run('h-snapshot', args, { cwd: t.root, env: t.env, ...opts });
  assert.equal(r.code, 0, r.out);
  const m = r.out.match(RANGE); assert.ok(m, r.out);
  return { range: `${m[1]}..${m[2]}`, base: m[1], snap: m[2] };
}

test('h-snapshot prints a range of HEAD plus the named working copies and leaves the tree alone', () => {
  const t = makeRepo();
  write(t, 'a.txt', 'a2\n'); write(t, 'c.txt', 'c\n'); write(t, 'b.txt', 'b2\n');
  const status = git(t, 'status --porcelain');
  // The file itself, so the shebang and the mode run as production runs them.
  const r = cp.spawnSync(path.join(__dirname, '..', 'bin', 'h-snapshot'), ['a.txt', 'c.txt'], { cwd: t.root, env: t.env, encoding: 'utf8' });
  assert.equal(r.status, 0, (r.stderr || '') + String(r.error || ''));
  const m = r.stdout.match(RANGE); assert.ok(m, r.stdout);
  const range = `${m[1]}..${m[2]}`;
  assert.equal(m[1], git(t, 'rev-parse HEAD'));
  assert.equal(git(t, `diff --name-only ${range}`), 'a.txt\nc.txt');
  assert.equal(git(t, `show ${m[2]}:c.txt`), 'c');
  assert.equal(git(t, 'status --porcelain'), status);
  assert.equal(git(t, 'diff --cached --name-only'), '');
  assert.equal(git(t, 'stash list'), '');
});

test('a deleted file is deleted in the snapshot', () => {
  const t = makeRepo();
  fs.rmSync(path.join(t.root, 'b.txt'));
  const { range } = snap(t, ['b.txt']);
  assert.equal(git(t, `diff --name-status ${range}`), 'D\tb.txt');
});

test('--base chains a snapshot on an earlier one', () => {
  const t = makeRepo();
  write(t, 'a.txt', 'a2\n');
  const s1 = snap(t, ['a.txt']).snap;
  write(t, 'a.txt', 'a3\n'); write(t, 'b.txt', 'b2\n');
  const { range, snap: s2 } = snap(t, ['--base', s1, 'a.txt', 'b.txt']);
  assert.ok(range.startsWith(s1 + '..'), range);
  assert.equal(git(t, `rev-parse ${s2}^`), s1);
  const d = git(t, `diff ${range} -- a.txt`);
  assert.match(d, /^-a2$/m);
  assert.match(d, /^\+a3$/m);
  assert.doesNotMatch(d, /^-a$/m);
});

test('the patch of a range applies back onto the restored files', () => {
  const t = makeRepo();
  write(t, 'a.txt', 'a2\n'); write(t, 'c.txt', 'c\n');
  const { range } = snap(t, ['a.txt', 'c.txt']);
  const saved = path.join(t.dir, 'saved');
  fs.writeFileSync(saved, cp.execSync(`git diff --binary ${range}`, { cwd: t.root, env: t.env, encoding: 'utf8' }));
  git(t, 'checkout HEAD -- a.txt'); fs.rmSync(path.join(t.root, 'c.txt'));
  const r = cp.spawnSync('git', ['apply', saved], { cwd: t.root, env: t.env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(t.root, 'a.txt'), 'utf8'), 'a2\n');
  assert.equal(fs.readFileSync(path.join(t.root, 'c.txt'), 'utf8'), 'c\n');
});

test('h-snapshot refuses what it cannot snapshot', () => {
  const t = makeRepo();
  const go = args => run('h-snapshot', args, { cwd: t.root, env: t.env });
  let r = go([]);
  assert.equal(r.code, 2, r.out); assert.match(r.out, /usage: h-snapshot/);
  r = go(['nope.txt']);
  assert.equal(r.code, 1, r.out); assert.match(r.out, /no such path at [0-9a-f]{7} or in the working tree: nope\.txt/);
  r = go(['a.txt']);
  assert.equal(r.code, 1, r.out); assert.match(r.out, /nothing changed in a\.txt since [0-9a-f]{7}/);
  r = go(['--base', 'nosuchref', 'a.txt']);
  assert.equal(r.code, 2, r.out); assert.match(r.out, /not a commit: nosuchref/);
});

test('paths are relative to the repo root from a subdirectory', () => {
  const t = makeRepo();
  fs.mkdirSync(path.join(t.root, 'sub'));
  write(t, 'a.txt', 'a2\n');
  const { range } = snap(t, ['a.txt'], { cwd: path.join(t.root, 'sub') });
  assert.equal(git(t, `diff --name-only ${range}`), 'a.txt');
});

const SNAP = path.join(__dirname, '..', 'bin', 'h-snapshot');
const HQ = path.join(__dirname, '..', 'bin', 'h-queue');
const shq = s => `'${String(s).replace(/'/g, `'\\''`)}'`;
// As skills/h-quick step 8 runs it: inside h-queue lock, which sets HOLDEN_LANDING_HELD for the command it wraps.
const lockCommit = (t, ...a) => run('h-queue', ['lock', '--', [process.execPath, SNAP, 'commit', ...a].map(shq).join(' ')], { cwd: t.root, env: t.env });
// The switch-off path; the patch and the message sit outside the repo, as the quick's scratch sits in an ignored directory.
function commitSetup(paths, edit) {
  const t = makeRepo({ concurrency: false });
  edit(t);
  const { range } = snap(t, paths);
  t.patch = path.join(t.dir, 'goal-1');
  fs.writeFileSync(t.patch, cp.execSync(`git diff --binary ${range}`, { cwd: t.root, env: t.env, encoding: 'utf8' }));
  t.msg = path.join(t.dir, 'goal.msg');
  fs.writeFileSync(t.msg, 'fix(q): goal 1\n\nGoal: a reads a2\n');
  return t;
}
const lastLine = s => s.trim().split('\n').pop();

test('commit takes exactly the patch and leaves an unrelated staged file staged', () => {
  const t = commitSetup(['a.txt', 'c.txt'], t => { write(t, 'a.txt', 'a2\n'); write(t, 'c.txt', 'c\n'); });
  write(t, 'z.txt', 'z\n'); git(t, 'add z.txt');
  write(t, 'b.txt', 'b2\n');
  const old = git(t, 'rev-parse HEAD');
  const r = lockCommit(t, t.patch, '-F', t.msg);
  assert.equal(r.code, 0, r.out);
  assert.equal(lastLine(r.out), `${old}..${git(t, 'rev-parse HEAD')}`);
  assert.equal(git(t, 'rev-parse HEAD^'), old);
  assert.equal(git(t, 'diff --name-only HEAD^ HEAD'), 'a.txt\nc.txt');
  assert.equal(git(t, 'show HEAD:c.txt'), 'c');
  assert.equal(git(t, 'log -1 --format=%s'), 'fix(q): goal 1');
  assert.equal(git(t, 'diff --cached --name-only'), 'z.txt');
  assert.equal(git(t, 'status --porcelain'), 'M b.txt\nA  z.txt');
});

test('commit refuses a patch that no longer applies and changes nothing', () => {
  const t = commitSetup(['a.txt'], t => write(t, 'a.txt', 'a2\n'));
  // A commit between the review and the lock commit moves HEAD under the patch.
  commitFile(t.root, 'a.txt', 'moved\n', 'another session', t.env);
  write(t, 'z.txt', 'z\n'); git(t, 'add z.txt');
  const before = [git(t, 'rev-parse HEAD'), git(t, 'ls-files -s'), git(t, 'status --porcelain'), fs.readFileSync(path.join(t.root, 'a.txt'), 'utf8')];
  const r = lockCommit(t, t.patch, '-F', t.msg);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /the patch does not apply at HEAD [0-9a-f]{7}; nothing committed/);
  assert.deepEqual([git(t, 'rev-parse HEAD'), git(t, 'ls-files -s'), git(t, 'status --porcelain'), fs.readFileSync(path.join(t.root, 'a.txt'), 'utf8')], before);
});

test('commit refuses a patch that changes a shared file', () => {
  const t = commitSetup(['.planning/state.yaml', 'a.txt'], t => {
    fs.appendFileSync(path.join(t.root, '.planning/state.yaml'), '# x\n'); write(t, 'a.txt', 'a2\n');
  });
  const before = [git(t, 'rev-parse HEAD'), git(t, 'ls-files -s')];
  const r = lockCommit(t, t.patch, '-F', t.msg);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /refusing: the patch changes shared files: \.planning\/state\.yaml;/);
  assert.deepEqual([git(t, 'rev-parse HEAD'), git(t, 'ls-files -s')], before);
});

test('commit runs only under the lock, on a branch, with a patch and a message', () => {
  const t = commitSetup(['a.txt'], t => write(t, 'a.txt', 'a2\n'));
  const head = git(t, 'rev-parse HEAD');
  // tests/fixtures/repo.js deletes HOLDEN_LANDING_HELD from t.env, so this runs outside any lock.
  const d = cp.spawnSync(process.execPath, [SNAP, 'commit', t.patch, '-F', t.msg], { cwd: t.root, env: t.env, encoding: 'utf8' });
  assert.equal(d.status, 2, d.stdout + d.stderr); assert.match(d.stderr, /runs under the landing lock/);
  assert.equal(git(t, 'rev-parse HEAD'), head);
  let r = lockCommit(t, t.patch);
  assert.equal(r.code, 2, r.out); assert.match(r.out, /usage: h-snapshot commit <patch> -F <message file>/);
  assert.equal(git(t, 'rev-parse HEAD'), head);
  r = lockCommit(t, path.join(t.dir, 'nope'), '-F', t.msg);
  assert.equal(r.code, 2, r.out); assert.match(r.out, /no such file: .*nope/);
  assert.equal(git(t, 'rev-parse HEAD'), head);
  git(t, 'checkout -q --detach');
  r = lockCommit(t, t.patch, '-F', t.msg);
  assert.equal(r.code, 1, r.out); assert.match(r.out, /HEAD is detached/);
  assert.equal(git(t, 'rev-parse HEAD'), head);
});

test('bin/h-queue gives SHARED to a require and runs nothing', () => {
  const r = cp.spawnSync(process.execPath, ['-e', `process.stdout.write(JSON.stringify(require(${JSON.stringify(HQ)}).SHARED))`], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const shared = JSON.parse(r.stdout);
  assert.equal(shared.length, 8);
  assert.ok(shared.includes('.planning/state.yaml') && shared.includes('CLAUDE.md'), r.stdout);
  assert.ok(!r.stdout.includes('h-queue: the package registry'), r.stdout);
});
