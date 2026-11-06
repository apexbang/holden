'use strict';
// The full suite's stamp names the tree that was tested (phase 001 D14, amended by quick 261021):
// a run during which HEAD's code tree or the non-ignored dirty state moved stamps nothing.
// makeRepo's full rule runs the throwaway repo's own full.sh.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path');
const { makeRepo, run, sh } = require('./fixtures/repo.js');

function repoWithSuite(script) {
  const t = makeRepo({ files: { 'a.txt': 'a\n', 'b.txt': 'b\n', 'tests/full.sh': script } });
  return { ...t, stamp: path.join(t.root, '.holden', 'test-stamp'), ledger: path.join(t.dir, 'ledger.md') };
}
const full = t => run('h-test', ['--full', '--ledger', t.ledger], { cwd: t.root, env: t.env });
const records = t => fs.readFileSync(t.ledger, 'utf8').split('\n').filter(l => l.startsWith('h-test: ')).map(l => JSON.parse(l.slice(8)));

test('--full stamps a tree that did not move', () => {
  const t = repoWithSuite('#!/bin/sh\nexit 0\n');
  const r = full(t);
  assert.equal(r.code, 0, r.out);
  const stamp = JSON.parse(fs.readFileSync(t.stamp, 'utf8'));
  assert.equal(stamp.sha, sh('git rev-parse HEAD', t.root, t.env));
  assert.equal(stamp.dirty, '');
  // Deploy scripts compare the stamp with `h-test --code-tree` at the deployed HEAD.
  assert.equal(stamp.code_tree, run('h-test', ['--code-tree'], { cwd: t.root, env: t.env }).out.trim());
  assert.deepEqual(Object.keys(stamp), ['sha', 'code_tree', 'dirty', 'time', 'commands']);
});

test('--full refuses to stamp when HEAD moved during the run', () => {
  const t = repoWithSuite('#!/bin/sh\necho c > b.txt\ngit commit -q -am moved\nexit 0\n');
  const r = full(t);
  assert.equal(r.code, 1, r.out);
  assert.ok(!fs.existsSync(t.stamp));
  assert.match(r.out, /the tree changed during the run/);
  const rec = records(t).pop();
  assert.equal(rec.full, 'fail');
  assert.ok(rec.before.sha && rec.after.sha);
  assert.notEqual(rec.before.sha, rec.after.sha);
  assert.equal(rec.before.dirty, ''); assert.equal(rec.after.dirty, '');
});

test('--full stamps when HEAD moved only in stamp_ignore paths', () => {
  // An orchestrator's .planning/ metadata commit during the run.
  const t = repoWithSuite('#!/bin/sh\necho x > .planning/x.md\ngit add .planning/x.md\ngit commit -q -m meta\nexit 0\n');
  const before = sh('git rev-parse HEAD', t.root, t.env);
  const r = full(t);
  assert.equal(r.code, 0, r.out);
  const stamp = JSON.parse(fs.readFileSync(t.stamp, 'utf8'));
  const head = sh('git rev-parse HEAD', t.root, t.env);
  assert.notEqual(head, before);
  assert.equal(stamp.sha, head);
  assert.equal(stamp.code_tree, run('h-test', ['--code-tree'], { cwd: t.root, env: t.env }).out.trim());
  assert.equal(stamp.code_tree, run('h-test', ['--code-tree', before], { cwd: t.root, env: t.env }).out.trim());
});

test('--full refuses to stamp when the dirty hash changed', () => {
  const t = repoWithSuite('#!/bin/sh\necho x >> a.txt\nexit 0\n');
  const r = full(t);
  assert.equal(r.code, 1, r.out);
  assert.ok(!fs.existsSync(t.stamp));
  assert.match(r.out, /the tree changed during the run/);
});

test('--full ignores .planning dirt', () => {
  const t = repoWithSuite('#!/bin/sh\necho x >> .planning/state.yaml\nexit 0\n');
  const r = full(t);
  assert.equal(r.code, 0, r.out);
  assert.ok(fs.existsSync(t.stamp));
});

test('--full red exits 1 with no stamp', () => {
  const t = repoWithSuite('#!/bin/sh\nexit 1\n');
  const r = full(t);
  assert.equal(r.code, 1, r.out);
  assert.ok(!fs.existsSync(t.stamp));
  assert.doesNotMatch(r.out, /the tree changed/);
});

test('--full red names each failing test in the ledger record', () => {
  const t = repoWithSuite([
    '#!/bin/sh',
    "echo 'not ok 3 - a lock frees when its holder dies'",
    "echo '    --- FAIL: TestRetryIsNotRepeated (0.02s)'",
    "echo 'FAILED tests/e2e/test_login.py::test_revoked_session_is_refused - OSError'",
    "echo 'not ok 3 - a lock frees when its holder dies'",
    'exit 1', '',
  ].join('\n'));
  const r = full(t);
  assert.equal(r.code, 1, r.out);
  assert.deepEqual(records(t).pop().results[0].failed, [
    'a lock frees when its holder dies',
    'TestRetryIsNotRepeated',
    'tests/e2e/test_login.py::test_revoked_session_is_refused',
  ]);
  assert.match(r.out, /^failed: a lock frees when its holder dies \| TestRetryIsNotRepeated \| /m);
});
