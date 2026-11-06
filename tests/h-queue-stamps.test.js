'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path'), cp = require('child_process');
const { makeRepo, run, sh, commitFile, writePlan } = require('./fixtures/repo.js');
const R = require('../lib/registry.js');

// A doc with a stamp line far from its body, so an edit at each end merges and an edit of the stamp conflicts.
const DOC = ['---', 'verified: old', '---', '# A', '', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', ''].join('\n');
const repo = (opts = {}) => makeRepo({ concurrency: false, files: { 'a.txt': 'a\n', 'docs/a.md': DOC, 'docs/CONTEXT.md': '# glossary\n' }, ...opts });
const queue = (t, ...a) => run('h-queue', a, { cwd: t.root, env: t.env });
const head = t => sh('git rev-parse HEAD', t.root, t.env);
const porcelain = t => sh('git status --porcelain', t.root, t.env);
const metaDir = t => path.join(t.root, '.git', 'holden-meta');
const tokens = t => fs.existsSync(metaDir(t)) ? fs.readdirSync(metaDir(t)).filter(n => n !== 'JOURNAL') : [];
function opened(r) {
  const token = (r.out.match(/^token (\S+)$/m) || [])[1], work = {};
  for (const m of r.out.matchAll(/^work (\S+) (\S+)$/gm)) work[m[1]] = m[2];
  return { token, work };
}
function openStamps(t, ...docs) { const r = queue(t, 'meta', 'open', '--stamps', ...docs); assert.equal(r.code, 0, r.out); const o = opened(r); o.dir = path.join(metaDir(t), o.token); return o; }
const restamp = (o, doc, to) => fs.writeFileSync(o.work[doc], fs.readFileSync(o.work[doc], 'utf8').replace(/^verified: .*$/m, `verified: ${to}`));
const headBlob = (t, p) => sh(`git show HEAD:${p}`, t.root, t.env);

test('meta open --stamps copies a tracked doc and meta commit publishes it alone', () => {
  const t = repo(), old = head(t);
  const o = openStamps(t, 'docs/a.md');
  assert.equal(fs.readFileSync(o.work['docs/a.md'], 'utf8'), DOC);
  assert.equal(JSON.parse(fs.readFileSync(path.join(o.dir, 'token.json'), 'utf8')).stamps, true);
  restamp(o, 'docs/a.md', 'new');
  const c = queue(t, 'meta', 'commit', o.token, '-m', 'docs(001-01): stamps');
  assert.equal(c.code, 0, c.out);
  assert.match(c.out, /^committed [0-9a-f]{7} docs\(001-01\): stamps$/m);
  assert.equal(sh('git rev-parse HEAD~1', t.root, t.env), old);
  assert.equal(sh('git show --name-only --format= HEAD', t.root, t.env), 'docs/a.md');
  assert.match(fs.readFileSync(path.join(t.root, 'docs/a.md'), 'utf8'), /^verified: new$/m);
  assert.equal(porcelain(t), '');
  assert.equal(tokens(t).length, 0);
});

test('meta open --stamps refuses a path not tracked at HEAD', () => {
  const t = repo();
  for (const p of ['docs/new.md', 'docs', '../x', '/etc/hostname', '.git/config']) {
    const r = queue(t, 'meta', 'open', '--stamps', p);
    assert.equal(r.code, 1, `${p}: ${r.out}`);
    assert.match(r.out, new RegExp(`not a file tracked at HEAD: ${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}; --stamps opens an existing doc to stamp`));
    assert.equal(tokens(t).length, 0, p);
  }
});

test('meta open --stamps refuses a tracked symlink', () => {
  const t = repo();
  fs.symlinkSync('a.md', path.join(t.root, 'docs', 'link.md'));
  sh('git add docs/link.md && git commit -q -m link', t.root, t.env);
  const r = queue(t, 'meta', 'open', '--stamps', 'docs/link.md');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /not a file tracked at HEAD: docs\/link\.md/);
  assert.equal(tokens(t).length, 0);
});

