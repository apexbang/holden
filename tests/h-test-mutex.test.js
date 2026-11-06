'use strict';
// The machine-wide test mutex (phase 001 D06). Every case runs on makeRepo(), whose env points
// XDG_CACHE_HOME at the test's own tmp dir, so the mutex here is never the machine's real one.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path'), cp = require('child_process');
const { makeRepo, run, sh, writePlan, writeLedger, onBranch } = require('./fixtures/repo.js');
const R = require('../lib/registry.js');

const BIN = path.join(__dirname, '..', 'bin');
const q = s => `'${String(s).replace(/'/g, `'\\''`)}'`;
const mutex = t => { const d = path.join(t.env.XDG_CACHE_HOME, 'holden'); fs.mkdirSync(d, { recursive: true }); return { lock: path.join(d, 'test-mutex.lock'), holder: path.join(d, 'test-mutex.holder') }; };
const lastLine = out => out.trim().split('\n').pop();

// Another process holds the mutex for `seconds`, as another repo's suite would. Its own process
// group, so release() kills flock and the sleep that inherited its lock fd together.
async function holdMutex(t, seconds) {
  const { lock } = mutex(t), ready = lock + '.ready';
  const child = cp.spawn('flock', [lock, 'sh', '-c', `touch ${q(ready)}; sleep ${seconds}`], { stdio: 'ignore', detached: true });
  for (let i = 0; i < 100 && !fs.existsSync(ready); i++) await R.sleep(50);
  assert.ok(fs.existsSync(ready), 'the holder took the mutex');
  return { release: () => { try { process.kill(-child.pid, 'SIGKILL'); } catch (e) {} } };
}
const timed = fn => { const t0 = Date.now(); const r = fn(); return { ...r, s: (Date.now() - t0) / 1000 }; };

function admitted(t) {
  const f = writePlan(path.join(t.root, '.planning', 'phases', '001-x'), '001-01-PLAN.md', { files: ['a.txt'] });
  const r = run('h-queue', ['admit', '001-01', '--kind', 'plan', '--owner', 'phase:001', '--plan', f], { cwd: t.root, env: t.env });
  assert.equal(r.code, 0, r.out);
  return lastLine(r.out);
}

test('h-machine run waits for a held mutex and runs when it frees', async () => {
  const t = makeRepo();
  const h = await holdMutex(t, 3);
  try {
    const r = timed(() => run('h-machine', ['run', '--', 'echo', 'ok'], { cwd: t.root, env: t.env }));
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /waiting for the test mutex/);
    assert.match(r.out, /^ok$/m);
    assert.ok(r.s >= 2, `waited ${r.s}s`);
  } finally { h.release(); }
});

test("h-machine run passes the command's exit code through", () => {
  const t = makeRepo();
  const r = run('h-machine', ['run', '--', 'exit 4'], { cwd: t.root, env: t.env });
  assert.equal(r.code, 4, r.out);
  assert.doesNotMatch(r.out, /waiting for/);
});

test('h-machine run is re-entrant', () => {
  const t = makeRepo();
  const inner = `${q(process.execPath)} ${q(path.join(BIN, 'h-machine'))} run --label inner -- echo inner`;
  const r = timed(() => run('h-machine', ['run', '--label', 'outer', '--', inner], { cwd: t.root, env: t.env }));
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^inner$/m);
  assert.ok(r.s < 5, `took ${r.s}s`);
  const holder = fs.readFileSync(mutex(t).holder, 'utf8');
  assert.match(holder, /^outer pid \d+ at /);
  assert.doesNotMatch(holder, /inner/);
});

test('h-machine run exits 75 after the wait window', async () => {
  const t = makeRepo();
  const h = await holdMutex(t, 10);
  try {
    const r = timed(() => run('h-machine', ['run', '--', 'echo', 'x'], { cwd: t.root, env: { ...t.env, HOLDEN_TEST_MUTEX_WAIT_S: '2' } }));
    assert.equal(r.code, 75, r.out);
    assert.match(r.out, /stayed busy/);
    assert.doesNotMatch(r.out, /^x$/m);
    assert.ok(r.s < 5, `took ${r.s}s`);
  } finally { h.release(); }
});

test('a server left behind by the command does not keep the mutex', () => {
  const t = makeRepo();
  const pidFile = path.join(t.dir, 'server.pid');
  const r = run('h-machine', ['run', '--', `setsid nohup sh -c 'echo $$ > ${pidFile}; exec sleep 30' >/dev/null 2>&1 &`], { cwd: t.root, env: t.env });
  try {
    assert.equal(r.code, 0, r.out);
    const flockRc = cp.spawnSync('flock', ['-n', mutex(t).lock, 'true']).status;
    assert.equal(flockRc, 0);
  } finally {
    for (let i = 0; i < 40 && !fs.existsSync(pidFile); i++) cp.spawnSync('sleep', ['0.05']);
    try { process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch (e) {}
  }
});

test("h-machine run beats the package's heartbeat", async () => {
  const t = makeRepo();
  const wt = admitted(t);
  const before = R.readRegistry(t.root).packages['001-01'].heartbeat;
  await R.sleep(1100);
  const r = run('h-machine', ['run', '--', 'true'], { cwd: wt, env: t.env });
  assert.equal(r.code, 0, r.out);
  const after = R.readRegistry(t.root).packages['001-01'].heartbeat;
  assert.ok(after > before, `${after} > ${before}`);
});

test('h-machine reports a missing flock', () => {
  const t = makeRepo();
  const r = run('h-machine', ['run', '--', 'true'], { cwd: t.root, env: { ...t.env, PATH: '/nonexistent' } });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /could not run flock/);
});

test('h-machine runs when the repo has no registry', () => {
  const t = makeRepo();
  const r = run('h-machine', ['run', '--', 'echo', 'ran'], { cwd: t.root, env: t.env });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^ran$/m);
  assert.ok(!fs.existsSync(R.paths(t.root).registry));
});

test('h-test --run waits for the mutex and exits 75 when it stays busy', async () => {
  const t = makeRepo();
  const ledger = path.join(t.dir, 'ledger.md');
  fs.writeFileSync(ledger, '# ledger\n');
  const h = await holdMutex(t, 10);
  try {
    const r = timed(() => run('h-test', ['--run', '--tests', 'tests/ok.sh', '--ledger', ledger], { cwd: t.root, env: { ...t.env, HOLDEN_TEST_MUTEX_WAIT_S: '2' } }));
    assert.equal(r.code, 75, r.out);
    assert.match(r.out, /stayed busy/);
    assert.ok(r.s < 5, `took ${r.s}s`);
    const ledgerLines = fs.readFileSync(ledger, 'utf8').split('\n').filter(l => l.startsWith('h-test:')).length;
    assert.equal(ledgerLines, 0);
  } finally { h.release(); }
});

test('h-test --run under a held mutex runs', async () => {
  const t = makeRepo();
  const h = await holdMutex(t, 10);
  try {
    const r = timed(() => run('h-test', ['--run', '--tests', 'tests/ok.sh'], { cwd: t.root, env: { ...t.env, HOLDEN_MUTEX_HELD: '1' } }));
    assert.equal(r.code, 0, r.out);
    assert.doesNotMatch(r.out, /waiting/);
    assert.ok(r.s < 5, `took ${r.s}s`);
  } finally { h.release(); }
});

test('nested h-test inside h-machine run does not lock itself out', () => {
  const t = makeRepo();
  const inner = `${q(process.execPath)} ${q(path.join(BIN, 'h-test'))} --run --tests tests/ok.sh`;
  const r = timed(() => run('h-machine', ['run', '--', inner], { cwd: t.root, env: t.env }));
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /"run":"pass"/);
  assert.ok(r.s < 5, `took ${r.s}s`);
});

test('h-test --code-tree takes no lock', async () => {
  const t = makeRepo();
  const h = await holdMutex(t, 10);
  try {
    const r = timed(() => run('h-test', ['--code-tree'], { cwd: t.root, env: t.env }));
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /^[0-9a-f]{64}$/m);
    assert.doesNotMatch(r.out, /waiting/);
    assert.ok(r.s < 5, `took ${r.s}s`);
  } finally { h.release(); }
});

test("h-test beats the package's heartbeat", async () => {
  const t = makeRepo();
  const wt = admitted(t);
  const before = R.readRegistry(t.root).packages['001-01'].heartbeat;
  await R.sleep(1100);
  const r = run('h-test', ['--run', '--tests', 'tests/ok.sh'], { cwd: wt, env: t.env });
  assert.equal(r.code, 0, r.out);
  const after = R.readRegistry(t.root).packages['001-01'].heartbeat;
  assert.ok(after > before, `${after} > ${before}`);
});

test('h-test runs in a repo without a registry', () => {
  const t = makeRepo();
  const r = run('h-test', ['--run', '--tests', 'tests/ok.sh'], { cwd: t.root, env: t.env });
  assert.equal(r.code, 0, r.out);
  assert.ok(!fs.existsSync(R.paths(t.root).registry));
});

function withSmoke(smoke) {
  const t = makeRepo();
  fs.appendFileSync(path.join(t.root, '.holden', 'config.yaml'), `worktrees:\n  smoke: ${JSON.stringify(smoke)}\n`);
  return t;
}

test('preflight runs the smoke under the mutex', async () => {
  const t = withSmoke('sh tests/ok.sh');
  const h = await holdMutex(t, 3);
  try {
    const r = timed(() => run('h-worktree', ['preflight'], { cwd: t.root, env: t.env }));
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /preflight: ok/);
    assert.ok(r.s >= 2, `waited ${r.s}s`);
  } finally { h.release(); }
});

test('preflight exits 75 when the mutex stays busy', async () => {
  const t = withSmoke('sh tests/ok.sh');
  const h = await holdMutex(t, 10);
  try {
    const r = run('h-worktree', ['preflight'], { cwd: t.root, env: { ...t.env, HOLDEN_TEST_MUTEX_WAIT_S: '2' } });
    assert.equal(r.code, 75, r.out);
    assert.match(r.out, /run preflight again/);
  } finally { h.release(); }
});

test('preflight under a held mutex runs at once', () => {
  const t = withSmoke('sh tests/ok.sh');
  const inner = `${q(process.execPath)} ${q(path.join(BIN, 'h-worktree'))} preflight`;
  const r = timed(() => run('h-machine', ['run', '--', inner], { cwd: t.root, env: { ...t.env, HOLDEN_TEST_MUTEX_WAIT_S: '2' } }));
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /preflight: ok/);
  assert.ok(r.s < 5, `took ${r.s}s`);
});

test('preflight fails on a red smoke', () => {
  const t = withSmoke("sh -c 'exit 1'");
  const r = run('h-worktree', ['preflight'], { cwd: t.root, env: t.env });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /smoke failed/);
});

test('land exits 75, not 4, when the mutex stays busy', async () => {
  const t = makeRepo();
  const add = run('h-worktree', ['add', '001-01'], { cwd: t.root, env: t.env });
  assert.equal(add.code, 0, add.out);
  onBranch(t.root, '001-01', 'a.txt', 'changed\n', 'change a', t.env);
  const ledger = writeLedger(path.join(t.dir, 'ledger.md'), ['tests/ok.sh']);
  const master = sh('git rev-parse master', t.root, t.env);
  const h = await holdMutex(t, 10);
  try {
    const r = run('h-worktree', ['land', '001-01', '--ledger', ledger], { cwd: t.root, env: { ...t.env, HOLDEN_TEST_MUTEX_WAIT_S: '2' } });
    assert.equal(r.code, 75, r.out);
    assert.match(r.out, /land again/);
    assert.equal(sh('git rev-parse master', t.root, t.env), master);
  } finally { h.release(); }
});
