'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path');
const { makeRepo, run, sh } = require('./fixtures/repo.js');

// A phase entry in templates/state.yaml's order; extra lines go before dir:.
const phaseEntry = (n, status, dir, extra = []) => [`  - number: ${n}`, `    slug: s${n}`, '    milestone: null', `    status: ${status}`, ...extra, ...(dir ? [`    dir: ${dir}`] : [])];
const quickEntry = (id, status, dir, extra = []) => [`  - id: ${id}`, `    slug: q${id}`, `    status: ${status}`, '    date: 2026-10-01', ...extra, ...(dir ? [`    dir: ${dir}`] : [])];
const stateOf = (phases, quick = []) => ['holden: 1', 'project: t', 'milestone: null', 'current_phase: 1', 'phases:', ...phases.flat(), ...(quick.length ? ['quick:', ...quick.flat()] : ['quick: []']), ''].join('\n');
// landed after the repo's first observations line, with a self diff review
const REVIEWED = ['    landed: 2026-10-20', '    review:', '      plan: self', '      diff: self'];
const WAIVED = ['    landed: 2026-10-20', '    review:', '      plan: none', '      diff: none'];
const VERDICT = (v, round = 1) => `# Codex review (diff), round ${round}\n\n## Verdict\n\n${v} (no BLOCKER): ok\n`;
function repo({ state, files = {}, obs = ['- 2026-10-01 repo 900: clean'] }) {
  const t = makeRepo({ files: { '.planning/state.yaml': state, ...files } });
  t.obs = path.join(t.dir, 'observations.md');
  fs.writeFileSync(t.obs, ['# Observations', '', ...obs, ''].join('\n'));
  t.env = { ...t.env, HOLDEN_OBSERVATIONS: t.obs };
  return t;
}
const BIN = path.join(__dirname, '..', 'bin', 'h-scratch-pass');
const locked = (t, ...a) => run('h-queue', ['lock', '--', process.execPath, BIN, ...a], { cwd: t.root, env: t.env });
const tokensLeft = t => { const d = path.join(t.root, '.git', 'holden-meta'); return fs.existsSync(d) ? fs.readdirSync(d) : []; };
const pass = (t, ...a) => run('h-scratch-pass', a, { cwd: t.root, env: t.env });
const linesOf = (out, start) => out.split('\n').filter(l => l.startsWith(start)).sort();
const PH = '.planning/phases/', QK = '.planning/quick/';
// Files of one directory: names to content (default `x\n`).
const filesIn = (dir, names) => Object.fromEntries(Object.entries(names).map(([n, c]) => [`${dir}/${n}`, c]));
const same = (a, b) => assert.deepStrictEqual(a, [...b].sort());

test('the pass keeps the exact record names at the top of a directory and deletes every other file', () => {
  const a = PH + '001-a';
  const t = repo({
    state: stateOf([phaseEntry(1, 'landed', a, REVIEWED)], [quickEntry('q1', 'complete', QK + 'q1'), quickEntry('260427', 'landed', QK + '250101-abc-fix')]),
    obs: ['- 2026-10-01 repo 900: clean', '- 2026-10-21 repo 001: clean'],
    files: {
      ...filesIn(a, { '001-DECISION.md': 'x\n', '001-FACTS.md': 'x\n', '001-HUMAN-UAT.md': 'x\n', 'CONTEXT.md': 'x\n', '001-01-PLAN.md': 'x\n', '001-RESEARCH.md': 'x\n',
        'DIFF-CODEX-REVIEW-r1.md': VERDICT('PASS'), 'CODEX-G2-DECISION.md': 'x\n', '001-DIFF-REVIEW-CONTEXT.md': 'x\n', 'fixture/DECISION.md': 'x\n', 'inputs/a/x.md': 'x\n', '.gitkeep': '' }),
      ...filesIn(QK + 'q1', { 'DECISION.md': 'x\n', 'PLAN.md': 'x\n', 'LEDGER.md': '# Executor ledger\n' }),
      ...filesIn(QK + '250101-abc-fix', { '250101-abc-CONTEXT.md': 'x\n', '250101-abc-PLAN.md': 'x\n' }),
    },
  });
  const r = pass(t, '--dry-run', '.planning');
  assert.strictEqual(r.code, 0, r.out);
  same(linesOf(r.out, '  delete '), [...['001-01-PLAN.md', '001-RESEARCH.md', 'DIFF-CODEX-REVIEW-r1.md', 'CODEX-G2-DECISION.md', '001-DIFF-REVIEW-CONTEXT.md', 'fixture/DECISION.md', 'inputs/a/x.md', '.gitkeep'].map(n => `  delete ${a}/${n}`),
    `  delete ${QK}q1/PLAN.md`, `  delete ${QK}q1/LEDGER.md`, `  delete ${QK}250101-abc-fix/250101-abc-PLAN.md`]);
  same(linesOf(r.out, '  keep '), [...['001-DECISION.md', '001-FACTS.md', '001-HUMAN-UAT.md', 'CONTEXT.md'].map(n => `  keep ${a}/${n}: kept name`),
    `  keep ${QK}q1/DECISION.md: kept name`, `  keep ${QK}250101-abc-fix/250101-abc-CONTEXT.md: kept name`]);
  assert.ok(r.out.includes(`act ${a}: delete 8, keep 4`), r.out);
  assert.strictEqual(sh('git status --porcelain', t.root, t.env), '');
});