test('meta open --stamps takes a shared doc too', () => {
  const t = repo(), old = head(t);
  const r = queue(t, 'meta', 'open', '--stamps', 'docs/CONTEXT.md');
  assert.equal(r.code, 0, r.out);
  const o = opened(r);
  fs.appendFileSync(o.work['docs/CONTEXT.md'], 'verified: new\n');
  const c = queue(t, 'meta', 'commit', o.token, '-m', 'docs(001-01): stamps');
  assert.equal(c.code, 0, c.out);
  assert.equal(sh('git rev-parse HEAD~1', t.root, t.env), old);
  assert.match(headBlob(t, 'docs/CONTEXT.md'), /^verified: new$/m);
  assert.equal(porcelain(t), '');
});

test('meta open without --stamps still takes only the shared files', () => {
  const t = repo();
  const r = queue(t, 'meta', 'open', 'docs/a.md');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /not a shared file: docs\/a\.md; an owner-unique path goes to meta commit --add/);
  assert.equal(tokens(t).length, 0);
});

test('meta open --stamps with no file is usage', () => {
  const t = repo();
  assert.equal(queue(t, 'meta', 'open', '--stamps').code, 2);
  assert.equal(queue(t, 'meta', 'open', '--stamps', '--x').code, 2);
  assert.equal(tokens(t).length, 0);
});

test("a sibling's edit to the doc between open and commit merges, and an edit of the stamp conflicts", () => {
  const t = repo();
  const o = openStamps(t, 'docs/a.md');
  restamp(o, 'docs/a.md', 'new');
  commitFile(t.root, 'docs/a.md', DOC.replace('seven', 'seven2'), 'sib', t.env);
  const c = queue(t, 'meta', 'commit', o.token, '-m', 'docs(001-01): stamps');
  assert.equal(c.code, 0, c.out);
  assert.match(headBlob(t, 'docs/a.md'), /^seven2$/m);
  assert.match(headBlob(t, 'docs/a.md'), /^verified: new$/m);
  assert.equal(porcelain(t), '');

  const o2 = openStamps(t, 'docs/a.md');
  restamp(o2, 'docs/a.md', 'mine');
  const sib = commitFile(t.root, 'docs/a.md', headBlob(t, 'docs/a.md').replace('verified: new', 'verified: sib') + '\n', 'sib2', t.env);
  const c2 = queue(t, 'meta', 'commit', o2.token, '-m', 'docs(001-01): stamps');
  assert.equal(c2.code, 73, c2.out);
  assert.match(c2.out, /^conflict in docs\/a\.md: open again and redo the edit$/m);
  assert.equal(head(t), sib);
});

test('an uncommitted edit of the doc blocks the stamp commit and is kept', () => {
  const t = repo(), old = head(t);
  const o = openStamps(t, 'docs/a.md');
  restamp(o, 'docs/a.md', 'new');
  fs.appendFileSync(path.join(t.root, 'docs/a.md'), '# hand edit\n');
  const c = queue(t, 'meta', 'commit', o.token, '-m', 'docs(001-01): stamps');
  assert.equal(c.code, 73, c.out);
  assert.match(c.out, /^uncommitted change in docs\/a\.md: commit or discard it$/m);
  assert.equal(head(t), old);
  assert.match(fs.readFileSync(path.join(t.root, 'docs/a.md'), 'utf8'), /^# hand edit$/m);
  assert.equal(fs.existsSync(path.join(t.root, 'docs/a.md.holden-saved')), false);
});

test('a hand-edited stamps token is refused as unreadable', () => {
  const t = repo(), old = head(t);
  for (const edit of [tk => ({ ...tk, stamps: true, files: ['../x'] }), tk => { const { stamps, ...rest } = tk; return rest; }]) {
    const o = openStamps(t, 'docs/a.md');
    restamp(o, 'docs/a.md', 'new');
    const f = path.join(o.dir, 'token.json');
    fs.writeFileSync(f, JSON.stringify(edit(JSON.parse(fs.readFileSync(f, 'utf8')))));
    const r = queue(t, 'meta', 'commit', o.token, '-m', 'docs(001-01): stamps');
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, new RegExp(`token ${o.token} is unreadable: h-queue meta abort ${o.token}, then open again`));
    assert.equal(head(t), old);
  }
});

