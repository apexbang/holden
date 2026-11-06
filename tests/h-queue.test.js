'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path'), cp = require('child_process');
const { makeRepo, run, start, sh, writePlan, writeLedger, commitFile } = require('./fixtures/repo.js');
const R = require('../lib/registry.js');
// A lock taken here is released at once: a held lock keeps this process alive.
async function busy(lockPath, label) { const l = await R.holdLock(lockPath, 0.5, label); if (l) await l.release(); return !l; }
const LIB = path.join(__dirname, '..', 'lib', 'registry.js');

const lastLine = out => out.trim().split('\n').pop();
const pkgOf = (root, id) => R.readRegistry(root).packages[id];
const planIn = (root, name, opts) => writePlan(path.join(root, '.planning', 'phases', '001-x'), name, opts);
function admitPlan(t, id, files, extra = []) {
  const f = planIn(t.root, `${id}-PLAN.md`, { files });
  return run('h-queue', ['admit', id, '--kind', 'plan', '--owner', 'phase:' + id.split('-')[0], '--plan', f, ...extra], { cwd: t.root, env: t.env });
}
const admitQuick = (t, id, writes) => run('h-queue', ['admit', id, '--kind', 'quick', '--owner', 'quick:' + id, '--writes', ...writes], { cwd: t.root, env: t.env });
// Written straight into the registry file, as plan 3's park and landing will write it.
function editRegistry(root, fn) { const reg = R.readRegistry(root); fn(reg); fs.writeFileSync(R.paths(root).registry, JSON.stringify(reg, null, 2)); }
// Another process holds the lock until killed, as a running landing or freeze would. It exits by
// itself after 60 s: a held lock keeps its event loop alive, so a failed test would otherwise hang.
async function holdFromChild(lockPath) {
  const child = cp.spawn(process.execPath, ['-e', `require(${JSON.stringify(LIB)}).holdLock(${JSON.stringify(lockPath)}, 60, 'test').then(() => setTimeout(() => process.exit(0), 60000))`], { stdio: 'ignore' });
  for (let i = 0; i < 100; i++) { if (fs.existsSync(lockPath + '.holder') && fs.readFileSync(lockPath + '.holder', 'utf8').startsWith('test')) break; await R.sleep(50); }
  return child;
}

test('admit refuses when concurrency is off', () => {
  const t = makeRepo({ concurrency: false });
  const r = admitQuick(t, '261018-1', ['a.txt']);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /concurrency is off/);
  // From inside a worktree whose own config says true, the main checkout's config still rules (D02).
  const wt = lastLine(run('h-worktree', ['add', '009-01'], { cwd: t.root, env: t.env }).out);
  fs.writeFileSync(path.join(wt, '.holden', 'config.yaml'), fs.readFileSync(path.join(wt, '.holden', 'config.yaml'), 'utf8').replace('concurrency: false', 'concurrency: true'));
  const r2 = admitQuick({ ...t, root: wt }, '261018-2', ['a.txt']);
  assert.equal(r2.code, 1, r2.out);
  assert.match(r2.out, /concurrency is off/);
});

test('admit reserves, takes the base and makes the worktree', () => {
  const t = makeRepo();
  const f = planIn(t.root, '001-01-PLAN.md', { files: ['a.txt'], reads: ['b.txt'] });
  const r = run('h-queue', ['admit', '001-01', '--kind', 'plan', '--owner', 'phase:001', '--plan', f], { cwd: t.root, env: t.env });
  assert.equal(r.code, 0, r.out);
  const wt = lastLine(r.out);
  assert.ok(fs.existsSync(wt));
  assert.equal(sh('git symbolic-ref --short HEAD', wt, t.env), 'holden/001-01');
  const p = pkgOf(t.root, '001-01');
  assert.equal(p.base, sh('git rev-parse HEAD', t.root, t.env));
  assert.deepEqual(p.writes, ['a.txt']);
  assert.deepEqual(p.reads, ['b.txt']);
  assert.equal(p.state, 'admitted');
  assert.match(p.transcript, /sess-1\.jsonl$/);
  assert.equal(p.seq, 1);
  assert.equal(p.worktree, wt);
});

test('admit refuses a metadata write', () => {
  const t = makeRepo();
  const r = admitQuick(t, '261018-1', ['a.txt', '.planning/state.yaml']);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /\.planning\/state\.yaml/);
  assert.match(r.out, /h-queue meta commit/);
});

test('admit refuses a plan without files', () => {
  const t = makeRepo();
  const f = planIn(t.root, '001-01-PLAN.md', { files: ['a.txt'] });
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/^files:\n  - a\.txt\n/m, ''));
  const r = run('h-queue', ['admit', '001-01', '--kind', 'plan', '--owner', 'phase:001', '--plan', f], { cwd: t.root, env: t.env });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /no files: in/);
});

test('two plans of one phase share a file', () => {
  const t = makeRepo();
  const r1 = admitPlan(t, '001-01', ['a.txt']);
  assert.equal(r1.code, 0, r1.out);
  const r2 = admitPlan(t, '001-02', ['a.txt']);
  assert.equal(r2.code, 0, r2.out);
});

test('a quick is parked behind a phase plan holding its file', () => {
  const t = makeRepo();
  assert.equal(admitPlan(t, '001-01', ['a.txt']).code, 0);
  const r = admitQuick(t, '261018-1', ['a.txt']);
  assert.equal(r.code, 70, r.out);
  const p = pkgOf(t.root, '261018-1');
  assert.equal(p.state, 'parked');
  assert.equal(p.waits_on.id, '001-01');
  assert.deepEqual(p.writes, []);
  assert.match(r.out, /yield on 001-01 for a\.txt/);
  assert.match(r.out, /h-queue wait 261018-1/);
});

test('a phase plan is parked behind a quick holding its file, as wait', () => {
  const t = makeRepo();
  assert.equal(admitQuick(t, '261018-1', ['a.txt']).code, 0);
  const r = admitPlan(t, '001-01', ['a.txt']);
  assert.equal(r.code, 70, r.out);
  assert.match(r.out, /wait on 261018-1 for a\.txt/);
});

