'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path'), cp = require('child_process');
const { makeRepo, run, sh } = require('./fixtures/repo.js');
const R = require('../lib/registry.js');
const LIB = path.join(__dirname, '..', 'lib', 'registry.js');
const BIN = path.join(__dirname, '..', 'bin', 'h-queue');

// D04's eight, in its order: bin/h-queue SHARED must hold exactly these.
const SHARED = ['.planning/state.yaml', '.planning/asks.yaml', '.planning/OPEN-ASKS.md', '.planning/ledger.md',
  '.holden/radius.yaml', '.holden/config.yaml', 'docs/CONTEXT.md', 'CLAUDE.md'];
const ST = '.planning/state.yaml';

const queue = (t, ...a) => run('h-queue', a, { cwd: t.root, env: t.env });
const metaDir = t => path.join(t.root, '.git', 'holden-meta');
const tokens = t => fs.existsSync(metaDir(t)) ? fs.readdirSync(metaDir(t)).filter(n => n !== 'JOURNAL') : [];
// The lines meta open prints: `token <t>`, `work <path> <copy>[ (absent at HEAD)]`, `new <dir>`.
function opened(r) {
  const token = (r.out.match(/^token (\S+)$/m) || [])[1];
  const work = {};
  for (const m of r.out.matchAll(/^work (\S+) (\S+)( \(absent at HEAD\))?$/gm)) work[m[1]] = { file: m[2], absent: !!m[3] };
  const nw = (r.out.match(/^new (\S+)$/m) || [])[1];
  return { token, work, new: nw };
}
const headBlob = (t, p) => cp.spawnSync('git', ['-C', t.root, 'cat-file', 'blob', `HEAD:${p}`], { env: t.env }).stdout;
async function holdFromChild(lockPath) {
  const child = cp.spawn(process.execPath, ['-e', `require(${JSON.stringify(LIB)}).holdLock(${JSON.stringify(lockPath)}, 60, 'test').then(() => setTimeout(() => process.exit(0), 60000))`], { stdio: 'ignore' });
  for (let i = 0; i < 100; i++) { if (fs.existsSync(lockPath + '.holder') && fs.readFileSync(lockPath + '.holder', 'utf8').startsWith('test')) break; await R.sleep(50); }
  return child;
}

test('meta open copies each file from HEAD byte for byte and prints the work paths', () => {
  const t = makeRepo();
  const r = queue(t, 'meta', 'open', ST, '.holden/config.yaml');
  assert.equal(r.code, 0, r.out);
  const o = opened(r);
  assert.match(o.token, /^[0-9a-z]+-[0-9a-f]{6}$/);
  const d = path.join(metaDir(t), o.token);
  for (const f of [ST, '.holden/config.yaml']) {
    assert.equal(o.work[f].file, path.join(d, 'work', f));
    assert.equal(o.work[f].absent, false);
    assert.ok(fs.readFileSync(o.work[f].file).equals(headBlob(t, f)), `${f}: work copy equals HEAD`);
    assert.ok(fs.readFileSync(path.join(d, 'base', f)).equals(headBlob(t, f)), `${f}: base copy equals HEAD`);
  }
  assert.ok(headBlob(t, ST).toString().endsWith('\n'), 'the trailing newline is kept');
  assert.equal(o.new, path.join(d, 'new'));
  assert.ok(fs.statSync(o.new).isDirectory());
  const tk = JSON.parse(fs.readFileSync(path.join(d, 'token.json'), 'utf8'));
  assert.equal(tk.token, o.token);
  assert.equal(tk.head, sh('git rev-parse HEAD', t.root, t.env));
  assert.deepEqual(tk.files, [ST, '.holden/config.yaml']);
  assert.deepEqual(tk.absent, []);
  assert.ok(!isNaN(Date.parse(tk.opened)), 'opened is a timestamp');
  assert.equal(tk.session, 'sess-1');
  assert.equal(sh('git status --porcelain', t.root, t.env), '', 'the tree is untouched');
});

test('meta open marks a shared file absent at HEAD and writes no copy', () => {
  const t = makeRepo();
  const r = queue(t, 'meta', 'open', 'CLAUDE.md');
  assert.equal(r.code, 0, r.out);
  const o = opened(r);
  assert.equal(o.work['CLAUDE.md'].absent, true, r.out);
  assert.ok(!fs.existsSync(o.work['CLAUDE.md'].file));
  assert.ok(!fs.existsSync(path.join(metaDir(t), o.token, 'base', 'CLAUDE.md')));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(metaDir(t), o.token, 'token.json'), 'utf8')).absent, ['CLAUDE.md']);
});

test('meta open without a file is usage', () => {
  const t = makeRepo();
  assert.equal(queue(t, 'meta', 'open').code, 2);
  assert.equal(queue(t, 'meta', 'open', '--x').code, 2);
  assert.equal(queue(t, 'meta').code, 2);
  assert.equal(tokens(t).length, 0);
});

test('meta open accepts each shared file and nothing else', () => {
  const t = makeRepo();
  for (const f of SHARED) {
    const r = queue(t, 'meta', 'open', f);
    assert.equal(r.code, 0, `${f}: ${r.out}`);
    assert.ok(opened(r).work[f], `${f}: a work line`);
  }
  assert.equal(tokens(t).length, SHARED.length);
  const t2 = makeRepo();
  const r = queue(t2, 'meta', 'open', 'a.txt');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /not a shared file: a\.txt; an owner-unique path goes to meta commit --add/);
  assert.equal(tokens(t2).length, 0);
});

test('meta open takes no lock', { timeout: 20000 }, async () => {
  const t = makeRepo();
  const holder = await holdFromChild(R.paths(t.root).landingLock);
  try {
    const r = cp.spawnSync(process.execPath, [BIN, 'meta', 'open', ST], { cwd: t.root, env: t.env, encoding: 'utf8', timeout: 5000 });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  } finally { holder.kill('SIGKILL'); }
});

test('meta open from a linked worktree puts the token in the common dir', () => {
  const t = makeRepo();
  const wt = run('h-worktree', ['add', '009-01'], { cwd: t.root, env: t.env }).out.trim().split('\n').pop();
  assert.ok(fs.existsSync(wt), wt);
  const r = run('h-queue', ['meta', 'open', ST], { cwd: wt, env: t.env });
  assert.equal(r.code, 0, r.out);
  const token = opened(r).token;
  assert.ok(fs.existsSync(path.join(t.root, '.git', 'holden-meta', token)));
});

test('meta abort deletes a token and refuses an unknown one', () => {
  const t = makeRepo();
  const token = opened(queue(t, 'meta', 'open', ST)).token;
  const r = queue(t, 'meta', 'abort', token);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, new RegExp(`aborted ${token}`));
  assert.equal(tokens(t).length, 0);
  const again = queue(t, 'meta', 'abort', token);
  assert.equal(again.code, 1, again.out);
  assert.match(again.out, /no such token/);
  const dots = queue(t, 'meta', 'abort', '..');
  assert.equal(dots.code, 1, dots.out);
  assert.ok(fs.existsSync(metaDir(t)), 'the meta dir is still there');
  assert.ok(fs.existsSync(path.join(t.root, '.git', 'HEAD')), 'the git dir is still there');
  assert.equal(queue(t, 'meta', 'abort').code, 2);
});

