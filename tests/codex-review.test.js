'use strict';
// bin/codex-review through --dry-run, and whole rounds against a scripted app-server: no Codex run, no Codex plan.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path'), cp = require('child_process');
const { makeRepo, commitFile } = require('./fixtures/repo.js');
const REVIEW = path.join(__dirname, '..', 'bin', 'codex-review');
const GOAL = '.holden/quick/q/goal.md';
const FAKE_SERVER = path.join(__dirname, 'fixtures', 'fake-app-server.js');
const ID = '01a15563-0000-7000-8000-000000000001';

function setup() {
  const t = makeRepo();
  const fake = path.join(t.dir, 'fakebin'); fs.mkdirSync(fake);
  fs.symlinkSync(FAKE_SERVER, path.join(fake, 'codex'));
  fs.writeFileSync(path.join(fake, 'tmux'), '#!/bin/sh\ncase "$1" in new-*) echo @7 ;; esac\n', { mode: 0o755 });
  fs.writeFileSync(path.join(fake, 'codex-limits'), '#!/bin/sh\nif [ "$1" = --check ]; then echo "${FAKE_LIMITS_LINE:-ok: codex plus}"; exit ${FAKE_LIMITS_RC:-0}; fi\necho "codex plus"\n', { mode: 0o755 });
  t.log = path.join(t.dir, 'server.log');
  t.env = { ...t.env, PATH: fake + ':' + process.env.PATH, FAKE_CODEX_LOG: t.log, CODEX_REVIEW_LIMITS: path.join(fake, 'codex-limits') };
  for (const k of ['CODEX_REVIEW_MAX_ROUNDS', 'CODEX_REVIEW_SKIP_LIMITS', 'FAKE_CODEX', 'FAKE_LIMITS_RC', 'FAKE_LIMITS_LINE', 'TMUX']) delete t.env[k];
  commitFile(t.root, 'a.txt', 'a2\n', 'change a', t.env);
  fs.mkdirSync(path.join(t.root, path.dirname(GOAL)), { recursive: true });
  fs.writeFileSync(path.join(t.root, GOAL), '# goal\nEntry point: a.txt\n');
  t.out = path.join(t.dir, 'out');
  return t;
}
function review(t, args, env = {}) {
  const r = cp.spawnSync(REVIEW, args, { cwd: t.root, env: { ...t.env, ...env }, encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout || '', out: (r.stdout || '') + (r.stderr || '') };
}
const quick = (t, ...more) => ['--kind', 'quick', '--diff', 'HEAD~1..HEAD', '--out-dir', t.out, '--context', GOAL, ...more, '--dry-run'];

test('a quick review sends the six items and no plan framing', () => {
  const t = setup();
  const r = review(t, quick(t));
  assert.equal(r.code, 0, r.out);
  for (const s of ['1. CORRECTNESS: a bug you can demonstrate by reading the code', '2. TEST HONESTY: a test that would pass with the change reverted',
    '3. BOUNDARY: a change that crosses a contract', '4. READERS:', '5. ENTRY POINT:', '6. PLANNING IDS:', '--check-ids --range HEAD~1..HEAD', 'goes under "Could not verify", not under Findings',
    `- ${GOAL}`, '# Codex review (quick), round 1', 'Which of the six items you checked']) assert.ok(r.stdout.includes(s), s);
  assert.ok(r.stdout.indexOf('6. PLANNING IDS:') > r.stdout.indexOf('5. ENTRY POINT:'));
  for (const s of ['SPEC GAP', 'SCOPE CREEP', 'against the plan or decision record', 'plans are not asked to do either', 'Plan / decision files'])
    assert.ok(!r.stdout.includes(s), s);
});

test('a quick review refuses a missing goal, a plan file and a second round', () => {
  const t = setup();
  const base = ['--kind', 'quick', '--diff', 'HEAD~1..HEAD', '--out-dir', t.out, '--dry-run'];
  let r = review(t, base);
  assert.equal(r.code, 1, r.out); assert.match(r.out, /--kind quick needs --context/);
  r = review(t, [...base, '--context', 'nope.md']);
  assert.equal(r.code, 1, r.out); assert.match(r.out, /missing file: nope\.md/);
  r = review(t, [...base, '--context', GOAL, '--files', 'x.md']);
  assert.equal(r.code, 1, r.out); assert.match(r.out, /takes no --files/);
  r = review(t, [...base, '--context', GOAL, '--round', '2']);
  assert.equal(r.code, 2, r.out); assert.match(r.out, /a quick has one round/);
  // Past the default cap of 2, so only the quick's own refusal stands between it and a third read.
  r = review(t, [...base, '--context', GOAL, '--round', '3'], { CODEX_REVIEW_MAX_ROUNDS: '3' });
  assert.equal(r.code, 2, r.out); assert.match(r.out, /a quick has one round/);
});

test('a quick review over a published report needs the operator', () => {
  const t = setup();
  fs.mkdirSync(t.out, { recursive: true });
  fs.writeFileSync(path.join(t.out, 'QUICK-CODEX-REVIEW-r1.md'), '# Codex review (quick), round 1\n');
  const r = review(t, quick(t));
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /a quick gets one review and one re-read of fix hunks \(--reread\); a further read needs the operator/);
});