test('the pass selects landed and archived phases and complete and landed quicks at their own dir', () => {
  const t = repo({
    state: stateOf([
      phaseEntry(1, 'landed', PH + '001-a', REVIEWED), phaseEntry(2, 'executing', PH + '002-b'), phaseEntry(3, 'landed', null, REVIEWED),
      phaseEntry(4, 'archived', '.planning/milestones/v1.0-phases/04-d', WAIVED.map(l => l.replace('2026-10-20', '2026-09-01'))),
      phaseEntry(5, 'archived', '.planning/milestones-old/05-e', WAIVED.map(l => l.replace('2026-10-20', '2026-09-01'))),
    ], [quickEntry('q1', 'complete', QK + 'q1'), quickEntry('q2', 'planned', QK + 'q2'), quickEntry('q3', 'landed', QK + 'q3'), quickEntry('q4', 'blocked', QK + 'q4')]),
    obs: ['- 2026-10-01 repo 900: clean', '- 2026-10-21 repo 001: clean'],
    files: {
      ...filesIn(PH + '001-a', { '001-DECISION.md': 'x\n', '001-01-PLAN.md': 'x\n', 'DIFF-CODEX-REVIEW-r1.md': VERDICT('PASS') }),
      ...filesIn(PH + '002-b', { '002-01-PLAN.md': 'x\n' }),
      ...filesIn('.planning/milestones/v1.0-phases/04-d', { '04-CONTEXT.md': 'x\n', '04-01-PLAN.md': 'x\n' }),
      ...filesIn('.planning/milestones-old/05-e', { '05-01-PLAN.md': 'x\n' }),
      ...filesIn(QK + 'q1', { 'PLAN.md': 'x\n', 'DECISION.md': 'x\n' }), ...filesIn(QK + 'q2', { 'PLAN.md': 'x\n' }),
      ...filesIn(QK + 'q3', { 'PLAN.md': 'x\n' }), ...filesIn(QK + 'q4', { 'PLAN.md': 'x\n' }),
    },
  });
  const acts = out => linesOf(out, 'act ').map(l => l.split(':')[0]);
  let r = pass(t, '--dry-run', '.planning');
  assert.strictEqual(r.code, 0, r.out);
  // 05-e sits under .planning too, so a run over .planning acts on it as well.
  same(acts(r.out), [`act ${PH}001-a`, 'act .planning/milestones/v1.0-phases/04-d', 'act .planning/milestones-old/05-e', `act ${QK}q1`, `act ${QK}q3`]);
  assert.ok(r.out.includes('skip phase 3: no dir'), r.out);
  r = pass(t, '--dry-run', '.planning/milestones');
  assert.strictEqual(r.code, 0, r.out);
  same(acts(r.out), ['act .planning/milestones/v1.0-phases/04-d']);
  r = pass(t, '--dry-run', '.planning/quick/');
  assert.strictEqual(r.code, 0, r.out);
  same(acts(r.out), [`act ${QK}q1`, `act ${QK}q3`]);
});

test('h-scratch-pass refuses what it cannot scope', () => {
  const a = PH + '001-a';
  const t = repo({ state: stateOf([phaseEntry(1, 'landed', a, REVIEWED)]), obs: ['- 2026-10-01 repo 900: clean', '- 2026-10-21 repo 001: clean'],
    files: filesIn(a, { '001-DECISION.md': 'x\n', '001-01-PLAN.md': 'x\n', 'DIFF-CODEX-REVIEW-r1.md': VERDICT('PASS') }) });
  let r = pass(t); assert.strictEqual(r.code, 2); assert.match(r.out, /usage: h-scratch-pass \[--dry-run\] <path>/);
  r = pass(t, '.planning'); assert.strictEqual(r.code, 2); assert.match(r.out, /h-scratch-pass commits under the landing lock: h-queue lock -- h-scratch-pass \.planning/);
  r = pass(t, '--dry-run'); assert.strictEqual(r.code, 2);
  r = pass(t, '--dry-run', '--force', '.planning'); assert.strictEqual(r.code, 2); assert.match(r.out, /unknown flag --force/);
  r = pass(t, '--dry-run', '/'); assert.strictEqual(r.code, 2); assert.match(r.out, /not a path inside the repo: \//);
  r = pass(t, '--dry-run', '.planning/nothing'); assert.strictEqual(r.code, 1);
  assert.match(r.out, /no landed or archived phase and no complete or landed quick has its dir under \.planning\/nothing/);
  r = pass(t, '-h'); assert.strictEqual(r.code, 0); assert.ok(r.out.includes('h-scratch-pass --dry-run <path>...'), r.out);
  fs.writeFileSync(path.join(t.root, '.planning/state.yaml'), 'phases:\n  - number: 1\n   bad');
  sh('git commit -qam bad', t.root, t.env);
  r = pass(t, '--dry-run', '.planning'); assert.strictEqual(r.code, 1); assert.match(r.out, /does not parse/);
});

test('a directory with no files at HEAD is skipped and named', () => {
  const b = PH + '002-b';
  const t = repo({ state: stateOf([phaseEntry(1, 'landed', PH + '001-gone', REVIEWED), phaseEntry(2, 'landed', b, REVIEWED)]),
    obs: ['- 2026-10-01 repo 900: clean', '- 2026-10-21 repo 001: clean', '- 2026-10-21 repo 002: clean'],
    files: filesIn(b, { '002-DECISION.md': 'x\n', '002-01-PLAN.md': 'x\n', 'DIFF-CODEX-REVIEW-r1.md': VERDICT('PASS') }) });
  const r = pass(t, '--dry-run', '.planning');
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(r.out.includes(`skip phase 1: no files at HEAD under ${PH}001-gone`), r.out);
  assert.ok(r.out.includes(`act ${b}`), r.out);
});

const nnn = n => String(n).padStart(3, '0');
const REPORT = { 'DIFF-CODEX-REVIEW-r1.md': VERDICT('PASS') };

test('a phase is acted on once /h-learn ran for it, or when it landed before its repo\'s first line', () => {
  const ph = (n, landed) => phaseEntry(n, 'landed', `${PH}${nnn(n)}-p`, landed === null ? WAIVED.slice(1) : WAIVED.map(l => l.replace('2026-10-20', landed)));
  const files = {};
  for (let n = 1; n <= 6; n++) Object.assign(files, filesIn(`${PH}${nnn(n)}-p`, { [`${nnn(n)}-DECISION.md`]: 'x\n', [`${nnn(n)}-01-PLAN.md`]: 'x\n' }));
  const t = repo({
    state: stateOf([ph(1, '2026-10-20'), ph(2, '2026-10-20'), ph(3, '2026-09-15'), ph(4, null), ph(5, '2026-10-20'), ph(6, '2026-10-20')]), files,
    obs: ['- 2026-10-01 repo 900: clean', '- 2026-10-21 repo 001 planner: a gap', '- 2026-09-01 other 003: clean', '- 2026-10-21 other 005: clean', '- 2026-10-21 repo 006 planner: a gap struck (abc1234)'],
  });
  let r = pass(t, '--dry-run', '.planning');
  assert.strictEqual(r.code, 0, r.out);
  for (const n of [1, 3, 6]) assert.ok(r.out.includes(`act ${PH}${nnn(n)}-p:`), r.out);
  for (const n of [2, 4, 5]) assert.ok(r.out.includes(`held ${PH}${nnn(n)}-p: /h-learn has not run for phase ${n}`), r.out);
  fs.writeFileSync(t.obs, '# Observations\n\n- 2026-10-21 other 001: clean\n');
  r = pass(t, '--dry-run', '.planning');
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(r.out.includes('observations: no line for repo repo'), r.out);
  for (let n = 1; n <= 6; n++) assert.ok(r.out.includes(`held ${PH}${nnn(n)}-p: /h-learn has not run`), r.out);
});

test('a missing observations file stops the run', () => {
  const a = PH + '001-a';
  const t = repo({ state: stateOf([phaseEntry(1, 'landed', a, REVIEWED)]), files: filesIn(a, { '001-DECISION.md': 'x\n', '001-01-PLAN.md': 'x\n' }) });
  const r = run('h-scratch-pass', ['--dry-run', '.planning'], { cwd: t.root, env: { ...t.env, HOLDEN_OBSERVATIONS: path.join(t.dir, 'nope.md') } });
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /cannot read .*nope\.md: ENOENT; nothing done/);
});