test('admit refuses each shared file', () => {
  const t = makeRepo();
  SHARED.forEach((f, i) => {
    const r = queue(t, 'admit', `261018-${i}`, '--kind', 'quick', '--owner', `quick:261018-${i}`, '--writes', 'a.txt', f);
    assert.equal(r.code, 1, `${f}: ${r.out}`);
    assert.ok(r.out.includes(f), `${f} named: ${r.out}`);
    assert.match(r.out, /h-queue meta commit/);
  });
  assert.deepEqual(R.readRegistry(t.root).packages, {});
});

// --- meta commit (Task 3) ---
const { start, commitFile } = require('./fixtures/repo.js');
const head = t => sh('git rev-parse HEAD', t.root, t.env);
const subject = (t, ref = 'HEAD') => sh(`git log -1 --format=%s ${ref}`, t.root, t.env);
const namesIn = (t, ref = 'HEAD') => sh(`git show --name-only --format= ${ref}`, t.root, t.env).split('\n').filter(Boolean).sort();
const porcelain = t => sh('git status --porcelain', t.root, t.env);
const headState = t => sh(`git show HEAD:${ST}`, t.root, t.env);
const journalF = t => path.join(metaDir(t), 'JOURNAL');
function openTok(t, ...files) { const r = queue(t, 'meta', 'open', ...files); assert.equal(r.code, 0, r.out); return { ...opened(r), dir: path.join(metaDir(t), opened(r).token) }; }
// A file absent at HEAD has no work copy: the caller creates it, parent dirs included (the Write tool does).
function edit(tok, f, fn) { const w = tok.work[f].file; fs.mkdirSync(path.dirname(w), { recursive: true }); fs.writeFileSync(w, fn(fs.existsSync(w) ? fs.readFileSync(w, 'utf8') : '')); }
const QUICK_LINE = /^quick: \[\].*$/m;
const quickEntry = id => `  - id: ${id}\n    slug: s\n    status: planned\n    date: 2026-10-18\n    dir: .planning/quick/${id}\n`;
const addQuick = (id) => s => s.replace(QUICK_LINE, 'quick:\n' + quickEntry(id).replace(/\n$/, ''));
const commitTok = (t, tok, ...a) => queue(t, 'meta', 'commit', tok.token, ...a);

test('meta commit publishes one commit and leaves the tree equal to HEAD', () => {
  const t = makeRepo();
  const old = head(t);
  const tok = openTok(t, ST);
  edit(tok, ST, s => s.replace(/^project: t$/m, 'project: t2'));
  const r = commitTok(t, tok, '-m', 'meta: t2');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^committed [0-9a-f]{7} meta: t2$/m);
  assert.equal(sh('git rev-parse HEAD~1', t.root, t.env), old);
  assert.equal(subject(t), 'meta: t2');
  assert.deepEqual(namesIn(t), [ST]);
  assert.match(fs.readFileSync(path.join(t.root, ST), 'utf8'), /^project: t2$/m);
  assert.equal(porcelain(t), '');
  assert.equal(sh('git diff --cached --name-only', t.root, t.env), '');
  assert.equal(tokens(t).length, 0);
  assert.ok(!fs.existsSync(journalF(t)));
});

test('the A3 order: a quick opens, a plan commits state, the quick commits', () => {
  const t = makeRepo();
  const quick = openTok(t, ST);
  edit(quick, ST, addQuick('261018-a'));
  fs.mkdirSync(path.join(quick.new, '.planning', 'quick', '261018-a'), { recursive: true });
  const plan = openTok(t, ST);
  edit(plan, ST, s => s.replace(/^    status: grilled .*$/m, '    status: planned'));
  fs.mkdirSync(path.join(t.root, '.planning', 'phases', '001-example-phase'), { recursive: true });
  fs.writeFileSync(path.join(t.root, '.planning', 'phases', '001-example-phase', '001-01-PLAN.md'), '# plan\n');
  const rp = commitTok(t, plan, '--add', '.planning/phases/001-example-phase', '-m', 'docs(001): plans');
  assert.equal(rp.code, 0, rp.out);
  assert.deepEqual(namesIn(t), ['.planning/phases/001-example-phase/001-01-PLAN.md', ST]);
  assert.doesNotMatch(headState(t), /261018-a/);
  const planCommit = head(t);
  const rq = commitTok(t, quick, '--next-quick', '261018-a', '-m', 'docs(quick-261018-a): open');
  assert.equal(rq.code, 0, rq.out);
  assert.equal(sh('git rev-parse HEAD~1', t.root, t.env), planCommit);
  assert.deepEqual(namesIn(t), [ST]);
  // Its own entry adds a status line; a stale copy would also remove the plan's `status: planned`.
  assert.doesNotMatch(sh('git show --format= HEAD', t.root, t.env), /^-\s+status:/m, 'the quick changes no existing status line');
  const hs = headState(t);
  assert.match(hs, /status: planned/);
  assert.match(hs, /261018-a/);
  assert.ok(fs.statSync(path.join(t.root, '.planning', 'quick', '261018-a')).isDirectory());
  assert.equal(porcelain(t), '');
});

test('two appends at one place conflict: 73 and nothing published', () => {
  const t = makeRepo();
  const a = openTok(t, ST), b = openTok(t, ST);
  edit(a, ST, addQuick('261018-a'));
  edit(b, ST, addQuick('261018-b'));
  assert.equal(commitTok(t, a, '-m', 'quick a').code, 0);
  const after = head(t);
  const r = commitTok(t, b, '-m', 'quick b');
  assert.equal(r.code, 73, r.out);
  assert.match(r.out, /conflict in \.planning\/state\.yaml: open again and redo the edit/);
  assert.equal(head(t), after);
  assert.ok(fs.existsSync(b.dir), 'the token is kept');
  assert.equal(porcelain(t), '');
  // The redo: a new token from the new HEAD, the entry after the first one.
  assert.equal(queue(t, 'meta', 'abort', b.token).code, 0);
  const c = openTok(t, ST);
  edit(c, ST, s => s.replace(quickEntry('261018-a'), quickEntry('261018-a') + quickEntry('261018-b')));
  const r2 = commitTok(t, c, '-m', 'quick b');
  assert.equal(r2.code, 0, r2.out);
  const hs = headState(t);
  assert.match(hs, /261018-a/);
  assert.match(hs, /261018-b/);
});

