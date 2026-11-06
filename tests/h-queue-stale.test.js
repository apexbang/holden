'use strict';
// Phase 001 plan 4: stale and stuck packages (D11, D04), the wait with its 4-hour backstop, resume.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path'), cp = require('child_process');
const { makeRepo, run, start, sh, writePlan, writeLedger, onBranch, worktreeOf } = require('./fixtures/repo.js');
const R = require('../lib/registry.js');

const HOUR = 3600 * 1000, MIN = 60 * 1000;
const ago = ms => new Date(Date.now() - ms);
const pkgOf = (t, id) => R.readRegistry(t.root).packages[id];
function editRegistry(t, fn) { const reg = R.readRegistry(t.root); fn(reg); fs.writeFileSync(R.paths(t.root).registry, JSON.stringify(reg, null, 2)); }
const ledgerOf = (t, id) => path.join(t.dir, `${id}-LEDGER.md`);
// The quicks run from a second session with no transcript file, so their own activity is the
// heartbeat alone and silencing sess-1's transcript silences only the plan.
const other = t => ({ ...t.env, CLAUDE_CODE_SESSION_ID: 'sess-2' });
function plan(t, id, files) {
  const f = writePlan(path.join(t.root, '.planning', 'phases', '001-x'), `${id}-PLAN.md`, { files });
  return run('h-queue', ['admit', id, '--kind', 'plan', '--owner', 'phase:' + id.split('-')[0], '--plan', f, '--ledger', writeLedger(ledgerOf(t, id), [])], { cwd: t.root, env: t.env });
}
const quick = (t, id, writes) => run('h-queue', ['admit', id, '--kind', 'quick', '--owner', 'quick:' + id, '--writes', ...writes, '--ledger', writeLedger(ledgerOf(t, id), [])], { cwd: t.root, env: other(t) });
const ok = r => { assert.equal(r.code, 0, r.out); return r; };
const queue = (t, ...a) => run('h-queue', a, { cwd: t.root, env: t.env });
// sess-1's transcript and the subagent dir beside it (<projects>/-tmp-repo/sess-1/subagents/).
const transcript = t => path.join(t.dir, 'claude', 'projects', '-tmp-repo', 'sess-1.jsonl');
function subagent(t, name = 'agent-a.jsonl') {
  const d = path.join(t.dir, 'claude', 'projects', '-tmp-repo', 'sess-1', 'subagents');
  fs.mkdirSync(d, { recursive: true });
  const f = path.join(d, name); if (!fs.existsSync(f)) fs.writeFileSync(f, '{}\n');
  return f;
}
const touch = (f, ms) => fs.utimesSync(f, ago(ms), ago(ms));
// Every channel of the package silent for `ms`: its heartbeat, the transcript, every subagent file.
function silence(t, id, ms = 2 * HOUR) {
  editRegistry(t, reg => { reg.packages[id].heartbeat = ago(ms).toISOString(); });
  touch(transcript(t), ms);
  const d = path.join(path.dirname(transcript(t)), 'sess-1', 'subagents');
  if (fs.existsSync(d)) for (const f of fs.readdirSync(d)) touch(path.join(d, f), ms);
}

test('lastActivity reads the heartbeat, the transcript and the subagent files', () => {
  const t = makeRepo();
  const tr = transcript(t), sub = subagent(t);
  const p = { state: 'admitted', session: 'sess-1', transcript: tr, heartbeat: ago(2 * HOUR).toISOString() };
  touch(tr, 2 * HOUR); touch(sub, 5 * MIN);
  assert.equal(R.isStale(p), false);
  assert.ok(Math.abs(R.lastActivity(p) - ago(5 * MIN).getTime()) < 2000);
  touch(sub, 2 * HOUR);
  assert.equal(R.isStale(p), true);
  // A fresh heartbeat alone keeps it: the newest channel counts, not the oldest.
  assert.equal(R.isStale({ ...p, heartbeat: ago(5 * MIN).toISOString() }), false);
  // No transcript: only the heartbeat, and a missing file is no error.
  assert.equal(R.isStale({ state: 'admitted', transcript: null, heartbeat: ago(5 * MIN).toISOString() }), false);
  assert.equal(R.isStale({ state: 'admitted', transcript: path.join(t.dir, 'gone.jsonl'), heartbeat: ago(2 * HOUR).toISOString() }), true);
  // A parked package is never stale: it holds nothing.
  assert.equal(R.isStale({ ...p, state: 'parked' }), false);
});