test('a ledger the pass would delete with a pending or missed stamp holds its directory back', t0 => {
  if (process.getuid && process.getuid() === 0) return t0.skip('root reads a chmod 0 file');
  const MISSED = 'Task 1: complete\nstamp: docs/x.md task 1: e\n## Result\n';
  const STAMPED = 'Task 1: complete\nstamp: docs/x.md task 1: e\nstamped: docs/x.md abc1234\n## Result\n';
  const d4 = '.planning/milestones/v1-phases/04-d';
  const t = repo({
    state: stateOf([phaseEntry(1, 'landed', PH + '001-a', REVIEWED), phaseEntry(2, 'landed', PH + '002-b', REVIEWED), phaseEntry(4, 'archived', d4, WAIVED)],
      [quickEntry('q1', 'complete', QK + 'q1'), quickEntry('q2', 'complete', QK + 'q2'), quickEntry('q3', 'complete', QK + 'q3')]),
    obs: ['- 2026-10-01 repo 900: clean', '- 2026-10-21 repo 001: clean', '- 2026-10-21 repo 002: clean', '- 2026-10-21 repo 004: clean'],
    files: {
      ...filesIn(PH + '001-a', { '001-DECISION.md': 'x\n', ...REPORT, '001-01-LEDGER.md': MISSED }),
      ...filesIn(PH + '002-b', { '002-DECISION.md': 'x\n', ...REPORT, '002-01-LEDGER.md': STAMPED }),
      ...filesIn(d4, { '04-CONTEXT.md': 'x\n', '04-01-LEDGER.md': MISSED }),
      ...filesIn(QK + 'q1', { 'DECISION.md': 'x\n', 'LEDGER-executor.md': 'Task 1: complete\nstamp: docs/y.md task 1: e\n' }),
      ...filesIn(QK + 'q2', { 'DECISION.md': 'x\n', 'fix1-LEDGER-dropped-r1.md': MISSED }),
      ...filesIn(QK + 'q3', { 'DECISION.md': 'x\n', 'LEDGER.md': 'Task 1: complete\n## Result\n' }),
    },
  });
  fs.chmodSync(path.join(t.root, QK, 'q3/LEDGER.md'), 0);
  const r = pass(t, '--dry-run', '.planning');
  fs.chmodSync(path.join(t.root, QK, 'q3/LEDGER.md'), 0o644);
  assert.strictEqual(r.code, 0, r.out);
  const why = '1 pending or missed stamp(s) in a ledger it would delete';
  assert.ok(r.out.includes(`held ${PH}001-a: ${why}\n  missed: ${PH}001-a/001-01-LEDGER.md docs/x.md task 1: e`), r.out);
  assert.ok(r.out.includes(`act ${PH}002-b`), r.out);
  assert.ok(r.out.includes(`held ${d4}: ${why}`), r.out);
  assert.ok(r.out.includes(`held ${QK}q1: ${why}\n  pending: ${QK}q1/LEDGER-executor.md docs/y.md task 1: e`), r.out);
  assert.ok(r.out.includes(`held ${QK}q2: ${why}`), r.out);
  assert.ok(r.out.includes(`held ${QK}q3: ${why}\n  unreadable: ${QK}q3/LEDGER.md`), r.out);
});

