'use strict';
// bin/h-worktree land under the landing lock (phase 001 D07, D08) and drop, sweep and check (D05,
// D01). Every repo comes from makeRepo(), so locks, worktrees and the registry are the test's own.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path'), cp = require('child_process');
const { makeRepo, run, start, sh, writePlan, writeLedger, commitFile, onBranch } = require('./fixtures/repo.js');
const R = require('../lib/registry.js');
const { listWorktrees } = require('../lib/worktrees.js');

const q = s => `'${String(s).replace(/'/g, `'\\''`)}'`;
const lastLine = out => out.trim().split('\n').pop();
// The fixture repo's targeted rule is `sh {files}`, so two test files run as one `sh` of the first
// with the second as its argument: each script records its own run in $T_MARK, then runs the next
// one it was handed.
const mark = (name, body = '') => `#!/bin/sh\necho ${name} >> "$T_MARK"\n${body}${body ? '\n' : ''}if [ $# -gt 0 ]; then f=$1; shift; exec sh "$f" "$@"; fi\nexit 0\n`;
const marks = t => { try { return fs.readFileSync(t.env.T_MARK, 'utf8').split('\n').filter(Boolean); } catch (e) { return []; } };
const master = t => sh('git rev-parse master', t.root, t.env);
const landWorktrees = t => listWorktrees(t.root).filter(w => /\/_land-\d+$/.test(w.worktree || ''));

function repo(opts) { const t = makeRepo(opts); t.env.T_MARK = path.join(t.dir, 'mark'); return t; }
// A package made by h-worktree add directly, with a.txt and the counting test committed on its branch.
function pkg(t, { id = '001-01', test = mark('t1') } = {}) {
  const add = run('h-worktree', ['add', id], { cwd: t.root, env: t.env });
  assert.equal(add.code, 0, add.out);
  onBranch(t.root, id, 'tests/t1.sh', test, 'add t1', t.env);
  const head = onBranch(t.root, id, 'a.txt', 'changed\n', 'change a', t.env);
  return { wt: lastLine(add.out), head, ledger: writeLedger(path.join(t.dir, `${id}-LEDGER.md`), ['tests/t1.sh']) };
}
const land = (t, id, ledger, extra = [], env = {}) => run('h-worktree', ['land', id, '--ledger', ledger, ...extra], { cwd: t.root, env: { ...t.env, ...env } });

test('land merges the submitted head, not the branch', () => {
  const t = repo();
  const p = pkg(t);
  onBranch(t.root, '001-01', 'c.txt', 'c\n', 'a second commit', t.env);
  const before = master(t);
  const r = land(t, '001-01', p.ledger, ['--head', p.head]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /moved past the submitted head/);
  assert.equal(master(t), before);
});

test('land with --head equal to the branch head lands by SHA', () => {
  const t = repo();
  const p = pkg(t);
  const r = land(t, '001-01', p.ledger, ['--head', p.head]);
  assert.equal(r.code, 0, r.out);
  assert.equal(sh('git log -1 --format=%P master', t.root, t.env).split(' ')[1], p.head);
  assert.equal(sh('git log -1 --format=%s master', t.root, t.env), `merge(001-01): land holden/001-01 ${p.head.slice(0, 7)}`);
});

test('land refuses a --head that is not a sha', () => {
  const t = repo();
  const p = pkg(t);
  const r = land(t, '001-01', p.ledger, ['--head', 'holden/001-01']);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /--head needs a commit sha/);
});