test('a same-rank newcomer is parked as the later admission', () => {
  const t = makeRepo();
  assert.equal(admitPlan(t, '001-01', ['a.txt']).code, 0);
  const r = admitPlan(t, '002-01', ['a.txt']);
  assert.equal(r.code, 70, r.out);
  assert.match(r.out, /yield on 001-01 for a\.txt/);
  assert.equal(admitQuick(t, '261018-1', ['b.txt']).code, 0);
  const q = admitQuick(t, '261018-2', ['b.txt']);
  assert.equal(q.code, 70, q.out);
  assert.match(q.out, /yield on 261018-1 for b\.txt/);
});

test('a manifest package waits for an empty queue and blocks others', () => {
  const t = makeRepo();
  assert.equal(admitPlan(t, '001-01', ['a.txt']).code, 0);
  const r = admitPlan(t, '001-02', ['package.json']);
  assert.equal(r.code, 70, r.out);
  assert.match(r.out, /manifest rule/);
  const t2 = makeRepo();
  assert.equal(admitPlan(t2, '001-02', ['package.json']).code, 0);
  const r2 = admitPlan(t2, '001-01', ['a.txt']);
  assert.equal(r2.code, 70, r2.out);
  assert.match(r2.out, /manifest rule/);
});

test('a package declaring nothing is not admitted beside a manifest package', () => {
  const t = makeRepo();
  assert.equal(admitPlan(t, '001-01', ['package.json']).code, 0);
  const r = run('h-queue', ['admit', '261018-1', '--kind', 'quick', '--owner', 'quick:261018-1'], { cwd: t.root, env: t.env });
  assert.equal(r.code, 70, r.out);
  assert.match(r.out, /on 001-01 for package\.json \(manifest rule\)/);
});

test('admit is idempotent', () => {
  const t = makeRepo();
  const r1 = admitPlan(t, '001-01', ['a.txt']);
  assert.equal(r1.code, 0, r1.out);
  const r2 = admitPlan(t, '001-01', ['a.txt']);
  assert.equal(r2.code, 0, r2.out);
  assert.match(r2.out, /already admitted/);
  assert.equal(lastLine(r2.out), lastLine(r1.out));
  assert.equal(pkgOf(t.root, '001-01').seq, 1);
  assert.equal(R.readRegistry(t.root).seq, 1);
});

test('a landed id is refused', () => {
  const t = makeRepo();
  editRegistry(t.root, reg => { reg.packages['001-01'] = { id: '001-01', kind: 'plan', owner: 'phase:001', state: 'landed', candidate: 'abcdef1234', writes: [], declared: ['a.txt'] }; });
  const r = admitPlan(t, '001-01', ['a.txt']);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /landed at abcdef1/);
});

test('the base is HEAD under the landing lock', { timeout: 20000 }, async () => {
  const t = makeRepo();
  const holder = await holdFromChild(R.paths(t.root).landingLock);
  try {
    const f = planIn(t.root, '001-01-PLAN.md', { files: ['a.txt'] });
    const a = start('h-queue', ['admit', '001-01', '--kind', 'plan', '--owner', 'phase:001', '--plan', f], { cwd: t.root, env: t.env });
    await R.sleep(2000);
    assert.match(a.out, /waiting for landing lock/);
    assert.equal(pkgOf(t.root, '001-01'), undefined, 'nothing reserved while the lock is held');
    // A landing that moves master while the admit waits: the base must be the new HEAD.
    const moved = sh(`git commit -q --allow-empty -m landed && git rev-parse HEAD`, t.root, t.env);
    holder.kill('SIGKILL');
    const r = await a.done;
    assert.equal(r.code, 0, r.out);
    assert.equal(pkgOf(t.root, '001-01').base, moved);
  } finally { holder.kill('SIGKILL'); }
});

test('a crash after the reservation is recovered by the next admit', () => {
  const t = makeRepo();
  const f = planIn(t.root, '001-01-PLAN.md', { files: ['a.txt'] });
  const argv = ['admit', '001-01', '--kind', 'plan', '--owner', 'phase:001', '--plan', f];
  const r = run('h-queue', argv, { cwd: t.root, env: { ...t.env, HOLDEN_TEST_CRASH_AT: 'after-reserve' } });
  assert.equal(r.code, 99, r.out);
  const p = pkgOf(t.root, '001-01');
  assert.equal(p.state, 'admitted');
  assert.equal(p.worktree, null);
  assert.equal(fs.existsSync(path.join(t.env.XDG_CACHE_HOME, 'holden', 'wt')) && fs.readdirSync(path.join(t.env.XDG_CACHE_HOME, 'holden', 'wt')).some(d => fs.existsSync(path.join(t.env.XDG_CACHE_HOME, 'holden', 'wt', d, '001-01'))), false);
  const r2 = run('h-queue', argv, { cwd: t.root, env: t.env });
  assert.equal(r2.code, 0, r2.out);
  const wt = lastLine(r2.out);
  assert.ok(fs.existsSync(wt));
  const reg = R.readRegistry(t.root);
  assert.equal(reg.packages['001-01'].seq, 1);
  assert.equal(reg.packages['001-01'].worktree, wt);
  assert.equal(reg.events.filter(e => e.kind === 'admitted' && e.id === '001-01').length, 1);
});

test('h-worktree add failing leaves no record', () => {
  const t = makeRepo({ setup: ['false'] });
  const r = admitPlan(t, '001-01', ['a.txt']);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /setup failed/);
  assert.equal(pkgOf(t.root, '001-01'), undefined);
});

test('admit without a session records null transcript', () => {
  const t = makeRepo();
  delete t.env.CLAUDE_CODE_SESSION_ID;
  const r = admitPlan(t, '001-01', ['a.txt']);
  assert.equal(r.code, 0, r.out);
  const p = pkgOf(t.root, '001-01');
  assert.equal(p.session, null);
  assert.equal(p.transcript, null);
});

test('admit refuses a bad id', () => {
  const t = makeRepo();
  for (const id of ['-x', 'a/b']) {
    const r = run('h-queue', ['admit', id, '--kind', 'quick', '--owner', 'quick:x', '--writes', 'a.txt'], { cwd: t.root, env: t.env });
    assert.equal(r.code, 2, `${id}: ${r.out}`);
  }
  assert.deepEqual(R.readRegistry(t.root).packages, {});
});