test('a phase\'s diff review is done by its field, waived by diff none or by no review map, or read from the report of an entry from before the field', () => {
  const ph = (n, extra) => phaseEntry(n, 'landed', `${PH}${nnn(n)}-p`, extra);
  const files = {};
  for (let n = 1; n <= 8; n++) Object.assign(files, filesIn(`${PH}${nnn(n)}-p`, { [`${nnn(n)}-DECISION.md`]: 'x\n', [`${nnn(n)}-01-PLAN.md`]: 'x\n' }));
  Object.assign(files, filesIn(PH + '003-p', { 'DIFF-CODEX-REVIEW-r1.md': VERDICT('REVISE'), 'DIFF-CODEX-REVIEW-r2.md': VERDICT('PASS', 2) }),
    filesIn(PH + '004-p', { '004-REVIEW-self-r1.md': '# Self review (diff), round 1\n## Verdict\nREVISE (one BLOCKER): x\n' }),
    filesIn(PH + '005-p', { '005-REVIEW-self-r1.md': '# Self review (plan), round 1\n## Verdict\nPASS: x\n' }));
  const t = repo({
    state: stateOf([
      ph(1, ['    landed: 2026-10-20', '    review:', '      plan: self', '      diff: self', '      diff_done: 2026-10-20 PASS']),
      ph(2, WAIVED), ph(3, REVIEWED), ph(4, REVIEWED), ph(5, REVIEWED), ph(6, ['    landed: 2026-10-20']),
      ph(7, ['    landed: 2026-10-20', '    review: codex']), ph(8, REVIEWED)]),
    files, obs: ['- 2026-10-01 repo 900: clean', ...[1, 2, 3, 4, 5, 6, 7, 8].map(n => `- 2026-10-21 repo ${nnn(n)}: clean`)],
  });
  const r = pass(t, '--dry-run', '.planning');
  assert.strictEqual(r.code, 0, r.out);
  const dOf = f => sh(`git log -1 --format=%cs -- ${f}`, t.root, t.env);
  assert.ok(r.out.includes(`act ${PH}001-p:`) && !r.out.includes(`state ${PH}001-p`), r.out);
  assert.ok(r.out.includes(`act ${PH}002-p:`) && r.out.includes(`  state ${PH}002-p: review.diff_done: waived`), r.out);
  assert.ok(r.out.includes(`act ${PH}003-p:`) && r.out.includes(`  state ${PH}003-p: review.diff_done: ${dOf(PH + '003-p/DIFF-CODEX-REVIEW-r2.md')} PASS`), r.out);
  assert.ok(r.out.includes(`  state ${PH}004-p: review.diff_done: ${dOf(PH + '004-p/004-REVIEW-self-r1.md')} REVISE`), r.out);
  assert.ok(r.out.includes(`held ${PH}005-p: diff review neither done nor waived`), r.out);
  assert.ok(r.out.includes(`act ${PH}006-p:`) && r.out.includes(`  state ${PH}006-p: review.diff_done: waived`), r.out);
  assert.ok(r.out.includes(`held ${PH}007-p: review is not a map; review.diff_done cannot be written`), r.out);
  assert.ok(r.out.includes(`held ${PH}008-p: diff review neither done nor waived`), r.out);
});

test('an older quick passes the diff review and gets waived; a quick with a goal needs its verdict', () => {
  const q = (id, extra) => quickEntry(id, 'complete', QK + id, extra);
  const files = {};
  for (const id of ['q1', 'q2', 'q3', 'q4']) Object.assign(files, filesIn(QK + id, { 'PLAN.md': 'x\n', 'REVIEW-self-r1.md': 'x\n' }));
  const t = repo({ state: stateOf([], [q('q1', []), q('q2', ['    goal: "g"', '    review: "codex PASS"']), q('q3', ['    goal: "g"']), q('q4', ['    review: {}'])]), files });
  const r = pass(t, '--dry-run', '.planning/quick');
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(r.out.includes(`act ${QK}q1:`) && r.out.includes(`  state ${QK}q1: review.diff_done: waived`), r.out);
  assert.ok(r.out.includes(`act ${QK}q2:`) && !r.out.includes(`state ${QK}q2: review.diff_done`), r.out);
  assert.ok(r.out.includes(`held ${QK}q3: diff review neither done nor waived`), r.out);
  assert.ok(r.out.includes(`act ${QK}q4:`) && r.out.includes(`  state ${QK}q4: review.diff_done: waived`), r.out);
});

