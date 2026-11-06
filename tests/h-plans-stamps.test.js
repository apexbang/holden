'use strict';
// bin/h-plans reads a plan's stamps: and cross-checks it against each task's `stamp: <doc>` span
// (phase 004 D01, D07).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path');
const { makeRepo, run } = require('./fixtures/repo.js');

const phaseDir = root => path.join(root, '.planning', 'phases', '001-x');
// One plan with a body. `tasks` holds each task's Files line text. Every task carries a
// Members line, so bin/h-plans' Members check finds the field. deps: null writes `wave:` and
// no depends_on (a wave set). stamps: null writes no key; a string writes it as a scalar.
function planWith(dir, name, { plan = 1, deps = '[]', files = ['a.js'], stamps = null, tasks = [] }) {
  const list = (k, xs) => xs.length ? `${k}:\n` + xs.map(x => `  - ${x}`).join('\n') : `${k}: []`;
  const fm = ['---', 'phase: 1', `plan: ${plan}`, deps === null ? `wave: ${plan}` : `depends_on: ${deps}`, list('files', files),
    ...(stamps === null ? [] : [typeof stamps === 'string' ? `stamps: ${stamps}` : list('stamps', stamps)]),
    'reads: []', 'produces: []', 'consumes: []', 'runs_tests: true', '---'];
  const body = ['# t', '<objective>x</objective>', '<tasks>',
    ...tasks.flatMap((f, i) => [`### Task ${i + 1}: t`, `- Files: ${f}`, '- Members: n/a: fixture']), '</tasks>', ''];
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), [...fm, ...body].join('\n'));
}
const plans = (t, dir, ...a) => run('h-plans', [dir || phaseDir(t.root), ...a], { cwd: t.root, env: t.env });

const missing = /01 task 1 names stamp: docs\/a\.md, which the plan's stamps: does not list/;
const unnamed = /01 lists docs\/a\.md under stamps:, which no task's Files line names as `stamp: docs\/a\.md`/;

test("a task's stamp: doc listed under stamps: passes", () => {
  const t = makeRepo();
  planWith(phaseDir(t.root), '001-01-PLAN.md', { stamps: ['docs/a.md'], tasks: ['`a.js`, `stamp: docs/a.md`'] });
  const r = plans(t);
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /stamp/);
  // The span is never a file of the task: no "changes only test files" shape.
  assert.doesNotMatch(r.out, /changes only test files/);
});

test("a task's stamp: doc missing from stamps: is an error", () => {
  for (const stamps of [null, []]) {
    const t = makeRepo();
    planWith(phaseDir(t.root), '001-01-PLAN.md', { stamps, tasks: ['`a.js`, `stamp: docs/a.md`'] });
    const r = plans(t);
    assert.equal(r.code, 1, `stamps ${JSON.stringify(stamps)}: ${r.out}`);
    assert.match(r.out, missing);
  }
});

test('a stamps: entry no task names is an error, the wrong spelling included', () => {
  // A task naming no stamp, a task spelling it outside one span, and a plan with no task at all.
  for (const tasks of [['`a.js`'], ['`a.js`, stamp: `docs/a.md`'], []]) {
    const t = makeRepo();
    planWith(phaseDir(t.root), '001-01-PLAN.md', { stamps: ['docs/a.md'], tasks });
    const r = plans(t);
    assert.equal(r.code, 1, `tasks ${JSON.stringify(tasks)}: ${r.out}`);
    assert.match(r.out, unnamed);
  }
});

test('stamps: must be a list of paths', () => {
  for (const stamps of ['docs/a.md', 'false', '0', '""', '[1]']) {
    const t = makeRepo();
    planWith(phaseDir(t.root), '001-01-PLAN.md', { stamps, tasks: ['`a.js`'] });
    const r = plans(t);
    assert.equal(r.code, 1, `stamps: ${stamps}: ${r.out}`);
    assert.match(r.out, /001-01-PLAN\.md: stamps must be a list of paths/, `stamps: ${stamps}`);
  }
});