test('land holds the landing lock', async () => {
  const t = repo();
  // The test script says when the landing is inside its tests, and stays there for 2 s.
  const p = pkg(t, { test: mark('t1', 'touch "$T_MARK.in"; sleep 2') });
  const lk = R.paths(t.root).landingLock, ready = path.join(t.dir, 'held');
  fs.closeSync(fs.openSync(lk, 'a'));
  // Another landing holds the lock for 3 s, in its own process group so the kill takes the sleep too.
  const holder = cp.spawn('flock', [lk, 'sh', '-c', `touch ${q(ready)}; sleep 3`], { stdio: 'ignore', detached: true });
  try {
    for (let i = 0; i < 100 && !fs.existsSync(ready); i++) await R.sleep(50);
    assert.ok(fs.existsSync(ready), 'the holder took the landing lock');
    const t0 = Date.now();
    const l = start('h-worktree', ['land', '001-01', '--ledger', p.ledger, '--head', p.head], { cwd: t.root, env: t.env });
    for (let i = 0; i < 200 && !fs.existsSync(t.env.T_MARK + '.in'); i++) await R.sleep(50);
    assert.ok(fs.existsSync(t.env.T_MARK + '.in'), 'the landing reached its tests');
    // The holder is gone by now (3 s); the lock is the landing's own.
    assert.ok(Date.now() - t0 >= 2000, 'the landing waited for the holder');
    const mine = await R.holdLock(lk, 0.5, 'test');
    if (mine) await mine.release();
    assert.equal(mine, null, 'the landing holds the lock through its tests');
    const r = await l.done;
    assert.equal(r.code, 0, r.out);
    assert.ok((Date.now() - t0) / 1000 >= 2);
  } finally { try { process.kill(-holder.pid, 'SIGKILL'); } catch (e) {} }
});

test('land runs --also-tests and names a missing one', () => {
  const t = repo();
  commitFile(t.root, 'tests/t2.sh', mark('t2'), 'add t2', t.env);
  const p = pkg(t);
  const r = land(t, '001-01', p.ledger, ['--head', p.head, '--also-tests', 'tests/t2.sh', 'tests/gone.sh']);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(marks(t), ['t1', 't2']);
  const ledger = fs.readFileSync(p.ledger, 'utf8');
  assert.match(ledger, /re-ran 2 proved test file\(s\)/);
  assert.match(ledger, /skipped missing: tests\/gone.sh/);
  assert.match(r.out, /^landed-tests: \["tests\/t1.sh","tests\/t2.sh"\]$/m);
});

test('a second land after the fast-forward finishes once without the branch', () => {
  const t = repo();
  const p = pkg(t);
  assert.equal(land(t, '001-01', p.ledger, ['--head', p.head]).code, 0);
  const rm = run('h-worktree', ['remove', '001-01'], { cwd: t.root, env: t.env });
  assert.equal(rm.code, 0, rm.out);
  assert.equal(sh('git branch --list holden/001-01', t.root, t.env), '');
  const r = land(t, '001-01', p.ledger, ['--head', p.head]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /already landed/);
  assert.match(r.out, /^landed-tests: \[\]$/m);
  assert.deepEqual(marks(t), ['t1']);
});

test('land without a branch and without a receipt refuses', () => {
  const t = repo();
  const r = land(t, '001-01', writeLedger(path.join(t.dir, 'l.md'), ['tests/t1.sh']));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /no branch holden\/001-01/);
});

test('a crash after the merge leaves master unmoved and the next land lands', () => {
  const t = repo();
  const p = pkg(t);
  const before = master(t);
  const r = land(t, '001-01', p.ledger, ['--head', p.head], { HOLDEN_TEST_CRASH_AT: 'land-after-merge' });
  assert.equal(r.code, 99, r.out);
  assert.equal(master(t), before);
  assert.equal(landWorktrees(t).length, 0);
  const again = land(t, '001-01', p.ledger, ['--head', p.head]);
  assert.equal(again.code, 0, again.out);
  assert.notEqual(master(t), before);
});

test('a crash after the fast-forward is recovered by the next land without re-running tests', () => {
  const t = repo();
  const p = pkg(t);
  const before = master(t);
  const r = land(t, '001-01', p.ledger, ['--head', p.head], { HOLDEN_TEST_CRASH_AT: 'land-after-ff' });
  assert.equal(r.code, 99, r.out);
  assert.notEqual(master(t), before);
  assert.doesNotMatch(fs.readFileSync(p.ledger, 'utf8'), /Landed:/);
  const again = land(t, '001-01', p.ledger, ['--head', p.head]);
  assert.equal(again.code, 0, again.out);
  assert.match(again.out, /already landed/);
  assert.deepEqual(marks(t), ['t1']);
  assert.match(fs.readFileSync(p.ledger, 'utf8'), /Landed: holden\/001-01 .* found at a second land/);
});

test('land exits 5 when master moved under a bypassed lock', () => {
  const t = repo();
  const p = pkg(t, { test: 'git -C "$MAIN" commit -q --allow-empty -m raw\n' });
  const before = master(t);
  const r = land(t, '001-01', p.ledger, ['--head', p.head], { HOLDEN_LANDING_HELD: '1', MAIN: t.root });
  assert.equal(r.code, 5, r.out);
  assert.equal(sh('git log -1 --format=%s master', t.root, t.env), 'raw');
  assert.equal(sh('git rev-parse master^', t.root, t.env), before);
});