test('a kill after the publish of a stamp commit is replayed from HEAD', () => {
  const t = repo();
  const o = openStamps(t, 'docs/a.md');
  restamp(o, 'docs/a.md', 'new');
  const c = run('h-queue', ['meta', 'commit', o.token, '-m', 'docs(001-01): stamps'], { cwd: t.root, env: { ...t.env, HOLDEN_TEST_CRASH_AT: 'meta-after-publish' } });
  assert.equal(c.code, 99, c.out);
  assert.ok(fs.existsSync(path.join(metaDir(t), 'JOURNAL')));
  const s = queue(t, 'status');
  assert.equal(s.code, 0, s.out);
  assert.match(s.out, /replayed the metadata journal/);
  assert.equal(fs.readFileSync(path.join(t.root, 'docs/a.md'), 'utf8'), headBlob(t, 'docs/a.md') + '\n');
  assert.match(headBlob(t, 'docs/a.md'), /^verified: new$/m);
  assert.equal(porcelain(t), '');
});

test('meta commit --checked refuses when a doc moved since the re-check', () => {
  const t = repo();
  const checked = head(t);
  const o = openStamps(t, 'docs/a.md');
  restamp(o, 'docs/a.md', 'new');
  const sib = commitFile(t.root, 'docs/a.md', DOC.replace('seven', 'seven2'), 'sib', t.env);
  const c = queue(t, 'meta', 'commit', o.token, '-m', 'docs(001-01): stamps', '--checked', checked);
  assert.equal(c.code, 73, c.out);
  assert.match(c.out, new RegExp(`^changed since ${checked}: docs/a\\.md: abort, re-check and open again$`, 'm'));
  assert.equal(head(t), sib);
  const bad = queue(t, 'meta', 'commit', o.token, '-m', 'docs(001-01): stamps', '--checked', 'nosuch');
  assert.equal(bad.code, 1, bad.out);
  assert.match(bad.out, /--checked nosuch is not a commit/);
  assert.equal(queue(t, 'meta', 'commit', o.token, '-m', 'docs(001-01): stamps', '--checked').code, 2);
  const ok = queue(t, 'meta', 'commit', o.token, '-m', 'docs(001-01): stamps', '--checked', sib);
  assert.equal(ok.code, 0, ok.out);
  assert.match(headBlob(t, 'docs/a.md'), /^verified: new$/m);
  assert.match(headBlob(t, 'docs/a.md'), /^seven2$/m);
});

const LED = '.planning/phases/001-x/001-01-LEDGER.md';
function ledgerAt(t, rel, text) { const f = path.join(t.root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, Array.isArray(text) ? text.join('\n') + '\n' : text); return f; }
const ENTRY = 'stamp: docs/a.md task 1: checked § A against bin/a.js at bbbbbbb';
const DONE1 = 'Task 1: complete (commits aaaaaaa..bbbbbbb)';
const RESULT = ['## Result', 'Commits: aaaaaaa..bbbbbbb'];
const MISSED = `missed: ${LED} docs/a.md task 1: checked § A against bin/a.js at bbbbbbb`;
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const lineRe = l => new RegExp('^' + esc(l) + '$', 'm');
const missedLines = r => r.out.split('\n').filter(l => l.startsWith('missed: '));

test("stamps lists a completed task's entry with no stamped line as missed", () => {
  const t = repo();
  ledgerAt(t, LED, [ENTRY, DONE1, ...RESULT]);
  const r = queue(t, 'stamps');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, lineRe(MISSED));
  assert.match(r.out, /^stamps: 1 missed, 0 pending$/m);
});

test('a later stamped: line for the doc covers the entry', () => {
  const t = repo();
  ledgerAt(t, LED, [ENTRY, DONE1, ...RESULT, 'stamped: docs/a.md 0a1b2c3']);
  const r = queue(t, 'stamps');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^stamps: none$/m);
  assert.doesNotMatch(r.out, /^missed: /m);
});

test('a stamped: line before the entry does not cover it', () => {
  const t = repo();
  ledgerAt(t, LED, ['stamped: docs/a.md 0a1b2c3', ENTRY, DONE1, ...RESULT]);
  const r = queue(t, 'stamps');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, lineRe(MISSED));
  assert.match(r.out, /^stamps: 1 missed, 0 pending$/m);
});