test("the diff kind's prompt keeps its five items and gains the ids item", () => {
  const t = setup();
  const r = review(t, ['--kind', 'diff', '--diff', 'HEAD~1..HEAD', '--out-dir', t.out, '--dry-run']);
  assert.equal(r.code, 0, r.out);
  for (const s of ['against the plan or decision record it implements', '1. SPEC GAP:', '2. CORRECTNESS: a bug you can demonstrate by reading the code',
    '3. SCOPE CREEP:', '4. TEST HONESTY: a test that would pass with the change reverted, or asserts nothing.', '5. BOUNDARY: a change that crosses a contract', '6. PLANNING IDS:', '--check-ids --range HEAD~1..HEAD',
    'be precise, not exhaustive. The harness that\nexecutes plans runs the full test suite', '## What to look for, in priority order',
    '# Codex review (diff), round 1', 'Which decisions / criteria you traced, and which you did not find.']) assert.ok(r.stdout.includes(s), s);
});

test('a re-read needs the first review', () => {
  const t = setup();
  const r = review(t, quick(t, '--reread'));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /--reread needs the first review .*QUICK-CODEX-REVIEW-r1\.md/);
});

test("a re-read carries the first review's text in its prompt, with no response file", () => {
  const t = setup();
  fs.mkdirSync(t.out, { recursive: true });
  const first = path.join(t.out, 'QUICK-CODEX-REVIEW-r1.md');
  const marker = '### [BLOCKER] marker finding r1-7f3a uses $HOME and `id`';
  fs.writeFileSync(first, ['# Codex review (quick), round 1', '## Findings', marker, ''].join('\n'));
  const r = review(t, quick(t, '--reread'));
  assert.equal(r.code, 0, r.out);
  for (const s of ['## This is the one re-read of fix hunks', `The first review, written to ${first}, is quoted between the two marker lines below.`,
    '5. ENTRY POINT:', '6. PLANNING IDS:', '# Codex review (quick re-read), round 1']) assert.ok(r.stdout.includes(s), s);
  // Quoted as written ($HOME and the backticks unexpanded), between the markers: Codex reads it there, never at a path.
  const at = r.stdout.indexOf(marker), open = r.stdout.indexOf('----- the first review -----'), close = r.stdout.indexOf('----- end of the first review -----');
  assert.ok(open >= 0 && at > open && close > at, `marker at ${at}, block ${open}..${close}`);
  assert.ok(!fs.existsSync(path.join(t.out, 'QUICK-CODEX-RESPONSE-r1.md')));
});

test('a second re-read needs the operator', () => {
  const t = setup();
  fs.mkdirSync(t.out, { recursive: true });
  fs.writeFileSync(path.join(t.out, 'QUICK-CODEX-REVIEW-r1.md'), '# Codex review (quick), round 1\n');
  fs.writeFileSync(path.join(t.out, 'QUICK-REREAD-CODEX-REVIEW-r1.md'), '# Codex review (quick re-read), round 1\n');
  const r = review(t, quick(t, '--reread'));
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /QUICK-REREAD-CODEX-REVIEW-r1\.md exists; a quick gets one review and one re-read of fix hunks/);
});

test('--reread is for the quick kind', () => {
  const t = setup();
  const r = review(t, ['--kind', 'diff', '--reread', '--diff', 'HEAD~1..HEAD', '--out-dir', t.out, '--dry-run']);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /--reread is for --kind quick/);
});

