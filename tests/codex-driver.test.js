'use strict';
// bin/codex-driver against a scripted app-server and a fake tmux on PATH: no network, no Codex plan.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');
const DRIVER = path.join(__dirname, '..', 'bin', 'codex-driver');
const FAKE = path.join(__dirname, 'fixtures', 'fake-app-server.js');
const ID = '01a15563-0000-7000-8000-000000000001';
const FAKE_TMUX = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_TMUX_LOG"
case "$1" in
  new-window) case "$*" in *"-t codex:"*) [ -n "$FAKE_TMUX_SESSION" ] || { echo "can't find session" >&2; exit 1; } ;; esac; echo @7 ;;
  new-session) echo @8 ;;
esac
exit 0
`;

function setup() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'holden-drv-')));
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  fs.symlinkSync(FAKE, path.join(bin, 'codex'));
  fs.writeFileSync(path.join(bin, 'tmux'), FAKE_TMUX, { mode: 0o755 });
  const t = { dir, bin, log: path.join(dir, 'server.log'), tmux: path.join(dir, 'tmux.log'), pidf: path.join(dir, 'pid'), out: path.join(dir, 'answer.md'), idf: path.join(dir, 'id'), prompt: path.join(dir, 'q.md') };
  fs.writeFileSync(t.prompt, 'the question\n');
  t.env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_CODEX_LOG: t.log, FAKE_CODEX_PID: t.pidf, FAKE_TMUX_LOG: t.tmux };
  for (const k of ['TMUX', 'FAKE_CODEX', 'FAKE_TMUX_SESSION', 'FAKE_THREAD_ID']) delete t.env[k];
  return t;
}
const args = (t, more = []) => ['--cwd', t.dir, '--model', 'gpt-6-sol', '--effort', 'low', '--minutes', '1', '--prompt', t.prompt, '--out', t.out, '--id-file', t.idf, '--label', 'x', ...more];
function run(t, { mode = 'ok', env = {}, more = [] } = {}) {
  return new Promise(res => {
    const c = cp.spawn(DRIVER, args(t, more), { env: { ...t.env, FAKE_CODEX: mode, ...env } });
    let out = ''; c.stdout.on('data', b => out += b); c.stderr.on('data', b => out += b);
    c.on('close', (code, signal) => res({ code, signal, out }));
  });
}
const lines = f => fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean) : [];
const events = t => lines(t.log).map(l => JSON.parse(l));
const calls = (t, method) => events(t).filter(e => e.method === method);
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return false; } };
const pidOf = t => Number(fs.readFileSync(t.pidf, 'utf8'));
const until = async (f, ms = 8000) => { const s = Date.now(); while (Date.now() - s < ms) { if (f()) return true; await new Promise(r => setTimeout(r, 25)); } return false; };

test('a fresh round starts a read-only thread and writes the final message, leaving no server', async () => {
  const t = setup();
  const r = await run(t);
  assert.equal(r.code, 0, r.out);
  assert.equal(fs.readFileSync(t.out, 'utf8'), 'answer 1\n');
  assert.equal(fs.readFileSync(t.idf, 'utf8'), ID + '\n');
  const [th] = calls(t, 'thread/start'), [tu] = calls(t, 'turn/start');
  assert.deepEqual(th.params, { cwd: t.dir, sandbox: 'read-only', approvalPolicy: 'never', model: 'gpt-6-sol', ephemeral: false });
  assert.equal(th.cwd, t.dir);
  assert.equal(tu.params.effort, 'low');
  assert.equal(tu.params.approvalPolicy, 'never');
  assert.deepEqual(tu.params.sandboxPolicy, { type: 'readOnly', networkAccess: false });
  assert.equal(tu.params.input[0].text, 'the question\n');
  assert.ok(!alive(pidOf(t)));
  assert.match(r.out, new RegExp(`^thread: ${ID}$`, 'm'));
});

test('--thread resumes by id on a fresh server', async () => {
  const t = setup();
  const r = await run(t, { more: ['--thread', ID] });
  assert.equal(r.code, 0, r.out);
  assert.equal(calls(t, 'thread/start').length, 0);
  assert.deepEqual(calls(t, 'thread/resume')[0].params, { cwd: t.dir, sandbox: 'read-only', approvalPolicy: 'never', model: 'gpt-6-sol', threadId: ID });
});

test('a resume that lands in another thread publishes nothing', async () => {
  const t = setup();
  const r = await run(t, { mode: 'otherid', more: ['--thread', ID] });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /not 01a15563/);
  assert.ok(!fs.existsSync(t.out));
});

test("only this turn's final_answer is the answer, not commentary or the server's own thread", async () => {
  const t = setup();
  const r = await run(t, { mode: 'commentary' });
  assert.equal(r.code, 0, r.out);
  assert.equal(fs.readFileSync(t.out, 'utf8'), 'answer 1\n');
});

test('a turn that ends before turn/start answers is still seen', async () => {
  const t = setup();
  const r = await run(t, { mode: 'early' });
  assert.equal(r.code, 0, r.out);
  assert.equal(fs.readFileSync(t.out, 'utf8'), 'answer 1\n');
});

test('a request from the server is declined, so the turn is not left waiting', async () => {
  const t = setup();
  const r = await run(t, { mode: 'request' });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /server request declined: item\/commandExecution\/requestApproval/);
});

for (const [mode, why] of [['interrupted', /ended interrupted/], ['failed', /ended failed.*model refused/], ['empty', /no final message/], ['noanswer', /no final message/]]) {
  test(`a turn scripted ${mode} publishes nothing and fails the round`, async () => {
    const t = setup();
    const r = await run(t, { mode });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, why);
    assert.ok(!fs.existsSync(t.out));
    assert.ok(!alive(pidOf(t)));
  });
}

test('a server that fails to start fails the round and names its output', async () => {
  const t = setup();
  const r = await run(t, { mode: 'nostart' });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /server exited/);
  assert.match(r.out, /address in use/);
  assert.ok(!fs.existsSync(t.out));
});

test('a server that dies during turn/start fails the round', async () => {
  const t = setup();
  const r = await run(t, { mode: 'die' });
  assert.equal(r.code, 1, r.out);
  assert.ok(!fs.existsSync(t.out));
});

test('a server that dies mid-turn fails the round and closes the view', async () => {
  const t = setup();
  const r = await run(t, { mode: 'dielater' });
  assert.equal(r.code, 1, r.out);
  assert.ok(!fs.existsSync(t.out));
  assert.ok(lines(t.tmux).some(l => l.startsWith('kill-window')), lines(t.tmux).join('\n'));
});

test('the wall clock interrupts the turn, publishes nothing and exits 124', async () => {
  const t = setup();
  const r = await run(t, { mode: 'hang', more: ['--minutes', '0.01'] });
  assert.equal(r.code, 124, r.out);
  assert.equal(calls(t, 'turn/interrupt').length, 1);
  assert.deepEqual(calls(t, 'turn/interrupt')[0].params, { threadId: ID, turnId: 'turn-1' });
  assert.ok(!fs.existsSync(t.out));
  assert.ok(!alive(pidOf(t)));
});

test('a turn known only from turn/started is still interrupted at the wall clock', async () => {
  const t = setup();
  const r = await run(t, { mode: 'noreply', more: ['--minutes', '0.01'] });
  assert.equal(r.code, 124, r.out);
  assert.deepEqual(calls(t, 'turn/interrupt').map(c => c.params), [{ threadId: ID, turnId: 'turn-1' }]);
  assert.ok(!alive(pidOf(t)));
});

test('a stalled tmux delays neither the answer nor the teardown', async () => {
  const t = setup();
  fs.writeFileSync(path.join(t.bin, 'tmux'), '#!/bin/sh\nexec sleep 60\n', { mode: 0o755 });
  const start = Date.now();
  const r = await run(t, { env: { TMUX: '/tmp/x,1,0' } });
  assert.equal(r.code, 0, r.out);
  assert.equal(fs.readFileSync(t.out, 'utf8'), 'answer 1\n');
  assert.ok(!alive(pidOf(t)));
  assert.ok(Date.now() - start < 12000, `took ${Date.now() - start} ms`);
});

test('a stalled tmux does not hold the wall clock or a signal back', async () => {
  const t = setup();
  fs.writeFileSync(path.join(t.bin, 'tmux'), '#!/bin/sh\nexec sleep 60\n', { mode: 0o755 });
  const start = Date.now();
  const r = await run(t, { mode: 'deaf', env: { TMUX: '/tmp/x,1,0' }, more: ['--minutes', '0.01'] });
  assert.equal(r.code, 124, r.out);
  assert.ok(events(t).some(e => e.method === 'turn/interrupt' || e.signal === 'SIGTERM'));
  assert.ok(!alive(pidOf(t)));
  assert.ok(Date.now() - start < 12000, `took ${Date.now() - start} ms`);
});

test('a server that ignores the interrupt and the SIGTERM is SIGKILLed', async () => {
  const t = setup();
  const start = Date.now();
  const r = await run(t, { mode: 'deaf', more: ['--minutes', '0.01'] });
  assert.equal(r.code, 124, r.out);
  assert.ok(events(t).some(e => e.signal === 'SIGTERM' && e.running), 'the SIGTERM found the turn running');
  assert.ok(!alive(pidOf(t)));
  assert.ok(Date.now() - start < 8000);
});

for (const [sig, code] of [['SIGTERM', 143], ['SIGINT', 130], ['SIGHUP', 129]]) {
  test(`${sig} tears the round down and exits ${code}`, async () => {
    const t = setup();
    const c = cp.spawn(DRIVER, args(t), { env: { ...t.env, FAKE_CODEX: 'deaf' } });
    let out = ''; c.stdout.on('data', b => out += b); c.stderr.on('data', b => out += b);
    assert.ok(await until(() => lines(t.tmux).length > 0), 'the turn started');
    c.kill(sig);
    const [rc] = await new Promise(res => c.on('close', (...a) => res(a)));
    assert.equal(rc, code, out);
    assert.ok(!alive(pidOf(t)));
    assert.ok(lines(t.tmux).some(l => l.startsWith('kill-window')));
    assert.ok(!fs.existsSync(t.out));
  });
}

test('a driver killed outright takes its server along', async () => {
  const t = setup();
  const c = cp.spawn(DRIVER, args(t), { env: { ...t.env, FAKE_CODEX: 'deaf' }, stdio: 'ignore' });
  assert.ok(await until(() => lines(t.tmux).length > 0), 'the turn started');
  const pid = pidOf(t);
  assert.ok(alive(pid));
  c.kill('SIGKILL');
  assert.ok(await until(() => !alive(pid)), 'the server died with the driver');
});

test('inside tmux the view is a background window, closed when the round ends', async () => {
  const t = setup();
  const r = await run(t, { env: { TMUX: '/tmp/x,1,0' } });
  assert.equal(r.code, 0, r.out);
  const l = lines(t.tmux);
  assert.equal(l.length, 2, l.join('\n'));
  assert.match(l[0], /^new-window -d -P -F #\{window_id\} -n codex-x -c /);
  assert.ok(!l[0].includes('-t codex:'));
  assert.ok(l[0].includes(`resume ${ID} --remote ws://127.0.0.1:`) && l[0].includes('-c check_for_update_on_startup=false'));
  assert.equal(l[1], 'kill-window -t @7');
});