test('a stale holder is yielded when another package needs its file', () => {
  const t = makeRepo();
  ok(plan(t, '001-01', ['a.txt']));
  subagent(t);
  silence(t, '001-01');
  const r = quick(t, '261018-q', ['a.txt']);
  assert.equal(r.code, 0, r.out);
  const p = pkgOf(t, '001-01');
  assert.equal(p.state, 'parked');
  assert.equal(p.yields, 1);
  assert.ok(R.readRegistry(t.root).events.some(e => e.kind === 'yielded' && e.id === '001-01' && /^stale: .*yielded for 261018-q on a\.txt/.test(e.text)));
  assert.deepEqual(pkgOf(t, '261018-q').writes, ['a.txt']);
});

test('a fresh holder is not yielded', () => {
  const t = makeRepo();
  ok(plan(t, '001-01', ['a.txt']));
  silence(t, '001-01');
  editRegistry(t, reg => { reg.packages['001-01'].heartbeat = ago(5 * MIN).toISOString(); });
  assert.equal(quick(t, '261018-q', ['a.txt']).code, 70);
  assert.equal(pkgOf(t, '001-01').state, 'admitted');
  assert.equal(pkgOf(t, '001-01').yields, 0);
});

test('extend yields a stale holder', () => {
  const t = makeRepo();
  ok(quick(t, '261018-q', ['b.txt']));
  ok(plan(t, '001-01', ['a.txt']));
  silence(t, '001-01');
  const r = queue(t, 'extend', '261018-q', 'a.txt');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /granted a\.txt/);
  assert.equal(pkgOf(t, '001-01').state, 'parked');
  assert.deepEqual(pkgOf(t, '261018-q').writes, ['b.txt', 'a.txt']);
});

test('a stale holder whose drop fails blocks the requester', () => {
  const t = makeRepo();
  ok(plan(t, '001-01', ['a.txt']));
  silence(t, '001-01');
  fs.rmSync(path.join(worktreeOf('001-01', t.env), '.git'));
  const r = quick(t, '261018-q', ['a.txt']);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /h-worktree drop failed/);
  assert.equal(pkgOf(t, '001-01').state, 'admitted');
  assert.equal(pkgOf(t, '261018-q'), undefined);
});

test('two requesters of one stale holder both proceed', async () => {
  const t = makeRepo();
  ok(plan(t, '001-01', ['a.txt', 'b.txt']));
  silence(t, '001-01');
  const adm = (id, w) => start('h-queue', ['admit', id, '--kind', 'quick', '--owner', 'quick:' + id, '--writes', w], { cwd: t.root, env: other(t) });
  const rs = await Promise.all([adm('261018-1', 'a.txt').done, adm('261018-2', 'b.txt').done]);
  for (const r of rs) assert.equal(r.code, 0, r.out);
  assert.equal(pkgOf(t, '001-01').yields, 1);
  assert.equal(R.readRegistry(t.root).events.filter(e => e.kind === 'yielded').length, 1);
});

test('status marks stale and stuck', () => {
  const t = makeRepo();
  ok(plan(t, '001-01', ['a.txt']));
  assert.equal(quick(t, '261018-q', ['a.txt']).code, 70);
  silence(t, '001-01');
  editRegistry(t, reg => { reg.packages['261018-q'].since = ago(5 * HOUR).toISOString(); });
  const r = queue(t, 'status');
  assert.equal(r.code, 0, r.out);
  const line = id => r.out.split('\n').find(l => l.startsWith(id + '  '));
  assert.match(line('001-01'), /  admitted stale  .*next: yields when another package needs its file; h-queue resume 001-01 re-admits it/);
  assert.match(line('261018-q'), /  parked stuck  .*next: over 4 hours: the operator decides/);
  assert.match(queue(t, 'status', '--summary').out, /^packages: 1 running, 0 waiting, 1 parked, 1 stale, 1 stuck; \/h-queue for the list$/m);
  // status reads staleness and never acts on it.
  assert.equal(pkgOf(t, '001-01').state, 'admitted');
  // A package with no transcript says so.
  editRegistry(t, reg => { reg.packages['001-01'].transcript = null; });
  assert.match(queue(t, 'status').out.split('\n').find(l => l.startsWith('001-01  ')), /  transcript: none$/);
});