test('a HEAD moved before the publish refuses with 73 and keeps the token', () => {
  const t = makeRepo();
  const tok = openTok(t, ST);
  edit(tok, ST, s => s.replace(/^project: t$/m, 'project: t2'));
  const env = { ...t.env, HOLDEN_TEST_RUN_AT: 'meta-before-publish', HOLDEN_TEST_RUN_CMD: 'git commit -q --allow-empty -m moved' };
  const r = run('h-queue', ['meta', 'commit', tok.token, '-m', 'meta: t2'], { cwd: t.root, env });
  assert.equal(r.code, 73, r.out);
  assert.match(r.out, /HEAD moved from [0-9a-f]{7} to [0-9a-f]{7} during the commit; nothing was published/);
  assert.equal(subject(t), 'moved');
  assert.ok(!fs.existsSync(journalF(t)), 'the journal of an unpublished commit is gone');
  assert.ok(fs.existsSync(tok.dir), 'the token is kept');
  assert.equal(porcelain(t), '');
  const r2 = commitTok(t, tok, '-m', 'meta: t2');
  assert.equal(r2.code, 0, r2.out);
  assert.equal(subject(t, 'HEAD~1'), 'moved');
  assert.match(headState(t), /^project: t2$/m);
});

test('a kill before the publish leaves the token; the next commit publishes it', () => {
  const t = makeRepo();
  const old = head(t);
  const tok = openTok(t, ST);
  edit(tok, ST, s => s.replace(/^project: t$/m, 'project: t2'));
  const r = run('h-queue', ['meta', 'commit', tok.token, '-m', 'meta: t2'], { cwd: t.root, env: { ...t.env, HOLDEN_TEST_CRASH_AT: 'meta-after-journal' } });
  assert.equal(r.code, 99, r.out);
  assert.equal(head(t), old);
  assert.ok(fs.existsSync(journalF(t)));
  assert.ok(fs.existsSync(tok.dir));
  assert.equal(sh('git diff --cached --name-only', t.root, t.env), '', 'the main index is untouched');
  assert.equal(porcelain(t), '');
  const r2 = commitTok(t, tok, '-m', 'meta: t2');
  assert.equal(r2.code, 0, r2.out);
  assert.match(r2.out, new RegExp(`was never published; token ${tok.token} kept`));
  assert.ok(!fs.existsSync(journalF(t)));
  assert.equal(subject(t), 'meta: t2');
  assert.equal(sh('git rev-parse HEAD~1', t.root, t.env), old);
});

test('a kill after the publish is replayed by the next meta commit', () => {
  const killed = () => {
    const t = makeRepo();
    const tok = openTok(t, ST);
    edit(tok, ST, s => s.replace(/^project: t$/m, 'project: t2'));
    const r = run('h-queue', ['meta', 'commit', tok.token, '-m', 'meta: t2'], { cwd: t.root, env: { ...t.env, HOLDEN_TEST_CRASH_AT: 'meta-after-publish' } });
    assert.equal(r.code, 99, r.out);
    assert.equal(subject(t), 'meta: t2');
    assert.equal(porcelain(t), 'M  .planning/state.yaml');
    // A second session opens after the kill: its copies come from the published HEAD.
    const second = openTok(t, ST);
    edit(second, ST, s => s.replace(/^current_phase: 1$/m, 'current_phase: 2'));
    return { t, tok, second };
  };
  // The same token first: the replay syncs the tree and deletes the token (D07's answer).
  const a = killed();
  const r = commitTok(a.t, a.tok, '-m', 'again');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /replayed the metadata journal of [0-9a-f]{7}: 1 path\(s\) synced from HEAD/);
  assert.match(r.out, /no such token: open again/);
  assert.match(fs.readFileSync(path.join(a.t.root, ST), 'utf8'), /^project: t2$/m);
  assert.equal(porcelain(a.t), '');
  assert.ok(!fs.existsSync(journalF(a.t)));
  const r2 = commitTok(a.t, a.second, '-m', 'phase 2');
  assert.equal(r2.code, 0, r2.out);
  // The second token first: its commit replays before anything reads the stale tree.
  const b = killed();
  const r3 = commitTok(b.t, b.second, '-m', 'phase 2');
  assert.equal(r3.code, 0, r3.out);
  assert.match(r3.out, /replayed the metadata journal/);
  const hs = headState(b.t);
  assert.match(hs, /^project: t2$/m);
  assert.match(hs, /^current_phase: 2$/m);
  assert.equal(porcelain(b.t), '');
  assert.match(commitTok(b.t, b.tok, '-m', 'again').out, /no such token: open again/);
});

test('meta commit of an unknown or aborted token says open again', () => {
  const t = makeRepo();
  const r = queue(t, 'meta', 'commit', 'zzz-000000', '-m', 'x');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /no such token: open again/);
  const tok = openTok(t, ST);
  assert.equal(queue(t, 'meta', 'abort', tok.token).code, 0);
  const r2 = commitTok(t, tok, '-m', 'x');
  assert.equal(r2.code, 1, r2.out);
  assert.match(r2.out, /no such token: open again/);
  const bad = openTok(t, ST);
  fs.writeFileSync(path.join(bad.dir, 'token.json'), '{');
  const r3 = commitTok(t, bad, '-m', 'x');
  assert.equal(r3.code, 1, r3.out);
  assert.match(r3.out, new RegExp(`token ${bad.token} is unreadable: h-queue meta abort ${bad.token}, then open again`));
  // A hand-edited file list naming a path outside the shared files reads as unreadable too.
  fs.writeFileSync(path.join(bad.dir, 'token.json'), JSON.stringify({ files: ['../x'] }));
  const r3b = commitTok(t, bad, '-m', 'x');
  assert.equal(r3b.code, 1, r3b.out);
  assert.match(r3b.out, /is unreadable: h-queue meta abort/);
  const gone = openTok(t, ST);
  fs.rmSync(gone.work[ST].file);
  const r4 = commitTok(t, gone, '-m', 'x');
  assert.equal(r4.code, 1, r4.out);
  assert.match(r4.out, /the work copy of \.planning\/state\.yaml is missing/);
});

test('meta commit moves an empty new directory into place', () => {
  const t = makeRepo();
  const tok = openTok(t, ST);
  edit(tok, ST, addQuick('261018-e'));
  fs.mkdirSync(path.join(tok.new, '.planning', 'quick', '261018-e'), { recursive: true });
  fs.mkdirSync(path.join(tok.new, '.planning', 'quick', '261018-f'), { recursive: true });
  fs.writeFileSync(path.join(tok.new, '.planning', 'quick', '261018-f', 'PLAN.md'), '# f\n');
  fs.writeFileSync(path.join(tok.new, '.planning', 'quick', '261018-f', 'run.sh'), '#!/bin/sh\n', { mode: 0o755 });
  const r = commitTok(t, tok, '-m', 'quick e');
  assert.equal(r.code, 0, r.out);
  assert.ok(fs.statSync(path.join(t.root, '.planning', 'quick', '261018-e')).isDirectory());
  assert.deepEqual(namesIn(t), ['.planning/quick/261018-f/PLAN.md', '.planning/quick/261018-f/run.sh', ST]);
  assert.equal(fs.readFileSync(path.join(t.root, '.planning', 'quick', '261018-f', 'PLAN.md'), 'utf8'), '# f\n');
  assert.match(sh('git ls-tree HEAD .planning/quick/261018-f/run.sh', t.root, t.env), /^100755 /);
  assert.equal(fs.statSync(path.join(t.root, '.planning', 'quick', '261018-f', 'run.sh')).mode & 0o111, 0o111);
  assert.equal(porcelain(t), '');
});