const extend = (t, id, ...ps) => run('h-queue', ['extend', id, ...ps], { cwd: t.root, env: t.env });

test('a re-admission reserves the full declaration', () => {
  const t = makeRepo();
  assert.equal(admitPlan(t, '001-01', ['a.txt']).code, 0);
  assert.equal(extend(t, '001-01', 'b.txt').code, 0);
  // What plan 3's park leaves: the record parked, holding nothing, its declaration kept.
  editRegistry(t.root, reg => { Object.assign(reg.packages['001-01'], { state: 'parked', writes: [], worktree: null }); });
  const d = run('h-worktree', ['drop', '001-01', '--ledger', writeLedger(path.join(t.dir, 'l.md'), []), '--reason', 'test'], { cwd: t.root, env: t.env });
  assert.equal(d.code, 0, d.out);
  const r = run('h-queue', ['admit', '001-01'], { cwd: t.root, env: t.env });
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(pkgOf(t.root, '001-01').writes, ['a.txt', 'b.txt']);
  assert.equal(pkgOf(t.root, '001-01').seq, 1);
  const q = admitQuick(t, '261018-1', ['b.txt']);
  assert.equal(q.code, 70, q.out);
});

// A park as plan 3 leaves it (writes emptied, no worktree), then its worktree and branch dropped.
function parkAndDrop(t, id) {
  editRegistry(t.root, reg => { Object.assign(reg.packages[id], { state: 'parked', writes: [], worktree: null }); });
  const d = run('h-worktree', ['drop', id, '--ledger', writeLedger(path.join(t.dir, `${id}-l.md`), []), '--reason', 'test'], { cwd: t.root, env: t.env });
  assert.equal(d.code, 0, d.out);
}
const narrowedEvents = (root, id) => (R.readRegistry(root).events || []).filter(e => e.kind === 'narrowed' && e.id === id);
const quickPlan = (t, id, files) => writePlan(path.join(t.root, '.planning', 'quick', id), 'PLAN.md', { files });
const admitQuickPlan = (t, id, f) => run('h-queue', ['admit', id, '--kind', 'quick', '--owner', 'quick:' + id, '--plan', f], { cwd: t.root, env: t.env });

test("re-admission with --plan reserves the plan's current files", () => {
  const t = makeRepo();
  const f = planIn(t.root, '001-01-PLAN.md', { files: ['a.txt', 'b.txt'], reads: ['r1.txt', 'r2.txt'] });
  const first = run('h-queue', ['admit', '001-01', '--kind', 'plan', '--owner', 'phase:001', '--plan', f], { cwd: t.root, env: t.env });
  assert.equal(first.code, 0, first.out);
  parkAndDrop(t, '001-01');
  planIn(t.root, '001-01-PLAN.md', { files: ['a.txt'], reads: ['r1.txt'] });
  const r = run('h-queue', ['admit', '001-01', '--plan', f], { cwd: t.root, env: t.env });
  assert.equal(r.code, 0, r.out);
  const p = pkgOf(t.root, '001-01');
  assert.deepEqual(p.declared, ['a.txt']);
  assert.deepEqual(p.writes, ['a.txt']);
  assert.deepEqual(p.reads, ['r1.txt']);
  assert.match(r.out, /^narrowed 001-01: dropped b\.txt$/m);
  assert.equal(lastLine(r.out), p.worktree);
  assert.deepEqual(narrowedEvents(t.root, '001-01').map(e => e.text), ['dropped b.txt']);
  assert.equal(p.narrowed, undefined);
  const q = admitQuick(t, '261021-1', ['b.txt']);
  assert.equal(q.code, 0, q.out);
});

test('a narrowed re-admission parks only on what the plan still writes', () => {
  const t = makeRepo();
  assert.equal(admitQuick(t, '261021-q1', ['docs/x.md']).code, 0);
  const f = quickPlan(t, '261021-q2', ['docs/x.md', 'src/y.js']);
  assert.equal(admitQuickPlan(t, '261021-q2', f).code, 70);
  // The same plan again drops nothing: parked again, no event.
  assert.equal(admitQuickPlan(t, '261021-q2', f).code, 70);
  assert.deepEqual(narrowedEvents(t.root, '261021-q2'), []);
  quickPlan(t, '261021-q2', ['src/y.js']);
  const r = admitQuickPlan(t, '261021-q2', f);
  assert.equal(r.code, 0, r.out);
  const p = pkgOf(t.root, '261021-q2');
  assert.equal(p.state, 'admitted');
  assert.deepEqual(p.declared, ['src/y.js']);
  assert.deepEqual(narrowedEvents(t.root, '261021-q2').map(e => e.text), ['dropped docs/x.md']);
});

test('a narrowed re-admission that still conflicts parks again with the narrowed declaration', () => {
  const t = makeRepo();
  assert.equal(admitQuick(t, '261021-q1', ['docs/x.md']).code, 0);
  const f = quickPlan(t, '261021-q2', ['docs/x.md', 'src/y.js']);
  assert.equal(admitQuickPlan(t, '261021-q2', f).code, 70);
  quickPlan(t, '261021-q2', ['docs/x.md']);
  const r = admitQuickPlan(t, '261021-q2', f);
  assert.equal(r.code, 70, r.out);
  assert.match(r.out, /^narrowed 261021-q2: dropped src\/y\.js$/m);
  const p = pkgOf(t.root, '261021-q2');
  assert.equal(p.state, 'parked');
  assert.deepEqual(p.declared, ['docs/x.md']);
  assert.deepEqual(p.writes, []);
  assert.equal(p.narrowed, undefined);
  assert.deepEqual(narrowedEvents(t.root, '261021-q2').map(e => e.text), ['dropped src/y.js']);
});