test('status clears a dead freeze', () => {
  const t = makeRepo();
  const dead = cp.spawnSync('true').pid;
  editRegistry(t, reg => { reg.freeze = { label: 'x', pid: dead, since: new Date().toISOString() }; });
  const r = queue(t, 'status');
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /frozen:/);
  assert.equal(R.readRegistry(t.root).freeze, null);
  assert.ok(R.readRegistry(t.root).events.some(e => e.kind === 'thaw' && /the freeze's process died/.test(e.text)));
});

test('status keeps a live freeze', () => {
  const t = makeRepo();
  editRegistry(t, reg => { reg.freeze = { label: 'x', pid: process.pid, since: new Date().toISOString() }; });
  assert.match(queue(t, 'status').out, /^frozen: x since /m);
  assert.notEqual(R.readRegistry(t.root).freeze, null);
});

test("extend and yield are the package's heartbeat", () => {
  const t = makeRepo();
  ok(plan(t, '001-01', ['a.txt']));
  silence(t, '001-01');
  ok(queue(t, 'extend', '001-01', 'b.txt'));
  assert.ok(Date.now() - Date.parse(pkgOf(t, '001-01').heartbeat) < MIN);
  editRegistry(t, reg => { reg.packages['001-01'].heartbeat = ago(2 * HOUR).toISOString(); });
  ok(queue(t, 'yield', '001-01', '--reason', 'x'));
  assert.ok(Date.now() - Date.parse(pkgOf(t, '001-01').heartbeat) < MIN);
});

// Task 2: h-queue wait and resume.
const within = (p, ms) => Promise.race([p, R.sleep(ms).then(() => null)]);
const waitFor = (t, id, env = {}) => start('h-queue', ['wait', id, '--poll', '1'], { cwd: t.root, env: { ...t.env, ...env } });
const land = (t, id) => run('h-queue', ['land', id, '--ledger', ledgerOf(t, id)], { cwd: t.root, env: t.env });
const master = t => sh('git rev-parse master', t.root, t.env);
const lastLine = out => out.trim().split('\n').pop();
// A child still running when its test ends would keep this process alive.
const kill = w => { try { w.child.kill(); } catch (e) {} };

test('wait admits a parked package when the holder lands', async () => {
  const t = makeRepo();
  ok(plan(t, '001-01', ['a.txt']));
  assert.equal(quick(t, '261018-q', ['a.txt']).code, 70);
  assert.deepEqual(pkgOf(t, '261018-q').writes, []);
  const w = waitFor(t, '261018-q');
  try {
    await R.sleep(2000);
    onBranch(t.root, '001-01', 'a.txt', 'changed\n', 'change a', t.env);
    ok(land(t, '001-01'));
    const r = await within(w.done, 10000);
    assert.ok(r, 'wait did not end within 10 s: ' + w.out);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /re-admitted 261018-q base \w{7} \(yields 0, drops 0\)/);
    const p = pkgOf(t, '261018-q');
    assert.equal(lastLine(r.out), p.worktree);
    assert.equal(p.state, 'admitted');
    assert.equal(p.base, master(t));
    assert.deepEqual(p.writes, ['a.txt']);
  } finally { kill(w); }
});

test('wait grants a waiting package its path when the holder lands', async () => {
  const t = makeRepo();
  ok(quick(t, '261018-q', ['b.txt']));
  ok(plan(t, '001-01', ['a.txt']));
  assert.equal(queue(t, 'extend', '001-01', 'b.txt').code, 70);
  assert.equal(pkgOf(t, '001-01').state, 'waiting');
  const w = waitFor(t, '001-01');
  try {
    onBranch(t.root, '261018-q', 'b.txt', 'changed\n', 'change b', t.env);
    ok(land(t, '261018-q'));
    const r = await within(w.done, 10000);
    assert.ok(r, 'wait did not end within 10 s: ' + w.out);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /^granted b\.txt$/m);
    assert.deepEqual(pkgOf(t, '001-01').writes, ['a.txt', 'b.txt']);
    assert.equal(pkgOf(t, '001-01').state, 'admitted');
  } finally { kill(w); }
});

test('wait gives up after the backstop with 74', async () => {
  const t = makeRepo();
  ok(plan(t, '001-01', ['a.txt']));
  assert.equal(quick(t, '261018-q', ['a.txt']).code, 70);
  const w = waitFor(t, '261018-q', { HOLDEN_TEST_WAIT_MAX_S: '2' });
  try {
    const r = await within(w.done, 5000);
    assert.ok(r, 'wait did not give up within 5 s: ' + w.out);
    assert.equal(r.code, 74, r.out);
    assert.match(r.out, /261018-q waited 4 hours on 001-01 for a\.txt; ask the operator/);
    assert.equal(pkgOf(t, '261018-q').state, 'parked');
    assert.ok(R.readRegistry(t.root).events.some(e => e.kind === 'gave-up' && e.id === '261018-q'));
  } finally { kill(w); }
});

