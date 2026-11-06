'use strict';
// bin/h-queue land, yield and drop (phase 001 D04, D05, D07, D08, D10). Every repo comes from
// makeRepo(), so the registry, the landing lock and the worktrees are the test's own.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path'), cp = require('child_process');
const { makeRepo, run, start, sh, writePlan, writeLedger, commitFile, onBranch, worktreeOf } = require('./fixtures/repo.js');
const R = require('../lib/registry.js');

const q = s => `'${String(s).replace(/'/g, `'\\''`)}'`;
// The fixture repo's targeted rule is `sh {files}`, so two test files run as one `sh` of the first
// with the second as its argument: each script records its own run in $T_MARK, then runs the next.
const mark = (name, body = '') => `#!/bin/sh\necho ${name} >> "$T_MARK"\n${body}${body ? '\n' : ''}if [ $# -gt 0 ]; then f=$1; shift; exec sh "$f" "$@"; fi\nexit 0\n`;
const marks = t => { try { return fs.readFileSync(t.env.T_MARK, 'utf8').split('\n').filter(Boolean); } catch (e) { return []; } };
const count = (t, name) => marks(t).filter(l => l === name).length;
const master = t => sh('git rev-parse master', t.root, t.env);
const merges = t => sh('git log --merges --format=%H master', t.root, t.env).split('\n').filter(Boolean);
const pkgOf = (t, id) => R.readRegistry(t.root).packages[id];
const receipts = t => R.readRegistry(t.root).receipts || [];
const branchExists = (t, id) => sh(`git branch --list ${q('holden/' + id)}`, t.root, t.env) !== '';
function editRegistry(t, fn) { const reg = R.readRegistry(t.root); fn(reg); fs.writeFileSync(R.paths(t.root).registry, JSON.stringify(reg, null, 2)); }

function repo() { const t = makeRepo(); t.env.T_MARK = path.join(t.dir, 'mark'); return t; }
const ledgerOf = (t, id) => path.join(t.dir, `${id}-LEDGER.md`);
// A phase plan, admitted with its ledger; `tests` are the ledger's proved tests.
function plan(t, id, files, { reads = [], tests = [] } = {}) {
  const f = writePlan(path.join(t.root, '.planning', 'phases', '001-x'), `${id}-PLAN.md`, { files, reads });
  const ledger = writeLedger(ledgerOf(t, id), tests);
  return run('h-queue', ['admit', id, '--kind', 'plan', '--owner', 'phase:' + id.split('-')[0], '--plan', f, '--ledger', ledger], { cwd: t.root, env: t.env });
}
function quick(t, id, writes, { tests = [] } = {}) {
  const ledger = writeLedger(ledgerOf(t, id), tests);
  return run('h-queue', ['admit', id, '--kind', 'quick', '--owner', 'quick:' + id, '--writes', ...writes, '--ledger', ledger], { cwd: t.root, env: t.env });
}
const ok = r => { assert.equal(r.code, 0, r.out); return r; };
const commit = (t, id, rel, content = rel + '\n') => onBranch(t.root, id, rel, content, 'change ' + rel, t.env);
const land = (t, id, extra = [], env = {}) => run('h-queue', ['land', id, '--ledger', ledgerOf(t, id), ...extra], { cwd: t.root, env: { ...t.env, ...env } });

// 001-01 declares a.txt and its test, and commits both.
function planWithTest(t, { reads = [] } = {}) {
  ok(plan(t, '001-01', ['a.txt', 'tests/t1.sh'], { reads, tests: ['tests/t1.sh'] }));
  commit(t, '001-01', 'tests/t1.sh', mark('t1'));
  return commit(t, '001-01', 'a.txt', 'changed\n');
}
function quickWithTest(t, id = '261018-q') {
  ok(quick(t, id, ['b.txt', 'tests/t2.sh'], { tests: ['tests/t2.sh'] }));
  commit(t, id, 'tests/t2.sh', mark('t2'));
  return commit(t, id, 'b.txt', 'changed\n');
}