test('meta commit --add stages an owner-unique path, deletions included', () => {
  const t = makeRepo();
  commitFile(t.root, '.planning/phases/001-x/a.md', 'a\n', 'a', t.env);
  commitFile(t.root, '.planning/phases/001-x/b.md', 'b\n', 'b', t.env);
  const dir = path.join(t.root, '.planning', 'phases', '001-x');
  fs.writeFileSync(path.join(dir, 'a.md'), 'a2\n');
  fs.rmSync(path.join(dir, 'b.md'));
  fs.writeFileSync(path.join(dir, 'c.md'), 'c\n');
  const tok = openTok(t, ST);
  const r = commitTok(t, tok, '--add', '.planning/phases/001-x', '-m', 'phase files');
  assert.equal(r.code, 0, r.out);
  assert.equal(sh('git show --name-status --format= HEAD', t.root, t.env).split('\n').sort().join('\n'),
    ['A\t.planning/phases/001-x/c.md', 'D\t.planning/phases/001-x/b.md', 'M\t.planning/phases/001-x/a.md'].join('\n'));
  assert.equal(porcelain(t), '');
});

test('a work copy equal to HEAD commits nothing and keeps the token', () => {
  const t = makeRepo();
  const old = head(t);
  const tok = openTok(t, ST);
  const r = commitTok(t, tok, '-m', 'x');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, new RegExp(`nothing to commit: the token's copies equal HEAD; h-queue meta abort ${tok.token} drops it`));
  assert.equal(head(t), old);
  assert.ok(fs.existsSync(tok.dir));
});

test('meta commit without -m is usage', () => {
  const t = makeRepo();
  const tok = openTok(t, ST);
  assert.equal(commitTok(t, tok).code, 2);
  assert.equal(commitTok(t, tok, '-m', '').code, 2);
  assert.equal(commitTok(t, tok, '-m').code, 2);
  assert.equal(queue(t, 'meta', 'commit', '-m', 'x').code, 2);
  assert.ok(fs.existsSync(tok.dir));
});

test('two meta commits at once both publish', { timeout: 60000 }, async () => {
  const t = makeRepo();
  const old = head(t);
  const a = openTok(t, ST), b = openTok(t, ST);
  edit(a, ST, s => s.replace(/^project: t$/m, 'project: t2'));
  edit(b, ST, addQuick('261018-b'));
  const ra = start('h-queue', ['meta', 'commit', a.token, '-m', 'a'], { cwd: t.root, env: t.env });
  const rb = start('h-queue', ['meta', 'commit', b.token, '-m', 'b'], { cwd: t.root, env: t.env });
  const res = await Promise.all([ra.done, rb.done]);
  assert.deepEqual(res.map(r => r.code).sort(), [0, 0], res.map(r => r.out).join('\n'));
  assert.equal(sh(`git rev-list --count ${old}..HEAD`, t.root, t.env), '2');
  const hs = headState(t);
  assert.match(hs, /^project: t2$/m);
  assert.match(hs, /261018-b/);
  assert.equal(porcelain(t), '');
});

test('meta commit inside h-queue lock does not wait on itself', async () => {
  const t = makeRepo();
  const tok = openTok(t, ST);
  edit(tok, ST, s => s.replace(/^project: t$/m, 'project: t2'));
  const a = start('h-queue', ['lock', '--', `${process.execPath} ${BIN} meta commit ${tok.token} -m inner`], { cwd: t.root, env: t.env });
  // A meta commit that waited on the outer lock would wait 4 hours; 15 s is the verdict.
  const r = await Promise.race([a.done, R.sleep(15000).then(() => ({ code: 'timeout', out: a.out }))]);
  a.child.kill('SIGKILL');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /committed [0-9a-f]{7} inner/);
});

// --- meta commit's checks (Task 4) ---
const esc = s => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const appendQuick = id => s => QUICK_LINE.test(s) ? addQuick(id)(s) : s.replace(/^quick:\n/m, 'quick:\n' + quickEntry(id));
const t2 = s => s.replace(/^project: t$/m, 'project: t2');

test('an uncommitted change to any shared file blocks the commit', () => {
  const t = makeRepo();
  const tok = openTok(t, ST);
  edit(tok, ST, t2);
  const old = head(t);
  const refused = p => {
    const r = commitTok(t, tok, '-m', 'x');
    assert.equal(r.code, 73, `${p}: ${r.out}`);
    assert.match(r.out, new RegExp(`uncommitted change in ${esc(p)}: commit or discard it`));
    assert.equal(head(t), old);
  };
  for (const p of SHARED) {
    const f = path.join(t.root, p);
    if (cp.spawnSync('git', ['-C', t.root, 'cat-file', '-e', `HEAD:${p}`]).status === 0) {
      const orig = fs.readFileSync(f);
      fs.appendFileSync(f, '# hand edit\n');
      refused(p);
      assert.match(fs.readFileSync(f, 'utf8'), /# hand edit/, 'the hand edit is kept');
      fs.writeFileSync(f, orig);
    } else {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, 'x\n');
      refused(p);
      fs.rmSync(f);
    }
  }
  const f = path.join(t.root, ST), orig = fs.readFileSync(f);
  // Staged only: the tree holds HEAD's bytes again, the main index does not.
  fs.appendFileSync(f, '# staged\n'); sh(`git add -- ${ST}`, t.root, t.env); fs.writeFileSync(f, orig);
  refused(ST);
  sh(`git reset -q -- ${ST}`, t.root, t.env);
  fs.rmSync(f);
  refused(ST);
  fs.writeFileSync(f, orig);
  assert.equal(porcelain(t), '');
  assert.equal(commitTok(t, tok, '-m', 'x').code, 0);
});

test('a merged state.yaml or asks.yaml that does not parse is refused', () => {
  const t = makeRepo();
  const old = head(t);
  const a = openTok(t, ST);
  edit(a, ST, s => s + 'garbage\n');
  const r = commitTok(t, a, '-m', 'x');
  assert.equal(r.code, 73, r.out);
  assert.match(r.out, /\.planning\/state\.yaml does not parse after the merge \(bad line: garbage\): open again and redo the edit/);
  const b = openTok(t, '.planning/asks.yaml');
  edit(b, '.planning/asks.yaml', () => 'asks:\n  - id: a\n    status: open\nnot yaml\n');
  const r2 = commitTok(t, b, '-m', 'x');
  assert.equal(r2.code, 73, r2.out);
  assert.match(r2.out, /\.planning\/asks\.yaml does not parse after the merge/);
  assert.equal(head(t), old);
});