test('wait on a stale holder ends when it is yielded', async () => {
  const t = makeRepo();
  ok(plan(t, '001-01', ['a.txt']));
  assert.equal(quick(t, '261018-q', ['a.txt']).code, 70);
  silence(t, '001-01');
  const w = waitFor(t, '261018-q');
  try {
    const r = await within(w.done, 5000);
    assert.ok(r, 'wait did not end within 5 s: ' + w.out);
    assert.equal(r.code, 0, r.out);
    assert.equal(pkgOf(t, '001-01').state, 'parked');
    assert.equal(pkgOf(t, '001-01').yields, 1);
    assert.equal(pkgOf(t, '261018-q').state, 'admitted');
  } finally { kill(w); }
});

test('wait prints a heartbeat line', async () => {
  const t = makeRepo();
  ok(plan(t, '001-01', ['a.txt']));
  assert.equal(quick(t, '261018-q', ['a.txt']).code, 70);
  const w = waitFor(t, '261018-q', { HOLDEN_TEST_WAIT_BEAT_S: '1', HOLDEN_TEST_WAIT_MAX_S: '3' });
  try {
    const r = await within(w.done, 8000);
    assert.ok(r, 'wait did not end within 8 s: ' + w.out);
    assert.match(r.out, /^h-queue: 261018-q parked on 001-01 for a\.txt, \d+s of 3$/m);
  } finally { kill(w); }
});

test('wait on an admitted package returns its path', () => {
  const t = makeRepo();
  const wt = lastLine(ok(plan(t, '001-01', ['a.txt'])).out);
  const r = queue(t, 'wait', '001-01', '--poll', '1');
  assert.equal(r.code, 0, r.out);
  assert.equal(lastLine(r.out), wt);
});

test('wait on a landed package is refused', () => {
  const t = makeRepo();
  ok(plan(t, '001-01', ['a.txt']));
  onBranch(t.root, '001-01', 'a.txt', 'changed\n', 'change a', t.env);
  ok(land(t, '001-01'));
  const r = queue(t, 'wait', '001-01', '--poll', '1');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /001-01 is landed/);
});

test('wait admits a manifest package when the queue empties', async () => {
  const t = makeRepo();
  ok(plan(t, '001-01', ['a.txt']));
  // Same phase, so only the manifest rule keeps it out (D03).
  assert.equal(plan(t, '001-02', ['package.json']).code, 70);
  const w = waitFor(t, '001-02');
  let ended = null; w.done.then(() => { ended = Date.now(); });
  try {
    await R.sleep(2000);
    assert.equal(ended, null, 'wait ended before the landing: ' + w.out);
    onBranch(t.root, '001-01', 'a.txt', 'changed\n', 'change a', t.env);
    const landStart = Date.now();
    ok(land(t, '001-01'));
    const r = await within(w.done, 10000);
    assert.ok(r, 'wait did not end within 10 s: ' + w.out);
    assert.equal(r.code, 0, r.out);
    assert.ok(ended >= landStart);
    assert.equal(pkgOf(t, '001-02').alone, 'package.json');
  } finally { kill(w); }
});

test('two waiters for one path: one is granted first', async () => {
  const t = makeRepo();
  ok(plan(t, '001-01', ['a.txt']));
  assert.equal(quick(t, '261018-1', ['a.txt']).code, 70);
  assert.equal(quick(t, '261018-2', ['a.txt']).code, 70);
  const ws = [waitFor(t, '261018-1'), waitFor(t, '261018-2')];
  try {
    onBranch(t.root, '001-01', 'a.txt', 'changed\n', 'change a', t.env);
    ok(land(t, '001-01'));
    await R.sleep(5000);
    const done = ws.map(w => w.child.exitCode);
    const zerosWithin5s = done.filter(c => c === 0).length;
    assert.equal(zerosWithin5s, 1, ws.map(w => w.out).join('\n---\n'));
    const first = done[0] === 0 ? '261018-1' : '261018-2', second = first === '261018-1' ? '261018-2' : '261018-1';
    assert.equal(pkgOf(t, second).state, 'parked');
    onBranch(t.root, first, 'a.txt', 'again\n', 'change a again', t.env);
    ok(land(t, first));
    // It re-admits and makes a worktree, which outlasts a short limit on a busy machine: this limit is for a hang.
    const r = await within(ws[first === '261018-1' ? 1 : 0].done, 60000);
    assert.ok(r, 'the second waiter did not end within 60 s');
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(pkgOf(t, second).writes, ['a.txt']);
  } finally { ws.forEach(kill); }
});