test('h-queue land writes a receipt and releases the reservations', () => {
  const t = repo();
  const head = planWithTest(t);
  const target = commitFile(t.root, 'c.txt', 'c\n', 'unrelated on master', t.env);
  // No --ledger: the record's ledger from admission.
  const r = run('h-queue', ['land', '001-01'], { cwd: t.root, env: t.env });
  assert.equal(r.code, 0, r.out);
  const rc = receipts(t)[0];
  assert.equal(rc.id, '001-01');
  assert.equal(rc.submitted, head);
  assert.equal(rc.target, target);
  assert.equal(rc.candidate, master(t));
  assert.deepEqual(rc.tests, ['tests/t1.sh']);
  assert.equal(pkgOf(t, '001-01').state, 'landed');
  assert.deepEqual(pkgOf(t, '001-01').writes, []);
  ok(quick(t, '261018-q', ['a.txt']));
});

test('h-queue land prints the package commits as a quoted commits: line', () => {
  // skills/h-quick step 9 pastes it: the non-merge commits from the base, full shas, in order.
  const t = repo();
  planWithTest(t);
  commitFile(t.root, 'c.txt', 'c\n', 'unrelated on master', t.env);
  const own = sh('git rev-list --reverse holden/001-01 --not master', t.root, t.env).split('\n');
  assert.equal(own.length, 2);
  const r = ok(land(t, '001-01'));
  assert.ok(r.out.split('\n').includes(`commits: [${own.map(c => `"${c}"`).join(', ')}]`), r.out);
});

for (const order of [['001-01', '261018-q'], ['261018-q', '001-01']]) {
  test(`both landing orders land and the later one re-runs the earlier's tests (${order.join(' then ')})`, () => {
    const t = repo();
    planWithTest(t);
    quickWithTest(t);
    for (const id of order) ok(land(t, id));
    const first = order[0] === '001-01' ? 't1' : 't2', second = first === 't1' ? 't2' : 't1';
    assert.equal(count(t, first), 2, marks(t).join(','));
    assert.equal(count(t, second), 1, marks(t).join(','));
    assert.equal(merges(t).length, 2);
  });
}

test('an undeclared free path is granted and recorded', () => {
  const t = repo();
  ok(plan(t, '001-01', ['a.txt']));
  commit(t, '001-01', 'a.txt');
  commit(t, '001-01', 'b.txt');
  ok(land(t, '001-01'));
  const ev = R.readRegistry(t.root).events.find(e => e.id === '001-01' && e.kind === 'extended');
  assert.ok(ev, 'an extended event');
  assert.match(ev.text, /granted b\.txt; writes a\.txt, b\.txt/);
});

test('an undeclared path held by a higher package makes the quick yield', () => {
  const t = repo();
  ok(plan(t, '001-01', ['b.txt']));
  ok(quick(t, '261018-q', ['a.txt']));
  commit(t, '261018-q', 'a.txt');
  commit(t, '261018-q', 'b.txt');
  const before = master(t);
  const r = land(t, '261018-q');
  assert.equal(r.code, 71, r.out);
  assert.match(r.out, /yield 001-01 b\.txt/);
  assert.equal(master(t), before);
});

test('an undeclared manifest in the diff is held to the whole-repo rule', () => {
  const t = repo();
  ok(plan(t, '001-01', ['a.txt']));
  ok(quick(t, '261018-q', ['c.txt']));
  commit(t, '001-01', 'a.txt');
  commit(t, '001-01', 'package.json', '{}\n');
  const before = master(t);
  const r = land(t, '001-01');
  assert.equal(r.code, 70, r.out);
  assert.match(r.out, /manifest rule/);
  assert.equal(master(t), before);
});

test('an undeclared path held by a lower package makes the plan wait', () => {
  const t = repo();
  ok(quick(t, '261018-q', ['b.txt']));
  ok(plan(t, '001-01', ['a.txt']));
  commit(t, '001-01', 'b.txt');
  const r = land(t, '001-01');
  assert.equal(r.code, 70, r.out);
  assert.match(r.out, /wait 261018-q b\.txt/);
  assert.equal(pkgOf(t, '001-01').state, 'waiting');
});

// git's rename detection would list only c.txt; the rank rule must see a.txt leave too.
test('a rename out of a held path is a write of that path', () => {
  const t = repo();
  ok(plan(t, '001-01', ['a.txt']));
  ok(quick(t, '261018-q', ['c.txt']));
  sh('git mv a.txt c.txt && git commit -q -m rename', worktreeOf('261018-q', t.env), t.env);
  const before = master(t);
  const r = land(t, '261018-q');
  assert.equal(r.code, 71, r.out);
  assert.match(r.out, /yield 001-01 a\.txt/);
  assert.equal(master(t), before);
});