// Phase 002 D01: a meta commit killed after its update-ref leaves HEAD ahead of the main index
// (research P5: the fast-forward then keeps the old state.yaml staged).
test('h-worktree land run directly replays a pending journal before the fast-forward', () => {
  const t = repo();
  const p = pkg(t);
  const ST = '.planning/state.yaml';
  const o = run('h-queue', ['meta', 'open', ST], { cwd: t.root, env: t.env });
  assert.equal(o.code, 0, o.out);
  const token = o.out.match(/^token (\S+)$/m)[1], work = o.out.match(/^work \S+ (\S+)$/m)[1];
  fs.writeFileSync(work, fs.readFileSync(work, 'utf8').replace(/^project: t$/m, 'project: t2'));
  const k = run('h-queue', ['meta', 'commit', token, '-m', 'meta: t2'], { cwd: t.root, env: { ...t.env, HOLDEN_TEST_CRASH_AT: 'meta-after-publish' } });
  assert.equal(k.code, 99, k.out);
  const r = land(t, '001-01', p.ledger, ['--head', p.head]);
  assert.equal(r.code, 0, r.out);
  assert.equal(sh('git status --porcelain', t.root, t.env), '');
  assert.match(sh(`git show HEAD:${ST}`, t.root, t.env), /^project: t2$/m);
  assert.match(r.out, /replayed the metadata journal/);
});

test('land with no proved tests says so', () => {
  const t = repo();
  const p = pkg(t);
  const r = land(t, '001-01', writeLedger(path.join(t.dir, 'empty.md'), []), ['--head', p.head]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /not re-verified/);
});

test('land exits 4 on a red merged tree', () => {
  const t = repo();
  const p = pkg(t, { test: 'exit 1\n' });
  const before = master(t);
  const r = land(t, '001-01', p.ledger, ['--head', p.head]);
  assert.equal(r.code, 4, r.out);
  assert.equal(master(t), before);
});

const registered = (t, d) => listWorktrees(t.root).some(w => w.worktree === d);
const branchExists = (t, b) => sh(`git branch --list ${q(b)}`, t.root, t.env) !== '';
const drop = (t, ledger, extra = []) => run('h-worktree', ['drop', '001-01', '--ledger', ledger, '--reason', 'x', ...extra], { cwd: t.root, env: t.env });
// A package with no commits whose worktree holds the given edits, uncommitted.
function dirtyPkg(t, edit) {
  const add = run('h-worktree', ['add', '001-01'], { cwd: t.root, env: t.env });
  assert.equal(add.code, 0, add.out);
  const wt = lastLine(add.out);
  edit(wt);
  return { wt, ledger: writeLedger(path.join(t.dir, '001-01-LEDGER.md'), []) };
}
const patchOf = out => { const m = out.match(/uncommitted work saved in (\S+)/); return m ? m[1] : null; };

test('drop with uncommitted work writes a checked patch and removes the worktree', () => {
  const t = repo();
  const p = dirtyPkg(t, wt => { fs.writeFileSync(path.join(wt, 'a.txt'), 'edited\n'); fs.writeFileSync(path.join(wt, 'new.txt'), 'new\n'); });
  const r = drop(t, p.ledger, ['--save-patch']);
  assert.equal(r.code, 0, r.out);
  const patch = patchOf(r.out);
  assert.ok(patch && patch.endsWith('-dropped-r1' + '.patch'), r.out);
  assert.ok(fs.existsSync(patch));
  assert.match(fs.readFileSync(patch, 'utf8'), /new\.txt/);
  sh(`git apply --check ${q(patch)}`, t.root, t.env);
  assert.ok(!registered(t, p.wt));
  assert.ok(!branchExists(t, 'holden/001-01'));
  assert.match(fs.readFileSync(path.join(t.dir, '001-01-LEDGER-dropped-r1.md'), 'utf8'), /apply with: git apply/);
});