test("a resumed task's last stamp: line counts", () => {
  const t = repo();
  ledgerAt(t, LED, ['stamp: docs/a.md task 1: v1', 'stamp: docs/a.md task 1: v2', DONE1, ...RESULT]);
  const r = queue(t, 'stamps');
  assert.equal(r.code, 0, r.out);
  assert.equal(missedLines(r).length, 1, r.out);
  assert.match(r.out, /task 1: v2$/m);
  const L2 = '.planning/phases/001-x/001-02-LEDGER.md';
  ledgerAt(t, LED, ['# none']);
  ledgerAt(t, L2, ['stamp: docs/a.md task 1: v1', 'stamped: docs/a.md 0a1b2c3', 'stamp: docs/a.md task 1: v2', DONE1, ...RESULT]);
  const r2 = queue(t, 'stamps');
  assert.equal(missedLines(r2).length, 1, r2.out);
  assert.match(r2.out, lineRe(`missed: ${L2} docs/a.md task 1: v2`));
});

test('an entry of a task without a completion line is not listed', () => {
  const t = repo();
  ledgerAt(t, LED, [ENTRY, DONE1, 'stamp: docs/a.md task 2: x', ...RESULT, 'stamped: docs/a.md 0a1b2c3']);
  const r = queue(t, 'stamps');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^stamps: none$/m);
  ledgerAt(t, LED, [ENTRY, DONE1, 'stamped: docs/a.md 0a1b2c3', 'stamp: docs/a.md task 2: x']);
  const r2 = queue(t, 'stamps');
  assert.equal(r2.code, 0, r2.out);
  assert.match(r2.out, /^stamps: none$/m);
});

test('a ledger without ## Result lists its entries as pending', () => {
  const t = repo();
  ledgerAt(t, LED, [ENTRY, DONE1]);
  const r = queue(t, 'stamps');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, lineRe(`pending: ${LED} docs/a.md task 1: checked § A against bin/a.js at bbbbbbb`));
  assert.doesNotMatch(r.out, /^missed: /m);
  assert.match(r.out, /^stamps: 0 missed, 1 pending$/m);
});

test('a line out of shape is unreadable and counted', () => {
  const t = repo();
  ledgerAt(t, LED, ['stamp: docs/a.md checked', DONE1, ...RESULT]);
  const r = queue(t, 'stamps');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^unreadable: \.planning\/phases\/001-x\/001-01-LEDGER\.md:1: stamp: docs\/a\.md checked$/m);
  assert.match(r.out, /^stamps: 1 missed, 0 pending$/m);
  ledgerAt(t, LED, [ENTRY, DONE1, 'stamped: docs/a.md', ...RESULT]);
  const r2 = queue(t, 'stamps');
  assert.match(r2.out, /^unreadable: \.planning\/phases\/001-x\/001-01-LEDGER\.md:3: stamped: docs\/a\.md$/m);
  assert.match(r2.out, lineRe(MISSED));
  assert.match(r2.out, /^stamps: 2 missed, 0 pending$/m);
});

test('./docs/a.md and docs/a.md are one doc', () => {
  const t = repo();
  ledgerAt(t, LED, ['stamp: ./docs/a.md task 1: x', DONE1, ...RESULT, 'stamped: docs/a.md 0a1b2c3']);
  assert.match(queue(t, 'stamps').out, /^stamps: none$/m);
  ledgerAt(t, LED, ['stamp: docs/a.md task 1: x', DONE1, ...RESULT, 'stamped: ./docs/a.md 0a1b2c3']);
  assert.match(queue(t, 'stamps').out, /^stamps: none$/m);
  ledgerAt(t, LED, ['stamp: ./docs/a.md task 1: x', DONE1, ...RESULT]);
  const r = queue(t, 'stamps');
  assert.match(r.out, lineRe(`missed: ${LED} docs/a.md task 1: x`));
});

test('a stamped: line for another doc covers nothing', () => {
  const t = repo();
  ledgerAt(t, LED, [ENTRY, DONE1, 'stamped: docs/b.md 0a1b2c3', ...RESULT]);
  const r = queue(t, 'stamps');
  assert.match(r.out, lineRe(MISSED));
  assert.match(r.out, /^stamps: 1 missed, 0 pending$/m);
});