test('an uncommitted change in a file the pass would delete holds its directory back', () => {
  const d3 = '.planning/milestones/v1-phases/03-c';
  const t = repo({
    state: stateOf([phaseEntry(1, 'landed', PH + '001-a', WAIVED), phaseEntry(2, 'landed', PH + '002-b', WAIVED), phaseEntry(3, 'archived', d3, ['    landed: 2026-09-01'])],
      [quickEntry('q1', 'landed', QK + 'q1'), quickEntry('q2', 'complete', QK + 'q2')]),
    obs: ['- 2026-10-01 repo 900: clean', '- 2026-10-21 repo 001: clean', '- 2026-10-21 repo 002: clean'],
    files: {
      ...filesIn(PH + '001-a', { '001-DECISION.md': 'x\n', '001-01-PLAN.md': 'x\n' }), ...filesIn(PH + '002-b', { '002-DECISION.md': 'x\n', '002-01-PLAN.md': 'x\n' }),
      ...filesIn(d3, { '03-01-PLAN.md': 'x\n' }), ...filesIn(QK + 'q1', { 'PLAN.md': 'x\n' }), ...filesIn(QK + 'q2', { 'DECISION.md': 'x\n', 'PLAN.md': 'x\n' }),
    },
  });
  const w = (rel, c) => fs.writeFileSync(path.join(t.root, rel), c);
  w(PH + '001-a/001-01-PLAN.md', 'changed\n'); w(PH + '002-b/notes.md', 'n\n'); w(d3 + '/z.md', 'n\n'); w(QK + 'q1/x.md', 'n\n'); w(QK + 'q2/y.md', 'n\n');
  const r = pass(t, '--dry-run', '.planning');
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(r.out.includes(`held ${PH}001-a: uncommitted change in ${PH}001-a/001-01-PLAN.md`), r.out);
  assert.ok(r.out.includes(`act ${PH}002-b`), r.out);
  assert.ok(r.out.includes(`held ${d3}: uncommitted change in ${d3}/z.md`), r.out);
  assert.ok(r.out.includes(`held ${QK}q1: uncommitted change in ${QK}q1/x.md`), r.out);
  assert.ok(r.out.includes(`act ${QK}q2`), r.out);
});

// Phase 1 of the pointer tests: REVIEWED, learned by a line, with one file of each kind.
const A = PH + '001-a';
const P1_FILES = { '001-DECISION.md': 'x\n', '001-01-PLAN.md': 'x\n', '001-02-GATE-r1.md': 'x\n', '001-03-PLAN.md': 'x\n', '001-RESEARCH.md': 'x\n',
  '001-01-LEDGER.md': '# Executor ledger\n', ...REPORT, 'inputs/a/x.md': 'x\n' };
const P1_OBS = ['- 2026-10-01 repo 900: clean', '- 2026-10-21 repo 001: clean'];

test('a shared file keeps the file it names by path, by prefixed name or by stem', () => {
  const t = repo({ state: stateOf([phaseEntry(1, 'landed', A, REVIEWED)]), obs: P1_OBS, files: {
    ...filesIn(A, P1_FILES),
    '.planning/OPEN-ASKS.md': ['# asks', `see ${A}/001-01-PLAN.md for the plan`, 'and 001-02-GATE-r1.md, and 001-RESEARCH', 'phases live in .planning/phases/', ''].join('\n'),
    '.planning/asks.yaml': `asks: []\n# note: ${A}/inputs/\n`,
  } });
  const r = pass(t, '--dry-run', '.planning');
  assert.strictEqual(r.code, 0, r.out);
  const keeps = linesOf(r.out, '  keep ');
  for (const l of [`  keep ${A}/001-01-PLAN.md: named by .planning/OPEN-ASKS.md:2`, `  keep ${A}/001-02-GATE-r1.md: named by .planning/OPEN-ASKS.md:3`,
    `  keep ${A}/001-RESEARCH.md: named by .planning/OPEN-ASKS.md:3`, `  keep ${A}/inputs/a/x.md: named by .planning/asks.yaml:2`]) assert.ok(keeps.includes(l), r.out);
  for (const n of ['001-03-PLAN.md', '001-01-LEDGER.md', 'DIFF-CODEX-REVIEW-r1.md']) assert.ok(r.out.includes(`  delete ${A}/${n}`), r.out);
});

test('a name with no prefix keeps the file only in a directory its line names', () => {
  const t = repo({ state: stateOf([], [quickEntry('q1', 'complete', QK + 'q1'), quickEntry('q2', 'complete', QK + 'q2')]), files: {
    ...filesIn(QK + 'q1', { 'DECISION.md': 'x\n', 'LEDGER.md': 'x\n', 'PLAN.md': 'x\n', 'FULL-SUITE.log': 'x\n' }),
    ...filesIn(QK + 'q2', { 'DECISION.md': 'x\n', 'LEDGER.md': 'x\n', 'PLAN.md': 'x\n' }),
    '.planning/OPEN-ASKS.md': ['# asks', 'the .planning/quick/q1/ run: its LEDGER.md', "q2's PLAN.md", 'every FULL-SUITE.log', ''].join('\n'),
  } });
  const r = pass(t, '--dry-run', '.planning/quick');
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(r.out.includes(`  keep ${QK}q1/LEDGER.md: named by .planning/OPEN-ASKS.md:2`), r.out);
  assert.ok(r.out.includes(`  keep ${QK}q2/PLAN.md: named by .planning/OPEN-ASKS.md:3`), r.out);
  for (const f of ['q2/LEDGER.md', 'q1/PLAN.md', 'q1/FULL-SUITE.log']) assert.ok(r.out.includes(`  delete ${QK}${f}`), r.out);
  assert.ok(r.out.includes('unscoped FULL-SUITE.log at .planning/OPEN-ASKS.md:4: names no directory; kept nothing'), r.out);
});

test('a kept record keeps what it names in another directory, never in its own', () => {
  const b = PH + '002-b';
  const t = repo({ state: stateOf([phaseEntry(1, 'landed', A, REVIEWED), phaseEntry(2, 'grilled', b)]), obs: P1_OBS, files: {
    ...filesIn(A, { ...P1_FILES, '001-DECISION.md': 'our 001-RESEARCH.md stays as written\n' }),
    ...filesIn(b, { '002-DECISION.md': 'see ../001-a/inputs/a/x.md and 001-01-PLAN.md\n' }),
  } });
  const check = () => {
    const r = pass(t, '--dry-run', A);
    assert.strictEqual(r.code, 0, r.out);
    assert.ok(r.out.includes(`  keep ${A}/inputs/a/x.md: named by ${b}/002-DECISION.md:1`), r.out);
    assert.ok(r.out.includes(`  keep ${A}/001-01-PLAN.md: named by ${b}/002-DECISION.md:1`), r.out);
    assert.ok(r.out.includes(`  delete ${A}/001-RESEARCH.md`), r.out);
  };
  check();
  fs.writeFileSync(path.join(t.root, b, '002-DECISION.md'), 'x\n');
  check();
});

