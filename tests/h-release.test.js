'use strict';
// bin/h-release from a throwaway source repo into a throwaway installed copy.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path'), cp = require('child_process');
const { makeRepo, sh } = require('./fixtures/repo.js');
const RELEASE = path.join(__dirname, '..', 'bin', 'h-release');

function setup() {
  const src = makeRepo({ files: { 'bin/tool': '#!/bin/sh\necho new\n', 'skills/a/SKILL.md': 'new\n', 'docs/CONTEXT.md': 'public\n', 'docs/guide.md': 'guide\n', 'README.md': 'public\n', '.planning/state.yaml': 'holden: 1\n' } });
  const dst = makeRepo({ files: { 'bin/tool': 'old\n', 'bin/gone': 'old\n', 'docs/CONTEXT.md': 'private\n', 'observations.md': 'private\n', 'TODO.md': 'private\n', '.planning/asks.yaml': 'private\n' } });
  fs.chmodSync(path.join(src.root, 'bin/tool'), 0o755);
  sh('git add -A && git commit -q -m exec', src.root, src.env);
  const fake = path.join(src.dir, 'fakebin'); fs.mkdirSync(fake);
  fs.writeFileSync(path.join(fake, 'pgrep'), '#!/bin/sh\n[ -z "$FAKE_RUNNING" ] && exit 1\necho 1234\n', { mode: 0o755 });
  const env = { ...dst.env, PATH: fake + ':' + process.env.PATH };
  return { src, dst, env };
}
function stamp(t) {
  const code_tree = sh(`${path.join(__dirname, '..', 'bin', 'h-test')} --code-tree`, t.src.root, t.src.env).trim();
  fs.writeFileSync(path.join(t.src.root, '.holden/test-stamp'), JSON.stringify({ sha: sh('git rev-parse HEAD', t.src.root, t.src.env).trim(), code_tree, dirty: '' }));
}
function release(t, args = [], env = {}) {
  const r = cp.spawnSync(RELEASE, ['--from', t.src.root, '--to', t.dst.root, ...args], { env: { ...t.env, ...env }, encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
const read = (t, f) => fs.readFileSync(path.join(t.dst.root, f), 'utf8');
const has = (t, f) => fs.existsSync(path.join(t.dst.root, f));
const head = t => sh('git rev-parse HEAD', t.dst.root, t.dst.env).trim();

test('a release copies the code, removes what the source dropped and keeps every private file', () => {
  const t = setup(); stamp(t);
  const r = release(t);
  assert.equal(r.code, 0, r.out);
  assert.equal(read(t, 'bin/tool'), '#!/bin/sh\necho new\n');
  assert.ok(fs.statSync(path.join(t.dst.root, 'bin/tool')).mode & 0o100, 'the mode travels');
  assert.equal(read(t, 'skills/a/SKILL.md'), 'new\n');
  assert.equal(read(t, 'README.md'), 'public\n');
  assert.ok(!has(t, 'bin/gone'));
  for (const f of ['docs/CONTEXT.md', 'observations.md', 'TODO.md', '.planning/asks.yaml']) assert.equal(read(t, f), 'private\n', f);
  assert.ok(!has(t, '.planning/state.yaml') || read(t, '.planning/state.yaml') !== 'holden: 1\n');
  const sha = sh('git rev-parse --short HEAD', t.src.root, t.src.env).trim();
  assert.match(sh('git log -1 --format=%s', t.dst.root, t.dst.env), new RegExp(`^release: holden ${sha}`));
  assert.equal(sh('git status --porcelain', t.dst.root, t.dst.env).trim(), '');
  assert.match(r.out, /skills, agents or hooks changed: run bin\/link/);
});

test('--dry-run reports the plan and changes nothing', () => {
  const t = setup(); stamp(t); const before = head(t);
  const r = release(t, ['--dry-run']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /copy bin\/tool/); assert.match(r.out, /remove bin\/gone/);
  assert.equal(read(t, 'bin/tool'), 'old\n'); assert.equal(head(t), before);
});

test('a second release has nothing to do and makes no commit', () => {
  const t = setup(); stamp(t);
  assert.equal(release(t).code, 0);
  const before = head(t), r = release(t);
  assert.equal(r.code, 0, r.out); assert.match(r.out, /nothing to release/); assert.equal(head(t), before);
});

test('it refuses while a Codex round runs, on a dirty source, without a passing suite and over local edits', () => {
  const t = setup();
  let r = release(t);
  assert.equal(r.code, 1, r.out); assert.match(r.out, /no passing full suite/);
  stamp(t);
  r = release(t, [], { FAKE_RUNNING: '1' });
  assert.equal(r.code, 1, r.out); assert.match(r.out, /a Codex round is running/);
  fs.writeFileSync(path.join(t.dst.root, 'bin/tool'), 'edited\n');
  r = release(t);
  assert.equal(r.code, 1, r.out); assert.match(r.out, /uncommitted change in .*bin\/tool/);
  assert.equal(read(t, 'bin/tool'), 'edited\n');
  sh('git checkout bin/tool', t.dst.root, t.dst.env);
  fs.writeFileSync(path.join(t.src.root, 'bin/tool'), 'dirty\n');
  r = release(t);
  assert.equal(r.code, 1, r.out); assert.match(r.out, /commit first/);
  assert.equal(read(t, 'bin/tool'), 'old\n');
});

test('it refuses to release a clone onto itself', () => {
  const t = setup(); stamp(t);
  const r = cp.spawnSync(RELEASE, ['--from', t.src.root, '--to', t.src.root], { env: t.env, encoding: 'utf8' });
  assert.equal(r.status, 1); assert.match(r.stdout + r.stderr, /is the installed copy/);
});

test('it refuses while a package is in flight in any repo, and a landed one does not count', () => {
  const t = setup(); stamp(t);
  const other = makeRepo();
  const wt = path.join(t.env.XDG_CACHE_HOME, 'holden', 'wt', 'other-1', '261106-x');
  fs.mkdirSync(wt, { recursive: true });
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(other.root, '.git', 'worktrees', '261106-x')}\n`);
  const reg = state => fs.writeFileSync(path.join(other.root, '.git', 'holden-registry.json'), JSON.stringify({ version: 1, packages: { '261106-x': { id: '261106-x', state } } }));
  reg('admitted');
  let r = release(t);
  assert.equal(r.code, 1, r.out); assert.match(r.out, /in flight: 261106-x/);
  assert.equal(read(t, 'bin/tool'), 'old\n');
  reg('landed');
  r = release(t);
  assert.equal(r.code, 0, r.out);
});