test('a duplicate phase number, quick or ask id is refused', () => {
  const t = makeRepo();
  const old = head(t);
  const tryIt = (files, fn, extra = []) => { const tok = openTok(t, ...files); fn(tok); const r = commitTok(t, tok, ...extra, '-m', 'x'); return r; };
  const r1 = tryIt([ST], tok => edit(tok, ST, s => s.replace(/^quick:/m, '  - number: 1\n    slug: dup\n    status: grilled\nquick:')));
  assert.equal(r1.code, 73, r1.out);
  assert.match(r1.out, /phase number 1 appears 2 times in \.planning\/state\.yaml; one entry expected/);
  const r2 = tryIt([ST], tok => edit(tok, ST, s => s.replace(QUICK_LINE, 'quick:\n  - id: 261018\n    dir: .planning/quick/261018-a\n  - id: 261018-a\n    dir: .planning/quick/261018-a')));
  assert.equal(r2.code, 73, r2.out);
  assert.match(r2.out, /quick 261018-a appears 2 times in \.planning\/state\.yaml; one entry expected/);
  // /h-audit's shape: the asks files alone, no --ask-once.
  const r3 = tryIt(['.planning/asks.yaml', '.planning/OPEN-ASKS.md'], tok => {
    edit(tok, '.planning/asks.yaml', () => 'asks:\n  - id: x\n    status: open\n  - id: x\n    status: open\n');
    edit(tok, '.planning/OPEN-ASKS.md', () => '# asks\n');
  });
  assert.equal(r3.code, 73, r3.out);
  assert.match(r3.out, /ask x appears 2 times in asks\.yaml; one entry expected/);
  assert.equal(head(t), old);
  // A converted repo's shape: one id twice, under two dirs.
  const r4 = tryIt([ST], tok => edit(tok, ST, s => s.replace(QUICK_LINE, 'quick:\n  - id: 250102\n    dir: .planning/quick/250102-a\n  - id: 250102\n    dir: .planning/quick/250102-b')));
  assert.equal(r4.code, 0, r4.out);
});

test("--next-phase takes HEAD's next number and one merged entry", () => {
  const entry = (n, slug) => `  - number: ${n}\n    slug: ${slug}\n    status: grilled\n    dir: .planning/phases/00${n}-${slug}\n`;
  const grill = (t, n, slug) => {
    const tok = openTok(t, ST);
    edit(tok, ST, s => s.replace(/^quick:/m, entry(n, slug) + 'quick:'));
    const d = path.join(tok.new, '.planning', 'phases', `00${n}-${slug}`);
    fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, `00${n}-DECISION.md`), 'x\n');
    return tok;
  };
  const t = makeRepo();
  const old = head(t);
  const a = grill(t, 2, 'x'), c = grill(t, 2, 'y');
  const r1 = commitTok(t, a, '--next-phase', '3', '-m', 'g');
  assert.equal(r1.code, 73, r1.out);
  assert.match(r1.out, /next phase is 002, not 3/);
  const b = openTok(t, ST);
  edit(b, ST, t2);
  const r2 = commitTok(t, b, '--next-phase', '2', '-m', 'g');
  assert.equal(r2.code, 73, r2.out);
  assert.match(r2.out, /phase 2 appears 0 times in the merged \.planning\/state\.yaml; one entry expected/);
  assert.equal(head(t), old);
  const r3 = commitTok(t, a, '--next-phase', '2', '-m', 'g');
  assert.equal(r3.code, 0, r3.out);
  assert.ok(fs.existsSync(path.join(t.root, '.planning/phases/002-x/002-DECISION.md')));
  // The grill race: a second grill that opened before the first committed conflicts first (D02).
  const after = head(t);
  const r4 = commitTok(t, c, '--next-phase', '2', '-m', 'g');
  assert.equal(r4.code, 73, r4.out);
  assert.match(r4.out, /conflict in \.planning\/state\.yaml/);
  assert.equal(head(t), after);
  // A stale number with a clean merge: HEAD gains a phase dir and no state entry.
  const u = makeRepo();
  const s = grill(u, 2, 'x');
  commitFile(u.root, '.planning/phases/002-other/002-DECISION.md', 'o\n', 'other phase', u.env);
  const r5 = commitTok(u, s, '--next-phase', '2', '-m', 'g');
  assert.equal(r5.code, 73, r5.out);
  assert.match(r5.out, /next phase is 003, not 2/);
  edit(s, ST, x => x.replace('  - number: 2\n    slug: x\n    status: grilled\n    dir: .planning/phases/002-x', '  - number: 3\n    slug: x\n    status: grilled\n    dir: .planning/phases/003-x'));
  fs.renameSync(path.join(s.new, '.planning/phases/002-x'), path.join(s.new, '.planning/phases/003-x'));
  const r6 = commitTok(u, s, '--next-phase', '3', '-m', 'g');
  assert.equal(r6.code, 0, r6.out);
  assert.equal(porcelain(u), '');
});

// --- phase numbers keyed as written (quick 261019) ---
const phaseAt = n => `  - number: ${n}\n    slug: s\n    status: landed\n`;
const withPhases = (...ns) => s => s.replace(/^quick:/m, ns.map(phaseAt).join('') + 'quick:');
// HEAD gains these phase entries in one plain commit: no meta check runs on it.
const headPhases = (t, ...ns) => commitFile(t.root, ST, withPhases(...ns)(fs.readFileSync(path.join(t.root, ST), 'utf8')), 'phases ' + ns.join(' '), t.env);
// One meta commit of state.yaml edited by fn; with dir, a phase dir under new/ as /h-grill writes one.
function stateCommit(t, fn, extra = [], dir = null) {
  const tok = openTok(t, ST);
  edit(tok, ST, fn);
  if (dir) { const d = path.join(tok.new, '.planning', 'phases', dir); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'DECISION.md'), 'x\n'); }
  return commitTok(t, tok, ...extra, '-m', 'x');
}

test('non-integer phase numbers are distinct keys', () => {
  const t = makeRepo();
  const r = stateCommit(t, withPhases(35, 35.1, '18a', '18b', '15B', 999.9));
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /phase number/);
  for (const n of ['35', '35.1', '18a', '18b', '15B', '999.9']) assert.match(headState(t), new RegExp(`^  - number: ${esc(n)}$`, 'm'), n);
});

test('a true duplicate stays refused across spellings', () => {
  const t = makeRepo();
  const old = head(t);
  for (const spelt of ['"001"', '" 1 "']) {
    const r = stateCommit(t, withPhases(spelt));
    assert.equal(r.code, 73, `${spelt}: ${r.out}`);
    assert.match(r.out, /phase number 1 appears 2 times in \.planning\/state\.yaml; one entry expected/, spelt);
  }
  assert.equal(head(t), old);
});

test('--next-phase counts its own entry by key', () => {
  for (const np of ['3', '003']) {
    const t = makeRepo();
    headPhases(t, 2);
    const r = stateCommit(t, withPhases(3, 3.1), ['--next-phase', np], '003-x');
    assert.equal(r.code, 0, `${np}: ${r.out}`);
    assert.doesNotMatch(r.out, /appears/, np);
  }
});

