'use strict';
// bin/detach-orphans over a throwaway HOME.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');
const BIN = path.join(__dirname, '..', 'bin', 'detach-orphans');

function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'holden-orph-'));
  const R = path.join(home, '.claude', 'detached'), S = path.join(home, '.claude', 'sessions');
  fs.mkdirSync(R, { recursive: true }); fs.mkdirSync(S, { recursive: true });
  const run = (name, session, { out = 'answer\nEXIT 0\n', seen = false } = {}) => {
    fs.writeFileSync(path.join(R, `${name}.run`), `out=x\nsession=${session}\ncmd=x\n`);
    if (out !== null) fs.writeFileSync(path.join(R, `${name}.out`), out);
    if (seen) fs.writeFileSync(path.join(R, `${name}.seen`), '');
  };
  const session = (id, pid) => fs.writeFileSync(path.join(S, `${pid}.json`), JSON.stringify({ pid, sessionId: id }));
  const list = () => cp.spawnSync(BIN, [], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
  return { R, S, run, session, list };
}
const deadPid = () => { const c = cp.spawnSync('true'); return c.pid; };

test('a finished, unseen run whose session is gone is listed with its exit and output', () => {
  const t = setup();
  t.run('ask-a', 'gone', { out: 'EXIT 1 in a quote\nEXIT 5\n' });
  const r = t.list();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `ask-a: EXIT 5, its session is gone; read ${path.join(t.R, 'ask-a.out')}, then detach-seen ask-a\n`);
});

test('a live session, a seen run, an unfinished run and a run with no session are left out', () => {
  const t = setup();
  t.session('mine', process.pid);
  t.run('live', 'mine');
  t.run('seen', 'gone', { seen: true });
  t.run('running', 'gone', { out: 'still going\n' });
  t.run('nofile', 'gone', { out: null });
  t.run('old', '');
  assert.equal(t.list().stdout, '');
});

test('a session file whose pid is dead counts as gone', () => {
  const t = setup();
  t.session('dead', deadPid());
  t.run('ask-b', 'dead');
  assert.match(t.list().stdout, /^ask-b: EXIT 0/);
});

test('a pid reused by another process counts as gone; the session\'s own process counts as live', () => {
  const t = setup();
  const stat = fs.readFileSync(`/proc/${process.pid}/stat`, 'utf8');
  const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  const record = (id, procStart) => fs.writeFileSync(path.join(t.S, `${id}.json`), JSON.stringify({ pid: process.pid, sessionId: id, procStart }));
  record('reused', '1');
  record('same', start);
  t.run('ask-r', 'reused');
  t.run('ask-s', 'same');
  assert.match(t.list().stdout, /^ask-r: EXIT 0/);
  assert.ok(!t.list().stdout.includes('ask-s'));
});

test('no detached directory lists nothing', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'holden-orph-'));
  const r = cp.spawnSync(BIN, [], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});