test('a narrowed re-admission whose worktree fails keeps the parked record and logs nothing', () => {
  const t = makeRepo({ setup: ['false'] });
  editRegistry(t.root, reg => { reg.seq = 1; reg.packages['001-01'] = { id: '001-01', kind: 'plan', owner: 'phase:001', seq: 1, yields: 1, drops: 0,
    head: null, patch: null, state: 'parked', declared: ['a.txt', 'b.txt'], reads: [], writes: [], worktree: null, plan: null, ledger: null,
    waits_on: null, since: new Date().toISOString() }; });
  const before = pkgOf(t.root, '001-01');
  const f = planIn(t.root, '001-01-PLAN.md', { files: ['a.txt'] });
  const r = run('h-queue', ['admit', '001-01', '--plan', f], { cwd: t.root, env: t.env });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /setup failed/);
  assert.deepEqual(pkgOf(t.root, '001-01'), before);
  assert.deepEqual(narrowedEvents(t.root, '001-01'), []);
  assert.doesNotMatch(r.out, /narrowed/);
});

test('a re-admission with --plan drops a path an extend granted before the park', () => {
  const t = makeRepo();
  assert.equal(admitPlan(t, '001-01', ['a.txt']).code, 0);
  assert.equal(extend(t, '001-01', 'b.txt').code, 0);
  parkAndDrop(t, '001-01');
  const f = planIn(t.root, '001-01-PLAN.md', { files: ['a.txt'] });
  const r = run('h-queue', ['admit', '001-01', '--plan', f], { cwd: t.root, env: t.env });
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(pkgOf(t.root, '001-01').declared, ['a.txt']);
  assert.match(r.out, /^narrowed 001-01: dropped b\.txt$/m);
});

test('a crash after a narrowed reservation logs narrowed when the admission finishes', () => {
  const t = makeRepo();
  assert.equal(admitPlan(t, '001-01', ['a.txt', 'b.txt']).code, 0);
  parkAndDrop(t, '001-01');
  const f = planIn(t.root, '001-01-PLAN.md', { files: ['a.txt'] });
  const c = run('h-queue', ['admit', '001-01', '--plan', f], { cwd: t.root, env: { ...t.env, HOLDEN_TEST_CRASH_AT: 'after-reserve' } });
  assert.equal(c.code, 99, c.out);
  const p = pkgOf(t.root, '001-01');
  assert.equal(p.state, 'admitted');
  assert.equal(p.worktree, null);
  assert.deepEqual(p.declared, ['a.txt']);
  assert.deepEqual(narrowedEvents(t.root, '001-01'), []);
  const r = run('h-queue', ['admit', '001-01'], { cwd: t.root, env: t.env });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^narrowed 001-01: dropped b\.txt$/m);
  assert.deepEqual(narrowedEvents(t.root, '001-01').map(e => e.text), ['dropped b.txt']);
  assert.equal(pkgOf(t.root, '001-01').narrowed, undefined);
});

test('a re-admission with --writes and no --plan adds to the stored declaration', () => {
  const t = makeRepo();
  assert.equal(admitPlan(t, '001-01', ['a.txt']).code, 0);
  parkAndDrop(t, '001-01');
  const r = run('h-queue', ['admit', '001-01', '--writes', 'b.txt'], { cwd: t.root, env: t.env });
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(pkgOf(t.root, '001-01').declared, ['a.txt', 'b.txt']);
  assert.deepEqual(narrowedEvents(t.root, '001-01'), []);
});

test('extend grants a free path and keeps it', () => {
  const t = makeRepo();
  assert.equal(admitPlan(t, '001-01', ['a.txt']).code, 0);
  const r = extend(t, '001-01', 'b.txt');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /granted b\.txt/);
  assert.deepEqual(pkgOf(t.root, '001-01').writes, ['a.txt', 'b.txt']);
  assert.equal(extend(t, '001-01', 'a.txt').code, 0);
  assert.deepEqual(pkgOf(t.root, '001-01').writes, ['a.txt', 'b.txt']);
  assert.deepEqual(pkgOf(t.root, '001-01').declared, ['a.txt', 'b.txt']);
});

test('extend waits when the holder ranks lower', () => {
  const t = makeRepo();
  assert.equal(admitQuick(t, '261018-1', ['b.txt']).code, 0);
  assert.equal(admitPlan(t, '001-01', ['a.txt']).code, 0);
  const r = extend(t, '001-01', 'b.txt');
  assert.equal(r.code, 70, r.out);
  assert.match(r.out, /wait 261018-1 b\.txt/);
  const p = pkgOf(t.root, '001-01');
  assert.equal(p.state, 'waiting');
  assert.equal(p.waits_on.id, '261018-1');
});

test('extend yields when the holder ranks higher', () => {
  const t = makeRepo();
  assert.equal(admitPlan(t, '001-01', ['b.txt']).code, 0);
  assert.equal(admitQuick(t, '261018-1', ['a.txt']).code, 0);
  const r = extend(t, '261018-1', 'b.txt');
  assert.equal(r.code, 71, r.out);
  assert.match(r.out, /yield 001-01 b\.txt/);
  assert.equal(pkgOf(t.root, '261018-1').state, 'admitted');
  assert.deepEqual(pkgOf(t.root, '261018-1').writes, ['a.txt']);
});

test('extend refuses a metadata path', () => {
  const t = makeRepo();
  assert.equal(admitPlan(t, '001-01', ['a.txt']).code, 0);
  const r = extend(t, '001-01', '.planning/asks.yaml');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /h-queue meta commit/);
  assert.deepEqual(pkgOf(t.root, '001-01').writes, ['a.txt']);
});

test('extend of a manifest waits for the repo to empty and then blocks others', () => {
  const both = () => { const t = makeRepo(); assert.equal(admitPlan(t, '001-01', ['a.txt']).code, 0); assert.equal(admitQuick(t, '261018-1', ['b.txt']).code, 0); return t; };
  const t1 = both();
  const r1 = extend(t1, '001-01', 'package.json');
  assert.equal(r1.code, 70, r1.out);
  assert.match(r1.out, /wait 261018-1 package\.json/);
  const t2 = both();
  assert.equal(extend(t2, '261018-1', 'package.json').code, 71);
  const t3 = makeRepo();
  assert.equal(admitPlan(t3, '001-01', ['a.txt']).code, 0);
  const r3 = extend(t3, '001-01', 'package.json');
  assert.equal(r3.code, 0, r3.out);
  assert.equal(pkgOf(t3.root, '001-01').alone, 'package.json');
  const q = admitQuick(t3, '261018-1', ['c.txt']);
  assert.equal(q.code, 70, q.out);
  assert.match(q.out, /manifest rule/);
});