const diffRound = (t, ...more) => ['--kind', 'diff', '--diff', 'HEAD~1..HEAD', '--out-dir', t.out, ...more];
const requests = (t, method) => fs.existsSync(t.log) ? fs.readFileSync(t.log, 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(e => e.method === method) : [];
const report = t => path.join(t.out, 'DIFF-CODEX-REVIEW-r1.md');

test('a review publishes its report and keeps a resumable read-only thread', () => {
  const t = setup();
  const r = review(t, diffRound(t));
  assert.equal(r.code, 0, r.out);
  assert.equal(fs.readFileSync(report(t), 'utf8'), 'answer 1\n');
  assert.deepEqual(requests(t, 'thread/start')[0].params, { cwd: t.root, sandbox: 'read-only', approvalPolicy: 'never', model: 'gpt-6-sol', ephemeral: false });
  assert.equal(requests(t, 'turn/start')[0].params.effort, 'high');
  assert.equal(fs.readFileSync(path.join(t.out, 'DIFF-CODEX-REVIEW-r1.session'), 'utf8'), `id=${ID}\nmodel=gpt-6-sol\neffort=high\nminutes=25\nroot=${t.root}\n`);
  assert.deepEqual(fs.readdirSync(t.out).filter(f => f.startsWith('.')), []);
});

for (const mode of ['failed', 'interrupted', 'empty']) {
  test(`a review whose turn is scripted ${mode} publishes nothing and leaves no earlier report looking fresh`, () => {
    const t = setup();
    const r = review(t, diffRound(t), { FAKE_CODEX: mode });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /codex failed \(exit 1\), no report published/);
    assert.ok(!fs.existsSync(report(t)));
    assert.ok(!fs.existsSync(path.join(t.out, 'DIFF-CODEX-REVIEW-r1.session')));
    assert.deepEqual(fs.readdirSync(t.out).filter(f => f.startsWith('.')), []);
  });
}

test('the wall clock publishes no report and exits 124', () => {
  const t = setup();
  const r = review(t, diffRound(t, '--minutes', '0.01'), { FAKE_CODEX: 'hang' });
  assert.equal(r.code, 124, r.out);
  assert.equal(requests(t, 'turn/interrupt').length, 1);
  assert.ok(!fs.existsSync(report(t)));
});

test('limits not ok exits 5 before any round, for a review and a follow', () => {
  const t = setup();
  const bad = { FAKE_LIMITS_RC: '3', FAKE_LIMITS_LINE: 'exhausted: x' };
  const r = review(t, diffRound(t), bad);
  assert.equal(r.code, 5, r.out);
  assert.match(r.out, /codex unavailable \(exhausted\)/);
  assert.deepEqual(requests(t, 'turn/start'), []);
  assert.equal(review(t, diffRound(t)).code, 0);
  const q = path.join(t.dir, 'f.md'); fs.writeFileSync(q, 'x\n');
  const f = review(t, ['--follow', report(t), '--file', q], bad);
  assert.equal(f.code, 5, f.out);
  assert.equal(requests(t, 'turn/start').length, 1);
});

test('a review and a quick review may propose a thread; a re-read may not', () => {
  const t = setup();
  const d = review(t, diffRound(t, '--dry-run'));
  assert.ok(d.stdout.includes('## Thread to follow'), d.out);
  const q = review(t, quick(t));
  assert.ok(q.stdout.includes('## Thread to follow'), q.out);
  assert.ok(q.stdout.includes('Do not ask questions; you'), 'a review keeps its bounds');
  fs.mkdirSync(t.out, { recursive: true });
  fs.writeFileSync(path.join(t.out, 'QUICK-CODEX-REVIEW-r1.md'), '# first\n');
  const rr = review(t, quick(t, '--reread'));
  assert.equal(rr.code, 0, rr.out);
  assert.ok(!rr.stdout.includes('## Thread to follow'));
});

test('a re-read keeps no session, so it has nothing to follow', () => {
  const t = setup();
  fs.mkdirSync(t.out, { recursive: true });
  fs.writeFileSync(path.join(t.out, 'QUICK-CODEX-REVIEW-r1.md'), '# first\n');
  const args = quick(t, '--reread').filter(a => a !== '--dry-run');
  const r = review(t, args);
  assert.equal(r.code, 0, r.out);
  const q = path.join(t.dir, 'f.md'); fs.writeFileSync(q, 'Follow it.\n');
  const f = review(t, ['--follow', path.join(t.out, 'QUICK-REREAD-CODEX-REVIEW-r1.md'), '--file', q]);
  assert.equal(f.code, 1, f.out);
  assert.match(f.out, /no thread to follow/);
});