test('an open observation line keeps the file it cites', () => {
  const t = repo({ state: stateOf([phaseEntry(1, 'landed', A, REVIEWED)]), files: filesIn(A, P1_FILES) });
  fs.writeFileSync(t.obs, ['# Observations', '',
    `- 2026-10-21 repo 001 planner: gap. Evidence: ${t.root}/${A}/001-RESEARCH.md`,
    '- 2026-10-21 repo 001 executor: gap. Evidence: DIFF-CODEX-REVIEW-r1.md',
    '- 2026-10-21 repo 001 planner: gap 001-01-PLAN.md struck (abc1234)',
    '- 2026-10-21 other 001 planner: gap 001-02-GATE-r1.md',
    `- 2026-10-21 other 001 planner: gap ${t.root}/${A}/001-01-LEDGER.md`, ''].join('\n'));
  const r = pass(t, '--dry-run', '.planning');
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(r.out.includes(`  keep ${A}/001-RESEARCH.md: cited by ${t.obs}:3`), r.out);
  assert.ok(r.out.includes(`  keep ${A}/DIFF-CODEX-REVIEW-r1.md: cited by ${t.obs}:4`), r.out);
  assert.ok(r.out.includes(`  keep ${A}/001-01-LEDGER.md: cited by ${t.obs}:7`), r.out);
  for (const n of ['001-01-PLAN.md', '001-02-GATE-r1.md']) assert.ok(r.out.includes(`  delete ${A}/${n}`), r.out);
});

test('a clone of a local checkout keeps what an open observation cites by the checkout\'s absolute path', () => {
  const t = repo({ state: stateOf([phaseEntry(1, 'landed', A, REVIEWED)]), files: filesIn(A, P1_FILES) });
  fs.writeFileSync(t.obs, ['# Observations', '',
    `- 2026-10-21 repo 001 planner: gap. Evidence: ${t.root}/${A}/001-RESEARCH.md`, ''].join('\n'));
  const clone = path.join(t.dir, 'sweep', 'repo');
  sh(`git clone -q ${t.root} ${clone}`, t.dir, t.env);
  const r = run('h-scratch-pass', ['--dry-run', '.planning'], { cwd: clone, env: t.env });
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(r.out.includes(`  keep ${A}/001-RESEARCH.md: cited by ${t.obs}:3`), r.out);
  assert.ok(r.out.includes(`  delete ${A}/001-01-PLAN.md`), r.out);
});

test('a pointer to a directory the pass would empty holds it back', () => {
  const t = repo({ state: stateOf([phaseEntry(1, 'landed', A, REVIEWED)], [quickEntry('q3', 'landed', QK + 'q3'), quickEntry('q4', 'landed', QK + 'q4')]), obs: P1_OBS, files: {
    ...filesIn(A, P1_FILES), ...filesIn(QK + 'q3', { 'PLAN.md': 'x\n' }), ...filesIn(QK + 'q4', { 'PLAN.md': 'x\n' }),
    '.planning/OPEN-ASKS.md': ['# asks', 'see .planning/quick/q3', `and ${A}/`, ''].join('\n'),
  } });
  const r = pass(t, '--dry-run', '.planning');
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(r.out.includes(`held ${QK}q3: .planning/OPEN-ASKS.md:2 names the directory, which would be emptied`), r.out);
  assert.ok(r.out.includes(`act ${QK}q4: delete 1, keep 0`), r.out);
  assert.ok(r.out.includes(`act ${A}: delete 7, keep 1`), r.out);
});

test('a ledger a pointer keeps is not gated', () => {
  const MISSED = 'Task 1: complete\nstamp: docs/x.md task 1: e\n## Result\n';
  const mk = extra => repo({ state: stateOf([phaseEntry(1, 'landed', A, REVIEWED)]), obs: P1_OBS, files: { ...filesIn(A, { ...P1_FILES, '001-01-LEDGER.md': MISSED }), ...extra } });
  let r = pass(mk({ '.planning/OPEN-ASKS.md': '# asks\nsee 001-01-LEDGER.md\n' }), '--dry-run', '.planning');
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(r.out.includes(`act ${A}:`) && r.out.includes(`  keep ${A}/001-01-LEDGER.md: named by .planning/OPEN-ASKS.md:2`), r.out);
  r = pass(mk({}), '--dry-run', '.planning');
  assert.ok(r.out.includes(`held ${A}: 1 pending or missed stamp(s) in a ledger it would delete`), r.out);
});

test('a landed phase the pass would empty is held; an archived one is emptied and drops its dir', () => {
  const ARCH = '.planning/milestones/v1-phases/04-d';
  const t = repo({
    state: stateOf([phaseEntry(1, 'landed', PH + '001-a', WAIVED), phaseEntry(4, 'archived', ARCH, WAIVED.map(l => l.replace('2026-10-20', '2026-09-01')))]),
    obs: ['- 2026-10-01 repo 900: clean', '- 2026-10-21 repo 001: clean'],
    files: { ...filesIn(PH + '001-a', { '001-01-PLAN.md': 'x\n' }), ...filesIn(ARCH, { '04-01-PLAN.md': 'x\n' }) },
  });
  const r = pass(t, '--dry-run', '.planning');
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(r.out.includes('held .planning/phases/001-a: every file would go and the phase is landed; h-milestone close reads its directory'), r.out);
  assert.ok(r.out.includes(`act ${ARCH}: delete 1, keep 0`), r.out);
  assert.ok(r.out.includes(`  state ${ARCH}: review.diff_done: waived`), r.out);
  assert.ok(r.out.includes(`  state ${ARCH}: dir: dropped`), r.out);
});