test('a request conflicting with several holders yields to any higher one', () => {
  // The quick first, so it is the first conflict the registry lists for a manifest request.
  const t = makeRepo();
  assert.equal(admitQuick(t, '261018-1', ['b.txt']).code, 0);
  assert.equal(admitPlan(t, '001-01', ['a.txt']).code, 0);
  assert.equal(admitPlan(t, '002-01', ['c.txt']).code, 0);
  const y = extend(t, '002-01', 'package.json');
  assert.equal(y.code, 71, y.out);
  assert.match(y.out, /yield 001-01 package\.json/);
  assert.equal(pkgOf(t.root, '002-01').state, 'admitted');
  const w = extend(t, '001-01', 'package.json');
  assert.equal(w.code, 70, w.out);
  assert.match(w.out, /wait 002-01 package\.json/);
  assert.equal(pkgOf(t.root, '001-01').waits_on.id, '002-01');
  const a = admitPlan(t, '003-01', ['package.json']);
  assert.equal(a.code, 70, a.out);
  assert.match(a.out, /yield on 001-01 for package\.json/);
});

test('extend grants paths in order and stops at the first conflict', () => {
  const t = makeRepo();
  assert.equal(admitPlan(t, '001-01', ['a.txt']).code, 0);
  assert.equal(admitQuick(t, '261018-1', ['b.txt']).code, 0);
  const r = extend(t, '261018-1', 'c.txt', 'a.txt', 'd.txt');
  assert.equal(r.code, 71, r.out);
  assert.match(r.out, /granted c\.txt\nyield 001-01 a\.txt/);
  assert.doesNotMatch(r.out, /d\.txt/);
  assert.deepEqual(pkgOf(t.root, '261018-1').writes, ['b.txt', 'c.txt']);
});

test('extend on a parked package is refused', () => {
  const t = makeRepo();
  assert.equal(admitPlan(t, '001-01', ['a.txt']).code, 0);
  assert.equal(admitQuick(t, '261018-1', ['a.txt']).code, 70);
  const r = extend(t, '261018-1', 'b.txt');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /261018-1 is parked/);
});

test("beat updates the heartbeat of the worktree's package", async () => {
  const t = makeRepo();
  const wt = lastLine(admitPlan(t, '001-01', ['a.txt']).out);
  const before = pkgOf(t.root, '001-01').heartbeat;
  await R.sleep(1100);
  const r = run('h-queue', ['beat', path.join(wt, '.planning')], { cwd: t.root, env: t.env });
  assert.equal(r.code, 0);
  assert.equal(r.out, '');
  const after = pkgOf(t.root, '001-01').heartbeat;
  assert.ok(after > before, `${after} > ${before}`);
  assert.equal(run('h-queue', ['beat', t.root], { cwd: t.root, env: t.env }).code, 0);
  assert.equal(pkgOf(t.root, '001-01').heartbeat, after);
  const out = run('h-queue', ['beat', '/tmp'], { cwd: '/tmp', env: t.env });
  assert.equal(out.code, 0);
  assert.equal(out.out, '');
});

test('status lists packages and events', () => {
  const t = makeRepo();
  const wt = lastLine(admitPlan(t, '001-01', ['a.txt']).out);
  assert.equal(admitQuick(t, '261018-1', ['a.txt']).code, 70);
  const st = () => run('h-queue', ['status'], { cwd: t.root, env: t.env });
  const r = st();
  assert.equal(r.code, 0, r.out);
  const line = id => r.out.split('\n').find(l => l.startsWith(id + '  '));
  assert.match(line('001-01'), /  plan  phase:001  admitted  since \S+  -  next: runs; lands with h-queue land 001-01  /);
  assert.match(line('001-01'), new RegExp(`  ${wt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}  diff: clean$`));
  assert.match(line('261018-1'), /  quick  quick:261018-1  parked  since \S+  waits on 001-01 for a\.txt  next: re-admitted when 001-01 lands; h-queue wait 261018-1  -  diff: -$/);
  assert.match(r.out, /^recent:$/m);
  assert.match(r.out, /admitted 001-01: base \w{7} writes 1 reads 0/);
  assert.match(r.out, /parked 261018-1: yield on 001-01 for a\.txt/);
  fs.writeFileSync(path.join(wt, 'a.txt'), 'changed\n');
  assert.match(st().out, /diff: 1 file changed/);
  assert.match(run('h-queue', ['status', '--summary'], { cwd: t.root, env: t.env }).out, /^packages: 1 running, 0 waiting, 1 parked, 0 stale, 0 stuck; \/h-queue for the list$/m);
  const j = JSON.parse(run('h-queue', ['status', '--json'], { cwd: t.root, env: t.env }).out);
  assert.ok(j.packages['001-01']);
});

test('two concurrent extends on one path grant one', async () => {
  const t = makeRepo();
  assert.equal(admitPlan(t, '001-01', ['a.txt']).code, 0);
  assert.equal(admitQuick(t, '261018-1', ['c.txt']).code, 0);
  const a = start('h-queue', ['extend', '001-01', 'b.txt'], { cwd: t.root, env: t.env });
  const b = start('h-queue', ['extend', '261018-1', 'b.txt'], { cwd: t.root, env: t.env });
  const codes = (await Promise.all([a.done, b.done])).map(r => r.code);
  assert.equal(codes.filter(c => c === 0).length, 1, codes.join(','));
  assert.equal(codes.filter(c => c === 70 || c === 71).length, 1, codes.join(','));
  const holders = Object.values(R.readRegistry(t.root).packages).filter(p => p.writes.includes('b.txt'));
  assert.equal(holders.length, 1);
});

test('status with no registry prints none', () => {
  const t = makeRepo();
  const r = run('h-queue', ['status'], { cwd: t.root, env: t.env });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /packages: none/);
  assert.match(run('h-queue', ['status', '--summary'], { cwd: t.root, env: t.env }).out, /^packages: none$/m);
});