test('the scan reads phase, fix and quick ledgers, not dropped or archived ones', () => {
  const t = repo();
  const at = {
    '.planning/phases/001-x/001-01-LEDGER.md': 'docs/p.md', '.planning/phases/001-x/001-fix1-LEDGER.md': 'docs/f.md',
    '.planning/quick/261021-q/LEDGER.md': 'docs/q.md', '.planning/quick/261021-q/fix1-LEDGER.md': 'docs/qf.md',
    '.planning/phases/001-x/001-02-LEDGER-dropped-r1.md': 'docs/d.md', '.planning/archive/m1/001-x/001-03-LEDGER.md': 'docs/ar.md',
  };
  for (const [rel, doc] of Object.entries(at)) ledgerAt(t, rel, [`stamp: ${doc} task 1: e`, DONE1, ...RESULT]);
  const r = queue(t, 'stamps');
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(missedLines(r), [
    'missed: .planning/phases/001-x/001-01-LEDGER.md docs/p.md task 1: e',
    'missed: .planning/phases/001-x/001-fix1-LEDGER.md docs/f.md task 1: e',
    'missed: .planning/quick/261021-q/LEDGER.md docs/q.md task 1: e',
    'missed: .planning/quick/261021-q/fix1-LEDGER.md docs/qf.md task 1: e',
  ]);
  assert.match(r.out, /^stamps: 4 missed, 0 pending$/m);
  assert.doesNotMatch(r.out, /docs\/d\.md/);
  assert.doesNotMatch(r.out, /docs\/ar\.md/);
});

test('paths.phases and paths.quick come from the config', () => {
  const t = repo();
  fs.appendFileSync(path.join(t.root, '.holden', 'config.yaml'), 'paths:\n  phases: work/phases\n  quick: work/quick\n');
  ledgerAt(t, 'work/phases/001-x/001-01-LEDGER.md', [ENTRY, DONE1, ...RESULT]);
  ledgerAt(t, LED, [ENTRY, DONE1, ...RESULT]);
  const r = queue(t, 'stamps');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^missed: work\/phases\/001-x\/001-01-LEDGER\.md /m);
  assert.doesNotMatch(r.out, /\.planning\/phases/);
  assert.match(r.out, /^stamps: 1 missed, 0 pending$/m);
});

test('--ledger reads only the ledger it names', () => {
  const t = repo();
  ledgerAt(t, LED, [ENTRY, DONE1, ...RESULT]);
  ledgerAt(t, '.planning/phases/001-x/001-02-LEDGER.md', [ENTRY, DONE1, ...RESULT]);
  const r = queue(t, 'stamps', '--ledger', LED);
  assert.equal(r.code, 0, r.out);
  assert.equal(missedLines(r).length, 1, r.out);
  assert.match(r.out, lineRe(MISSED));
  const out = path.join(t.dir, 'x-LEDGER.md');
  fs.writeFileSync(out, [ENTRY, DONE1, ...RESULT].join('\n') + '\n');
  const r2 = queue(t, 'stamps', '--ledger', out);
  assert.equal(r2.code, 0, r2.out);
  assert.match(r2.out, lineRe(`missed: ${out} docs/a.md task 1: checked § A against bin/a.js at bbbbbbb`));
  const r3 = queue(t, 'stamps', '--ledger', path.join(t.dir, 'nosuch-LEDGER.md'));
  assert.equal(r3.code, 1, r3.out);
  assert.match(r3.out, /no ledger at /);
  assert.equal(queue(t, 'stamps', '--ledger').code, 2);
});

test("stamps from a linked worktree reads the main checkout's ledgers", () => {
  const t = repo();
  const wt = run('h-worktree', ['add', '009-01'], { cwd: t.root, env: t.env }).out.trim().split('\n').pop();
  assert.ok(fs.existsSync(wt), wt);
  ledgerAt(t, LED, [ENTRY, DONE1, ...RESULT]);
  const r = run('h-queue', ['stamps'], { cwd: wt, env: t.env });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, lineRe(MISSED));
});

test('an unreadable ledger is a line, not a crash', () => {
  const t = repo();
  fs.mkdirSync(path.join(t.root, '.planning/phases/001-x/001-09-LEDGER.md'), { recursive: true });
  ledgerAt(t, LED, [ENTRY, DONE1, ...RESULT]);
  const r = queue(t, 'stamps');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^unreadable: \.planning\/phases\/001-x\/001-09-LEDGER\.md: EISDIR$/m);
  assert.match(r.out, lineRe(MISSED));
  assert.match(r.out, /^stamps: 2 missed, 0 pending$/m);
});

test('no ledger prints stamps: none', () => {
  const t = repo();
  assert.equal(fs.existsSync(path.join(t.root, '.planning/phases')), false);
  const r = queue(t, 'stamps');
  assert.equal(r.code, 0, r.out);
  assert.equal(r.out, 'stamps: none\n');
});