test('a quick whose dropped dir would repeat a quick key keeps its dir and is emptied', () => {
  const q = (id, dir, status = 'landed') => quickEntry(id, status, QK + dir);
  const t = repo({
    state: stateOf([], [q(10, '10-a'), q(10, '10-b'), q(11, '11-c'), q(12, '12', 'complete'), q(12, '12-x')]),
    files: { ...filesIn(QK + '10-a', { 'PLAN.md': 'x\n' }), ...filesIn(QK + '10-b', { 'PLAN.md': 'x\n' }), ...filesIn(QK + '11-c', { 'PLAN.md': 'x\n' }),
      ...filesIn(QK + '12', { 'DECISION.md': 'x\n', 'PLAN.md': 'x\n' }), ...filesIn(QK + '12-x', { 'PLAN.md': 'x\n' }) },
  });
  const r = pass(t, '--dry-run', '.planning');
  assert.strictEqual(r.code, 0, r.out);
  for (const d of ['10-a', '10-b']) {
    assert.ok(r.out.includes(`act ${QK}${d}: delete 1, keep 0`) && r.out.includes(`  state ${QK}${d}: dir: kept, quick key 10 would appear 2 times`), r.out);
  }
  assert.ok(r.out.includes(`act ${QK}12-x: delete 1, keep 0`) && r.out.includes(`  state ${QK}12-x: dir: kept, quick key 12 would appear 2 times`), r.out);
  assert.ok(r.out.includes(`act ${QK}11-c: delete 1, keep 0`) && r.out.includes(`  state ${QK}11-c: dir: dropped`), r.out);
  assert.ok(r.out.includes(`act ${QK}12: delete 1, keep 1`), r.out);
  assert.ok(!r.out.includes(`state ${QK}12: dir:`) && !/^held /m.test(r.out), r.out);
});

test('an entry whose state edit cannot be made or read back is held', () => {
  const t = repo({
    state: stateOf([
      ['  - number: 1', '    slug: s1', '    milestone: null', '    status: landed', ...WAIVED, `    dir: ".planning/phases/001-a"   # moved`],
      phaseEntry(2, 'landed', PH + '002-b', WAIVED),
      phaseEntry(3, 'landed', PH + '003-c', ['    landed: 2026-10-20', '    review:', '        plan: self', '        diff: self']),
    ], [quickEntry('q9', 'planned', PH + '002-b')]),
    obs: ['- 2026-10-01 repo 900: clean', '- 2026-10-21 repo 001: clean', '- 2026-10-21 repo 002: clean', '- 2026-10-21 repo 003: clean'],
    files: { ...filesIn(PH + '001-a', { '001-DECISION.md': 'x\n', '001-01-PLAN.md': 'x\n' }), ...filesIn(PH + '002-b', { '002-DECISION.md': 'x\n', '002-01-PLAN.md': 'x\n' }),
      ...filesIn(PH + '003-c', { '003-DECISION.md': 'x\n', '003-01-PLAN.md': 'x\n', 'DIFF-CODEX-REVIEW-r1.md': VERDICT('PASS') }) },
  });
  const r = pass(t, '--dry-run', '.planning');
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(r.out.includes('act .planning/phases/001-a') && r.out.includes('  state .planning/phases/001-a: review.diff_done: waived'), r.out);
  assert.ok(r.out.includes('held .planning/phases/002-b: state entry not found once by its dir: line (2 found)'), r.out);
  assert.match(r.out, /^held \.planning\/phases\/003-c: the state edit would not read back: /m);
});

test('a run outside the landing lock is refused', () => {
  const a = PH + '001-a';
  const t = repo({ state: stateOf([phaseEntry(1, 'landed', a, WAIVED)]), obs: ['- 2026-10-01 repo 900: clean', '- 2026-10-21 repo 001: clean'],
    files: filesIn(a, { '001-DECISION.md': 'x\n', '001-01-PLAN.md': 'x\n' }) });
  const head = sh('git rev-parse HEAD', t.root, t.env);
  const r = pass(t, '.planning');
  assert.strictEqual(r.code, 2, r.out);
  assert.match(r.out, /h-scratch-pass commits under the landing lock: h-queue lock -- h-scratch-pass \.planning/);
  assert.strictEqual(sh('git rev-parse HEAD', t.root, t.env), head);
  assert.deepStrictEqual(tokensLeft(t), []);
});

