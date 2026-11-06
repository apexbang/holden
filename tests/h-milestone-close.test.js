'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path'), cp = require('child_process');
const { makeRepo, run, sh } = require('./fixtures/repo.js');

const ST = '.planning/state.yaml', ASKS = '.planning/asks.yaml';
const OLD = '.planning/phases/001-example-phase', NEW = '.planning/archive/v1.0/001-example-phase';
const OPEN = [ST, ASKS, '.planning/ledger.md', 'CLAUDE.md'];

const queue = (t, ...a) => run('h-queue', a, { cwd: t.root, env: t.env });
const close = (t, ...a) => run('h-milestone-close', a, { cwd: t.root, env: t.env });
const tokenDir = (t, token) => path.join(t.root, '.git', 'holden-meta', token);
const headBlob = (t, p) => cp.spawnSync('git', ['-C', t.root, 'cat-file', 'blob', `HEAD:${p}`], { env: t.env, encoding: 'utf8' }).stdout;

// templates/state.yaml's one phase (number 1, milestone v1.0, dir OLD) set to landed, a phase dir
// with an executable file, and an ask pointing into it: everything a close of v1.0 archives.
function closable({ pointer = `${OLD}/001-DECISION.md`, extra = {} } = {}) {
  const t = makeRepo();
  const w = (rel, text, mode) => { const f = path.join(t.root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); if (mode) fs.chmodSync(f, mode); };
  w(ST, fs.readFileSync(path.join(t.root, ST), 'utf8').replace(/^(    status: )grilled/m, '$1landed'));
  w(`${OLD}/001-DECISION.md`, '# decision\n');
  w(`${OLD}/run.sh`, '#!/bin/sh\nexit 0\n', 0o755);
  w(ASKS, ['asks:', '  - id: a1', '    status: open', `    pointer: ${pointer}`, ''].join('\n'));
  for (const [rel, text] of Object.entries(extra)) w(rel, text);
  sh(`git add -- ${[ST, ASKS, `${OLD}/001-DECISION.md`, `${OLD}/run.sh`, ...Object.keys(extra)].join(' ')} && git commit -q -m setup`, t.root, t.env);
  t.setup = sh('git rev-parse HEAD', t.root, t.env);
  return t;
}
function openToken(t, files = OPEN) {
  const r = queue(t, 'meta', 'open', ...files);
  assert.equal(r.code, 0, r.out);
  return r.out.match(/^token (\S+)$/m)[1];
}

test('h-milestone-close --token writes only into the token and one meta commit archives the milestone', () => {
  const t = closable();
  const token = openToken(t);
  const r = close(t, '--token', token);
  assert.equal(r.code, 0, r.out);
  assert.equal(sh('git status --porcelain', t.root, t.env), '', 'the script wrote nothing in the tree');
  assert.ok(fs.existsSync(path.join(t.root, OLD, 'run.sh')), 'the phase dir is still in place');
  assert.match(r.out, new RegExp(`publish with h-queue meta commit ${token} `));

  const c = queue(t, 'meta', 'commit', token, '-m', 'docs: close milestone v1.0');
  assert.equal(c.code, 0, c.out);
  assert.equal(sh('git rev-parse HEAD~1', t.root, t.env), t.setup, 'one commit');
  assert.equal(headBlob(t, `${NEW}/001-DECISION.md`), '# decision\n');
  assert.match(sh(`git ls-tree HEAD ${NEW}/run.sh`, t.root, t.env), /^100755 /);
  assert.equal(sh(`git ls-tree -r HEAD -- ${OLD}`, t.root, t.env), '', 'the old dir is gone at HEAD');
  assert.ok(!fs.existsSync(path.join(t.root, OLD)), 'the old dir is gone from the tree');
  assert.ok(fs.existsSync(path.join(t.root, NEW, 'run.sh')), 'the archive dir is in the tree');
  const st = headBlob(t, ST);
  assert.match(st, /^    status: archived/m);
  assert.match(st, new RegExp(`^    dir: ${NEW}$`, 'm'));
  assert.match(headBlob(t, ASKS), new RegExp(`^    pointer: ${NEW}/001-DECISION.md$`, 'm'));
  assert.equal(sh('git status --porcelain', t.root, t.env), '');
});