test("the ledger template's stamp lines read through h-queue stamps", () => {
  const tpl = fs.readFileSync(path.join(__dirname, '..', 'templates', 'LEDGER-executor.md'), 'utf8');
  const t = repo();
  ledgerAt(t, LED, tpl);
  const r = queue(t, 'stamps');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^stamps: none$/m);
  assert.doesNotMatch(r.out, /unreadable/);
  ledgerAt(t, LED, tpl.split('\n').filter(l => !l.startsWith('stamped: ')).join('\n'));
  const r2 = queue(t, 'stamps');
  assert.equal(r2.out.split('\n').filter(l => l.startsWith('missed: ')).length, 1, r2.out);
  assert.match(r2.out, /^missed: \.planning\/phases\/001-x\/001-01-LEDGER\.md docs\/x\.md task 1: what was checked/m);
  assert.match(r2.out, /^stamps: 1 missed, 0 pending$/m);
});

test('admit reserves files: and never stamps:', () => {
  const t = repo({ concurrency: true });
  const f = writePlan(path.join(t.root, '.planning', 'phases', '001-x'), '001-01-PLAN.md', { files: ['a.txt'] });
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/^reads: \[\]$/m, 'reads: []\nstamps:\n  - docs/a.md'));
  const r = queue(t, 'admit', '001-01', '--kind', 'plan', '--owner', 'phase:001', '--plan', f);
  assert.equal(r.code, 0, r.out);
  const p = R.readRegistry(t.root).packages['001-01'];
  assert.deepEqual(p.writes, ['a.txt']);
  assert.deepEqual(p.declared, ['a.txt']);
});

const ST_LINE = 'stamps: 1 missed, 0 pending; h-queue stamps lists them';

test('status prints the stamps count with no registry', () => {
  const t = repo();
  ledgerAt(t, LED, [ENTRY, DONE1, ...RESULT]);
  ledgerAt(t, '.planning/phases/001-x/001-02-LEDGER.md', [ENTRY, DONE1]);
  const r = queue(t, 'status');
  assert.equal(r.code, 0, r.out);
  assert.equal(fs.existsSync(path.join(t.root, '.git', 'holden-registry.json')), false);
  assert.match(r.out, /^packages: none$/m);
  assert.match(r.out, /^stamps: 1 missed, 1 pending; h-queue stamps lists them$/m);
});

test('status --summary adds the stamps line, and only then', () => {
  const t = repo();
  ledgerAt(t, LED, [ENTRY, DONE1, ...RESULT]);
  const r = queue(t, 'status', '--summary');
  assert.equal(r.code, 0, r.out);
  assert.equal(r.out, `packages: none\n${ST_LINE}\n`);
  fs.appendFileSync(path.join(t.root, LED), 'stamped: docs/a.md 0a1b2c3\n');
  const r2 = queue(t, 'status', '--summary');
  assert.equal(r2.code, 0, r2.out);
  assert.equal(r2.out, 'packages: none\n');
});

test('status --json stays JSON with stamps to report', () => {
  const t = repo();
  ledgerAt(t, LED, [ENTRY, DONE1, ...RESULT]);
  const r = queue(t, 'status', '--json');
  assert.equal(r.code, 0, r.out);
  const j = JSON.parse(r.out);
  assert.ok(j.packages, r.out);
  assert.doesNotMatch(r.out, /stamps: /);
});

test('the stamps line comes after the packages and before recent:', () => {
  const t = repo({ concurrency: true });
  const a = queue(t, 'admit', '261021-q', '--kind', 'quick', '--owner', 'quick:261021-q', '--writes', 'a.txt');
  assert.equal(a.code, 0, a.out);
  ledgerAt(t, LED, [ENTRY, DONE1, ...RESULT]);
  const r = queue(t, 'status');
  assert.equal(r.code, 0, r.out);
  const ls = r.out.split('\n');
  const pkg = ls.findIndex(l => l.startsWith('261021-q ')), stamps = ls.indexOf(ST_LINE), recent = ls.indexOf('recent:');
  assert.ok(pkg >= 0 && stamps >= 0 && recent >= 0, r.out);
  assert.ok(pkg < stamps, r.out);
  assert.ok(stamps < recent, r.out);
});
