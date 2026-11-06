'use strict';
// Phase 001 plan 4 Task 3: the statusline's queue block (D13) replaces the next-command cell.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path'), os = require('os');
const { makeRepo } = require('./fixtures/repo.js');
const R = require('../lib/registry.js');
const { render } = require('../hooks/holden-statusline.js');

const HOUR = 3600 * 1000;
const iso = ms => new Date(Date.now() - ms).toISOString();
const out = dir => render({ workspace: { current_dir: dir }, model: { display_name: 'x' } }).replace(/\x1b\[[0-9;]*m/g, '');
function writeRegistry(root, packages) {
  fs.writeFileSync(R.paths(root).registry, JSON.stringify({ ...R.emptyRegistry(), packages: Object.fromEntries(packages.map(p => [p.id, p])) }));
}
const pkg = (id, state, { heartbeat = iso(0), since = iso(0), transcript = null } = {}) => ({ id, state, heartbeat, since, transcript, writes: [] });

test('the queue block counts running, parked and warn', () => {
  const t = makeRepo();
  writeRegistry(t.root, [pkg('001-01', 'admitted'), pkg('001-02', 'admitted'), pkg('261018-q', 'parked'),
    pkg('001-03', 'admitted', { heartbeat: iso(2 * HOUR) }), pkg('001-04', 'landed')]);
  const o = out(t.root);
  assert.match(o, /▶2/);
  assert.match(o, /⏸1/);
  assert.match(o, /⚠1/);
});

test('no packages, no block', () => {
  const t = makeRepo();
  const none = o => { assert.doesNotMatch(o, /▶/); assert.doesNotMatch(o, /⏸/); assert.doesNotMatch(o, /⚠/); };
  none(out(t.root));
  writeRegistry(t.root, []);
  none(out(t.root));
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'holden-plain-'));
  try { none(out(plain)); } finally { fs.rmSync(plain, { recursive: true, force: true }); }
});

test('the next command is gone', () => {
  const t = makeRepo();
  fs.writeFileSync(path.join(t.root, '.planning', 'state.yaml'), 'project: t\ncurrent_phase: 1\nphases:\n  - number: 1\n    name: x\n    status: grilled\n');
  assert.doesNotMatch(out(t.root), /h-plan/);
});

test('a stuck parked package counts as warn, not parked', () => {
  const t = makeRepo();
  writeRegistry(t.root, [pkg('261018-q', 'parked', { since: iso(5 * HOUR) })]);
  const o = out(t.root);
  assert.match(o, /⚠1/);
  assert.doesNotMatch(o, /⏸/);
});

test('the block appears in the first line beside the handoff cell', () => {
  const t = makeRepo();
  fs.mkdirSync(path.join(t.root, '.holden'), { recursive: true });
  fs.writeFileSync(path.join(t.root, '.holden', 'handoff.md'), '# handoff\n');
  writeRegistry(t.root, [pkg('001-01', 'admitted')]);
  const first = out(t.root).split('\n')[0];
  assert.match(first, /▶1/);
  assert.ok(first.includes('\u{f0219}'), first);
});

test('a corrupt registry hides the block', () => {
  const t = makeRepo();
  fs.writeFileSync(R.paths(t.root).registry, '{');
  const o = out(t.root);
  assert.doesNotMatch(o, /[▶⏸⚠]/);
});
