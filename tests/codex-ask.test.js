'use strict';
// bin/codex-ask against a scripted app-server, a fake tmux and a fake codex-limits: no network, no Codex plan.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path'), cp = require('child_process');
const { makeRepo, sh } = require('./fixtures/repo.js');
const BIN = path.join(__dirname, '..', 'bin'), ASK = path.join(BIN, 'codex-ask');
const ID = '01a15563-0000-7000-8000-000000000001';
const FAKE_SERVER = path.join(__dirname, 'fixtures', 'fake-app-server.js');
const FAKE_TMUX = '#!/bin/sh\ncase "$1" in new-*) echo @7 ;; esac\n';
const FAKE_LIMITS = '#!/bin/sh\nif [ "$1" = --check ]; then echo "${FAKE_LIMITS_LINE:-ok: codex plus}"; exit ${FAKE_LIMITS_RC:-0}; fi\necho "codex plus"\n';
function setup() {
  const t = makeRepo();
  const fake = path.join(t.dir, 'fakebin'); fs.mkdirSync(fake);
  fs.symlinkSync(FAKE_SERVER, path.join(fake, 'codex'));
  fs.writeFileSync(path.join(fake, 'tmux'), FAKE_TMUX, { mode: 0o755 });
  fs.writeFileSync(path.join(fake, 'codex-limits'), FAKE_LIMITS, { mode: 0o755 });
  t.q = path.join(t.dir, 'q.md'); fs.writeFileSync(t.q, 'Should the guard match positional questions?\n');
  t.log = path.join(t.dir, 'codex.log');
  t.env = { ...t.env, PATH: fake + ':' + process.env.PATH, FAKE_CODEX_LOG: t.log, CODEX_ASK_LIMITS: path.join(fake, 'codex-limits') };
  for (const k of ['CODEX_ASK_SKIP_LIMITS', 'FAKE_CODEX', 'FAKE_LIMITS_RC', 'FAKE_LIMITS_LINE', 'TMUX']) delete t.env[k];
  t.base = path.join(t.root, '.holden', 'codex-ask');
  return t;
}
function ask(t, args, { cwd = t.root, env = {} } = {}) {
  const r = cp.spawnSync(ASK, args, { cwd, env: { ...t.env, ...env }, encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
const requests = (t, method) => fs.existsSync(t.log) ? fs.readFileSync(t.log, 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(e => e.method === method) : [];
// One turn per round that reached Codex.
const calls = t => requests(t, 'turn/start');
const sent = c => c.params.input[0].text;
const slugs = t => fs.existsSync(t.base) ? fs.readdirSync(t.base).filter(n => !n.startsWith('.')).sort() : [];
const slugOf = r => (r.out.match(/^slug: (\S+) round \d+$/m) || [])[1];
const read = f => fs.readFileSync(f, 'utf8');
function first(t, opts) {
  const r = ask(t, ['--file', t.q], opts);
  assert.equal(r.code, 0, r.out);
  const slug = slugOf(r); assert.ok(slug, r.out);
  return { r, slug, dir: path.join(t.base, slug) };
}
function followUp(t, slug, opts) {
  const f = path.join(t.dir, 'f.md');
  if (!fs.existsSync(f)) fs.writeFileSync(f, 'And the second case?\n');
  return ask(t, ['--continue', slug, '--file', f], opts);
}

test('a first call runs a read-only thread with the consult bounds and saves the conversation id', () => {
  const t = setup();
  const r = ask(t, ['--file', t.q]);
  assert.equal(r.code, 0, r.out);
  const c = calls(t);
  assert.equal(c.length, 1);
  assert.deepEqual(requests(t, 'thread/start')[0].params, { cwd: t.root, sandbox: 'read-only', approvalPolicy: 'never', model: 'gpt-6-sol', ephemeral: false });
  assert.equal(c[0].params.effort, 'medium');
  const s = slugs(t);
  assert.equal(s.length, 1);
  assert.match(s[0], /^\d{4}-\d{2}-\d{2}-should-the-guard-match-positional-questions$/);
  const dir = path.join(t.base, s[0]);
  assert.equal(read(path.join(dir, 'session')), `id=${ID}\nmodel=gpt-6-sol\neffort=medium\nminutes=15\nroot=${t.root}\n`);
  assert.equal(read(path.join(dir, 'A-r1.md')), 'answer 1\n');
  const q1 = read(path.join(dir, 'Q-r1.md'));
  assert.equal(q1, sent(c[0]));
  assert.ok(q1.includes('Should the guard match positional questions?'));
  assert.ok(q1.includes('about 15 minutes of wall clock'));
  assert.ok(q1.includes('Do not run test suites'));
  assert.match(r.out, /^answer: .*\/A-r1\.md$/m);
  assert.match(r.out, /^slug: \S+ round 1$/m);
  assert.match(r.out, /^watch: .* resume /m);
});

test('a consult may propose a thread and ask back, and has no read count', () => {
  const t = setup();
  for (const flags of [[], ['--sheet']]) {
    const r = ask(t, [...flags, '--dry-run', '--file', t.q]);
    assert.equal(r.code, 0, r.out);
    assert.ok(r.out.includes('## Thread to follow'));
    assert.ok(r.out.includes('## Questions back'));
    assert.ok(r.out.includes('Do not follow it yet'));
    assert.ok(!/file reads/.test(r.out));
    assert.ok(!r.out.includes('Do not ask questions'));
  }
});

test('the dry run prints the wall clock and the planned requests and writes nothing', () => {
  const t = setup();
  const r = ask(t, ['--dry-run', '--file', t.q]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^### wall clock: 15 min/m);
  assert.match(r.out, /^### server: setpriv --pdeathsig KILL codex app-server/m);
  assert.match(r.out, /^### thread\/start: .*"sandbox":"read-only"/m);
  assert.ok(!fs.existsSync(t.base));
  assert.deepEqual(calls(t), []);
});

test('a killed codex-ask takes its driver and server along', async () => {
  const t = setup();
  const pidf = path.join(t.dir, 'server.pid');
  const c = cp.spawn(ASK, ['--file', t.q], { cwd: t.root, env: { ...t.env, FAKE_CODEX: 'deaf', FAKE_CODEX_PID: pidf }, stdio: 'ignore' });
  const until = async f => { for (const end = Date.now() + 8000; Date.now() < end; await new Promise(r => setTimeout(r, 25))) if (f()) return true; return false; };
  assert.ok(await until(() => calls(t).length === 1), 'the turn started');
  const pid = Number(read(pidf));
  c.kill('SIGKILL');
  const dead = () => { try { process.kill(pid, 0); return false; } catch (e) { return true; } };
  assert.ok(await until(dead), 'the server is gone');
  assert.ok(!fs.existsSync(path.join(t.base, slugs(t)[0], 'A-r1.md')));
});

test('--model and --effort override the defaults', () => {
  const t = setup();
  const r = ask(t, ['--model', 'gpt-6-astra', '--effort', 'low', '--file', t.q]);
  assert.equal(r.code, 0, r.out);
  const c = calls(t)[0];
  assert.equal(c.params.model, 'gpt-6-astra');
  assert.equal(requests(t, 'thread/start')[0].params.model, 'gpt-6-astra');
  assert.equal(c.params.effort, 'low');
  const session = read(path.join(t.base, slugOf(r), 'session'));
  assert.match(session, /^model=gpt-6-astra$/m);
  assert.match(session, /^effort=low$/m);
});

test('a question asked from a subdirectory runs Codex at the repository root', () => {
  const t = setup();
  const sub = path.join(t.root, 'sub'); fs.mkdirSync(sub);
  const r = ask(t, ['--file', t.q], { cwd: sub });
  assert.equal(r.code, 0, r.out);
  const call = calls(t)[0];
  assert.equal(call.cwd, t.root);
  assert.equal(call.params.cwd, t.root);
});

test('limits not ok exits 5 before any codex run', () => {
  const t = setup();
  for (const [rc, line] of [['1', 'unreadable: x'], ['3', 'exhausted: x'], ['4', 'no-plan: x']]) {
    const r = ask(t, ['--file', t.q], { env: { FAKE_LIMITS_RC: rc, FAKE_LIMITS_LINE: line } });
    assert.equal(r.code, 5, `${rc}: ${r.out}`);
    assert.match(r.out, /codex unavailable/);
    assert.deepEqual(calls(t), []);
    assert.ok(!fs.existsSync(t.base));
  }
  const gone = ask(t, ['--file', t.q], { env: { CODEX_ASK_LIMITS: path.join(t.dir, 'no-such-limits') } });
  assert.equal(gone.code, 5, gone.out);
  assert.match(gone.out, /codex unavailable/);
  assert.deepEqual(calls(t), []);
  assert.ok(!fs.existsSync(t.base));

  const { slug, dir } = first(t);
  const r = followUp(t, slug, { env: { FAKE_LIMITS_RC: '3', FAKE_LIMITS_LINE: 'exhausted: x' } });
  assert.equal(r.code, 5, r.out);
  assert.equal(calls(t).length, 1);
  assert.ok(!fs.existsSync(path.join(dir, 'Q-r2.md')));

  const skip = ask(t, ['--file', t.q], { env: { CODEX_ASK_SKIP_LIMITS: '1', FAKE_LIMITS_RC: '3' } });
  assert.equal(skip.code, 0, skip.out);
});

test('a failed codex run publishes no answer and no session', () => {
  const t = setup();
  const r = ask(t, ['--file', t.q], { env: { FAKE_CODEX: 'failed' } });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /codex failed \(exit 1\)/);
  const s = slugs(t);
  assert.equal(s.length, 1);
  assert.deepEqual(fs.readdirSync(path.join(t.base, s[0])), ['Q-r1.md']);
});

test('an empty answer is not published', () => {
  const t = setup();
  const r = ask(t, ['--file', t.q], { env: { FAKE_CODEX: 'empty' } });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /no final message/);
  const dir = path.join(t.base, slugs(t)[0]);
  assert.ok(!fs.existsSync(path.join(dir, 'A-r1.md')));
  assert.ok(!fs.existsSync(path.join(dir, 'session')));
});

test('a first call with no thread id publishes nothing', () => {
  const t = setup();
  const r = ask(t, ['--file', t.q], { env: { FAKE_CODEX: 'noid' } });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /no thread id/);
  const dir = path.join(t.base, slugs(t)[0]);
  assert.ok(!fs.existsSync(path.join(dir, 'A-r1.md')));
  assert.ok(!fs.existsSync(path.join(dir, 'session')));
});

test('a made slug that exists takes a suffix; a given slug that exists is refused', () => {
  const t = setup();
  const a = first(t), b = first(t);
  const s = slugs(t);
  assert.equal(s.length, 2);
  assert.equal(b.slug, a.slug + '-2');
  for (const n of s) assert.ok(fs.existsSync(path.join(t.base, n, 'session')), n);
  const g = ask(t, ['--slug', 'x1', '--file', t.q]);
  assert.equal(g.code, 0, g.out);
  const again = ask(t, ['--slug', 'x1', '--file', t.q]);
  assert.equal(again.code, 2, again.out);
  assert.match(again.out, /refusing: consult 'x1' exists; a follow-up is --continue x1/);
  assert.equal(read(path.join(t.base, 'x1', 'A-r1.md')), 'answer 3\n');
  assert.equal(calls(t).length, 3);
});

test('a bad slug, a missing question or a call outside a repository is refused', () => {
  const t = setup();
  const empty = path.join(t.dir, 'empty.md'); fs.writeFileSync(empty, '');
  const blank = path.join(t.dir, 'blank.md'); fs.writeFileSync(blank, '\n \t\n');
  const cases = [
    [['--slug', '../x', '--file', t.q]],
    [['--slug', '.work', '--file', t.q]],
    [['--slug', 'X', '--file', t.q]],
    [['--file', path.join(t.dir, 'missing.md')]],
    [['--file', empty]],
    [['--file', blank], /no question/],
    [['--file', t.dir], /no question/],
    [['--slug', 'y']],
    [['--continue', 'a', '--slug', 'b', '--file', t.q], /--continue takes no --slug/],
    [['--file', t.q], /inside a git repository/, { cwd: t.dir }],
  ];
  for (const [args, re, opts] of cases) {
    const r = ask(t, args, opts);
    assert.equal(r.code, 1, `${args.join(' ')}: ${r.out}`);
    if (re) assert.match(r.out, re);
  }
  assert.deepEqual(calls(t), []);
  assert.ok(!fs.existsSync(path.join(t.root, '.holden', 'x')));
  assert.ok(!fs.existsSync(t.base));
});

test('--continue resumes by the saved id with the saved model, effort and read-only sandbox', () => {
  const t = setup();
  const { slug, dir } = first(t);
  const r = followUp(t, slug);
  assert.equal(r.code, 0, r.out);
  const c = calls(t)[1];
  assert.deepEqual(requests(t, 'thread/resume')[0].params, { cwd: t.root, sandbox: 'read-only', approvalPolicy: 'never', model: 'gpt-6-sol', threadId: ID });
  assert.equal(c.params.effort, 'medium');
  assert.equal(c.params.threadId, ID);
  assert.equal(sent(c), 'And the second case?\n');
  assert.equal(read(path.join(dir, 'A-r2.md')), 'answer 2\n');
  assert.match(r.out, /^slug: \S+ round 2$/m);
});

test('--continue from a subdirectory runs Codex in the saved root', () => {
  const t = setup();
  const { slug } = first(t);
  const sub = path.join(t.root, 'sub'); fs.mkdirSync(sub);
  const r = followUp(t, slug, { cwd: sub });
  assert.equal(r.code, 0, r.out);
  assert.equal(calls(t)[1].cwd, t.root);
  assert.equal(calls(t)[1].params.cwd, t.root);
});

test('rounds count up past a failed round and a hand-made answer, and nothing is overwritten', () => {
  const t = setup();
  const { slug, dir } = first(t);
  const p = n => path.join(dir, n);
  const session = read(p('session'));
  const r2 = followUp(t, slug, { env: { FAKE_CODEX: 'failed' } });
  assert.equal(r2.code, 1, r2.out);
  assert.ok(fs.existsSync(p('Q-r2.md')));
  assert.ok(!fs.existsSync(p('A-r2.md')));
  const r3 = followUp(t, slug);
  assert.equal(r3.code, 0, r3.out);
  assert.equal(read(p('A-r3.md')), 'answer 3\n');
  fs.writeFileSync(p('A-r5.md'), 'hand\n');
  const r6 = followUp(t, slug);
  assert.equal(r6.code, 0, r6.out);
  assert.ok(fs.existsSync(p('Q-r6.md')));
  assert.ok(fs.existsSync(p('A-r6.md')));
  assert.equal(read(p('A-r5.md')), 'hand\n');
  assert.equal(read(p('A-r1.md')), 'answer 1\n');
  assert.equal(read(p('session')), session);
});

test('--continue of a consult with no session file refuses without running codex', () => {
  const t = setup();
  const f = ask(t, ['--file', t.q], { env: { FAKE_CODEX: 'failed' } });
  assert.equal(f.code, 1, f.out);
  const r = followUp(t, slugs(t)[0]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /has no session file/);
  assert.equal(calls(t).length, 1);
});

test('--continue of an unknown slug refuses', () => {
  const t = setup();
  const r = followUp(t, 'nope');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /no consult 'nope'/);
  assert.deepEqual(calls(t), []);
});

test('a session file with a bad key refuses', () => {
  const t = setup();
  const { slug, dir } = first(t);
  const file = path.join(dir, 'session'), good = read(file);
  for (const [key, value] of [['id', 'zz'], ['model', 'a b'], ['effort', 'HIGH'], ['minutes', '0'], ['root', t.dir + '/gone']]) {
    fs.writeFileSync(file, good.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`));
    const r = followUp(t, slug);
    assert.equal(r.code, 1, `${key}: ${r.out}`);
    assert.match(r.out, new RegExp('unreadable session file .*: ' + key));
    assert.equal(calls(t).length, 1);
  }
});

test('a resume answering in another thread publishes nothing', () => {
  const t = setup();
  const { slug, dir } = first(t);
  const r = followUp(t, slug, { env: { FAKE_CODEX: 'otherid' } });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /not 01a15563/);
  assert.ok(fs.existsSync(path.join(dir, 'Q-r2.md')));
  assert.ok(!fs.existsSync(path.join(dir, 'A-r2.md')));
});

test('a consult from a linked worktree records under the main checkout', () => {
  const t = setup();
  sh('git worktree add -q ../wt -b wt', t.root, t.env);
  const wt = path.join(t.dir, 'wt');
  const r = ask(t, ['--file', t.q], { cwd: wt });
  assert.equal(r.code, 0, r.out);
  const s = slugs(t);
  assert.equal(s.length, 1);
  assert.ok(!fs.existsSync(path.join(wt, '.holden', 'codex-ask')));
  assert.equal(calls(t)[0].params.cwd, wt);
  assert.match(read(path.join(t.base, s[0], 'session')), new RegExp(`^root=${wt}$`, 'm'));
});

test('codex-ask runs through bin/detach as a launch from a session does', async () => {
  const t = setup();
  const home = path.join(t.dir, 'home');
  const d = cp.spawnSync(path.join(BIN, 'detach'), ['ask-t', ASK + ' --file ' + t.q], { cwd: t.root, env: { ...t.env, HOME: home }, encoding: 'utf8' });
  assert.equal(d.status, 0, (d.stdout || '') + (d.stderr || ''));
  const out = path.join(home, '.claude', 'detached', 'ask-t.out');
  let text = '';
  for (const end = Date.now() + 20000; Date.now() < end; await new Promise(r => setTimeout(r, 200))) {
    text = fs.existsSync(out) ? read(out) : '';
    if (/^EXIT \d+$/m.test(text)) break;
  }
  assert.match(text, /^EXIT 0$/m);
  assert.match(text, /^answer: .*\/A-r1\.md$/m);
  assert.equal(sent(calls(t)[0]), read(path.join(t.base, slugs(t)[0], 'Q-r1.md')));
});

test('--sheet runs at high effort for 25 minutes and sends templates/answer-sheet.md', () => {
  const t = setup();
  const r = ask(t, ['--sheet', '--slug', 'g1', '--file', t.q]);
  assert.equal(r.code, 0, r.out);
  const c = calls(t)[0];
  assert.equal(c.params.effort, 'high');
  const session = read(path.join(t.base, 'g1', 'session'));
  assert.match(session, /^effort=high$/m);
  assert.match(session, /^minutes=25$/m);
  const tpl = read(path.join(__dirname, '..', 'templates', 'answer-sheet.md')).replace(/\n$/, '');
  assert.ok(sent(c).includes(tpl));
  assert.ok(sent(c).includes('## The decision list\nShould the guard'));
  assert.ok(sent(c).includes('Read ## Settled as context'));
  const d = ask(t, ['--sheet', '--dry-run', '--file', t.q]);
  assert.equal(d.code, 0, d.out);
  assert.match(d.out, /^### wall clock: 25 min/m);
});

test('--sheet with --effort keeps 25 minutes', () => {
  const t = setup();
  const r = ask(t, ['--sheet', '--effort', 'medium', '--file', t.q]);
  assert.equal(r.code, 0, r.out);
  const session = read(path.join(t.base, slugOf(r), 'session'));
  assert.match(session, /^effort=medium$/m);
  assert.match(session, /^minutes=25$/m);
});

test('--continue takes no --sheet', () => {
  const t = setup();
  const r = ask(t, ['--continue', 'x', '--sheet', '--file', t.q]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /--continue takes no --slug or --sheet/);
});

test('a follow-up on a sheet keeps 25 minutes and high effort', () => {
  const t = setup();
  const r = ask(t, ['--sheet', '--file', t.q]);
  assert.equal(r.code, 0, r.out);
  const f = path.join(t.dir, 'f.md'); fs.writeFileSync(f, 'And D02?\n');
  const d = ask(t, ['--continue', slugOf(r), '--dry-run', '--file', f]);
  assert.equal(d.code, 0, d.out);
  assert.match(d.out, /^### wall clock: 25 min/m);
  assert.match(d.out, /^### thread\/resume: /m);
  assert.match(d.out, /^### turn\/start: .*"effort":"high"/m);
});

test('the view window has a short name, whatever the slug', () => {
  const t = setup();
  const r = ask(t, ['--slug', 'a-rather-long-slug-for-a-window', '--file', t.q], { env: { TMUX: '/tmp/x,1,0' } });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^view: tmux window @7 \(codex-ask-r1\)$/m);
});
