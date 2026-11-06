'use strict';
// h-plans reads numbered plans only: a quick directory's lone PLAN.md is no plan set (phase 005 D15),
// and a PLAN.md beside numbered plans is ignored.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path');
const { makeRepo, run, writePlan } = require('./fixtures/repo.js');

test("h-plans reads no quick directory's lone PLAN.md", () => {
  const { root, env } = makeRepo();
  const dir = path.join(root, '.planning', 'quick', '261021-x');
  writePlan(dir, 'PLAN.md', { files: ['a.txt'], reads: ['a.txt'] });
  const r = run('h-plans', [dir], { cwd: root, env });
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /no plan files in /);
});

test('h-plans reads numbered plans and not PLAN.md beside them', () => {
  const { root, env } = makeRepo();
  const dir = path.join(root, '.planning', 'phases', '001-x');
  writePlan(dir, '001-01-PLAN.md', { files: ['a.txt'] });
  writePlan(dir, 'PLAN.md', { files: ['a.txt'], reads: ['a.txt'], plan: 2 });
  const r = run('h-plans', [dir], { cwd: root, env });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^plans: 1; /m);
  assert.doesNotMatch(r.out, /lists a\.txt under both files and reads/);
});

test('h-plans exits 2 on a directory with no plan file', () => {
  const { root, env } = makeRepo();
  const dir = path.join(root, '.planning', 'quick', '261021-y');
  writePlan(dir, 'plan.md', { files: ['a.txt'] });
  fs.writeFileSync(path.join(dir, 'DECISION.md'), '# d\n');
  const r = run('h-plans', [dir], { cwd: root, env });
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /no plan files in /);
});
