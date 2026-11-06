'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process');
const { makeRepo } = require('./fixtures/repo.js');
const LIB = path.join(__dirname, '..', 'lib', 'registry.js');
const R = require('../lib/registry.js');

const tmpLock = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'holden-lock-')), 'x.lock');
const exitOf = child => new Promise(r => child.on('exit', code => r(code)));

test('holdLock excludes a second holder and releases on release()', async () => {
  const p = tmpLock();
  const l1 = await R.holdLock(p, 1, 'a');
  assert.ok(l1);
  const t0 = Date.now();
  const l2 = await R.holdLock(p, 1, 'b');
  assert.equal(l2, null);
  assert.ok(Date.now() - t0 >= 900, 'waited about the window before giving up');
  await l1.release();
  const l3 = await R.holdLock(p, 1, 'c');
  assert.ok(l3);
  await l3.release();
});

test('holdLock releases when the holder process dies', async () => {
  const p = tmpLock();
  const child = cp.spawn(process.execPath, ['-e', `require(${JSON.stringify(LIB)}).holdLock(${JSON.stringify(p)}, 5, 'x').then(() => setTimeout(() => {}, 60000))`], { stdio: 'ignore' });
  for (let i = 0; i < 100 && !fs.existsSync(p + '.holder'); i++) await R.sleep(50);
  assert.ok(fs.existsSync(p + '.holder'), 'the child took the lock');
  child.kill('SIGKILL');
  await exitOf(child);
  const l = await R.holdLock(p, 3, 'y');
  assert.ok(l);
  await l.release();
});

test('holdLock throws when flock is absent', async () => {
  const saved = process.env.PATH;
  process.env.PATH = '/nonexistent';
  try { await assert.rejects(R.holdLock(tmpLock(), 1, 'z'), /flock failed/); }
  finally { process.env.PATH = saved; }
});

test('withRegistry writes atomically and serialises', async () => {
  const { root } = makeRepo();
  // Each child reads in a loop around its write, and holds its read-modify-write open for 300 ms,
  // so two writers without the lock would both read the same seq.
  const script = `const R = require(${JSON.stringify(LIB)}), root = ${JSON.stringify(root)};
    (async () => {
      for (let i = 0; i < 20; i++) { R.readRegistry(root); await R.sleep(10); }
      await R.withRegistry(root, async reg => { const s = reg.seq; await R.sleep(300); reg.seq = s + 1; });
      for (let i = 0; i < 20; i++) { R.readRegistry(root); await R.sleep(10); }
    })().catch(e => { console.error(e); process.exit(1); });`;
  const kids = Array.from({ length: 5 }, () => cp.spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'ignore', 'inherit'] }));
  const codes = await Promise.all(kids.map(exitOf));
  assert.deepEqual(codes, [0, 0, 0, 0, 0]);
  assert.equal(R.readRegistry(root).seq, 5);
});

test('readRegistry returns the empty registry when the file is absent', () => {
  const { root } = makeRepo();
  const reg = R.readRegistry(root);
  assert.deepEqual(reg.packages, {});
  assert.equal(reg.seq, 0);
  assert.equal(reg.freeze, null);
});

test('conflicts and decide', () => {
  const A = { id: 'A', kind: 'plan', owner: 'phase:001', seq: 1, writes: ['x'], state: 'admitted' };
  const Q = { id: 'Q', kind: 'quick', owner: 'quick:q', seq: 2, writes: ['y'], state: 'admitted' };
  const reg = { packages: { A, Q } };
  assert.deepEqual(R.conflicts(reg, { owner: 'phase:001' }, ['x']), []);
  const c = R.conflicts(reg, { owner: 'quick:r' }, ['x']);
  assert.equal(c.length, 1);
  assert.equal(c[0].holder.id, 'A');
  assert.equal(c[0].path, 'x');
  assert.equal(R.decide({ kind: 'plan', owner: 'phase:001', seq: 3 }, Q), 'wait');
  assert.equal(R.decide({ kind: 'quick', owner: 'quick:r', seq: 3 }, A), 'yield');
  assert.equal(R.decide({ kind: 'plan', owner: 'phase:002', seq: 3 }, A), 'yield');
  assert.equal(R.decide({ kind: 'fix', owner: 'phase:001', seq: 4 }, Q), 'wait');
  assert.equal(R.decide({ kind: 'fix', owner: 'quick:q', seq: 4 }, A), 'yield');
  // A newcomer parked before its first admission has no seq yet: it is the later one (D04).
  assert.equal(R.decide({ kind: 'plan', owner: 'phase:002', seq: null }, A), 'yield');
  assert.equal(R.decide({ kind: 'quick', owner: 'quick:r' }, Q), 'yield');
});

test('crashAt exits 99 only on its label', () => {
  const env = { ...process.env, HOLDEN_TEST_CRASH_AT: 'here' };
  const at = label => cp.spawnSync(process.execPath, ['-e', `require(${JSON.stringify(LIB)}).crashAt(${JSON.stringify(label)})`], { env, encoding: 'utf8' }).status;
  assert.equal(at('here'), 99);
  assert.equal(at('other'), 0);
});
