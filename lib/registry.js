'use strict';
// The package registry of one repo (DECISION D01 of phase 001): a JSON file in the git common dir,
// so every worktree of the repo sees the same file, never committed. Only withRegistry writes it,
// under a short flock; bin/h-queue calls it for every change, hooks/holden-statusline.js only reads.
// holdLock is also the landing lock bin/h-queue holds for admissions, metadata commits and freezes.
const fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process');
const { aloneFile } = require(path.join(__dirname, 'manifests.js'));

const sleep = ms => new Promise(r => setTimeout(r, ms));
function sh(c, o = {}) { return cp.execSync(c, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...o }).trim(); }

// Always the main checkout, even from inside a worktree (the pattern of bin/h-worktree's root).
// hooks/holden-statusline.js (plan 4) passes a timeout so a slow git never stalls the statusline.
function commonDir(cwd, { timeout } = {}) { return sh('git rev-parse --path-format=absolute --git-common-dir', { cwd, timeout }); }
function mainRoot(cwd, { timeout } = {}) { return path.dirname(commonDir(cwd, { timeout })); }

const pathsCache = new Map();
// `timeout` reaches git only on the first call for a root (hooks/holden-statusline.js queueSeg).
// `meta`: the metadata transactions' tokens and JOURNAL (lib/meta.js).
function paths(root, { timeout } = {}) {
  if (!pathsCache.has(root)) {
    const c = commonDir(root, { timeout });
    pathsCache.set(root, { registry: path.join(c, 'holden-registry.json'), registryLock: path.join(c, 'holden-registry.lock'),
      landingLock: path.join(c, 'holden-landing.lock'), meta: path.join(c, 'holden-meta') });
  }
  return { ...pathsCache.get(root), cache: process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache') };
}

// One attempt. The lock belongs to the `sh` that flock runs: it holds it until `read` sees its stdin
// close, which release() does, and which the kernel does when this process dies. So the lock never
// outlives its holder, and a killed holder frees it with no cleanup step. watch(pid) extends that to
// a child the holder runs under the lock: after the close, the lock stays until that pid is gone
// too, so bin/h-queue land killed mid-landing does not free the lock under its h-worktree land.
// watch resolves once the holder has answered `watching <pid>`: the pid is then held, and a caller
// may let the child run (bin/h-queue spawnWatched).
function tryLock(lockPath, label) {
  return new Promise((resolve, reject) => {
    const script = 'printf "%s pid %s at %s\\n" "$0" "$$" "$(date -Is)" > "$1.holder"; echo locked; ' +
      'pids=; while read -r w p; do [ "$w" = watch ] && { pids="$pids $p"; echo "watching $p"; }; done; ' +
      'for p in $pids; do while kill -0 "$p" 2>/dev/null; do sleep 0.2; done; done';
    const child = cp.spawn('flock', ['-n', '-E', '199', lockPath, 'sh', '-c', script, label, lockPath], { stdio: ['pipe', 'pipe', 'inherit'] });
    let settled = false, exited = false;
    child.stdin.on('error', () => {});   // EPIPE when the holder is already gone: nothing left to release
    const exitP = new Promise(r => child.on('exit', () => { exited = true; r(); }));
    child.on('error', e => { if (!settled) { settled = true; reject(new Error(`flock failed: ${e.message}`)); } });
    // The holder's stdout: `locked`, then one `watching <pid>` per watch it took.
    let buf = '';
    const acks = new Map();
    child.stdout.on('data', d => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        const m = /^watching (\d+)$/.exec(line);
        if (m && acks.has(m[1])) { acks.get(m[1])(); acks.delete(m[1]); }
        if (line !== 'locked' || settled) continue;
        settled = true;
        resolve({
          release: async () => { if (!exited) { child.stdin.end(); await exitP; } },
          watch: pid => new Promise(r => {
            if (exited) return r();
            acks.set(String(pid), r);
            child.stdin.write(`watch ${pid}\n`);
          }),
        });
      }
    });
    exitP.then(() => { for (const r of acks.values()) r(); acks.clear(); });
    child.on('exit', code => {
      if (settled) return; settled = true;
      if (code === 199) resolve(null); else reject(new Error(`flock failed: exit ${code} on ${lockPath}`));
    });
  });
}