test('two unchained plans stamping one doc are not chained', () => {
  const t = makeRepo(), dir = phaseDir(t.root);
  planWith(dir, '001-01-PLAN.md', { files: ['a.js'], stamps: ['docs/a.md'], tasks: ['`a.js`, `stamp: docs/a.md`'] });
  planWith(dir, '001-02-PLAN.md', { plan: 2, files: ['b.js'], stamps: ['docs/a.md'], tasks: ['`b.js`, `stamp: docs/a.md`'] });
  const r = plans(t);
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /share/);
  assert.doesNotMatch(r.out, /runs alone/);
});

test('a doc in files: of two unchained plans still chains them', () => {
  const t = makeRepo(), dir = phaseDir(t.root);
  planWith(dir, '001-01-PLAN.md', { files: ['docs/a.md'] });
  planWith(dir, '001-02-PLAN.md', { plan: 2, files: ['docs/a.md'] });
  const r = plans(t);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /01 and 02 share docs\/a\.md with no dependency: a shared test file or doc chains them/);
});

test('a doc in both files: and stamps: is valid', () => {
  const t = makeRepo();
  planWith(phaseDir(t.root), '001-01-PLAN.md', { files: ['docs/a.md', 'a.js'], stamps: ['docs/a.md'],
    tasks: ['`docs/a.md`, `a.js`, `stamp: docs/a.md`'] });
  const r = plans(t);
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /under both/);
  assert.doesNotMatch(r.out, /changes only test files/);
});

test('./docs/a.md and docs/a.md are one doc', () => {
  for (const [stamps, span] of [['./docs/a.md', 'docs/a.md'], ['docs/a.md', './docs/a.md']]) {
    const t = makeRepo();
    planWith(phaseDir(t.root), '001-01-PLAN.md', { stamps: [stamps], tasks: [`\`a.js\`, \`stamp: ${span}\``] });
    const r = plans(t);
    assert.equal(r.code, 0, `stamps ${stamps}, span ${span}: ${r.out}`);
  }
});

test('a wave set errors on a stamps mismatch too', () => {
  const t = makeRepo();
  planWith(phaseDir(t.root), '001-01-PLAN.md', { deps: null, tasks: ['`a.js`, `stamp: docs/a.md`'] });
  const r = plans(t);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, missing);
});

test('--ready stops on a stamps mismatch', () => {
  const t = makeRepo();
  planWith(phaseDir(t.root), '001-01-PLAN.md', { tasks: ['`a.js`, `stamp: docs/a.md`'] });
  const r = plans(t, null, '--ready');
  assert.equal(r.code, 1, r.out);
  assert.doesNotMatch(r.out, /^01$/m);
});

const yaml = require('../lib/yaml-lite.js');
test('the template carries stamps: in the shape h-plans checks', () => {
  const tpl = fs.readFileSync(path.join(__dirname, '..', 'templates', 'PLAN.md'), 'utf8');
  const fm = tpl.match(/^---\n([\s\S]*?)\n---/)[1];
  assert.deepEqual(yaml.parse(fm).stamps, ['docs/doc.md']);
  const filesLine = tpl.split('\n').find(l => l.startsWith('- Files: '));
  assert.match(filesLine, /`stamp: docs\/doc\.md`/);
  const t = makeRepo(), dir = phaseDir(t.root);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '001-01-PLAN.md'), ['---', fm, '---', '# t', '<tasks>', '### Task 1: t', filesLine, '- Members: n/a: fixture', '</tasks>', ''].join('\n'));
  const r = plans(t);
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /stamp/);
});

test('h-plans -h states the stamps rule', () => {
  const r = run('h-plans', ['-h']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /plan, files, reads, stamps,/);
  assert.match(r.out, /`stamp: <doc>`/);
  assert.match(r.out, /stamps: never counts toward the shared-file rule/);
});