test('under the lock the pass commits the deletions and the state edits in one commit whose message names its parent', () => {
  const P = n => `${PH}${nnn(n)}-`;
  const a = PH + '001-a', b = PH + '002-b', c = PH + '003-c', d4 = '.planning/milestones/v1-phases/04-d';
  const q = (id, status, extra) => quickEntry(id, status, QK + id, extra);
  const t = repo({
    state: stateOf([
      phaseEntry(1, 'landed', a, [...REVIEWED, '    models:', '      executor: opus']), phaseEntry(2, 'landed', b, WAIVED), phaseEntry(3, 'landed', c, REVIEWED),
      ['  - number: 4', '    slug: s4', '    milestone: null', '    status: archived', '    landed: 2026-09-01', `    dir: ${d4}`],
    ], [q('q1', 'complete'), q('q2', 'landed'), q('q3', 'complete', ['    review: {}'])]),
    obs: ['- 2026-10-01 repo 900: clean', '- 2026-10-21 repo 001: clean', '- 2026-10-21 repo 002: clean', '- 2026-10-21 repo 003: clean'],
    files: {
      ...filesIn(a, { '001-DECISION.md': 'x\n', '001-01-PLAN.md': 'plan one\n', ...REPORT, 'inputs/a/x.md': 'x\n' }),
      ...filesIn(b, { '002-DECISION.md': 'x\n', '002-01-PLAN.md': 'x\n' }), ...filesIn(c, { '003-DECISION.md': 'x\n', '003-01-PLAN.md': 'x\n' }),
      ...filesIn(d4, { '04-01-PLAN.md': 'x\n' }),
      ...filesIn(QK + 'q1', { 'DECISION.md': 'x\n', 'PLAN.md': 'x\n', 'LEDGER.md': '# Executor ledger\n' }), ...filesIn(QK + 'q2', { 'PLAN.md': 'x\n' }),
      ...filesIn(QK + 'q3', { 'DECISION.md': 'x\n', 'PLAN.md': 'x\n' }),
    },
  });
  const parent = sh('git rev-parse HEAD', t.root, t.env), g = (c) => sh(c, t.root, t.env);
  const dd = g(`git log -1 --format=%cs -- ${a}/DIFF-CODEX-REVIEW-r1.md`);
  let r = locked(t, '.planning');
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /^committed [0-9a-f]{7} docs\(scratch\): delete scratch records under \.planning$/m);
  assert.strictEqual(g('git rev-parse HEAD^'), parent);
  const msg = g('git log -1 --format=%B');
  for (const s of [`Parent: ${parent}`, `git checkout ${parent} -- `, 'held back 1', '  .planning/phases/003-c: diff review neither done nor waived',
    '  .planning/quick/q2: deleted 1, kept 0, review.diff_done: waived, dir: dropped', `  ${d4}: deleted 1, kept 0, review.diff_done: waived, dir: dropped`]) assert.ok(msg.includes(s), s + '\n' + msg);
  const ns = g('git diff --name-status --no-renames HEAD^ HEAD').split('\n').sort();
  same(ns, [`${a}/001-01-PLAN.md`, `${a}/DIFF-CODEX-REVIEW-r1.md`, `${a}/inputs/a/x.md`, `${b}/002-01-PLAN.md`, `${d4}/04-01-PLAN.md`,
    QK + 'q1/LEDGER.md', QK + 'q1/PLAN.md', QK + 'q2/PLAN.md', QK + 'q3/PLAN.md'].map(f => `D\t${f}`).concat('M\t.planning/state.yaml'));
  const text = g('git show HEAD:.planning/state.yaml'), st = require('../lib/yaml-lite.js').parse(text);
  const ph = n => st.phases.find(p => p.number === n), qk = id => st.quick.find(e => String(e.id) === id);
  assert.strictEqual(ph(1).review.diff_done, `${dd} PASS`); assert.strictEqual(ph(1).review.diff, 'self'); assert.strictEqual(ph(1).models.executor, 'opus');
  assert.strictEqual(ph(2).review.diff_done, 'waived'); assert.ok(!('diff_done' in ph(3).review));
  assert.ok(!('dir' in ph(4)) && ph(4).review.diff_done === 'waived');
  assert.strictEqual(qk('q1').review.diff_done, 'waived'); assert.strictEqual(qk('q1').dir, QK + 'q1');
  assert.ok(!('dir' in qk('q2')) && qk('q2').review.diff_done === 'waived'); assert.strictEqual(qk('q3').review.diff_done, 'waived');
  assert.ok(text.includes(`      diff: self\n      diff_done: ${dd} PASS\n    models:`), text);
  assert.ok(!fs.existsSync(path.join(t.root, QK + 'q2')) && !fs.existsSync(path.join(t.root, d4)));
  assert.ok(fs.existsSync(path.join(t.root, a, '001-DECISION.md')) && fs.existsSync(path.join(t.root, QK, 'q1/DECISION.md')));
  assert.strictEqual(g('git status --porcelain'), ''); assert.deepStrictEqual(tokensLeft(t), []);
  assert.strictEqual(g(`git show ${parent}:${a}/001-01-PLAN.md`), 'plan one');
  const head = g('git rev-parse HEAD');
  r = locked(t, '.planning');
  assert.strictEqual(r.code, 0, r.out);
  for (const s of ['nothing to delete', 'skip quick q2: no dir', 'skip phase 4: no dir']) assert.ok(r.out.includes(s), r.out);
  assert.strictEqual(g('git rev-parse HEAD'), head);
});

test('a refused metadata commit leaves HEAD and the tree as they were and drops its token', () => {
  const a = PH + '001-a';
  const t = repo({ state: stateOf([phaseEntry(1, 'landed', a, WAIVED)]), obs: ['- 2026-10-01 repo 900: clean', '- 2026-10-21 repo 001: clean'],
    files: filesIn(a, { '001-DECISION.md': 'x\n', '001-01-PLAN.md': 'x\n' }) });
  const head = sh('git rev-parse HEAD', t.root, t.env);
  fs.appendFileSync(path.join(t.root, '.holden/config.yaml'), '# local\n');
  const r = locked(t, '.planning');
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /uncommitted change in \.holden\/config\.yaml: commit or discard it/);
  assert.match(r.out, /h-queue meta commit exited 73; nothing committed/);
  assert.strictEqual(sh('git rev-parse HEAD', t.root, t.env), head);
  assert.ok(fs.existsSync(path.join(t.root, a, '001-01-PLAN.md')));
  assert.deepStrictEqual(tokensLeft(t), []);
});