const queue = (t, ...a) => run('h-queue', a, { cwd: t.root, env: t.env });
// Waits until the landing lock's holder file names this label: the command is running under it.
async function heldBy(root, label) {
  const f = R.paths(root).landingLock + '.holder';
  for (let i = 0; i < 100; i++) { if (fs.existsSync(f) && fs.readFileSync(f, 'utf8').startsWith(label + ' ')) return; await R.sleep(50); }
  throw new Error(`the landing lock was never held by ${label}`);
}

test('lock runs the command holding the landing lock', async () => {
  const t = makeRepo();
  const a = start('h-queue', ['lock', '--', 'sleep 1; echo done'], { cwd: t.root, env: t.env });
  await heldBy(t.root, 'lock');
  assert.equal(await busy(R.paths(t.root).landingLock, 'test'), true);
  const r = await a.done;
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /done/);
});

test("lock passes the command's exit code through", async () => {
  const t = makeRepo();
  assert.equal(queue(t, 'lock', '--', 'exit 7').code, 7);
  const l = await R.holdLock(R.paths(t.root).landingLock, 1, 'test');
  assert.ok(l, 'released after a failing command');
  await l.release();
});

test('lock is re-entrant', async () => {
  const t = makeRepo();
  const a = start('h-queue', ['lock', '--', `${process.execPath} ${path.join(__dirname, '..', 'bin', 'h-queue')} lock -- echo inner`], { cwd: t.root, env: t.env });
  // An inner lock that waited on the outer one would wait 4 hours; 15 s is the verdict.
  const r = await Promise.race([a.done, R.sleep(15000).then(() => ({ code: 'timeout', out: a.out }))]);
  a.child.kill('SIGKILL');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /inner/);
});

test('lock --next-phase refuses a stale number', () => {
  const t = makeRepo();
  commitFile(t.root, '.planning/phases/002-x/002-DECISION.md', 'x\n', 'phase 2', t.env);
  const r = queue(t, 'lock', '--next-phase', '002', '--', 'true');
  assert.equal(r.code, 73, r.out);
  assert.match(r.out, /next phase is 003/);
  assert.equal(queue(t, 'lock', '--next-phase', '003', '--', 'true').code, 0);
});

test("lock --next-phase accepts the grill's own uncommitted phase", () => {
  const t = makeRepo();
  fs.mkdirSync(path.join(t.root, '.planning', 'phases', '002-new'), { recursive: true });
  fs.writeFileSync(path.join(t.root, '.planning', 'phases', '002-new', '002-DECISION.md'), 'x\n');
  const st = path.join(t.root, '.planning', 'state.yaml');
  fs.writeFileSync(st, fs.readFileSync(st, 'utf8').replace(/^quick:/m, '  - number: 2\n    slug: new\n    status: grilled\nquick:'));
  const r = queue(t, 'lock', '--next-phase', '002', '--', 'git add .planning/phases/002-new && git commit -qm d');
  assert.equal(r.code, 0, r.out);
  assert.equal(sh('git log -1 --format=%s', t.root, t.env), 'd');
});

test('lock --next-phase ignores non-integer numbers', () => {
  const t = makeRepo();
  const st = path.join(t.root, '.planning', 'state.yaml');
  const add = (...ns) => fs.readFileSync(st, 'utf8').replace(/^quick:/m, ns.map(n => `  - number: ${n}\n    slug: s\n    status: landed\n`).join('') + 'quick:');
  commitFile(t.root, '.planning/state.yaml', add(2, 999.9, '18a', 'null'), 'phases', t.env);
  commitFile(t.root, '.planning/phases/999.9-later/999.9-DECISION.md', 'x\n', 'insert dir', t.env);
  const r = queue(t, 'lock', '--next-phase', '003', '--', 'true');
  assert.equal(r.code, 0, r.out);
  // A quoted all-digit number counts as its integer.
  commitFile(t.root, '.planning/state.yaml', add('"004"'), 'phase 4', t.env);
  const r2 = queue(t, 'lock', '--next-phase', '003', '--', 'true');
  assert.equal(r2.code, 73, r2.out);
  assert.match(r2.out, /next phase is 005, not 003/);
});

// A repo whose shared files are each edited in the tree, so a wrapped commit that staged one would carry it.
function sharedDirtyRepo() {
  const t = makeRepo({ files: { 'a.txt': 'a\n', 'b.txt': 'b\n', 'CLAUDE.md': 'c\n', 'docs/CONTEXT.md': 'c\n', '.planning/ledger.md': 'l\n' } });
  for (const f of ['.planning/state.yaml', 'CLAUDE.md', 'docs/CONTEXT.md', '.planning/ledger.md', '.holden/radius.yaml']) {
    const p = path.join(t.root, f); fs.writeFileSync(p, (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '') + '# edited\n');
  }
  fs.writeFileSync(path.join(t.root, 'list'), '.planning/state.yaml\n');
  return t;
}
function assertRefused(t, r, form) {
  assert.equal(r.code, 1, `${form}: ${r.out}`);
  assert.match(r.out, /h-queue meta commit/, form);
  assert.equal(sh('git log -1 --format=%s', t.root, t.env), 'init', form);
  assert.equal(cp.spawnSync('git', ['diff', '--cached', '--quiet'], { cwd: t.root, env: t.env }).status, 0, form);
  assert.ok(!fs.existsSync(path.join(t.root, 'ran')), `${form}: the command ran`);
}