test('drop saves a deletion in the patch', () => {
  const t = repo();
  const p = dirtyPkg(t, wt => fs.unlinkSync(path.join(wt, 'a.txt')));
  const r = drop(t, p.ledger, ['--save-patch']);
  assert.equal(r.code, 0, r.out);
  assert.match(fs.readFileSync(patchOf(r.out), 'utf8'), /deleted file mode/);
});

test('drop leaves setup\'s own paths out of the patch', () => {
  const t = makeRepo({ setup: ['ln -s "$REPO/b.txt" dep'] });
  const p = dirtyPkg(t, wt => fs.writeFileSync(path.join(wt, 'a.txt'), 'edited\n'));
  assert.ok(fs.lstatSync(path.join(p.wt, 'dep')).isSymbolicLink(), 'setup made its link');
  const r = drop(t, p.ledger, ['--save-patch']);
  assert.equal(r.code, 0, r.out);
  const text = fs.readFileSync(patchOf(r.out), 'utf8');
  assert.match(text, /a\.txt/);
  assert.doesNotMatch(text, /\bdep\b/);
});

test('drop of a clean worktree writes no patch', () => {
  const t = repo();
  const p = dirtyPkg(t, () => {});
  const r = drop(t, p.ledger, ['--save-patch']);
  assert.equal(r.code, 0, r.out);
  assert.ok(!fs.existsSync(path.join(t.dir, '001-01-LEDGER-dropped-r1' + '.patch')));
  const line = fs.readFileSync(path.join(t.dir, '001-01-LEDGER-dropped-r1.md'), 'utf8').split('\n').find(l => l.startsWith('Dropped:'));
  assert.ok(line);
  assert.doesNotMatch(line, /uncommitted/);
});

test('drop without --save-patch refuses a dirty worktree as today', () => {
  const t = repo();
  const p = dirtyPkg(t, wt => fs.writeFileSync(path.join(wt, 'a.txt'), 'edited\n'));
  const r = drop(t, p.ledger);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /has uncommitted work/);
  assert.ok(registered(t, p.wt));
  assert.ok(branchExists(t, 'holden/001-01'));
  assert.doesNotMatch(fs.readFileSync(p.ledger, 'utf8'), /Dropped:/);
});

test('drop leaves everything when the patch cannot be written', () => {
  const t = repo();
  const ro = path.join(t.dir, 'ro');
  const p = dirtyPkg(t, wt => fs.writeFileSync(path.join(wt, 'a.txt'), 'edited\n'));
  const ledger = writeLedger(path.join(ro, '001-01-LEDGER.md'), []);
  fs.chmodSync(ro, 0o555);
  try {
    const r = drop(t, ledger, ['--save-patch']);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /nothing dropped/);
    assert.ok(registered(t, p.wt));
    assert.ok(branchExists(t, 'holden/001-01'));
    assert.match(fs.readFileSync(path.join(p.wt, 'a.txt'), 'utf8'), /edited/);
  } finally { fs.chmodSync(ro, 0o755); }
});

test('sweep keeps a registered quick\'s clean worktree', () => {
  const t = repo();
  const a = run('h-queue', ['admit', '261018-q', '--kind', 'quick', '--owner', 'quick:261018-q', '--writes', 'a.txt'], { cwd: t.root, env: t.env });
  assert.equal(a.code, 0, a.out);
  const qwt = lastLine(a.out);
  const z = run('h-worktree', ['add', '261018-z'], { cwd: t.root, env: t.env });
  assert.equal(z.code, 0, z.out);
  const zwt = lastLine(z.out);
  const r = run('h-worktree', ['sweep'], { cwd: t.root, env: t.env });
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /remove worktree .*261018-q/);
  assert.match(r.out, /remove worktree .*261018-z/);
  assert.ok(registered(t, qwt));
  assert.ok(branchExists(t, 'holden/261018-q'));
  assert.ok(!registered(t, zwt));
});

test('sweep with a corrupt registry falls back to the executing rule', () => {
  const t = repo();
  fs.writeFileSync(R.paths(t.root).registry, '{');
  const z = run('h-worktree', ['add', '261018-z'], { cwd: t.root, env: t.env });
  assert.equal(z.code, 0, z.out);
  const r = run('h-worktree', ['sweep'], { cwd: t.root, env: t.env });
  assert.equal(r.code, 0, r.out);
  assert.ok(!registered(t, lastLine(z.out)));
});