test('h-queue land inside h-queue lock does not wait on itself', () => {
  const t = repo();
  planWithTest(t);
  const Q = path.join(__dirname, '..', 'bin', 'h-queue');
  // A land that waited on its caller's lock would sit out the 4 h window; 60 s is the bound here.
  const r = cp.spawnSync(process.execPath, [Q, 'lock', '--', process.execPath, Q, 'land', '001-01', '--ledger', ledgerOf(t, '001-01')], { cwd: t.root, env: t.env, encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 0, (r.stdout || '') + (r.stderr || '') + (r.error ? r.error.message : ''));
  assert.equal(merges(t).length, 1);
  assert.equal(pkgOf(t, '001-01').state, 'landed');
});

test('land refuses a diff that commits a metadata file', () => {
  const t = repo();
  ok(plan(t, '001-01', ['a.txt']));
  commit(t, '001-01', '.planning/state.yaml', 'project: changed\n');
  const before = master(t);
  const r = land(t, '001-01');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /\.planning\/state\.yaml/);
  assert.equal(master(t), before);
});

test('a changed read stops the landing with 76 until a ruling', () => {
  const t = repo();
  ok(plan(t, '001-01', ['a.txt'], { reads: ['b.txt'] }));
  commit(t, '001-01', 'a.txt');
  const T = commitFile(t.root, 'b.txt', 'changed\n', 'quick landed', t.env);
  const r = land(t, '001-01');
  assert.equal(r.code, 76, r.out);
  assert.match(r.out, /changed reads: b\.txt/);
  assert.equal(master(t), T);
  const r2 = land(t, '001-01', ['--reads-hold', 'b.txt gained a comment; the signature is the same']);
  assert.equal(r2.code, 0, r2.out);
  assert.match(fs.readFileSync(ledgerOf(t, '001-01'), 'utf8'), /^Reads ruling: b\.txt gained a comment/m);
  assert.equal(pkgOf(t, '001-01').reads_ruling.upto, T);
});

test('a ruling covers only the range it was given', () => {
  const t = repo();
  ok(plan(t, '001-01', ['a.txt'], { reads: ['b.txt'] }));
  commit(t, '001-01', 'a.txt');
  const T1 = commitFile(t.root, 'b.txt', 'changed\n', 'quick landed', t.env);
  const r = land(t, '001-01', ['--reads-hold', 'b.txt gained a comment'], { HOLDEN_TEST_CRASH_AT: 'queue-before-land' });
  assert.equal(r.code, 99, r.out);
  assert.equal(master(t), T1);
  assert.equal(pkgOf(t, '001-01').reads_ruling.upto, T1);
  const T2 = commitFile(t.root, 'b.txt', 'changed again\n', 'second change', t.env);
  const r2 = land(t, '001-01');
  assert.equal(r2.code, 76, r2.out);
  assert.match(r2.out, /changed reads: b\.txt/);
  assert.ok(r2.out.includes(`range: ${T1}..${T2}`), r2.out);
  ok(land(t, '001-01', ['--reads-hold', 'the second change is a comment too']));
});

test('yield drops with a patch and parks', () => {
  const t = repo();
  ok(plan(t, '001-01', ['a.txt']));
  const wt = worktreeOf('001-01', t.env);
  const head = sh('git rev-parse holden/001-01', t.root, t.env);
  fs.writeFileSync(path.join(wt, 'a.txt'), 'uncommitted\n');
  const r = run('h-queue', ['yield', '001-01', '--reason', 'yield on 261018-q for a.txt'], { cwd: t.root, env: t.env });
  assert.equal(r.code, 0, r.out);
  const p = pkgOf(t, '001-01');
  assert.equal(p.state, 'parked');
  assert.equal(p.head, head);
  assert.ok(p.patch && p.patch.endsWith('-dropped-r1' + '.patch'), JSON.stringify(p));
  assert.deepEqual(p.writes, []);
  assert.equal(p.yields, 1);
  assert.ok(!branchExists(t, '001-01'));
  assert.equal(master(t), head);
  sh(`git apply --check ${q(p.patch)}`, t.root, t.env);
  const moved = path.join(t.dir, '001-01-LEDGER-dropped-r1.md');
  assert.match(fs.readFileSync(moved, 'utf8'), new RegExp(`^Dropped: .*uncommitted work saved in ${path.basename(p.patch).replace(/\./g, '\\.')}`, 'm'));
});