test('a non-integer duplicate is refused', () => {
  const t = makeRepo();
  const old = head(t);
  for (const [n, key] of [['35.1', '35.1'], ['18a', '18a'], ['backlog', 'backlog'], ['""', '']]) {
    const r = stateCommit(t, withPhases(n, n));
    assert.equal(r.code, 73, `${n}: ${r.out}`);
    assert.match(r.out, new RegExp(`^phase number ${esc(key)} appears 2 times in \\.planning/state\\.yaml; one entry expected$`, 'm'), n);
  }
  assert.equal(head(t), old);
  // Only a null number is skipped (D01).
  const r = stateCommit(t, withPhases('null', 'null'));
  assert.equal(r.code, 0, r.out);
});

test('--next-phase ignores non-integer numbers', () => {
  const t = makeRepo();
  headPhases(t, 2, 999.9, '18a');
  const r = stateCommit(t, withPhases(3), ['--next-phase', '3'], '003-x');
  assert.equal(r.code, 0, r.out);
  assert.ok(fs.existsSync(path.join(t.root, '.planning/phases/003-x/DECISION.md')));
});

test('--next-quick refuses an id at HEAD and needs one merged entry', () => {
  const t = makeRepo();
  const a = openTok(t, ST);
  edit(a, ST, appendQuick('261018-a'));
  const r1 = commitTok(t, a, '--next-quick', '261018-a', '-m', 'q');
  assert.equal(r1.code, 0, r1.out);
  commitFile(t.root, '.planning/quick/261018-b/PLAN.md', 'b\n', 'quick b dir', t.env);
  const old = head(t);
  const b = openTok(t, ST);
  edit(b, ST, appendQuick('261018-b'));
  const r2 = commitTok(t, b, '--next-quick', '261018-b', '-m', 'q');
  assert.equal(r2.code, 73, r2.out);
  assert.match(r2.out, /quick 261018-b already exists at HEAD/);
  const c = openTok(t, ST);
  edit(c, ST, t2);
  const r3 = commitTok(t, c, '--next-quick', '261018-c', '-m', 'q');
  assert.equal(r3.code, 73, r3.out);
  assert.match(r3.out, /quick 261018-c appears 0 times in the merged \.planning\/state\.yaml; one entry expected/);
  assert.equal(head(t), old);
});