test('h-milestone-close without --token refuses and moves nothing', () => {
  const t = closable();
  const r = close(t);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /h-queue meta open \.planning\/state\.yaml/);
  assert.ok(fs.existsSync(path.join(t.root, OLD, 'run.sh')));
  assert.equal(sh('git status --porcelain', t.root, t.env), '');
});

test('h-milestone-close with an unknown token refuses', () => {
  const t = closable();
  for (const bad of ['..', 'zzzz-000000']) {
    const r = close(t, '--token', bad);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, new RegExp(`no such token: ${bad.replace(/\./g, '\\.')}`));
  }
  const aborted = openToken(t);
  assert.equal(queue(t, 'meta', 'abort', aborted).code, 0);
  const r = close(t, '--token', aborted);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /no such token/);

  // A token opened without state.yaml: the tree's copy is never read in its place.
  const noState = openToken(t, [ASKS]);
  const r2 = close(t, '--token', noState);
  assert.equal(r2.code, 1, r2.out);
  assert.match(r2.out, /the token holds no \.planning\/state\.yaml/);
  assert.ok(fs.existsSync(path.join(t.root, OLD, 'run.sh')));
  assert.equal(sh('git status --porcelain', t.root, t.env), '');
});

test('a failed pre-check leaves the token\'s copies as they were', () => {
  const t = closable({ pointer: `${OLD}/missing.md` });
  const token = openToken(t);
  const d = tokenDir(t, token);
  const r = close(t, '--token', token);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /pre-check failed/);
  for (const f of [ST, ASKS]) assert.ok(fs.readFileSync(path.join(d, 'work', f)).equals(fs.readFileSync(path.join(d, 'base', f))), `${f}: work equals base`);
  assert.ok(!fs.existsSync(path.join(d, 'new', '.planning')), 'nothing under new/');
  assert.ok(!fs.existsSync(path.join(d, 'remove')), 'no remove file');
  assert.equal(sh('git status --porcelain', t.root, t.env), '');
});

test('--dry-run without a token prints the map and writes nothing', () => {
  const t = closable();
  const r = close(t, '--dry-run');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, new RegExp(`^  ${OLD} -> ${NEW}$`, 'm'));
  assert.match(r.out, /dry run: pre-check passed/);
  assert.ok(fs.existsSync(path.join(t.root, OLD, 'run.sh')));
  assert.equal(sh('git status --porcelain', t.root, t.env), '');
});

test('the close commit refuses a phase dir with an untracked file', () => {
  const t = closable();
  fs.writeFileSync(path.join(t.root, OLD, 'notes.txt'), 'mine\n');
  const token = openToken(t);
  const r = close(t, '--token', token);
  assert.equal(r.code, 0, r.out);
  assert.ok(!fs.existsSync(path.join(tokenDir(t, token), 'new', NEW, 'notes.txt')), 'only HEAD\'s files are copied');
  const c = queue(t, 'meta', 'commit', token, '-m', 'docs: close milestone v1.0');
  assert.equal(c.code, 73, c.out);
  assert.match(c.out, new RegExp(`uncommitted change in ${OLD}: commit or discard it`));
  assert.equal(sh('git rev-parse HEAD', t.root, t.env), t.setup, 'nothing published');
  assert.equal(fs.readFileSync(path.join(t.root, OLD, 'notes.txt'), 'utf8'), 'mine\n');
});

test('a failed post-check undoes every write in the token', () => {
  // The pre-check reads the tree, where the untracked file is; the copy under new/ is HEAD's, without it.
  const t = closable({ pointer: `${OLD}/notes.txt` });
  fs.writeFileSync(path.join(t.root, OLD, 'notes.txt'), 'mine\n');
  const token = openToken(t);
  const d = tokenDir(t, token);
  const r = close(t, '--token', token);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /undone\. post-check failed/);
  for (const f of [ST, ASKS]) assert.ok(fs.readFileSync(path.join(d, 'work', f)).equals(fs.readFileSync(path.join(d, 'base', f))), `${f}: work equals base`);
  assert.deepEqual(fs.readdirSync(path.join(d, 'new')), [], 'new/ is as meta open left it');
  assert.ok(!fs.existsSync(path.join(d, 'remove')), 'no remove file');
});