test('check lists a parked package of the phase', () => {
  const t = repo();
  const a = run('h-queue', ['admit', '261018-q', '--kind', 'quick', '--owner', 'quick:261018-q', '--writes', 'a.txt'], { cwd: t.root, env: t.env });
  assert.equal(a.code, 0, a.out);
  // The plan outranks the quick holding a.txt, so admit parks it to wait: a record with no branch.
  const f = writePlan(path.join(t.root, '.planning', 'phases', '001-x'), '001-01-PLAN.md', { files: ['a.txt'] });
  const p = run('h-queue', ['admit', '001-01', '--kind', 'plan', '--owner', 'phase:001', '--plan', f], { cwd: t.root, env: t.env });
  assert.equal(p.code, 70, p.out);
  const r = run('h-worktree', ['check', '001'], { cwd: t.root, env: t.env });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /package 001-01 parked/);
  // A landed record is finished: written straight into the file, as bin/h-queue land writes it.
  const reg = R.readRegistry(t.root); reg.packages['001-01'].state = 'landed';
  fs.writeFileSync(R.paths(t.root).registry, JSON.stringify(reg));
  const r2 = run('h-worktree', ['check', '001'], { cwd: t.root, env: t.env });
  assert.equal(r2.code, 0, r2.out);
});

test('needId accepts a quick dir name and a fix id', () => {
  const t = repo();
  for (const id of ['261018-review-fixes', '001-fix1']) { const r = run('h-worktree', ['add', id], { cwd: t.root, env: t.env }); assert.equal(r.code, 0, r.out); }
  assert.equal(run('h-worktree', ['add', 'a/b'], { cwd: t.root, env: t.env }).code, 2);
});

test('a drop killed after the forced removal finds its patch on the next drop', () => {
  const t = repo();
  const p = dirtyPkg(t, wt => fs.writeFileSync(path.join(wt, 'a.txt'), 'edited\n'));
  const head = sh('git rev-parse holden/001-01', t.root, t.env);
  const r = run('h-worktree', ['drop', '001-01', '--ledger', p.ledger, '--reason', 'x', '--save-patch'], { cwd: t.root, env: { ...t.env, HOLDEN_TEST_CRASH_AT: 'drop-after-remove' } });
  assert.equal(r.code, 99, r.out);
  assert.ok(!registered(t, p.wt));
  assert.ok(branchExists(t, 'holden/001-01'));
  const again = drop(t, p.ledger, ['--save-patch']);
  assert.equal(again.code, 0, again.out);
  assert.ok(patchOf(again.out) && patchOf(again.out).endsWith('-dropped-r1' + '.patch'), again.out);
  assert.match(fs.readFileSync(patchOf(again.out), 'utf8'), /a\.txt/);
  assert.match(again.out, new RegExp(`^dropped-head: ${head}$`, 'm'));
  assert.ok(!branchExists(t, 'holden/001-01'));
  const lines = fs.readFileSync(path.join(t.dir, '001-01-LEDGER-dropped-r1.md'), 'utf8').split('\n').filter(l => l.startsWith('Dropped:'));
  assert.equal(lines.length, 1, lines.join('\n'));
});

test('a drop killed after the branch delete is finished by the next drop', () => {
  const t = repo();
  const p = dirtyPkg(t, wt => fs.writeFileSync(path.join(wt, 'a.txt'), 'edited\n'));
  const head = sh('git rev-parse holden/001-01', t.root, t.env);
  const r = run('h-worktree', ['drop', '001-01', '--ledger', p.ledger, '--reason', 'x', '--save-patch'], { cwd: t.root, env: { ...t.env, HOLDEN_TEST_CRASH_AT: 'drop-after-branch' } });
  assert.equal(r.code, 99, r.out);
  assert.ok(!branchExists(t, 'holden/001-01'));
  assert.ok(fs.existsSync(p.ledger), 'the ledger was not moved');
  const again = drop(t, p.ledger, ['--save-patch']);
  assert.equal(again.code, 0, again.out);
  assert.ok(patchOf(again.out) && fs.existsSync(patchOf(again.out)), again.out);
  assert.match(again.out, new RegExp(`^dropped-head: ${head}$`, 'm'));
  assert.ok(!fs.existsSync(p.ledger));
  assert.ok(fs.existsSync(path.join(t.dir, '001-01-LEDGER-dropped-r1.md')));
});