test('drop counts drops and leaves yields alone', () => {
  const t = repo();
  ok(plan(t, '001-01', ['a.txt']));
  ok(run('h-queue', ['drop', '001-01', '--reason', 'red on the merged tree: tests/t1.sh'], { cwd: t.root, env: t.env }));
  assert.equal(pkgOf(t, '001-01').drops, 1);
  assert.equal(pkgOf(t, '001-01').yields, 0);
  ok(run('h-queue', ['admit', '001-01'], { cwd: t.root, env: t.env }));
  ok(run('h-queue', ['drop', '001-01', '--reason', 'conflict'], { cwd: t.root, env: t.env }));
  assert.equal(pkgOf(t, '001-01').drops, 2);
});

test('re-admission of a parked package reuses its declaration', () => {
  const t = repo();
  ok(plan(t, '001-01', ['a.txt']));
  ok(run('h-queue', ['yield', '001-01', '--reason', 'x'], { cwd: t.root, env: t.env }));
  assert.deepEqual(pkgOf(t, '001-01').writes, []);
  const T = commitFile(t.root, 'c.txt', 'c\n', 'moved on', t.env);
  ok(run('h-queue', ['admit', '001-01'], { cwd: t.root, env: t.env }));
  const p = pkgOf(t, '001-01');
  assert.equal(p.base, T);
  assert.ok(fs.existsSync(p.worktree));
  assert.deepEqual(p.writes, ['a.txt']);
  assert.equal(p.yields, 1);
});

test('a crash after h-worktree landed but before the receipt is recovered', () => {
  const t = repo();
  planWithTest(t);
  quickWithTest(t);
  const before = master(t);
  const r = land(t, '001-01', [], { HOLDEN_TEST_CRASH_AT: 'queue-after-land' });
  assert.equal(r.code, 99, r.out);
  assert.notEqual(master(t), before);
  assert.equal(receipts(t).length, 0);
  const r2 = land(t, '001-01');
  assert.equal(r2.code, 0, r2.out);
  assert.match(r2.out, /recovered from git/);
  const rc = receipts(t)[0];
  assert.equal(rc.recovered, true);
  assert.deepEqual(rc.tests, ['tests/t1.sh']);
  assert.equal(count(t, 't1'), 1);
  assert.equal(pkgOf(t, '001-01').state, 'landed');
  assert.ok(!branchExists(t, '001-01'));
  assert.ok(!fs.existsSync(path.join(path.dirname(worktreeOf('261018-q', t.env)), '001-01')));
  const r3 = land(t, '001-01');
  assert.equal(r3.code, 0, r3.out);
  assert.match(r3.out, /already landed/);
  assert.equal(count(t, 't1'), 1);
  // The recovered receipt's tests reach the next landing (D08).
  ok(land(t, '261018-q'));
  assert.equal(count(t, 't1'), 2);
});

test('recovery does not need the branch', () => {
  const t = repo();
  planWithTest(t);
  assert.equal(land(t, '001-01', [], { HOLDEN_TEST_CRASH_AT: 'queue-after-land' }).code, 99);
  assert.ok(!branchExists(t, '001-01'), 'h-worktree land deleted the branch before the crash');
  const r = land(t, '001-01');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /recovered from git/);
});

test('a child that dies after the fast-forward still leaves a receipt with its tests', () => {
  const t = repo();
  planWithTest(t);
  quickWithTest(t);
  const r = land(t, '001-01', [], { HOLDEN_TEST_CRASH_AT: 'land-after-ff' });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /recovered from git after h-worktree exited 99/);
  assert.equal(merges(t).length, 1);
  assert.equal(receipts(t).length, 1);
  assert.equal(receipts(t)[0].recovered, true);
  assert.deepEqual(receipts(t)[0].tests, ['tests/t1.sh']);
  assert.equal(pkgOf(t, '001-01').pending, null);
  ok(land(t, '261018-q'));
  assert.equal(count(t, 't1'), 2);
});