test('a token without CLAUDE.md refuses when CLAUDE.md names the phase dir', () => {
  const t = closable({ extra: { 'CLAUDE.md': `see ${OLD}/001-DECISION.md\n` } });
  const token = openToken(t, [ST, ASKS]);
  const r = close(t, '--token', token);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, new RegExp(`the token does not hold CLAUDE\\.md, which names ${OLD}/001-DECISION\\.md: open it with the other files`));
  assert.ok(!fs.existsSync(path.join(tokenDir(t, token), 'remove')));
  assert.deepEqual(fs.readdirSync(path.join(tokenDir(t, token), 'new')), []);
});

test('a phase-dir commit after the script makes the close commit refuse', () => {
  const t = closable();
  const token = openToken(t);
  assert.equal(close(t, '--token', token).code, 0);
  fs.writeFileSync(path.join(t.root, OLD, '001-DECISION.md'), '# decision CHANGED\n');
  sh(`git add -- ${OLD}/001-DECISION.md && git commit -q -m later`, t.root, t.env);
  const later = sh('git rev-parse HEAD', t.root, t.env);
  const c = queue(t, 'meta', 'commit', token, '-m', 'docs: close milestone v1.0');
  assert.equal(c.code, 73, c.out);
  assert.match(c.out, new RegExp(`${OLD} changed at HEAD since the token opened: open again`));
  assert.equal(sh('git rev-parse HEAD', t.root, t.env), later, 'nothing published');
  assert.equal(headBlob(t, `${OLD}/001-DECISION.md`), '# decision CHANGED\n');
});

test('an ask HEAD gains after the open that names the phase dir makes the close commit refuse', () => {
  const t = closable();
  const token = openToken(t);
  // Another session adds an ask at the top, away from the line the close rewrites: the merge is clean.
  const other = openToken(t, [ASKS]);
  const w = path.join(tokenDir(t, other), 'work', ASKS);
  fs.writeFileSync(w, fs.readFileSync(w, 'utf8').replace('asks:\n', `asks:\n  - id: a0\n    status: open\n    pointer: ${OLD}/001-DECISION.md\n`));
  const o = queue(t, 'meta', 'commit', other, '-m', 'ask a0');
  assert.equal(o.code, 0, o.out);
  const asked = sh('git rev-parse HEAD', t.root, t.env);
  assert.equal(close(t, '--token', token).code, 0);
  const c = queue(t, 'meta', 'commit', token, '-m', 'docs: close milestone v1.0');
  assert.equal(c.code, 73, c.out);
  assert.match(c.out, new RegExp(`\\.planning/asks\\.yaml names ${OLD}, which this commit removes: open again and redo the edit`));
  assert.equal(sh('git rev-parse HEAD', t.root, t.env), asked, 'nothing published');
});

test('a shared file outside the token that HEAD gains a pointer in makes the close commit refuse', () => {
  const t = closable({ extra: { 'CLAUDE.md': '# c\n' } });
  const token = openToken(t, [ST, ASKS, '.planning/ledger.md']);
  assert.equal(close(t, '--token', token).code, 0);
  fs.writeFileSync(path.join(t.root, 'CLAUDE.md'), `# c\nsee ${OLD}/001-DECISION.md\n`);
  sh('git add CLAUDE.md && git commit -q -m pointer', t.root, t.env);
  const pointed = sh('git rev-parse HEAD', t.root, t.env);
  const c = queue(t, 'meta', 'commit', token, '-m', 'docs: close milestone v1.0');
  assert.equal(c.code, 73, c.out);
  assert.match(c.out, new RegExp(`CLAUDE\\.md names ${OLD}, which this commit removes: open again and redo the edit`));
  assert.equal(sh('git rev-parse HEAD', t.root, t.env), pointed, 'nothing published');
});