test('--next-quick with a numeric id names the directory to pass', () => {
  const t = makeRepo();
  const numbered = (id, dir = '.planning/quick/261021-x') => s => s.replace(QUICK_LINE,
    `quick:\n  - id: ${id}\n    slug: x\n    status: planned\n    date: 2026-10-21` + (dir ? `\n    dir: ${dir}` : ''));
  const tryNext = (entry, v) => { const tok = openTok(t, ST); edit(tok, ST, entry); return commitTok(t, tok, '--next-quick', v, '-m', 'q'); };
  const old = head(t);
  const r1 = tryNext(numbered('64'), '64');
  assert.equal(r1.code, 73, r1.out);
  assert.match(r1.out, /^quick 64 appears 0 times in the merged \.planning\/state\.yaml; one entry expected; a quick is keyed by its directory's name: pass --next-quick 261021-x$/m);
  // yaml-lite reads `id: 064` as 64: an all-digit value is also compared without its leading zeros.
  const r2 = tryNext(numbered('064'), '064');
  assert.equal(r2.code, 73, r2.out);
  assert.match(r2.out, /pass --next-quick 261021-x$/m);
  // No entry has the id: the plain refusal.
  const r3 = tryNext(numbered('64'), '65');
  assert.equal(r3.code, 73, r3.out);
  assert.match(r3.out, /^quick 65 appears 0 times in the merged \.planning\/state\.yaml; one entry expected$/m);
  // An entry with no dir has no directory to name.
  const r4 = tryNext(numbered('064', null), '064');
  assert.equal(r4.code, 73, r4.out);
  assert.match(r4.out, /^quick 064 appears 0 times in the merged \.planning\/state\.yaml; one entry expected$/m);
  assert.equal(head(t), old);
});

test('--ask-once counts the merged asks.yaml', () => {
  const t = makeRepo();
  const ASKS = '.planning/asks.yaml', entry = id => `  - id: ${id}\n    status: open\n`;
  const z = openTok(t, ST);
  edit(z, ST, t2);
  const r0 = commitTok(t, z, '--ask-once', 'my-ask', '-m', 'a');
  assert.equal(r0.code, 73, r0.out);
  assert.match(r0.out, /ask my-ask appears 0 times in asks\.yaml/);
  const a = openTok(t, ASKS);
  edit(a, ASKS, () => 'asks:\n' + entry('my-ask'));
  const r1 = commitTok(t, a, '--ask-once', 'my-ask', '-m', 'a');
  assert.equal(r1.code, 0, r1.out);
  const b = openTok(t, ASKS);
  edit(b, ASKS, s => s + entry('my-ask'));
  const r2 = commitTok(t, b, '--ask-once', 'my-ask', '-m', 'a');
  assert.equal(r2.code, 73, r2.out);
  assert.match(r2.out, /ask my-ask appears 2 times in asks\.yaml/);
});

test('a new path that exists at HEAD or in the tree is refused', () => {
  const t = makeRepo();
  commitFile(t.root, '.planning/quick/261018-h/PLAN.md', 'h\n', 'h', t.env);
  const old = head(t);
  const withNew = rel => { const tok = openTok(t, ST); edit(tok, ST, t2); fs.mkdirSync(path.dirname(path.join(tok.new, rel)), { recursive: true }); fs.writeFileSync(path.join(tok.new, rel), 'n\n'); return commitTok(t, tok, '-m', 'n'); };
  const r1 = withNew('.planning/quick/261018-h/PLAN.md');
  assert.equal(r1.code, 73, r1.out);
  assert.match(r1.out, /\.planning\/quick\/261018-h\/PLAN\.md already exists at HEAD/);
  fs.mkdirSync(path.join(t.root, '.planning/quick/261018-u'), { recursive: true });
  fs.writeFileSync(path.join(t.root, '.planning/quick/261018-u/PLAN.md'), 'mine\n');
  const r2 = withNew('.planning/quick/261018-u/PLAN.md');
  assert.equal(r2.code, 73, r2.out);
  assert.match(r2.out, /\.planning\/quick\/261018-u\/PLAN\.md already exists in the tree/);
  assert.equal(fs.readFileSync(path.join(t.root, '.planning/quick/261018-u/PLAN.md'), 'utf8'), 'mine\n');
  const r3 = withNew(ST);
  assert.equal(r3.code, 1, r3.out);
  assert.match(r3.out, /\.planning\/state\.yaml is a shared file: open it with meta open, not under new\//);
  assert.equal(head(t), old);
});

test('--add refuses a shared file, a directory holding one, a path outside the repo and a missing path', () => {
  const t = makeRepo();
  const old = head(t);
  const tok = openTok(t, ST);
  edit(tok, ST, t2);
  for (const [p, re] of [[ST, /--add \.planning\/state\.yaml is or holds a shared file: open it with meta open/],
    ['.planning', /--add \.planning is or holds a shared file/], ['../x', /--add \.\.\/x: not a repo path/],
    ['.git', /--add \.git: not a repo path/], ['nothere', /--add nothere: no such path in the tree or at HEAD/]]) {
    const r = commitTok(t, tok, '--add', p, '-m', 'x');
    assert.equal(r.code, 1, `${p}: ${r.out}`);
    assert.match(r.out, re);
  }
  assert.equal(head(t), old);
  assert.equal(porcelain(t), '');
});

test("the token's remove list deletes clean paths at HEAD and refuses others", () => {
  const t = makeRepo();
  commitFile(t.root, '.planning/phases/001-old/a.md', 'a\n', 'a', t.env);
  commitFile(t.root, '.planning/phases/001-old/b.md', 'b\n', 'b', t.env);
  const old = head(t);
  const tok = openTok(t, ST);
  edit(tok, ST, t2);
  fs.writeFileSync(path.join(tok.dir, 'remove'), 'nothere\n');
  const r1 = commitTok(t, tok, '-m', 'rm');
  assert.equal(r1.code, 1, r1.out);
  assert.match(r1.out, /remove nothere: not at HEAD/);
  fs.writeFileSync(path.join(tok.dir, 'remove'), '.planning/phases/001-old\n');
  fs.writeFileSync(path.join(t.root, '.planning/phases/001-old/u.md'), 'untracked\n');
  const r2 = commitTok(t, tok, '-m', 'rm');
  assert.equal(r2.code, 73, r2.out);
  assert.match(r2.out, /uncommitted change in \.planning\/phases\/001-old: commit or discard it/);
  assert.equal(head(t), old);
  fs.rmSync(path.join(t.root, '.planning/phases/001-old/u.md'));
  const r3 = commitTok(t, tok, '-m', 'rm');
  assert.equal(r3.code, 0, r3.out);
  assert.equal(sh('git ls-tree -r --name-only HEAD .planning/phases', t.root, t.env), '');
  assert.ok(!fs.existsSync(path.join(t.root, '.planning/phases/001-old')));
  assert.equal(porcelain(t), '');
});

// --- the replay in every locked command (plan 2, Task 1) ---
const { writeLedger, onBranch } = require('./fixtures/repo.js');
// A meta commit killed right after its update-ref: HEAD holds `project: t2`, the tree and the main
// index still hold the old blob, and JOURNAL names the commit (research P3).
function killedPastPublish(t) {
  const tok = openTok(t, ST);
  edit(tok, ST, t2);
  const r = run('h-queue', ['meta', 'commit', tok.token, '-m', 'meta: t2'], { cwd: t.root, env: { ...t.env, HOLDEN_TEST_CRASH_AT: 'meta-after-publish' } });
  assert.equal(r.code, 99, r.out);
  assert.ok(fs.existsSync(journalF(t)), 'the kill left JOURNAL');
  assert.equal(porcelain(t), 'M  .planning/state.yaml');
  return tok;
}

test('a locked commit after a kill past the publish keeps the metadata commit', () => {
  const t = makeRepo();
  killedPastPublish(t);
  fs.writeFileSync(path.join(t.root, 'a.txt'), 'x\n');
  const r = queue(t, 'lock', '--', 'git add a.txt && git commit -qm code');
  assert.equal(r.code, 0, r.out);
  assert.match(headState(t), /^project: t2$/m);
  assert.deepEqual(namesIn(t), ['a.txt']);
  assert.equal(subject(t, 'HEAD~1'), 'meta: t2');
  assert.equal(porcelain(t), '');
});

test('freeze replays a pending journal first', () => {
  const t = makeRepo();
  killedPastPublish(t);
  const r = queue(t, 'freeze', '--', 'true');
  assert.equal(r.code, 0, r.out);
  assert.ok(!fs.existsSync(journalF(t)));
  assert.match(r.out, /replayed the metadata journal/);
  assert.equal(porcelain(t), '');
});

test('h-queue land replays a pending journal before h-worktree runs', () => {
  const t = makeRepo();
  const ledger = writeLedger(path.join(t.dir, '261018-q-LEDGER.md'), []);
  const a = queue(t, 'admit', '261018-q', '--kind', 'quick', '--owner', 'quick:261018-q', '--writes', 'b.txt', '--ledger', ledger);
  assert.equal(a.code, 0, a.out);
  onBranch(t.root, '261018-q', 'b.txt', 'changed\n', 'change b', t.env);
  // After the admit: admit's own replay is not what clears it.
  killedPastPublish(t);
  const r = run('h-queue', ['land', '261018-q', '--ledger', ledger], { cwd: t.root, env: { ...t.env, HOLDEN_TEST_CRASH_AT: 'queue-before-land' } });
  assert.equal(r.code, 99, r.out);
  assert.ok(!fs.existsSync(journalF(t)), r.out);
  assert.match(r.out, /replayed the metadata journal/);
  assert.equal(porcelain(t), '');
});

test('admit replays a pending journal first', () => {
  const t = makeRepo();
  killedPastPublish(t);
  const r = queue(t, 'admit', '261018-q', '--kind', 'quick', '--owner', 'quick:261018-q', '--writes', 'b.txt');
  assert.equal(r.code, 0, r.out);
  assert.ok(!fs.existsSync(journalF(t)));
  assert.equal(porcelain(t), '');
  // skills/h-execute/SKILL.md step 4 reads the worktree path from the last line.
  const last = r.out.trim().split('\n').pop();
  assert.ok(path.isAbsolute(last) && fs.statSync(last).isDirectory(), r.out);
});

test('status replays a pending journal when the landing lock is free', () => {
  const t = makeRepo();
  killedPastPublish(t);
  const r = queue(t, 'status');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /replayed the metadata journal/);
  assert.ok(!fs.existsSync(journalF(t)));
  assert.equal(porcelain(t), '');
  // --summary keeps its one line and --json stays JSON with a journal pending.
  const s = makeRepo();
  killedPastPublish(s);
  const rs = queue(s, 'status', '--summary');
  assert.equal(rs.code, 0, rs.out);
  assert.equal(rs.out, 'packages: none\n');
  const j = makeRepo();
  killedPastPublish(j);
  const rj = queue(j, 'status', '--json');
  assert.equal(rj.code, 0, rj.out);
  assert.ok(JSON.parse(rj.out).packages);
});

test('status leaves a pending journal while the landing lock is held', { timeout: 30000 }, async () => {
  const t = makeRepo();
  killedPastPublish(t);
  const holder = await holdFromChild(R.paths(t.root).landingLock);
  try {
    const r = cp.spawnSync(process.execPath, [BIN, 'status'], { cwd: t.root, env: t.env, encoding: 'utf8', timeout: 10000 });
    const out = (r.stdout || '') + (r.stderr || '');
    assert.equal(r.status, 0, out);
    assert.match(out, /metadata journal pending; the next locked h-queue command replays it/);
    assert.ok(fs.existsSync(journalF(t)), 'JOURNAL kept');
  } finally { holder.kill('SIGKILL'); }
});

test('lock refuses to run while the journal is unreadable', () => {
  const t = makeRepo();
  fs.mkdirSync(metaDir(t), { recursive: true });
  fs.writeFileSync(journalF(t), '{');
  const ran = path.join(t.root, 'ran');
  const r = queue(t, 'lock', '--', 'touch ran');
  assert.ok(!fs.existsSync(ran), r.out);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /is unreadable/);
});

