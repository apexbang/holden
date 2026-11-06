'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path'), cp = require('child_process');
const { makeRepo, sh, commitFile } = require('./fixtures/repo.js');
const R = require('../lib/registry.js');
const M = require('../lib/meta.js');

function git(t, argv, { input, index } = {}) {
  const env = index ? { ...t.env, GIT_INDEX_FILE: index } : t.env;
  const r = cp.spawnSync('git', ['-C', t.root, ...argv], { env, input, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${argv.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
// A commit built in a temporary index, as bin/h-queue meta commit builds one: the main index and
// the tree keep the old content. `write` maps a path to [mode, content]; `drop` lists deletions.
function build(t, { write = {}, drop = [], publish = true }) {
  const index = path.join(t.dir, `index-${Date.now()}-${Math.random()}`);
  const old = git(t, ['rev-parse', 'HEAD']);
  git(t, ['read-tree', 'HEAD'], { index });
  for (const [p, [mode, content]] of Object.entries(write)) {
    const sha = git(t, ['hash-object', '-w', '--stdin'], { input: content });
    git(t, ['update-index', '--add', '--cacheinfo', `${mode},${sha},${p}`], { index });
  }
  for (const p of drop) git(t, ['update-index', '--force-remove', '--', p], { index });
  const tree = git(t, ['write-tree'], { index });
  const next = git(t, ['commit-tree', tree, '-p', old], { input: 'meta\n' });
  if (publish) git(t, ['update-ref', 'HEAD', next, old]);
  fs.rmSync(index, { force: true });
  const paths = git(t, ['diff', '--name-only', '--no-renames', '-z', old, next]).split('\0').filter(Boolean);
  return { old, next, paths };
}
const ST = '.planning/state.yaml';
function repoWithOld() {
  const t = makeRepo();
  commitFile(t.root, 'x/old/k.txt', 'k\n', 'k', t.env);
  return t;
}
// In the fixture repo: state.yaml changed, an executable run.sh added under x, b.txt and the file under x/old deleted.
function theCommit(t, opts = {}) {
  const st = fs.readFileSync(path.join(t.root, ST), 'utf8').replace(/^project: t$/m, 'project: t2');
  return build(t, { write: { [ST]: ['100644', st], 'x/run.sh': ['100755', '#!/bin/sh\necho hi\n'] }, drop: ['b.txt', 'x/old/k.txt'], ...opts });
}
const porcelain = t => sh('git status --porcelain', t.root, t.env);
const headBlob = (t, p) => git(t, ['cat-file', 'blob', `HEAD:${p}`]);
function journal(t, j) { fs.mkdirSync(M.dirOf(t.root), { recursive: true }); fs.writeFileSync(M.journalOf(t.root), typeof j === 'string' ? j : JSON.stringify(j)); }
function token(t, name) { const d = path.join(M.dirOf(t.root), name); fs.mkdirSync(path.join(d, 'work'), { recursive: true }); return d; }

test("syncFromHead writes HEAD's content, removes what HEAD lacks and resets the main index", () => {
  const t = repoWithOld();
  const c = theCommit(t);
  assert.notEqual(porcelain(t), '', 'the publish leaves the tree and the main index behind');
  M.syncFromHead(t.root, c.paths);
  assert.equal(fs.readFileSync(path.join(t.root, ST), 'utf8').trim(), headBlob(t, ST));
  assert.match(fs.readFileSync(path.join(t.root, ST), 'utf8'), /^project: t2$/m);
  assert.equal(fs.statSync(path.join(t.root, 'x/run.sh')).mode & 0o111, 0o111);
  assert.ok(!fs.existsSync(path.join(t.root, 'b.txt')));
  assert.ok(!fs.existsSync(path.join(t.root, 'x/old')), 'the emptied directory is pruned');
  assert.ok(fs.existsSync(path.join(t.root, 'x')), 'a directory still holding a file stays');
  assert.equal(porcelain(t), '');
});

test('replayJournal syncs a published journal and deletes its token', () => {
  const t = repoWithOld();
  const c = theCommit(t);
  const d = token(t, 'abc-0a0b0c');
  journal(t, { token: 'abc-0a0b0c', old: c.old, new: c.next, paths: c.paths });
  const lines = M.replayJournal(t.root);
  assert.match(lines.join('\n'), new RegExp(`replayed the metadata journal of ${c.next.slice(0, 7)}: ${c.paths.length} path\\(s\\)`));
  assert.ok(!fs.existsSync(d), 'the token is gone');
  assert.ok(!fs.existsSync(M.journalOf(t.root)));
  assert.match(fs.readFileSync(path.join(t.root, ST), 'utf8'), /^project: t2$/m);
  assert.equal(porcelain(t), '');
});

test('replayJournal keeps the token and the tree of an unpublished journal', () => {
  const t = repoWithOld();
  const c = theCommit(t, { publish: false });
  const d = token(t, 'abc-0a0b0c');
  journal(t, { token: 'abc-0a0b0c', old: c.old, new: c.next, paths: [ST, 'x/new.txt'] });
  const lines = M.replayJournal(t.root);
  assert.match(lines.join('\n'), /was never published; token abc-0a0b0c kept/);
  assert.ok(fs.existsSync(d), 'the token is kept');
  assert.ok(!fs.existsSync(M.journalOf(t.root)));
  assert.ok(fs.existsSync(path.join(t.root, 'b.txt')), 'the tree is untouched');
  assert.match(fs.readFileSync(path.join(t.root, ST), 'utf8'), /^project: t$/m);
  assert.equal(git(t, ['rev-parse', 'HEAD']), c.old);
  assert.equal(porcelain(t), '');
});

test('replayJournal counts a journal behind a later HEAD as published', () => {
  const t = repoWithOld();
  const c = theCommit(t);
  // A later locked commit on top, built the same way, so it carries the published content.
  build(t, { write: { 'c.txt': ['100644', 'c\n'] } });
  const d = token(t, 'abc-0a0b0c');
  journal(t, { token: 'abc-0a0b0c', old: c.old, new: c.next, paths: c.paths });
  M.replayJournal(t.root);
  assert.equal(fs.existsSync(M.journalOf(t.root)), false);
  assert.ok(!fs.existsSync(d), 'published: the token is deleted');
  assert.match(fs.readFileSync(path.join(t.root, ST), 'utf8'), /^project: t2$/m);
  assert.ok(!fs.existsSync(path.join(t.root, 'b.txt')));
});

test('replayJournal without a journal does nothing', () => {
  const t = makeRepo();
  const lines = M.replayJournal(t.root);
  assert.deepEqual(lines, []);
  assert.equal(porcelain(t), '');
});

test('an unreadable journal stops with its path', () => {
  const t = makeRepo();
  journal(t, '{');
  assert.throws(() => M.replayJournal(t.root), /holden-meta\/JOURNAL is unreadable/);
  journal(t, { token: 'a-000000', new: git(t, ['rev-parse', 'HEAD']), paths: [] });
  assert.throws(() => M.replayJournal(t.root), /holden-meta\/JOURNAL is unreadable/);
  assert.ok(fs.existsSync(M.journalOf(t.root)), 'the journal is left for the operator');
});

test('a journal naming an invalid token removes no directory', () => {
  const t = makeRepo();
  const head = git(t, ['rev-parse', 'HEAD']);
  journal(t, { token: '..', old: head, new: head, paths: [] });
  M.replayJournal(t.root);
  assert.ok(fs.existsSync(R.paths(t.root).meta));
  assert.ok(!fs.existsSync(M.journalOf(t.root)));
});