test('a crash before h-worktree land leaves everything as it was', () => {
  const t = repo();
  planWithTest(t);
  const before = master(t);
  const r = land(t, '001-01', [], { HOLDEN_TEST_CRASH_AT: 'queue-before-land' });
  assert.equal(r.code, 99, r.out);
  assert.equal(master(t), before);
  assert.equal(pkgOf(t, '001-01').state, 'admitted');
  assert.equal(receipts(t).length, 0);
  ok(land(t, '001-01'));
  assert.equal(merges(t).length, 1);
  assert.equal(count(t, 't1'), 1);
  assert.equal(pkgOf(t, '001-01').state, 'landed');
});

test('two lands at once are serialised and the second re-runs the first\'s tests', async () => {
  const t = repo();
  planWithTest(t);
  quickWithTest(t);
  const a = start('h-queue', ['land', '001-01', '--ledger', ledgerOf(t, '001-01')], { cwd: t.root, env: t.env });
  const b = start('h-queue', ['land', '261018-q', '--ledger', ledgerOf(t, '261018-q')], { cwd: t.root, env: t.env });
  const [ra, rb] = await Promise.all([a.done, b.done]);
  assert.equal(ra.code, 0, ra.out);
  assert.equal(rb.code, 0, rb.out);
  assert.equal(merges(t).length, 2);
  assert.equal(marks(t).length, 3, marks(t).join(','));
});

test('the landing lock outlives an h-queue land killed while h-worktree land runs', async () => {
  const t = repo();
  ok(plan(t, '001-01', ['a.txt', 'tests/t1.sh'], { tests: ['tests/t1.sh'] }));
  // The test says when the landing is inside its tests, and stays there for 3 s.
  commit(t, '001-01', 'tests/t1.sh', mark('t1', 'touch "$T_MARK.in"; sleep 3'));
  const lk = R.paths(t.root).landingLock;
  const l = start('h-queue', ['land', '001-01', '--ledger', ledgerOf(t, '001-01')], { cwd: t.root, env: t.env });
  for (let i = 0; i < 300 && !fs.existsSync(t.env.T_MARK + '.in'); i++) await R.sleep(50);
  assert.ok(fs.existsSync(t.env.T_MARK + '.in'), 'the landing reached its tests');
  // Only h-queue dies; its h-worktree land child and the lock's holder live on.
  // 'exit', not l.done: the lock's holder inherits h-queue's stderr, so the pipes close only when it does.
  const exited = new Promise(r => l.child.once('exit', r));
  l.child.kill('SIGKILL');
  await exited;
  await R.sleep(300);
  const during = await R.holdLock(lk, 0.3, 'test');
  if (during) await during.release();
  assert.equal(during, null, 'the lock is still held while the orphaned landing runs');
  // It frees once the orphan has exited.
  let freed = null;
  for (let i = 0; i < 60 && !freed; i++) freed = await R.holdLock(lk, 0.5, 'test');
  assert.ok(freed, 'the lock frees after the orphan exits');
  await freed.release();
  await l.done;
  // Whatever the orphan reached, the next land finishes the package once.
  ok(land(t, '001-01'));
  assert.equal(pkgOf(t, '001-01').state, 'landed');
  assert.equal(merges(t).length, 1);
});

test('land on a parked package is refused', () => {
  const t = repo();
  ok(plan(t, '001-01', ['a.txt']));
  ok(run('h-queue', ['yield', '001-01', '--reason', 'x'], { cwd: t.root, env: t.env }));
  const r = land(t, '001-01');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /parked; admit it again/);
});

test('land with no branch and no receipt is refused', () => {
  const t = repo();
  ok(plan(t, '001-01', ['a.txt']));
  // The branch goes behind the registry's back; the record still says admitted.
  ok(run('h-worktree', ['drop', '001-01', '--ledger', writeLedger(path.join(t.dir, 'raw.md'), []), '--reason', 'raw'], { cwd: t.root, env: t.env }));
  const r = land(t, '001-01');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /no branch and no receipt for 001-01/);
});

test('land passes a red merged tree through as 4', () => {
  const t = repo();
  ok(plan(t, '001-01', ['a.txt', 'tests/t1.sh'], { tests: ['tests/t1.sh'] }));
  commit(t, '001-01', 'tests/t1.sh', 'exit 1\n');
  const before = master(t);
  const r = land(t, '001-01');
  assert.equal(r.code, 4, r.out);
  assert.equal(master(t), before);
  assert.equal(pkgOf(t, '001-01').state, 'admitted');
  assert.equal(pkgOf(t, '001-01').pending, null);
  assert.equal(receipts(t).length, 0);
});