test('outside tmux the first round makes the codex session', async () => {
  const t = setup();
  const r = await run(t);
  assert.equal(r.code, 0, r.out);
  const l = lines(t.tmux);
  assert.match(l[0], /^new-window -d .* -t codex: /);
  assert.match(l[1], /^new-session -d -s codex /);
  assert.equal(l[2], 'kill-window -t @8');
  assert.match(r.out, /^view: tmux attach -t codex/m);
});

test('outside tmux a later round takes a window in the codex session', async () => {
  const t = setup();
  const r = await run(t, { env: { FAKE_TMUX_SESSION: '1' } });
  assert.equal(r.code, 0, r.out);
  assert.ok(!lines(t.tmux).some(l => l.startsWith('new-session')));
});

test('with no tmux the round still runs and prints the watch command', async () => {
  const t = setup();
  fs.unlinkSync(path.join(t.bin, 'tmux'));
  const dirs = t.env.PATH.split(':').filter(d => !fs.existsSync(path.join(d, 'tmux')));
  for (const [name, target] of [['node', process.execPath], ['setpriv', cp.execSync('command -v setpriv', { encoding: 'utf8' }).trim()]]) fs.symlinkSync(target, path.join(t.bin, name));
  const r = await run(t, { env: { PATH: dirs.join(':') } });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^watch: .* resume /m);
  assert.match(r.out, /tmux is not installed/);
});