test('resume re-admits through a yield', () => {
  const t = makeRepo();
  const wt = lastLine(ok(plan(t, '001-01', ['a.txt'])).out);
  const head = sh('git rev-parse HEAD', wt, t.env);
  fs.writeFileSync(path.join(wt, 'a.txt'), 'half done\n');
  const r = run('h-queue', ['resume', '001-01'], { cwd: t.root, env: { ...t.env, CLAUDE_CODE_SESSION_ID: 'sess-9' } });
  assert.equal(r.code, 0, r.out);
  const p = pkgOf(t, '001-01');
  assert.equal(p.state, 'admitted');
  assert.equal(p.yields, 1);
  assert.equal(p.session, 'sess-9');
  assert.equal(p.head, head);
  assert.ok(p.patch && p.patch.endsWith('.patch') && path.dirname(p.patch) === path.dirname(ledgerOf(t, '001-01')), p.patch);
  assert.ok(fs.existsSync(p.patch));
  assert.match(r.out, new RegExp(`^recorded: head ${head.slice(0, 7)}, patch ${p.patch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  assert.equal(lastLine(r.out), p.worktree);
  assert.ok(fs.existsSync(p.worktree));
  // The new worktree runs the plan from scratch (D05): the half-done edit is in the patch only.
  assert.equal(fs.readFileSync(path.join(p.worktree, 'a.txt'), 'utf8'), 'a\n');
  assert.ok(R.readRegistry(t.root).events.some(e => e.kind === 'yielded' && e.text === 'resume: re-admitted from session sess-9'));
});

test('resume on a parked package just admits', () => {
  const t = makeRepo();
  ok(plan(t, '001-01', ['a.txt']));
  ok(queue(t, 'yield', '001-01', '--reason', 'x'));
  const r = queue(t, 'resume', '001-01');
  assert.equal(r.code, 0, r.out);
  assert.equal(pkgOf(t, '001-01').state, 'admitted');
  assert.equal(pkgOf(t, '001-01').yields, 1);
});

// Gate r1 rulings.
test('wait on an admission in flight keeps polling until its worktree exists', async () => {
  const t = makeRepo();
  editRegistry(t, reg => { reg.packages['001-01'] = { id: '001-01', kind: 'plan', owner: 'phase:001', state: 'admitted', seq: 1,
    writes: ['a.txt'], declared: ['a.txt'], reads: [], worktree: null, since: new Date().toISOString(), heartbeat: new Date().toISOString() }; });
  const w = waitFor(t, '001-01');
  try {
    await R.sleep(2500);
    assert.equal(w.child.exitCode, null, 'wait ended on an admission with no worktree: ' + JSON.stringify(w.out));
    const wt = path.join(t.dir, 'wt-001-01');
    editRegistry(t, reg => { reg.packages['001-01'].worktree = wt; });
    const r = await within(w.done, 5000);
    assert.ok(r, 'wait did not end within 5 s: ' + w.out);
    assert.equal(r.code, 0, r.out);
    assert.equal(lastLine(r.out), wt);
  } finally { kill(w); }
});

test('a silent holder with a landing in doubt is not yielded', () => {
  const t = makeRepo();
  ok(plan(t, '001-01', ['a.txt']));
  const T = sh('git rev-parse HEAD', t.root, t.env);
  editRegistry(t, reg => { reg.packages['001-01'].pending = { submitted: T, target: T, tests: [], time: new Date().toISOString() }; });
  silence(t, '001-01');
  assert.equal(R.isStale(pkgOf(t, '001-01')), false);
  assert.equal(quick(t, '261018-q', ['a.txt']).code, 70);
  assert.equal(pkgOf(t, '001-01').state, 'admitted');
  assert.equal(pkgOf(t, '001-01').yields, 0);
  const line = queue(t, 'status').out.split('\n').find(l => l.startsWith('001-01  '));
  assert.match(line, /  admitted landing  .*next: a landing to finish: h-queue land 001-01 completes it from git/);
  assert.doesNotMatch(line, / stale/);
});

// Quick 261025: h-queue retire (D01-D03, D05).
const { render } = require('../hooks/holden-statusline.js');
const bar = t => render({ workspace: { current_dir: t.root }, model: { display_name: 'x' } }).replace(/\x1b\[[0-9;]*m/g, '');
const retire = (t, id, reason = 'never runs') => queue(t, 'retire', id, '--reason', reason);
const defaultLedger = (t, name) => path.join(path.dirname(R.paths(t.root).registry), 'holden-ledgers', name);
const lastEvent = t => R.readRegistry(t.root).events.slice(-1)[0];

test('retire forgets a stuck parked package', () => {
  const t = makeRepo();
  ok(plan(t, '001-01', ['a.txt']));
  assert.equal(quick(t, '261018-q', ['a.txt']).code, 70);
  editRegistry(t, reg => { reg.packages['261018-q'].since = ago(5 * HOUR).toISOString(); });
  assert.match(queue(t, 'status', '--summary').out, /^packages: 1 running, 0 waiting, 1 parked, 0 stale, 1 stuck; \/h-queue for the list$/m);
  assert.match(bar(t), /⚠1/);
  assert.match(queue(t, 'status').out.split('\n').find(l => l.startsWith('261018-q  ')),
    /  parked stuck  .*  next: over 4 hours: the operator decides; h-queue retire 261018-q --reason <text> forgets it  /);
  const r = retire(t, '261018-q');
  assert.equal(r.code, 0, r.out);
  assert.equal(r.out, `retired 261018-q\nkept: patch none, ledgers ${ledgerOf(t, '261018-q')}\n`);
  assert.equal(pkgOf(t, '261018-q'), undefined);
  assert.match(queue(t, 'status', '--summary').out, /^packages: 1 running, 0 waiting, 0 parked, 0 stale, 0 stuck; \/h-queue for the list$/m);
  assert.doesNotMatch(bar(t), /⚠/);
  const e = lastEvent(t);
  assert.deepEqual([e.kind, e.id, e.text], ['retired', '261018-q', `never runs; head none, patch none, ledgers ${ledgerOf(t, '261018-q')}`]);
  assert.ok(fs.existsSync(ledgerOf(t, '261018-q')));
  assert.equal(pkgOf(t, '001-01').state, 'admitted');
  assert.equal(queue(t, 'admit', '261018-q').code, 2);
});

test('retire keeps the patch and the ledger', () => {
  const t = makeRepo();
  const wt = lastLine(ok(quick(t, '261018-q', ['a.txt'])).out);
  fs.writeFileSync(path.join(wt, 'a.txt'), 'half done\n');
  ok(queue(t, 'yield', '261018-q', '--reason', 'x'));
  const stem = ledgerOf(t, '261018-q').replace(/\.md$/, '');
  const patch = `${stem}-dropped-r1` + '.patch', ledger = `${stem}-dropped-r1.md`;
  const head = pkgOf(t, '261018-q').head;
  assert.equal(pkgOf(t, '261018-q').patch, patch);
  const bytes = [patch, ledger].map(f => fs.readFileSync(f, 'utf8'));
  const r = retire(t, '261018-q');
  assert.equal(r.code, 0, r.out);
  assert.equal(r.out, `retired 261018-q\nkept: patch ${patch}, ledgers ${ledger}\n`);
  assert.ok(fs.existsSync(patch) && fs.existsSync(ledger));
  assert.deepEqual([patch, ledger].map(f => fs.readFileSync(f, 'utf8')), bytes);
  assert.equal(pkgOf(t, '261018-q'), undefined);
  assert.equal(lastEvent(t).text, `never runs; head ${head.slice(0, 7)}, patch ${patch}, ledgers ${ledger}`);
});

test('retire names the default ledger of a package admitted without one', () => {
  const t = makeRepo();
  ok(plan(t, '001-01', ['b.txt']));
  assert.equal(queue(t, 'admit', '261018-r', '--kind', 'quick', '--owner', 'quick:261018-r', '--writes', 'b.txt').code, 70);
  assert.equal(fs.existsSync(defaultLedger(t, '')), false);
  assert.equal(retire(t, '261018-r').out, 'retired 261018-r\nkept: patch none, ledgers none\n');
  ok(queue(t, 'admit', '261018-q', '--kind', 'quick', '--owner', 'quick:261018-q', '--writes', 'a.txt'));
  ok(queue(t, 'yield', '261018-q', '--reason', 'x'));
  assert.equal(retire(t, '261018-q').out, `retired 261018-q\nkept: patch none, ledgers ${defaultLedger(t, '261018-q-LEDGER-dropped-r1.md')}\n`);
});

test('retire lists every dropped ledger in ascending order', () => {
  const t = makeRepo();
  ok(plan(t, '001-01', ['a.txt']));
  assert.equal(quick(t, '261018-q', ['a.txt']).code, 70);
  const stem = ledgerOf(t, '261018-q').replace(/\.md$/, '');
  const extra = [`${stem}-dropped-r10.md`, `${stem}-dropped-r2.md`, `${stem}-dropped-r2` + '.patch', `${stem}-dropped-r3.md.bak`];
  for (const f of extra) fs.writeFileSync(f, 'x\n');
  assert.equal(retire(t, '261018-q').out, `retired 261018-q\nkept: patch none, ledgers ${stem}.md, ${stem}-dropped-r2.md, ${stem}-dropped-r10.md\n`);
  for (const f of extra) assert.ok(fs.existsSync(f));
});

test('retire refuses a package in flight', () => {
  const t = makeRepo();
  ok(plan(t, '001-01', ['a.txt']));
  ok(quick(t, '261018-q', ['b.txt']));
  editRegistry(t, reg => { Object.assign(reg.packages['261018-q'], { state: 'waiting', waits_on: { id: '001-01', path: 'a.txt' } }); });
  for (const [id, state] of [['001-01', 'admitted'], ['261018-q', 'waiting']]) {
    const before = pkgOf(t, id);
    const r = retire(t, id);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, new RegExp(`^h-queue: ${id} is ${state}; yield or drop it first$`, 'm'));
    assert.deepEqual(pkgOf(t, id), before);
  }
});

test('retire refuses an unknown id', () => {
  const t = makeRepo();
  for (const id of ['261018-x', 'constructor']) {
    const r = retire(t, id);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, new RegExp(`^h-queue: no package ${id} in the registry$`, 'm'));
  }
  ok(quick(t, '261018-q', ['a.txt']));
  ok(queue(t, 'yield', '261018-q', '--reason', 'x'));
  for (const argv of [['retire', '261018-q'], ['retire', '261018-q', '--reason'], ['retire', '--reason', 'x']]) assert.equal(queue(t, ...argv).code, 2);
  assert.equal(pkgOf(t, '261018-q').state, 'parked');
});

test('retire refuses a landing in doubt', () => {
  const t = makeRepo();
  ok(quick(t, '261018-q', ['a.txt']));
  ok(quick(t, '261018-r', ['b.txt']));
  ok(queue(t, 'yield', '261018-r', '--reason', 'x'));
  const T = sh('git rev-parse HEAD', t.root, t.env);
  editRegistry(t, reg => { for (const id of ['261018-q', '261018-r']) reg.packages[id].pending = { submitted: T, target: T, tests: [], time: new Date().toISOString() }; });
  for (const [id, text] of [['261018-q', 'h-queue land 261018-q finishes it'], ['261018-r', 'ask the operator']]) {
    const before = pkgOf(t, id);
    const r = retire(t, id);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, new RegExp(`^h-queue: ${id} has a landing in doubt; ${text}$`, 'm'));
    assert.deepEqual(pkgOf(t, id), before);
  }
});

test("retire refuses a phase's package", () => {
  const t = makeRepo();
  ok(plan(t, '001-01', ['a.txt']));
  ok(queue(t, 'yield', '001-01', '--reason', 'x'));
  ok(queue(t, 'admit', '001-01-fix1', '--kind', 'fix', '--owner', 'phase:001', '--writes', 'b.txt'));
  ok(queue(t, 'yield', '001-01-fix1', '--reason', 'x'));
  for (const id of ['001-01', '001-01-fix1']) {
    const before = pkgOf(t, id);
    assert.equal(before.state, 'parked');
    const r = retire(t, id);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, new RegExp(`^h-queue: ${id} belongs to phase 001; /h-execute re-runs a phase's parked package$`, 'm'));
    assert.deepEqual(pkgOf(t, id), before);
  }
});

test("retire forgets a quick's parked fix", () => {
  const t = makeRepo();
  ok(queue(t, 'admit', '261018-q-fix1', '--kind', 'fix', '--owner', 'quick:261018-q', '--writes', 'a.txt'));
  ok(queue(t, 'yield', '261018-q-fix1', '--reason', 'x'));
  assert.equal(retire(t, '261018-q-fix1').code, 0);
  assert.equal(pkgOf(t, '261018-q-fix1'), undefined);
});

test('retire refuses a landed package', () => {
  const t = makeRepo();
  ok(quick(t, '261018-q', ['a.txt']));
  onBranch(t.root, '261018-q', 'a.txt', 'changed\n', 'change a', t.env);
  ok(land(t, '261018-q'));
  ok(plan(t, '001-01', ['b.txt']));
  onBranch(t.root, '001-01', 'b.txt', 'changed\n', 'change b', t.env);
  ok(land(t, '001-01'));
  for (const id of ['261018-q', '001-01']) {
    const before = pkgOf(t, id);
    const r = retire(t, id);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, new RegExp(`^h-queue: ${id} is landed; only a parked package can be retired$`, 'm'));
    assert.deepEqual(pkgOf(t, id), before);
  }
});