// --- status lists old tokens (plan 2, Task 2) ---
const HOUR = 60 * 60 * 1000;
function setOpened(tok, ms) {
  const f = path.join(tok.dir, 'token.json'), tk = JSON.parse(fs.readFileSync(f, 'utf8'));
  tk.opened = new Date(ms).toISOString();
  fs.writeFileSync(f, JSON.stringify(tk, null, 2) + '\n');
  return tk.opened;
}
const tokenLines = out => out.split('\n').filter(l => l.startsWith('metadata token '));

test('status lists a token older than 24 hours with its abort command', { timeout: 30000 }, async () => {
  const t = makeRepo();
  const tok = openTok(t, ST, '.planning/asks.yaml');
  const opened = setOpened(tok, Date.now() - 25 * HOUR);
  // Neither is a token: a pending JOURNAL (kept, since another process holds the lock) and a
  // leftover temp file of lib/meta.js writeAtomic, both dated past 24 hours.
  fs.writeFileSync(journalF(t), '{');
  const tmp = path.join(metaDir(t), '.JOURNAL.holden-tmp-123');
  fs.writeFileSync(tmp, '{}');
  const old = (Date.now() - 25 * HOUR) / 1000;
  for (const f of [journalF(t), tmp]) fs.utimesSync(f, old, old);
  const holder = await holdFromChild(R.paths(t.root).landingLock);
  try {
    const st = (...a) => { const r = cp.spawnSync(process.execPath, [BIN, 'status', ...a], { cwd: t.root, env: t.env, encoding: 'utf8', timeout: 10000 }); return { code: r.status, out: (r.stdout || '') + (r.stderr || '') }; };
    const r = st();
    assert.equal(r.code, 0, r.out);
    const lines = tokenLines(r.out);
    assert.equal(lines.length, 1, r.out);
    // opened is UTC: read as local time, the minute would move by the zone offset.
    assert.equal(lines[0], `metadata token ${tok.token} opened ${opened.slice(0, 16)} (.planning/state.yaml, .planning/asks.yaml): older than 24 hours; h-queue meta abort ${tok.token} deletes it`);
    const ls = r.out.split('\n');
    assert.ok(ls.indexOf('packages: none') < ls.indexOf(lines[0]), r.out);
    assert.ok(fs.existsSync(tok.dir), 'status deletes no token');
    const s = st('--summary');
    assert.equal(s.code, 0, s.out);
    assert.equal(s.out.trim().split('\n').length, 1, s.out);
  } finally { holder.kill('SIGKILL'); }
});

test('status does not list a token younger than 24 hours', () => {
  const t = makeRepo();
  const tok = openTok(t, ST);
  setOpened(tok, Date.now() - 24 * HOUR + 60 * 1000);
  const r = queue(t, 'status');
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /metadata token/);
});

test('status dates a token without token.json by its directory', () => {
  const t = makeRepo();
  const tok = openTok(t, ST);
  fs.rmSync(path.join(tok.dir, 'token.json'));
  const old = (Date.now() - 25 * HOUR) / 1000;
  fs.utimesSync(tok.dir, old, old);
  // A token deleted between status's readdir and its stat: a name that stats to nothing is skipped.
  fs.symlinkSync(path.join(t.dir, 'gone'), path.join(metaDir(t), 'zzzz-000000'));
  const r = queue(t, 'status');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /metadata token \S+ opened .*: older than 24 hours/);
  assert.deepEqual(tokenLines(r.out), [`metadata token ${tok.token} opened ${new Date(old * 1000).toISOString().slice(0, 16)}: older than 24 hours; h-queue meta abort ${tok.token} deletes it`]);
});

// --- diff review r1 (phase 002) ---
test('a kill after the publish keeps an empty new directory: the replay makes it', () => {
  const t = makeRepo();
  const tok = openTok(t, ST);
  edit(tok, ST, addQuick('261018-k'));
  fs.mkdirSync(path.join(tok.new, '.planning', 'quick', '261018-k'), { recursive: true });
  const r = run('h-queue', ['meta', 'commit', tok.token, '-m', 'quick k'], { cwd: t.root, env: { ...t.env, HOLDEN_TEST_CRASH_AT: 'meta-after-publish' } });
  assert.equal(r.code, 99, r.out);
  assert.ok(!fs.existsSync(path.join(t.root, '.planning', 'quick', '261018-k')));
  const r2 = queue(t, 'lock', '--', 'true');
  assert.equal(r2.code, 0, r2.out);
  assert.match(r2.out, /replayed the metadata journal/);
  assert.ok(fs.statSync(path.join(t.root, '.planning', 'quick', '261018-k')).isDirectory());
  assert.ok(!fs.existsSync(tok.dir));
});

test('an in-place edit made after the D03 check is kept as .holden-saved, not overwritten', () => {
  const t = makeRepo();
  const tok = openTok(t, ST);
  edit(tok, ST, s => s.replace(/^project: t$/m, 'project: t2'));
  const env = { ...t.env, HOLDEN_TEST_RUN_AT: 'meta-before-publish', HOLDEN_TEST_RUN_CMD: "printf '# late\\n' >> .planning/state.yaml" };
  const r = run('h-queue', ['meta', 'commit', tok.token, '-m', 'meta: t2'], { cwd: t.root, env });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /kept an uncommitted edit of \.planning\/state\.yaml as \.planning\/state\.yaml\.holden-saved/);
  assert.match(fs.readFileSync(path.join(t.root, ST + '.holden-saved'), 'utf8'), /^# late$/m);
  assert.equal(fs.readFileSync(path.join(t.root, ST), 'utf8'), headBlob(t, ST).toString());
  // A sync that replaces only what it published saves nothing.
  const tok2 = openTok(t, ST);
  edit(tok2, ST, s => s.replace(/^project: t2$/m, 'project: t3'));
  fs.rmSync(path.join(t.root, ST + '.holden-saved'));
  const r2 = commitTok(t, tok2, '-m', 'meta: t3');
  assert.equal(r2.code, 0, r2.out);
  assert.doesNotMatch(r2.out, /holden-saved/);
});

test('status with an unreadable journal prints the reason and still lists the packages', () => {
  const t = makeRepo();
  fs.mkdirSync(metaDir(t), { recursive: true });
  fs.writeFileSync(journalF(t), '{');
  const r = queue(t, 'status');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /metadata journal .* is unreadable/);
});

test('admit refuses while the journal is unreadable and leaves the landing lock free', () => {
  const t = makeRepo();
  fs.mkdirSync(metaDir(t), { recursive: true });
  fs.writeFileSync(journalF(t), '{');
  const r = queue(t, 'admit', '001-01', '--kind', 'quick', '--owner', 'quick:x', '--writes', 'a.txt');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /is unreadable/);
  fs.rmSync(journalF(t));
  assert.equal(queue(t, 'lock', '--', 'true').code, 0);
});