test('lock refuses a wrapped command that stages a shared file', { timeout: 60000 }, async () => {
  const forms = root => [
    'git add .planning/state.yaml && git commit -qm x',
    'git add .planning && git commit -qm x',
    'git add -A && git commit -qm x',
    'git add . && git commit -qm x',
    'git commit -qam x',
    'git commit -qm x -- .planning/state.yaml',
    'git commit -qm x CLAUDE.md',
    "bash -c 'git add docs/CONTEXT.md'",
    'git -C .planning add state.yaml',
    "git add '.planning/*.yaml'",
    'git rm -q --cached .planning/ledger.md',
    'git stage .holden/radius.yaml',
    'git add --pathspec-from-file=list',
    'git add .planning/ && git commit -qm x',
    `git -C ${root} add .planning/state.yaml`,
    `git add ${root}/.planning/state.yaml`,
    'git add -Av && git commit -qm x',
    'git add -vA && git commit -qm x',
    'git stage -uv && git commit -qm x',
    `git add ${root}-link/.planning/state.yaml`,
  ];
  for (const i of forms('').keys()) {
    const t = sharedDirtyRepo(), form = forms(t.root)[i];
    fs.symlinkSync(t.root, t.root + '-link');   // the `~/.claude/holden` shape: an absolute path through a link
    assertRefused(t, queue(t, 'lock', '--', `${form}; touch ran`), form);
  }
  // A refusal waits on no landing: it comes before the lock.
  const t = sharedDirtyRepo();
  const holder = await holdFromChild(R.paths(t.root).landingLock);
  try {
    const s = cp.spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'h-queue'), 'lock', '--', 'git add .planning && git commit -qm x; touch ran'], { cwd: t.root, env: t.env, encoding: 'utf8', timeout: 5000 });
    assertRefused(t, { code: s.status, out: (s.stdout || '') + (s.stderr || '') }, 'under a held lock');
  } finally { holder.kill('SIGKILL'); }
});

test('freeze refuses a wrapped command that stages a shared file', () => {
  const t = sharedDirtyRepo();
  assertRefused(t, queue(t, 'freeze', '--', 'git add .planning/state.yaml && git commit -qm x; touch ran'), 'freeze');
});

test('lock runs a wrapped commit of owner-unique paths', () => {
  const t = sharedDirtyRepo();
  fs.mkdirSync(path.join(t.root, '.planning', 'phases', '001-x'), { recursive: true });
  const write = (rel, c) => fs.writeFileSync(path.join(t.root, rel), c);
  // Each form with what it commits staged or written first; a message form commits a.txt staged outside the lock.
  const cases = [
    ['git add a.txt && git commit -qm x', () => write('a.txt', '1\n'), 'x'],
    ['git add .planning/phases/001-x/p.md && git commit -qm y', () => write('.planning/phases/001-x/p.md', 'p\n'), 'y'],
    ['git add -A .planning/phases/001-x && git commit -qm w', () => write('.planning/phases/001-x/q.md', 'q\n'), 'w'],
    ['git commit -q --allow-empty -m z', () => {}, 'z'],
    ['git commit -qm "fix: a -- b"', () => { write('a.txt', '2\n'); sh('git add a.txt', t.root, t.env); }, 'fix: a -- b'],
    ['git commit -qm .planning', () => { write('a.txt', '3\n'); sh('git add a.txt', t.root, t.env); }, '.planning'],
    ['git commit -madd', () => { write('a.txt', '4\n'); sh('git add a.txt', t.root, t.env); }, 'add'],
  ];
  for (const [form, before, subject] of cases) {
    before();
    const r = queue(t, 'lock', '--', form);
    assert.equal(r.code, 0, `${form}: ${r.out}`);
    assert.equal(sh('git log -1 --format=%s', t.root, t.env), subject, form);
    assert.equal(sh('git show --format= --name-only HEAD -- .planning/state.yaml CLAUDE.md', t.root, t.env), '', `${form} committed a shared file`);
  }
});

test('lock --next-quick refuses an id at HEAD', () => {
  const t = makeRepo();
  commitFile(t.root, '.planning/quick/261018-a/PLAN.md', 'x\n', 'quick a', t.env);
  const r = queue(t, 'lock', '--next-quick', '261018-a', '--', 'true');
  assert.equal(r.code, 73, r.out);
  assert.match(r.out, /quick 261018-a already exists at HEAD/);
  assert.equal(queue(t, 'lock', '--next-quick', '261018-b', '--', 'true').code, 0);
});

test('lock --ask-once refuses a duplicate', () => {
  const t = makeRepo();
  const asks = path.join(t.root, '.planning', 'asks.yaml');
  const entry = '  - id: my-ask\n    status: open\n';
  fs.writeFileSync(asks, 'asks:\n' + entry + entry);
  const r = queue(t, 'lock', '--ask-once', 'my-ask', '--', 'true');
  assert.equal(r.code, 73, r.out);
  assert.match(r.out, /ask my-ask appears 2 times/);
  fs.writeFileSync(asks, 'asks:\n' + entry + '  - id: my-ask-2\n    status: open\n');
  assert.equal(queue(t, 'lock', '--ask-once', 'my-ask', '--', 'true').code, 0);
  fs.rmSync(asks);
  assert.equal(queue(t, 'lock', '--ask-once', 'my-ask', '--', 'true').code, 73);
});

test('lock records an event', () => {
  const t = makeRepo();
  assert.equal(queue(t, 'lock', '--', 'echo hi').code, 0);
  assert.match(queue(t, 'status').out, /lock -: lock: echo hi/);
});

test('freeze --expect refuses when HEAD moved and names what landed', () => {
  const t = makeRepo();
  const sha = sh('git rev-parse HEAD', t.root, t.env);
  const moved = commitFile(t.root, 'a.txt', 'x\n', 'moved', t.env);
  const ran = path.join(t.root, 'ran');
  const r = queue(t, 'freeze', '--expect', sha, '--', 'echo ran > ran');
  assert.equal(r.code, 73, r.out);
  assert.match(r.out, /HEAD is \w{7}, expected/);
  assert.match(r.out, /moved/);
  assert.ok(!fs.existsSync(ran));
  const ok = queue(t, 'freeze', '--expect', moved, '--', 'echo ran > ran');
  assert.equal(ok.code, 0, ok.out);
  assert.ok(fs.existsSync(ran));
  fs.rmSync(ran);
  assert.equal(queue(t, 'freeze', '--expect', moved.slice(0, 7), '--', 'echo ran > ran').code, 0);
  assert.ok(fs.existsSync(ran));
});

