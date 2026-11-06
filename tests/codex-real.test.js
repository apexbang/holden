'use strict';
// bin/codex-driver against the installed Codex CLI: real turns on the Codex plan, so it is off unless
// HOLDEN_REAL_CODEX=1, and is run by hand before a landing. It checks the protocol the fake app-server
// stands in for, and that no process outlives a round however it ends.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');
const DRIVER = path.join(__dirname, '..', 'bin', 'codex-driver');
const skip = process.env.HOLDEN_REAL_CODEX === '1' ? false : 'set HOLDEN_REAL_CODEX=1';
const wait = ms => new Promise(r => setTimeout(r, ms));

function setup(seconds) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'holden-real-')));
  cp.execSync('git init -q', { cwd: dir });
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'tmux'), '#!/bin/sh\ncase "$1" in new-*) echo @7 ;; esac\n', { mode: 0o755 });
  const marker = `${seconds}.${process.pid % 1000}`;
  const q = path.join(dir, 'q.md'), out = path.join(dir, 'a.md');
  fs.writeFileSync(q, `Run exactly this one shell command, once, with no other commands: sleep ${marker} ; echo finished\nThen reply with the single word DONE.\n`);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` }; delete env.TMUX;
  const args = ['--cwd', dir, '--model', 'gpt-6-sol', '--effort', 'low', '--minutes', '4', '--prompt', q, '--out', out];
  return { marker, out, args, env };
}
function rows() {
  return cp.spawnSync('ps', ['-eo', 'pid=,ppid=,args='], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean)
    .map(l => { const m = l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/); return { pid: +m[1], ppid: +m[2], args: m[3] }; });
}
function tree(root) {
  const all = rows(), seen = new Set([root]);
  for (let grew = true; grew;) { grew = false; for (const r of all) if (seen.has(r.ppid) && !seen.has(r.pid)) { seen.add(r.pid); grew = true; } }
  return all.filter(r => seen.has(r.pid) && r.pid !== root).map(r => r.pid);
}
const alive = pids => cp.spawnSync('ps', ['-o', 'pid=', '-p', pids.join(',')], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean);
async function untilRunning(t, c) {
  for (const end = Date.now() + 90000; Date.now() < end; await wait(500)) {
    const pids = tree(c.pid);
    if (rows().some(r => pids.includes(r.pid) && r.args.startsWith(`sleep ${t.marker}`))) return pids;
  }
  throw new Error('the command never ran');
}
async function gone(pids, ms) { for (const end = Date.now() + ms; Date.now() < end; await wait(250)) if (!alive(pids).length) return true; return false; }

test('a real turn answers and leaves nothing', { skip }, async () => {
  const t = setup(5);
  const c = cp.spawn(DRIVER, t.args, { env: t.env, stdio: 'ignore' });
  const pids = await untilRunning(t, c);
  assert.ok(pids.length >= 4, `a turn has a tree, saw ${pids.length}`);
  const code = await new Promise(r => c.on('close', r));
  assert.equal(code, 0);
  assert.match(fs.readFileSync(t.out, 'utf8'), /DONE/);
  assert.ok(await gone(pids, 5000), alive(pids).join(' '));
});

for (const [name, sig, code] of [['SIGTERM', 'SIGTERM', 143], ['SIGINT', 'SIGINT', 130]]) {
  test(`${name} mid-turn leaves nothing and publishes nothing`, { skip }, async () => {
    const t = setup(120);
    const c = cp.spawn(DRIVER, t.args, { env: t.env, stdio: 'ignore' });
    const pids = await untilRunning(t, c);
    c.kill(sig);
    assert.equal(await new Promise(r => c.on('close', r)), code);
    assert.ok(await gone(pids, 8000), alive(pids).join(' '));
    assert.ok(!fs.existsSync(t.out));
  });
}

test('a driver killed outright mid-turn leaves nothing', { skip }, async () => {
  const t = setup(120);
  const c = cp.spawn(DRIVER, t.args, { env: t.env, stdio: 'ignore' });
  const pids = await untilRunning(t, c);
  c.kill('SIGKILL');
  assert.ok(await gone(pids, 8000), alive(pids).join(' '));
});
