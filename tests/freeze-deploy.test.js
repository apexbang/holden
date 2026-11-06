'use strict';
// D15 on a disposable repo with a bare origin, never prod: the deploy's two runs under the freeze,
// the confirmed one with the confirmed sha. The fake deploy models the three checks of a repo's
// scripts/deploy.sh this phase relies on.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path');
const { makeRepo, run, start, sh, commitFile } = require('./fixtures/repo.js');
const R = require('../lib/registry.js');
// A lock taken here is released at once: a held lock keeps this process alive.
async function busy(lockPath, label) { const l = await R.holdLock(lockPath, 0.5, label); if (l) await l.release(); return !l; }

const DEPLOY = `#!/bin/sh
# fake deploy: the three checks of a scripts/deploy.sh this test models:
#   HEAD == origin/master ("Push first", exit 1),
#   the gate (prints the sha, exit 10 unless --confirmed),
#   the confirmed run records what it shipped.
git fetch -q origin master
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/master)" ] || { echo "Push first"; exit 1; }
sha=$(git rev-parse HEAD)
if [ "$1" != "--confirmed" ]; then echo "Sha:  $sha"; echo "DEPLOY_GATE: Awaiting confirmation. Re-run with --confirmed."; exit 10; fi
echo "$sha" > "$DEPLOYED"
echo "Deploy complete: $sha"
`;
const FIRST = 'git push -q origin master && sh scripts/deploy.sh';
const CONFIRMED = 'git push -q origin master && sh scripts/deploy.sh --confirmed';

function deployRepo() {
  const t = makeRepo({ files: { 'a.txt': 'a\n', 'scripts/deploy.sh': DEPLOY } });
  t.env.DEPLOYED = path.join(t.dir, 'deployed');
  sh(`git init -q --bare ${JSON.stringify(path.join(t.dir, 'origin.git'))} && git remote add origin ${JSON.stringify(path.join(t.dir, 'origin.git'))} && git push -q origin master`, t.root, t.env);
  t.freeze = (...a) => run('h-queue', ['freeze', ...a], { cwd: t.root, env: t.env });
  return t;
}
const gateSha = out => (out.match(/^Sha: {2}([0-9a-f]{40})$/m) || [])[1];

test('the first run under the freeze stops at the gate with the SHA', () => {
  const t = deployRepo();
  const r = t.freeze('--', FIRST);
  assert.equal(r.code, 10, r.out);
  assert.equal(gateSha(r.out), sh('git rev-parse HEAD', t.root, t.env));
  assert.match(r.out, /DEPLOY_GATE/);
});

test('a landing between the runs makes the confirmed run refuse', () => {
  const t = deployRepo();
  const sha = gateSha(t.freeze('--', FIRST).out);
  assert.ok(sha);
  commitFile(t.root, 'a.txt', 'y\n', 'landed meanwhile', t.env);
  const r = t.freeze('--expect', sha, '--', CONFIRMED);
  assert.equal(r.code, 73, r.out);
  assert.match(r.out, /landed meanwhile/);
  assert.ok(!fs.existsSync(t.env.DEPLOYED));
  assert.equal(sh('git ls-remote origin master', t.root, t.env).split(/\s/)[0], sha, 'nothing was pushed');
});

test('the confirmed run with the current SHA ships it', () => {
  const t = deployRepo();
  t.freeze('--', FIRST);
  const head = commitFile(t.root, 'a.txt', 'y\n', 'landed meanwhile', t.env);
  const first = t.freeze('--', FIRST);
  assert.equal(gateSha(first.out), head);
  const r = t.freeze('--expect', head, '--', CONFIRMED);
  assert.equal(r.code, 0, r.out);
  assert.equal(fs.readFileSync(t.env.DEPLOYED, 'utf8').trim(), head);
  assert.equal(sh('git ls-remote origin master', t.root, t.env).split(/\s/)[0], head);
});

test('a landing cannot happen during the freeze', async () => {
  const t = deployRepo();
  const a = start('h-queue', ['freeze', '--', 'sleep 2; sh scripts/deploy.sh'], { cwd: t.root, env: t.env });
  const f = R.paths(t.root).landingLock + '.holder';
  for (let i = 0; i < 100 && !(fs.existsSync(f) && fs.readFileSync(f, 'utf8').startsWith('freeze ')); i++) await R.sleep(50);
  assert.equal(await busy(R.paths(t.root).landingLock, 'land'), true);
  const r = await a.done;
  assert.equal(r.code, 10, r.out);
});

test('the landing lock outlives a freeze killed while its command runs', async () => {
  const t = deployRepo();
  const inF = path.join(t.dir, 'in'), doneF = path.join(t.dir, 'done');
  const lk = R.paths(t.root).landingLock;
  const a = start('h-queue', ['freeze', '--', `touch ${JSON.stringify(inF)}; sleep 3; touch ${JSON.stringify(doneF)}`], { cwd: t.root, env: t.env });
  for (let i = 0; i < 100 && !fs.existsSync(inF); i++) await R.sleep(50);
  assert.ok(fs.existsSync(inF), 'the frozen command started');
  // Only h-queue dies; its command and the lock's holder live on.
  const exited = new Promise(r => a.child.once('exit', r));
  a.child.kill('SIGKILL');
  await exited;
  await R.sleep(300);
  assert.equal(await busy(lk, 'land'), true, 'the lock is still held while the orphaned command runs');
  let freed = null;
  for (let i = 0; i < 60 && !freed; i++) freed = await R.holdLock(lk, 0.5, 'test');
  assert.ok(freed, 'the lock frees after the command exits');
  await freed.release();
  assert.ok(fs.existsSync(doneF), 'the lock freed only once the command had finished');
  await a.done;
});

test('a freeze killed before its command is watched never runs the command', async () => {
  const t = deployRepo();
  const ranF = path.join(t.dir, 'ran');
  const r = run('h-queue', ['freeze', '--', `touch ${JSON.stringify(ranF)}`], { cwd: t.root, env: { ...t.env, HOLDEN_TEST_CRASH_AT: 'gate-before-go' } });
  assert.equal(r.code, 99, r.out);
  await R.sleep(500);
  assert.equal(fs.existsSync(ranF), false, 'the command did not run without the lock');
  assert.equal(await busy(R.paths(t.root).landingLock, 'land'), false, 'the lock is free');
});