test('freeze --expect refuses a sha shorter than 7 hex digits', () => {
  const t = makeRepo();
  const head = sh('git rev-parse HEAD', t.root, t.env);
  const ran = path.join(t.root, 'ran');
  for (const bad of [head.slice(0, 6), 'HEAD', '']) {
    const r = queue(t, 'freeze', '--expect', bad, '--', 'echo ran > ran');
    assert.equal(r.code, 2, `${bad}: ${r.out}`);
    assert.match(r.out, /--expect needs a sha of 7 to 40 hex digits/);
    assert.ok(!fs.existsSync(ran));
  }
  assert.equal(queue(t, 'freeze', '--expect', head.slice(0, 7), '--', 'echo ran > ran').code, 0);
  assert.ok(fs.existsSync(ran));
});

test('freeze sets and clears the freeze field', async () => {
  const t = makeRepo();
  const a = start('h-queue', ['freeze', '--', 'sleep 1'], { cwd: t.root, env: t.env });
  await heldBy(t.root, 'freeze');
  let f = null;
  for (let i = 0; i < 40 && !f; i++) { f = R.readRegistry(t.root).freeze; if (!f) await R.sleep(25); }
  assert.equal(f && f.label, 'freeze');
  assert.match(queue(t, 'status').out, /^frozen: freeze since /m);
  const r = await a.done;
  assert.equal(r.code, 0, r.out);
  assert.equal(R.readRegistry(t.root).freeze, null);
  assert.doesNotMatch(queue(t, 'status').out, /frozen:/);
});

// One importer per kind bin/h-queue rootsLine counts or leaves out for the fixture settings module: a dotted
// import, a top-level `import x`, a Svelte basename collision, an extensionless script, a test.
const IMPORTS = {
  'a.txt': 'a\n', 'b.txt': 'b\n',
  'services/settings.py': 'def get(k):\n    return k\n',
  'routes/orders.py': 'from services.settings import get\n',
  'app.py': 'import services.settings\n',
  'client/src/App.svelte': "<script>\nimport s from './stores/settings.js';\n</script>\n",
  'bin/tool': "#!/usr/bin/env node\nrequire('../services/settings');\n",
  'tests/test_settings.py': 'from services.settings import get\n',
};
const ROOTS_TAIL = " (a warning: a quick's goal shows from one entry point; the operator may overrule)";
const beforeLast = out => { const ls = out.trim().split('\n'); return ls[ls.length - 2]; };

test('a quick admit prints the importer roots of --writes before the worktree', () => {
  const t = makeRepo({ files: IMPORTS });
  const r = admitQuick(t, '261030-1', ['services/settings.py']);
  assert.equal(r.code, 0, r.out);
  assert.equal(beforeLast(r.out), 'importer roots: ., bin, routes' + ROOTS_TAIL);
  assert.ok(fs.existsSync(lastLine(r.out)), r.out);
  const r2 = admitQuick(t, '261030-1', ['services/settings.py']);
  assert.equal(r2.code, 0, r2.out);
  assert.match(r2.out, /^importer roots: \., bin, routes \(a warning: [^\n]*\nalready admitted 261030-1\n/m);
  assert.equal(lastLine(r2.out), lastLine(r.out));
});

test('a written file in no language family counts importers of every language', () => {
  const t = makeRepo({ files: { 'a.txt': 'a\n', 'b.txt': 'b\n', 'data/prices.json': '{}\n',
    'client/src/load.js': "import p from '../../data/prices.json';\n", 'scripts/load.py': "open('data/prices.json')\n" } });
  const r = admitQuick(t, '261030-1', ['data/prices.json', 'a.txt']);
  assert.equal(r.code, 0, r.out);
  assert.equal(beforeLast(r.out), 'importer roots: client, scripts' + ROOTS_TAIL);
});

test('an importer of another language family is left out', () => {
  const t = makeRepo({ files: { 'a.txt': 'a\n', 'b.txt': 'b\n', 'client/src/stores/settings.js': 'export default {};\n',
    'client/src/App.svelte': IMPORTS['client/src/App.svelte'], 'bin/tool': IMPORTS['bin/tool'], 'scripts/Sync.PY': "NAME = 'settings.js'\n" } });
  const r = admitQuick(t, '261030-1', ['client/src/stores/settings.js']);
  assert.equal(r.code, 0, r.out);
  assert.equal(beforeLast(r.out), 'importer roots: bin, client' + ROOTS_TAIL);
});

test('a new file has no importer roots', () => {
  const t = makeRepo();
  const r = admitQuick(t, '261030-1', ['tests/test_new.py']);
  assert.equal(r.code, 0, r.out);
  assert.equal(beforeLast(r.out), 'importer roots: none');
});

test('a parked quick prints its importer roots before the parked line', () => {
  const t = makeRepo({ files: IMPORTS });
  const p = admitPlan(t, '001-01', ['services/settings.py']);
  assert.equal(p.code, 0, p.out);
  const r = admitQuick(t, '261030-1', ['services/settings.py']);
  assert.equal(r.code, 70, r.out);
  assert.match(r.out, /^importer roots: \., bin, routes \(a warning: [^\n]*\nparked 261030-1: /m);
});

test('a re-admission prints no importer roots', () => {
  const t = makeRepo({ files: IMPORTS });
  const r = admitQuick(t, '261030-1', ['services/settings.py']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^importer roots: \., bin, routes /m);
  const r2 = run('h-queue', ['resume', '261030-1'], { cwd: t.root, env: t.env });
  assert.equal(r2.code, 0, r2.out);
  assert.doesNotMatch(r2.out, /importer roots/);
  assert.ok(fs.existsSync(lastLine(r2.out)), r2.out);
});

test('a fix, and a quick admitted with --plan alone, print no importer roots', () => {
  const t = makeRepo({ files: IMPORTS });
  const f = run('h-queue', ['admit', '261030-1-fix1', '--kind', 'fix', '--owner', 'quick:261030-1', '--writes', 'services/settings.py'], { cwd: t.root, env: t.env });
  assert.equal(f.code, 0, f.out);
  assert.doesNotMatch(f.out, /importer roots/);
  const q = admitQuickPlan(t, '261030-2', quickPlan(t, '261030-2', ['routes/orders.py']));
  assert.equal(q.code, 0, q.out);
  assert.doesNotMatch(q.out, /importer roots/);
});