test('--follow resumes the report\'s thread into its own numbered file and leaves the report alone', () => {
  const t = setup();
  assert.equal(review(t, diffRound(t)).code, 0);
  const q = path.join(t.dir, 'f.md'); fs.writeFileSync(q, 'Yes, follow it.\n');
  const sub = path.join(t.root, 'sub'); fs.mkdirSync(sub);
  const r = cp.spawnSync(path.join(__dirname, '..', 'bin', 'codex-review'), ['--follow', report(t), '--file', q], { cwd: sub, env: t.env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const [res] = requests(t, 'thread/resume');
  assert.equal(res.params.threadId, ID);
  assert.equal(res.params.cwd, t.root);
  const turns = requests(t, 'turn/start');
  assert.match(turns[1].params.input[0].text, /^Yes, follow it\.\n\nBudget: about 60 file reads and 25 minutes .*Do not run test suites\.$/s);
  assert.equal(turns[1].params.effort, 'high');
  assert.equal(fs.readFileSync(path.join(t.out, 'DIFF-CODEX-REVIEW-r1-thread1.md'), 'utf8'), 'answer 2\n');
  assert.equal(fs.readFileSync(report(t), 'utf8'), 'answer 1\n');
  const again = review(t, ['--follow', report(t), '--file', q]);
  assert.equal(again.code, 0, again.out);
  assert.equal(fs.readFileSync(path.join(t.out, 'DIFF-CODEX-REVIEW-r1-thread2.md'), 'utf8'), 'answer 3\n');
  const round2 = review(t, diffRound(t, '--round', '2'));
  assert.equal(round2.code, 1, round2.out);
  assert.match(round2.out, /needs .*DIFF-CODEX-RESPONSE-r1\.md/);
});

test('two follows that both chose thread1 keep both answers', async () => {
  const t = setup();
  assert.equal(review(t, diffRound(t)).code, 0);
  const q = path.join(t.dir, 'f.md'); fs.writeFileSync(q, 'Yes.\n');
  const one = () => new Promise(res => {
    const c = cp.spawn(path.join(__dirname, '..', 'bin', 'codex-review'), ['--follow', report(t), '--file', q], { cwd: t.root, env: { ...t.env, FAKE_TURN_MS: '1500', FAKE_ANSWER_PID: '1' } });
    let out = ''; c.stdout.on('data', b => out += b); c.stderr.on('data', b => out += b);
    c.on('close', code => res({ code, out }));
  });
  const runs = await Promise.all([one(), one()]);
  for (const r of runs) assert.equal(r.code, 0, r.out);
  const texts = ['thread1', 'thread2'].map(k => fs.readFileSync(path.join(t.out, `DIFF-CODEX-REVIEW-r1-${k}.md`), 'utf8'));
  for (const x of texts) assert.match(x, /^answer from \d+\n$/);
  assert.notEqual(texts[0], texts[1], 'each follow kept its own answer');
  assert.deepEqual(fs.readdirSync(t.out).filter(f => f.startsWith('.')), []);
});

test('--follow refuses a missing report, question or session and needs --file', () => {
  const t = setup();
  const q = path.join(t.dir, 'f.md'); fs.writeFileSync(q, 'x\n');
  assert.match(review(t, ['--follow', report(t), '--file', q]).out, /no report/);
  fs.mkdirSync(t.out, { recursive: true }); fs.writeFileSync(report(t), 'r\n');
  assert.match(review(t, ['--follow', report(t)]).out, /--follow needs --file/);
  assert.match(review(t, ['--follow', report(t), '--file', path.join(t.dir, 'none.md')]).out, /no question/);
  assert.match(review(t, ['--follow', report(t), '--file', q]).out, /no thread to follow/);
  assert.match(review(t, [...diffRound(t), '--file', q]).out, /--file is for --follow/);
  assert.deepEqual(requests(t, 'turn/start'), []);
});

test('the view window has a short name, since a status line may print it twice', () => {
  const t = setup(), env = { TMUX: '/tmp/x,1,0' };
  const r = review(t, diffRound(t), env);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^view: tmux window @7 \(codex-diff-r1\)$/m);
  const q = path.join(t.dir, 'f.md'); fs.writeFileSync(q, 'Yes, follow it.\n');
  const f = review(t, ['--follow', report(t), '--file', q], env);
  assert.equal(f.code, 0, f.out);
  assert.match(f.out, /^view: tmux window @7 \(codex-follow-1\)$/m);
});

test('two reviews of one round: the first report stands and the second run is refused', async () => {
  const t = setup();
  const one = () => new Promise(res => {
    const c = cp.spawn(REVIEW, diffRound(t), { cwd: t.root, env: { ...t.env, FAKE_TURN_MS: '1500', FAKE_ANSWER_PID: '1' } });
    let out = ''; c.stdout.on('data', b => out += b); c.stderr.on('data', b => out += b);
    c.on('close', code => res({ code, out }));
  });
  const runs = await Promise.all([one(), one()]);
  assert.deepEqual(runs.map(r => r.code).sort(), [0, 2], runs.map(r => r.out).join('\n'));
  assert.match(runs.find(r => r.code === 2).out, /refusing: .*DIFF-CODEX-REVIEW-r1\.md was published during this run/);
  assert.match(fs.readFileSync(report(t), 'utf8'), /^answer from \d+\n$/);
  assert.deepEqual(fs.readdirSync(t.out).filter(f => f.startsWith('.')), []);
});
