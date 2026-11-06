'use strict';
// The machine-wide test mutex (DECISION D06 of phase 001): one lock file under ~/.cache/holden/,
// taken by every test run in every holden repo, so one repo's suite never starves another's of
// CPU. bin/h-test takes it for every mode that runs tests, bin/h-machine for executor Verify and
// planner baseline commands, bin/h-worktree for preflight's smoke. HOLDEN_MUTEX_HELD=1 marks a
// process that already runs under it; a nested call runs at once instead of waiting on itself.
const fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process');

// The path has no repo part: one identity for every repo on the machine.
function mutexPaths() {
  let cache;
  // lib/registry.js paths needs a git checkout; a command run outside one still shares the mutex.
  try { cache = require(path.join(__dirname, 'registry.js')).paths(process.cwd()).cache; }
  catch (e) { cache = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'); }
  const lock = path.join(cache, 'holden', 'test-mutex.lock'), holder = path.join(cache, 'holden', 'test-mutex.holder');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  return { lock, holder };
}

// D06: "about 9 minutes"; a foreground Bash call outliving its cap is backgrounded, not killed.
// HOLDEN_TEST_MUTEX_WAIT_S is for tests/h-test-mutex.test.js only; production never sets it.
const WAIT_S = Number(process.env.HOLDEN_TEST_MUTEX_WAIT_S) > 0 ? Number(process.env.HOLDEN_TEST_MUTEX_WAIT_S) : 540;
const POLL_S = Math.min(10, WAIT_S), BEAT_S = 30;
// flock's code for "busy" under -n. Not 1 or 75, so a wrapped command's own exit is passed
// through; a command that itself exits 199 is read as busy and run again (no holden runner does).
const BUSY = 199;
const held = () => process.env.HOLDEN_MUTEX_HELD === '1';
const sleepS = s => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, s * 1000);

function holderText(holder) {
  try { return fs.readFileSync(holder, 'utf8').trim() || 'unknown'; } catch (e) { return 'unknown'; }
}

// `-o` closes the lock fd before `sh` runs, so a server the command leaves behind does not keep the
// mutex; the lock is flock's own, and flock waits for `sh`. The sh names the holder for waiters.
const HOLDER_SH = 'printf "%s pid %s at %s\\n" "$0" "$$" "$(date -Is)" > "$HOLDEN_MUTEX_HOLDER"; exec "$@"';
function flockArgv(lock, label, argv) { return ['-n', '-E', String(BUSY), '-o', lock, 'sh', '-c', HOLDER_SH, label, ...argv]; }

// Polls attempt() until it is not busy. Returns its spawnSync result, or null when the mutex stayed
// busy for WAIT_S. Waiting lines go to stderr, so a wrapped command's stdout stays its own.
function poll(attempt, label, holder) {
  const start = Date.now(), end = start + WAIT_S * 1000;
  let nextBeat = start;
  for (;;) {
    const r = attempt();
    if (r.error || r.status !== BUSY) return r;
    const now = Date.now();
    if (now >= end) return null;
    if (now >= nextBeat) {
      process.stderr.write(`${label}: waiting for the test mutex, held by ${holderText(holder)}, ${Math.round((now - start) / 1000)}s of ${WAIT_S}\n`);
      nextBeat = now + BEAT_S * 1000;
    }
    sleepS(Math.min(POLL_S, (end - now) / 1000));
  }
}
const busyLine = (label, holder) => `${label}: the test mutex stayed busy for ${WAIT_S}s (held by ${holderText(holder)}); exit 75, run it again`;
const spawnFailed = (label, r) => `${label}: could not run flock for the test mutex: ${r.error.message}`;

// Runs argv under the mutex with inherited stdio; returns its exit code, 75 when the mutex stayed busy.
function acquireAndRun(argv, label, { cwd = process.cwd(), env = {} } = {}) {
  const { lock, holder } = mutexPaths();
  const r = poll(() => cp.spawnSync('flock', flockArgv(lock, label, argv), { stdio: 'inherit', cwd,
    env: { ...process.env, ...env, HOLDEN_MUTEX_HELD: '1', HOLDEN_MUTEX_HOLDER: holder } }), label, holder);
  if (!r) { process.stderr.write(busyLine(label, holder) + '\n'); return 75; }
  if (r.error) { process.stderr.write(spawnFailed(label, r) + '\n'); return 1; }
  return r.status === null ? 1 : r.status;
}

// The same around `bash -lc cmd` with the output captured (the run shape of bin/h-worktree), for a
// caller that reads it. Under a held mutex it runs at once: bin/h-worktree has no held() check.
function runUnderMutex(cmd, cwd, env = {}, label = 'h-machine') {
  const { lock, holder } = mutexPaths();
  const opts = { cwd, encoding: 'utf8', env: { ...process.env, ...env, HOLDEN_MUTEX_HELD: '1', HOLDEN_MUTEX_HOLDER: holder } };
  const out = r => (r.stdout || '') + (r.stderr || '');
  if (held()) { const r = cp.spawnSync('bash', ['-lc', cmd], opts); return { code: r.status === null ? 1 : r.status, out: out(r) }; }
  const r = poll(() => cp.spawnSync('flock', flockArgv(lock, label, ['bash', '-lc', cmd]), opts), label, holder);
  if (!r) return { code: 75, out: busyLine(label, holder) };
  if (r.error) return { code: 1, out: spawnFailed(label, r) };
  return { code: r.status === null ? 1 : r.status, out: out(r) };
}

module.exports = { mutexPaths, acquireAndRun, runUnderMutex, held, WAIT_S, POLL_S, BEAT_S };