// Polls until the lock is free or waitSeconds have passed (then null: the caller runs nothing).
// A long waiter (pollMs of a second or more: the landing lock) says so at once and every 30 s; a
// short one (the registry lock, milliseconds of work behind it) only after 30 s.
async function holdLock(lockPath, waitSeconds, label, pollMs = 15000) {
  fs.closeSync(fs.openSync(lockPath, 'a'));
  const start = Date.now(), end = start + waitSeconds * 1000;
  let nextBeat = pollMs >= 1000 ? start : start + 30000;
  for (;;) {
    const l = await tryLock(lockPath, label);
    if (l) return l;
    const now = Date.now();
    if (now >= end) return null;
    if (now >= nextBeat) {
      let holder = 'unknown';
      try { holder = fs.readFileSync(lockPath + '.holder', 'utf8').trim() || 'unknown'; } catch (e) {}
      process.stdout.write(`h-queue: waiting for ${label} lock ${path.basename(lockPath)}, held by ${holder}, ${Math.round((now - start) / 1000)}s\n`);
      nextBeat = now + 30000;
    }
    await sleep(Math.min(pollMs, end - now));
  }
}

const emptyRegistry = () => ({ version: 1, seq: 0, packages: {}, receipts: [], events: [], freeze: null });
// Lockless: the file is replaced by rename, so a reader sees the old or the new file, never half.
function readRegistry(root, { timeout } = {}) {
  try { return JSON.parse(fs.readFileSync(paths(root, { timeout }).registry, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return emptyRegistry(); throw e; }
}

async function withRegistry(root, fn) {
  const p = paths(root);
  const l = await holdLock(p.registryLock, 30, 'registry', 100);
  if (!l) throw new Error('registry lock busy for 30s');
  try {
    const reg = readRegistry(root);
    const out = await fn(reg);
    const tmp = `${p.registry}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(reg, null, 2));
    fs.renameSync(tmp, p.registry);
    return out;
  } finally { await l.release(); }
}

const inFlight = reg => Object.values(reg.packages || {}).filter(p => p.state === 'admitted' || p.state === 'waiting');
// D04: a phase plan and its phase's inline fixes rank above a quick and a quick's fixes.
const rank = p => (p.kind === 'quick' || (p.kind === 'fix' && String(p.owner || '').startsWith('quick:'))) ? 0 : 1;
// A package not yet admitted (seq null: bin/h-queue admit parks a newcomer before it takes a seq)
// is the later admission against every admitted one.
const order = p => p.seq == null ? Infinity : p.seq;
const outranks = (a, b) => rank(a) > rank(b) || (rank(a) === rank(b) && order(a) < order(b));

// Every caller (admit, extend, landing's undeclared paths, wait) asks this one function, so the
// manifest rule (D03) holds wherever a path is reserved: a manifest conflicts with every other
// package in flight whatever its owner, and a package holding one (`alone`) with every request.
function conflicts(reg, pkg, pathsWanted) {
  const out = [], seen = new Set();
  const add = (p, h) => { const k = p + '\0' + h.id; if (!seen.has(k)) { seen.add(k); out.push({ path: p, holder: h }); } };
  const live = inFlight(reg), others = live.filter(h => h.id !== pkg.id);
  for (const p of pathsWanted) {
    for (const h of live) if (h.owner !== pkg.owner && (h.writes || []).includes(p)) add(p, h);
    if (aloneFile(p)) for (const h of others) add(p, h);
  }
  // Even an empty request: a package that declares nothing is still a package in the repo (D03).
  for (const h of others) if (h.alone) add(h.alone, h);
  return out;
}

const decide = (pkg, holder) => outranks(pkg, holder) ? 'wait' : 'yield';
// One request can conflict with several holders (the manifest rule conflicts with every package
// in flight). Rank is one total order, so the request yields when the highest-ranking holder
// outranks it, which is when any does, and waits otherwise; the verdict names that holder.
function verdict(pkg, cs) {
  const top = cs.reduce((a, c) => outranks(c.holder, a.holder) ? c : a);
  return { how: decide(pkg, top.holder), path: top.path, holder: top.holder };
}

function event(reg, kind, id, text) {
  reg.events = reg.events || [];
  reg.events.push({ time: new Date().toISOString(), kind, id, text });
  if (reg.events.length > 200) reg.events.splice(0, reg.events.length - 200);
}

// The recovery tests kill a command at a named boundary; production never sets the variable.
function crashAt(label) {
  if (process.env.HOLDEN_TEST_CRASH_AT === label) { process.stderr.write('crash-at ' + label + '\n'); process.exit(99); }
}
// A test that needs HEAD moved at a named boundary sets both variables (bin/h-queue meta commit's
// update-ref refusal, phase 002 D06); production never does.
function testRun(label, cwd) { if (process.env.HOLDEN_TEST_RUN_AT === label && process.env.HOLDEN_TEST_RUN_CMD) cp.execSync(process.env.HOLDEN_TEST_RUN_CMD, { cwd, stdio: 'ignore' }); }

// The proved tests of an executor ledger: bin/h-worktree land re-runs them on the merged tree, and
// bin/h-queue land records them in the landing receipt, so both read a ledger the same way.
function ledgerTests(ledger) {
  const tests = new Set();
  for (const line of fs.readFileSync(ledger, 'utf8').split('\n')) {
    if (!line.startsWith('h-test: ')) continue;
    try { const v = JSON.parse(line.slice(8)); if (/^proved/.test(v.verdict || '')) for (const t of v.tests || []) tests.add(t); } catch (e) {}
  }
  return [...tests];
}

// D08: the landing receipts of the packages that landed after `base` and are on `T`, the target a
// landing merges onto; bin/h-queue land re-runs their proved tests with its own.
function receiptsSince(reg, root, base, T) {
  const anc = (a, b) => cp.spawnSync('git', ['-C', root, 'merge-base', '--is-ancestor', a, b], { stdio: 'ignore' }).status === 0;
  const receipts = (reg.receipts || []).filter(r => r.candidate && anc(r.candidate, T) && !anc(r.candidate, base));
  return { receipts, tests: [...new Set(receipts.flatMap(r => r.tests || []))] };
}

// D05: a parked package holds nothing. `declared` stays, so bin/h-queue admit reserves the same files
// again at re-admission; `counter` is 'yields' (rank) or 'drops' (a conflict or a red merged tree:
// D04's "failed twice" is drops >= 2). An undefined head or patch (no drop ran: the package had no
// branch) keeps the record's own, so a re-drop after a crash never loses where the work is (D11).
function park(reg, id, { reason, head, patch, counter }) {
  const p = reg.packages[id];
  Object.assign(p, { state: 'parked', head: head === undefined ? (p.head || null) : head, patch: patch === undefined ? (p.patch || null) : patch,
    writes: [], worktree: null, since: new Date().toISOString() });
  p[counter] = (p[counter] || 0) + 1;
  event(reg, counter === 'yields' ? 'yielded' : 'dropped', id, reason);
  return p;
}

// D11: a package is stale after 60 minutes with no heartbeat from its own commands and no change
// to its driver's transcript; a package waiting or parked over 4 hours is stuck, the operator's
// to decide (D04). WAIT_MAX_S bounds every wait of the phase: bin/h-queue wait's backstop and the
// landing-lock waits of admit, lock, freeze and land.
const STALE_MS = 60 * 60 * 1000, STUCK_MS = 4 * 60 * 60 * 1000, WAIT_MAX_S = 14400;
const mtimeOf = f => { try { return fs.statSync(f).mtimeMs; } catch (e) { return 0; } };
// The newest sign of life: the heartbeat, the main transcript, and each subagent transcript beside
// it (<dirname(transcript)>/<session>/subagents/*.jsonl, the shape hooks/holden-statusline.js
// agentsSeg reads), since a thinking executor writes only its own subagent file. A package with no
// transcript (bin/h-queue transcriptOf found none) has only its heartbeat; a missing file counts 0.
function lastActivity(p) {
  const hb = p.heartbeat ? (Date.parse(p.heartbeat) || 0) : 0;
  if (!p.transcript) return hb;
  const sub = path.join(path.dirname(p.transcript), path.basename(p.transcript, '.jsonl'), 'subagents');
  let subs = []; try { subs = fs.readdirSync(sub).filter(f => f.endsWith('.jsonl')).map(f => mtimeOf(path.join(sub, f))); } catch (e) {}
  return Math.max(hb, mtimeOf(p.transcript), ...subs);
}
// Only a package in flight can be stale: a parked one holds nothing, so its silence costs no one.
// A record with `pending` is a landing in doubt: bin/h-queue landLocked finishes it from git (D07),
// and it refuses a parked record, so a yield would strand work that is already on the main branch.
const isStale = (p, now = Date.now()) => ['admitted', 'waiting'].includes(p.state) && !p.pending && now - lastActivity(p) > STALE_MS;
// Measured from `since`, when it began to wait or was parked, never from the heartbeat.
const isStuck = (p, now = Date.now()) => ['waiting', 'parked'].includes(p.state) && now - Date.parse(p.since) > STUCK_MS;

module.exports = { STALE_MS, STUCK_MS, WAIT_MAX_S, lastActivity, isStale, isStuck, mainRoot, commonDir, paths, holdLock, readRegistry, withRegistry, inFlight, rank, outranks, conflicts, decide, verdict, event, crashAt, testRun, ledgerTests, receiptsSince, park, sleep, emptyRegistry };