test('yield on a never-started package parks it', () => {
  const t = repo();
  ok(plan(t, '001-01', ['a.txt']));
  ok(run('h-worktree', ['drop', '001-01', '--ledger', writeLedger(path.join(t.dir, 'raw.md'), []), '--reason', 'raw'], { cwd: t.root, env: t.env }));
  const r = run('h-queue', ['yield', '001-01', '--reason', 'x'], { cwd: t.root, env: t.env });
  assert.equal(r.code, 0, r.out);
  assert.equal(pkgOf(t, '001-01').state, 'parked');
  assert.equal(pkgOf(t, '001-01').head, null);
});

test('a yield killed inside drop parks with the head and the patch on the next yield', () => {
  const t = repo();
  ok(plan(t, '001-01', ['a.txt']));
  fs.writeFileSync(path.join(worktreeOf('001-01', t.env), 'a.txt'), 'uncommitted\n');
  const head = sh('git rev-parse holden/001-01', t.root, t.env);
  const r = run('h-queue', ['yield', '001-01', '--reason', 'x'], { cwd: t.root, env: { ...t.env, HOLDEN_TEST_CRASH_AT: 'drop-after-branch' } });
  assert.equal(r.code, 1, r.out);
  assert.equal(pkgOf(t, '001-01').state, 'admitted');
  assert.ok(!branchExists(t, '001-01'));
  ok(run('h-queue', ['yield', '001-01', '--reason', 'x'], { cwd: t.root, env: t.env }));
  const p = pkgOf(t, '001-01');
  assert.equal(p.state, 'parked');
  assert.equal(p.head, head);
  assert.ok(p.patch && fs.existsSync(p.patch), JSON.stringify(p));
  assert.ok(fs.existsSync(path.join(t.dir, '001-01-LEDGER-dropped-r1.md')));
});

test('a branch-less yield keeps the record\'s head and patch', () => {
  const t = repo();
  ok(plan(t, '001-01', ['a.txt']));
  ok(run('h-worktree', ['drop', '001-01', '--ledger', writeLedger(path.join(t.dir, 'raw.md'), []), '--reason', 'raw'], { cwd: t.root, env: t.env }));
  editRegistry(t, reg => Object.assign(reg.packages['001-01'], { head: 'a'.repeat(40), patch: '/somewhere/001-01-LEDGER-dropped-r1.patch' }));
  ok(run('h-queue', ['yield', '001-01', '--reason', 'x'], { cwd: t.root, env: t.env }));
  const p = pkgOf(t, '001-01');
  assert.equal(p.state, 'parked');
  assert.equal(p.head, 'a'.repeat(40));
  assert.equal(p.patch, '/somewhere/001-01-LEDGER-dropped-r1.patch');
});

test('yield refuses when drop refuses', () => {
  const t = repo();
  ok(plan(t, '001-01', ['a.txt']));
  fs.unlinkSync(path.join(worktreeOf('001-01', t.env), '.git'));
  const r = run('h-queue', ['yield', '001-01', '--reason', 'x'], { cwd: t.root, env: t.env });
  assert.equal(r.code, 1, r.out);
  assert.equal(pkgOf(t, '001-01').state, 'admitted');
  assert.ok(branchExists(t, '001-01'));
});

test('yield writes a stub ledger when none exists', () => {
  const t = repo();
  ok(plan(t, '001-01', ['a.txt']));
  fs.unlinkSync(ledgerOf(t, '001-01'));
  const r = run('h-queue', ['yield', '001-01', '--reason', 'x'], { cwd: t.root, env: t.env });
  assert.equal(r.code, 0, r.out);
  const moved = fs.readFileSync(path.join(t.dir, '001-01-LEDGER-dropped-r1.md'), 'utf8');
  assert.match(moved, /^# Executor ledger: 001-01\nPlan: .*001-01-PLAN\.md\n/);
  assert.match(moved, /^Dropped: holden\/001-01 at /m);
});

test('a quick id with a slug is admitted and lands', () => {
  const t = repo();
  ok(quick(t, '261018-review-fixes', ['a.txt']));
  commit(t, '261018-review-fixes', 'a.txt');
  ok(land(t, '261018-review-fixes'));
  assert.equal(pkgOf(t, '261018-review-fixes').state, 'landed');
});