test('a wait on a retired package ends', async () => {
  const t = makeRepo();
  ok(plan(t, '001-01', ['a.txt']));
  assert.equal(quick(t, '261018-q', ['a.txt']).code, 70);
  const w = waitFor(t, '261018-q');
  try {
    await R.sleep(1500);
    assert.equal(w.child.exitCode, null, w.out);
    ok(retire(t, '261018-q'));
    const r = await within(w.done, 5000);
    assert.ok(r, 'wait did not end within 5 s: ' + w.out);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /^h-queue: no package 261018-q in the registry$/m);
  } finally { kill(w); }
});

test('h-queue -h lists retire after resume', () => {
  const r = run('h-queue', ['-h']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^\/\/   h-queue retire <id> --reason <text>  a parked package that will never run: delete its record, keep its patch and ledger\n\/\/ Exit:/m);
});

test('status names retire only on a stuck parked quick', () => {
  const t = makeRepo();
  ok(plan(t, '001-01', ['a.txt']));
  assert.equal(quick(t, '261018-q', ['a.txt']).code, 70);
  ok(queue(t, 'admit', '261018-q-fix1', '--kind', 'fix', '--owner', 'quick:261018-q', '--writes', 'b.txt'));
  ok(queue(t, 'yield', '261018-q-fix1', '--reason', 'x'));
  ok(queue(t, 'admit', '001-01-fix1', '--kind', 'fix', '--owner', 'phase:001', '--writes', 'b.txt'));
  ok(queue(t, 'yield', '001-01-fix1', '--reason', 'x'));
  const T = sh('git rev-parse HEAD', t.root, t.env), n = new Date().toISOString();
  editRegistry(t, reg => {
    reg.packages['261018-w'] = { id: '261018-w', kind: 'quick', owner: 'quick:261018-w', state: 'waiting', seq: 9, writes: [], declared: [], reads: [],
      waits_on: { id: '001-01', path: 'a.txt' }, worktree: null, since: n, heartbeat: n };
    reg.packages['261018-p'] = { id: '261018-p', kind: 'quick', owner: 'quick:261018-p', state: 'parked', seq: 10, writes: [], declared: [], reads: [],
      waits_on: null, worktree: null, since: n, pending: { submitted: T, target: T, tests: [], time: n } };
  });
  const lineOf = (out, id) => out.split('\n').find(l => l.startsWith(id + '  '));
  // Not stuck yet: a parked quick shows its own next step.
  assert.match(lineOf(queue(t, 'status').out, '261018-q'), /  next: re-admitted when 001-01 lands; h-queue wait 261018-q  /);
  editRegistry(t, reg => { for (const p of Object.values(reg.packages)) if (p.id !== '001-01') p.since = ago(5 * HOUR).toISOString(); });
  const out = queue(t, 'status').out;
  for (const id of ['261018-q', '261018-q-fix1']) assert.match(lineOf(out, id), new RegExp(`  parked stuck  .*  next: over 4 hours: the operator decides; h-queue retire ${id} --reason <text> forgets it  `));
  assert.match(lineOf(out, '001-01-fix1'), /  parked stuck  .*  next: over 4 hours: the operator decides  /);
  assert.match(lineOf(out, '261018-w'), /  waiting stuck  .*  next: over 4 hours: the operator decides  /);
  assert.match(lineOf(out, '261018-p'), /  parked landing stuck  .*  next: a landing to finish: h-queue land 261018-p completes it from git  /);
  for (const id of ['001-01-fix1', '261018-w', '261018-p']) assert.doesNotMatch(lineOf(out, id), /retire/);
});
