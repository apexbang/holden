'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path');
const { makeRepo, run, writePlan } = require('./fixtures/repo.js');

const phaseDir = root => path.join(root, '.planning', 'phases', '001-x');

test('h-plans accepts a plan without reads', () => {
  const { root, env } = makeRepo();
  const dir = phaseDir(root);
  writePlan(dir, '001-01-PLAN.md', { files: ['a.txt'], reads: ['b.txt'] });
  // The second plan carries no reads: line at all, as every plan written before the field.
  const f = writePlan(dir, '001-02-PLAN.md', { files: ['b.txt'], plan: 2 });
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/^reads: \[\]\n/m, ''));
  const r = run('h-plans', [dir], { cwd: root, env });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /plans: 2/);
});

test('h-plans refuses a scalar reads', () => {
  const { root, env } = makeRepo();
  const dir = phaseDir(root);
  const f = writePlan(dir, '001-01-PLAN.md', { files: ['a.txt'] });
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/^reads: \[\]$/m, 'reads: b.txt'));
  const r = run('h-plans', [dir], { cwd: root, env });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /reads must be a list of paths/);
});

test('h-plans notes a path in both files and reads', () => {
  const { root, env } = makeRepo();
  const dir = phaseDir(root);
  writePlan(dir, '001-01-PLAN.md', { files: ['a.txt'], reads: ['a.txt'] });
  const r = run('h-plans', [dir], { cwd: root, env });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /01 lists a\.txt under both files and reads/);
});

test('h-plans still notes a manifest plan as alone', () => {
  const { root, env } = makeRepo();
  const dir = phaseDir(root);
  writePlan(dir, '001-01-PLAN.md', { files: ['package.json'] });
  writePlan(dir, '001-02-PLAN.md', { files: ['requirements-dev.txt'], plan: 2 });
  const r = run('h-plans', [dir], { cwd: root, env });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /01 runs alone: it changes package\.json/);
  assert.match(r.out, /02 runs alone: it changes requirements-dev\.txt/);
});