test('a tmux that refuses does not fail the round', async () => {
  const t = setup();
  fs.writeFileSync(path.join(t.bin, 'tmux'), '#!/bin/sh\necho nope >&2\nexit 1\n', { mode: 0o755 });
  const r = await run(t, { env: { TMUX: '/tmp/x,1,0' } });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /tmux refused \(nope\)/);
});

test('a different Codex version warns and runs', async () => {
  const t = setup();
  const r = await run(t, { mode: 'oldversion' });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^warning: codex 0\.150 runs here, this driver was built against 0\.166$/m);
  assert.equal((await run(setup())).out.includes('warning:'), false);
});

test('no setpriv refuses before any server starts', async () => {
  const t = setup();
  const dirs = t.env.PATH.split(':').filter(d => !fs.existsSync(path.join(d, 'setpriv')));
  fs.symlinkSync(process.execPath, path.join(t.bin, 'node'));
  const r = await run(t, { env: { PATH: dirs.join(':') } });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /setpriv is not on PATH/);
  assert.ok(!fs.existsSync(t.pidf));
});

test('the dry run prints the launch and the planned requests and starts nothing', async () => {
  const t = setup();
  const r = await run(t, { more: ['--dry-run'] });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^### server: setpriv --pdeathsig KILL codex app-server --listen ws:\/\/127\.0\.0\.1:<port>$/m);
  assert.match(r.out, /^### thread\/start: \{.*"sandbox":"read-only".*"approvalPolicy":"never"/m);
  assert.match(r.out, /^### turn\/start: \{.*"effort":"low"/m);
  assert.ok(!fs.existsSync(t.pidf));
});
