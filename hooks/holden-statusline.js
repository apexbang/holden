#!/usr/bin/env node
'use strict';
// holden statusline in Tokyo Night colours with Nerd Font glyphs. One line outside a holden repo:
//   󰉋 scratch   main  󰍛 ctx:19%  󰅐 2h51m:18%  󰃭 2d20h:43%  󰃨 97%  opus 5.5
// Two lines where there is holden state (packages in flight, a handoff or open asks), place then fuel:
//   󰉋 holden   master ↑50  ▶2 ⏸1 ⚠1  󰈙 stale  󰘥 38 (12 red)
//   opus 5.5  󰍛 ctx:19%  󰚩 2:61%/18%  󰃨 97%  󰅐 2h51m:18%  󰃭 2d20h:43%
// The budget cells are the time until each plan window resets (5-hour, then weekly), then its use.
// Times are d/h/m, with minutes dropped past one day and days dropped at zero. rate_limits only
// exists on subscription plans and after the session's first response; each missing window drops
// its cell.
// The queue cell counts this repo's packages in flight (hooks read <git common dir>/holden-registry.json,
// written by bin/h-queue): running, parked, and stale or stuck; it is absent when there are none.
// The asks cell counts .planning/asks.yaml's asks with
// status open or blocked, and how many of those are red. The handoff cell says whether .holden/handoff.md is
// older than state.yaml or ledger.md (stale) rather than when it was written. The repo cell is
// the folder holding .git, else the working directory. The git cell is the branch and its commits
// ahead (↑) and behind (↓) its upstream.
// The cache cell is the session's cache hit rate: cache reads over all input tokens (fresh, cache
// writes, cache reads), summed over the main transcript's responses. It reads only what the
// transcript gained since the last refresh, keeping running sums in a temp state file.
// The agents cell (two-line layout only) is each running subagent's context, fullest first. It reads
// the tail of each transcript under <session>/subagents/; an agent counts as running while its last
// response is not a final answer (end_turn) and the file changed in the last 30 minutes. Its window
// comes from its model (agentWindow), and like ctx it counts up to the auto-compact point.
// Also writes the context bridge file the context monitor hook reads (unchanged contract).
const fs = require('fs'), path = require('path'), os = require('os'), { execFileSync } = require('child_process');
const yaml = require(path.join(__dirname, '..', 'lib', 'yaml-lite.js'));
const registry = require(path.join(__dirname, '..', 'lib', 'registry.js'));
const hex = h => `\x1b[38;2;${parseInt(h.slice(0, 2), 16)};${parseInt(h.slice(2, 4), 16)};${parseInt(h.slice(4), 16)}m`;
const TN = { blue: hex('7aa2f7'), cyan: hex('7dcfff'), purple: hex('bb9af7'), green: hex('9ece6a'), yellow: hex('e0af68'), orange: hex('ff9e64'), red: hex('f7768e'), teal: hex('73daca'), comment: hex('565f89') };
const RESET = '\x1b[0m';
const paint = (color, s) => s ? `${color}${s}${RESET}` : '';
const ICON = { asks: '\u{f0625}', five: '\u{f0150}', week: '\u{f00ed}', ctx: '\u{f035b}', cache: '\u{f00e8}', agents: '\u{f06a9}', handoff: '\u{f0219}', repo: '\u{f024b}', branch: '\u{e725}', rc: '\u{f018d}' };
function findUp(dir, rel) { let cur = dir; for (let i = 0; i < 10; i++) { const c = path.join(cur, rel); if (fs.existsSync(c)) return c; const p = path.dirname(cur); if (p === cur) break; cur = p; } return null; }
function shortModel(name) { return (name || 'Claude').replace(/\s*\(.*?\)\s*/g, ' ').trim().toLowerCase(); }
function pctColor(pct) { return pct < 50 ? TN.green : pct < 65 ? TN.yellow : pct < 80 ? TN.orange : TN.red; }
function clampPct(p) { return Math.max(0, Math.min(100, Math.round(p))); }
// 2h51m under a day, 1d3h46m on the last day, 3d11h beyond it.
function until(epoch) {
  const s = Math.round(epoch - Date.now() / 1000); if (!(s > 0)) return '';
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d > 1 ? `${d}d${h}h` : d === 1 ? `${d}d${h}h${m}m` : h ? `${h}h${m}m` : `${m}m`;
}
function budgetSegs(data) {
  const rl = data.rate_limits || {}; const out = [];
  for (const [icon, w] of [[ICON.five, rl.five_hour], [ICON.week, rl.seven_day]]) {
    if (!w) continue;
    const u = w.resets_at ? until(w.resets_at) : '';
    const pct = w.used_percentage == null ? null : clampPct(w.used_percentage);
    if (!u && pct == null) continue;
    const parts = [paint(TN.cyan, u), pct == null ? '' : paint(pctColor(pct), `${pct}%`)].filter(Boolean);
    out.push(`${paint(TN.blue, icon)} ${parts.join(paint(TN.comment, ':'))}`);
  }
  return out;
}
// D13: one block per repo, ▶ running, ⏸ parked, ⚠ stale or stuck (counted there and nowhere else);
// landed and dropped count nowhere. Lockless, never a lock (lib/registry.js readRegistry: the file
// is replaced by rename); git gets the 1 s gitSeg gets, and any failure hides the block.
function queueSeg(dir) {
  let root; try { root = registry.mainRoot(dir, { timeout: 1000 }); } catch (e) { return ''; }
  let reg; try { reg = registry.readRegistry(root, { timeout: 1000 }); } catch (e) { return ''; }
  const now = Date.now(), ps = Object.values(reg.packages || {});
  const warn = ps.filter(p => registry.isStale(p, now) || registry.isStuck(p, now)).length;
  const run = ps.filter(p => ['admitted', 'waiting'].includes(p.state) && !registry.isStale(p, now) && !registry.isStuck(p, now)).length;
  const parked = ps.filter(p => p.state === 'parked' && !registry.isStuck(p, now)).length;
  if (!run && !parked && !warn) return '';
  return [run ? paint(TN.green, `▶${run}`) : '', parked ? paint(TN.yellow, `⏸${parked}`) : '', warn ? paint(TN.red, `⚠${warn}`) : ''].filter(Boolean).join(' ');
}
function mtime(p) { try { return fs.statSync(p).mtimeMs; } catch (e) { return 0; } }
function handoffSeg(dir) {
  const h = findUp(dir, path.join('.holden', 'handoff.md')); if (!h) return '';
  const root = path.dirname(path.dirname(h));
  const newest = Math.max(mtime(path.join(root, '.planning', 'state.yaml')), mtime(path.join(root, '.planning', 'ledger.md')));
  const stale = newest > mtime(h), color = stale ? TN.yellow : TN.teal;
  return `${paint(color, ICON.handoff)} ${paint(color, stale ? 'stale' : 'ok')}`;
}
function asksSeg(dir) {
  const ap = findUp(dir, path.join('.planning', 'asks.yaml')); if (!ap) return '';
  let a; try { a = yaml.load(ap); } catch (e) { return paint(TN.red, 'asks.yaml unreadable'); }
  const open = ((a && a.asks) || []).filter(x => x.status === 'open' || x.status === 'blocked');
  if (!open.length) return '';
  const red = open.filter(x => x.priority === 'red').length;
  return `${paint(TN.yellow, ICON.asks)} ${paint(TN.yellow, String(open.length))}${red ? ' ' + paint(TN.red, `(${red} red)`) : ''}`;
}
function repoSeg(dir) { const g = findUp(dir, '.git'); return `${paint(TN.blue, ICON.repo)} ${paint(TN.blue, path.basename(g ? path.dirname(g) : dir))}`; }
function gitSeg(dir) {
  let out; try { out = execFileSync('git', ['-C', dir, 'status', '--porcelain=v2', '--branch', '--untracked-files=no', '--ignore-submodules'], { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { return ''; }
  let head = '', oid = '', ahead = 0, behind = 0;
  for (const line of out.split('\n')) {
    if (line.startsWith('# branch.head ')) head = line.slice(14);
    else if (line.startsWith('# branch.oid ')) oid = line.slice(13, 20);
    else if (line.startsWith('# branch.ab ')) { const m = line.match(/\+(\d+) -(\d+)/); if (m) { ahead = +m[1]; behind = +m[2]; } }
  }
  if (!head) return '';
  const name = head === '(detached)' ? oid : head;
  const counts = [ahead ? paint(TN.orange, `↑${ahead}`) : '', behind ? paint(TN.red, `↓${behind}`) : ''].filter(Boolean).join(' ');
  return `${paint(TN.green, ICON.branch)} ${paint(TN.green, name)}${counts ? ' ' + counts : ''}`;
}
// Share of the window used before auto-compact, so 100% is where compaction fires.
function usedBeforeCompact(remaining, window) {
  const acw = parseInt(process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW || '0', 10);
  const buf = acw > 0 ? Math.min(100, (acw / window) * 100) : 16.5;
  const usable = Math.max(0, ((remaining - buf) / (100 - buf)) * 100);
  return clampPct(100 - usable);
}
function ctxSeg(data) {
  const remaining = data.context_window && data.context_window.remaining_percentage; if (remaining == null) return { seg: '', used: null };
  const used = usedBeforeCompact(remaining, (data.context_window && data.context_window.total_tokens) || 1000000);
  const color = used < 80 ? pctColor(used) : '\x1b[5m' + TN.red;
  return { seg: `${paint(TN.blue, ICON.ctx)} ${paint(TN.comment, 'ctx:')}${paint(color, `${used}%`)}`, used, remaining };
}
function cacheSeg(data) {
  const session = data.session_id || '', tp = data.transcript_path;
  if (!session || /[/\\]|\.\./.test(session) || !tp) return '';
  const sf = path.join(os.tmpdir(), `claude-cache-${session}.json`);
  let st = { offset: 0, read: 0, total: 0, lastId: '' }; try { st = Object.assign(st, JSON.parse(fs.readFileSync(sf, 'utf8'))); } catch (e) {}
  try {
    const size = fs.statSync(tp).size; if (size < st.offset) st = { offset: 0, read: 0, total: 0, lastId: '' };
    if (size > st.offset) {
      const fd = fs.openSync(tp, 'r'); const buf = Buffer.alloc(size - st.offset);
      try { fs.readSync(fd, buf, 0, buf.length, st.offset); } finally { fs.closeSync(fd); }
      const end = buf.lastIndexOf(0x0a) + 1;
      for (const line of buf.subarray(0, end).toString('utf8').split('\n')) {
        if (!line.includes('"usage"')) continue;
        let e; try { e = JSON.parse(line); } catch (err) { continue; }
        const m = e.message, u = m && m.usage; if (!u || (m.id && m.id === st.lastId)) continue;
        st.lastId = m.id || '';
        const read = u.cache_read_input_tokens || 0; st.read += read; st.total += read + (u.cache_creation_input_tokens || 0) + (u.input_tokens || 0);
      }
      st.offset += end; fs.writeFileSync(sf, JSON.stringify(st));
    }
  } catch (e) { return ''; }
  if (!st.total) return '';
  const pct = Math.floor((st.read / st.total) * 100);
  const color = pct >= 90 ? TN.green : pct >= 70 ? TN.yellow : pct >= 50 ? TN.orange : TN.red;
  return `${paint(TN.blue, ICON.cache)} ${paint(color, `${pct}%`)}`;
}
function lastUsage(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size, len = Math.min(size, 262144), buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= (len < size ? 1 : 0); i--) {
      if (!lines[i].includes('"usage"')) continue;
      try { const m = JSON.parse(lines[i]).message; if (m && m.usage) return m; } catch (e) {}
    }
  } finally { fs.closeSync(fd); }
  return null;
}
// Measured from subagent transcripts: Sonnet 5, Opus 5, Opus 5.5 and Fable 5.1 all ran past 200k
// tokens (Sonnet to 511k); only Haiku stays within 200k.
function agentWindow(model) { return /haiku/.test(String(model)) ? 200000 : 1000000; }
function agentsSeg(data) {
  const session = data.session_id || '', tp = data.transcript_path;
  if (!session || /[/\\]|\.\./.test(session) || !tp) return '';
  const sub = path.join(path.dirname(tp), session, 'subagents');
  const pcts = [];
  let files; try { files = fs.readdirSync(sub).filter(f => f.endsWith('.jsonl')); } catch (e) { return ''; }
  for (const f of files) {
    const file = path.join(sub, f);
    try {
      if (Date.now() - fs.statSync(file).mtimeMs > 30 * 60 * 1000) continue;
      const m = lastUsage(file); if (!m || m.stop_reason === 'end_turn') continue;
      const u = m.usage, used = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      const win = agentWindow(m.model);
      pcts.push(usedBeforeCompact(100 - (used / win) * 100, win));
    } catch (e) {}
  }
  if (!pcts.length) return '';
  pcts.sort((x, y) => y - x);
  return `${paint(TN.blue, ICON.agents)} ${paint(TN.comment, `${pcts.length}:`)}${pcts.slice(0, 3).map(p => paint(pctColor(p), `${p}%`)).join(paint(TN.comment, '/'))}`;
}
// Remote Control has no field in the statusline input; Claude Code records the bridge on this
// process's entry in ~/.claude/sessions/<pid>.json and clears it when /rc disconnects.
function rcSeg(data) {
  const session = data.session_id || ''; if (!session) return '';
  const dir = path.join(os.homedir(), '.claude', 'sessions');
  let files; try { files = fs.readdirSync(dir).filter(f => f.endsWith('.json')); } catch (e) { return ''; }
  for (const f of files) {
    try { const s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); if (s.sessionId === session) return typeof s.bridgeSessionId === 'string' ? paint(TN.teal, ICON.rc) : ''; } catch (e) {}
  }
  return '';
}
function writeBridge(data, ctx) {
  const session = data.session_id || ''; if (!session || /[/\\]|\.\./.test(session) || ctx.remaining == null) return;
  const file = path.join(os.tmpdir(), `claude-ctx-${session}.json`);
  // One file per session and nothing removed them: they piled up. A session's
  // first write clears every bridge and warned-marker file untouched for a day.
  if (!fs.existsSync(file)) {
    try {
      const day = Date.now() - 86400000;
      for (const f of fs.readdirSync(os.tmpdir())) {
        if (!/^claude-ctx-.*\.json$/.test(f)) continue;
        const p = path.join(os.tmpdir(), f);
        try { if (fs.statSync(p).mtimeMs < day) fs.unlinkSync(p); } catch (e) {}
      }
    } catch (e) {}
  }
  try { fs.writeFileSync(file, JSON.stringify({ session_id: session, remaining_percentage: ctx.remaining, used_pct: Math.round(100 - ctx.remaining), timestamp: Math.floor(Date.now() / 1000) })); } catch (e) {}
}
function render(data) {
  const dir = (data.workspace && data.workspace.current_dir) || process.cwd();
  const ctx = ctxSeg(data); writeBridge(data, ctx);
  const model = `\x1b[1m${paint(TN.purple, shortModel(data.model && data.model.display_name))}`;
  const where = [repoSeg(dir), gitSeg(dir)], holden = [queueSeg(dir), handoffSeg(dir), asksSeg(dir)].filter(Boolean);
  const join = cells => cells.filter(Boolean).join('  ');
  const rc = rcSeg(data);
  if (!holden.length) return join([...where, ctx.seg, ...budgetSegs(data), cacheSeg(data), model, rc]);
  return join([...where, ...holden, rc]) + '\n' + join([model, ctx.seg, agentsSeg(data), cacheSeg(data), ...budgetSegs(data)]);
}
module.exports = { render };
if (require.main === module) {
  let input = ''; const t = setTimeout(() => process.exit(0), 3000);
  process.stdin.setEncoding('utf8'); process.stdin.on('data', c => input += c);
  process.stdin.on('end', () => { clearTimeout(t); try { process.stdout.write(render(JSON.parse(input))); } catch (e) {} });
}
