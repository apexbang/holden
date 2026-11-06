'use strict';
// Metadata transactions (phase 002 D01). Each token is <git common dir>/holden-meta/<token>/;
// JOURNAL beside them records a publish whose tree sync has not finished. bin/h-queue meta
// writes both; every command that takes the landing lock replays JOURNAL first.
const fs = require('fs'), path = require('path'), cp = require('child_process');
const R = require(path.join(__dirname, 'registry.js'));

const TOKEN_RE = /^[0-9a-z]+-[0-9a-f]{6}$/, SHA_RE = /^[0-9a-f]{40}$/;
const dirOf = root => R.paths(root).meta;
const journalOf = root => path.join(dirOf(root), 'JOURNAL');
// null for anything but a token bin/h-queue meta open makes, so no path outside the dir is named.
const tokenDir = (root, token) => TOKEN_RE.test(String(token || '')) ? path.join(dirOf(root), token) : null;

function git(root, argv, { input, env, buffer = false } = {}) {
  const r = cp.spawnSync('git', ['-C', root, ...argv], { input, env: env || process.env, encoding: buffer ? 'buffer' : 'utf8', maxBuffer: 1 << 28 });
  return { status: r.status, out: r.stdout, err: String(r.stderr || '') };
}
function must(root, argv, opts) {
  const r = git(root, argv, opts);
  if (r.status !== 0) throw new Error(`git ${argv[0]} failed: ${r.err.trim() || 'exit ' + r.status}`);
  return r;
}

// A reader sees the old file or the new one (hooks/holden-statusline.js parses asks.yaml).
function writeAtomic(file, data, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.holden-tmp-${process.pid}`);
  fs.writeFileSync(tmp, data); fs.chmodSync(tmp, mode); fs.renameSync(tmp, file);
}

// JOURNAL is written by rename (writeJournal), so only a hand edit makes it unreadable; the
// operator then decides from git log, since a guess here could sync the tree to the wrong commit.
function readJournal(root) {
  const f = journalOf(root);
  let text;
  try { text = fs.readFileSync(f, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  const bad = () => new Error(`metadata journal ${f} is unreadable: compare it with git log, then delete it`);
  let j; try { j = JSON.parse(text); } catch (e) { throw bad(); }
  if (!j || typeof j !== 'object' || typeof j.token !== 'string' || !SHA_RE.test(j.old) || !SHA_RE.test(j.new)
    || !Array.isArray(j.paths) || !j.paths.every(p => typeof p === 'string')
    || (j.emptyDirs !== undefined && !(Array.isArray(j.emptyDirs) && j.emptyDirs.every(safeRel)))) throw bad();
  return j;
}
// A repo-relative path that names nothing outside the root: JOURNAL's emptyDirs are made under it.
const safeRel = p => typeof p === 'string' && p !== '' && !path.isAbsolute(p) && !p.split('/').includes('..');
const writeJournal = (root, j) => writeAtomic(journalOf(root), JSON.stringify(j, null, 2) + '\n');
const isAncestor = (root, a, b) => git(root, ['merge-base', '--is-ancestor', a, b]).status === 0;

const blobsAt = (root, rev, paths) => {
  const at = new Map();
  for (let i = 0; i < paths.length; i += 500) {
    const out = must(root, ['ls-tree', '-z', '--full-tree', rev, '--', ...paths.slice(i, i + 500)]).out;
    for (const rec of out.split('\0').filter(Boolean)) {
      const tab = rec.indexOf('\t'), [mode, , sha] = rec.slice(0, tab).split(' ');
      at.set(rec.slice(tab + 1), { mode, sha });
    }
  }
  return at;
};

// D01 step 5 and the JOURNAL replay: the tree and the main index take HEAD's content for `paths`.
// Raw blobs, not a checkout: a checkout of a path absent at HEAD fails, and a rename keeps a
// reader from seeing half a file. D03 says an uncommitted edit is never overwritten, and the
// D03 check runs before the merge: a tree file edited since, equal to neither `old`'s blob nor
// HEAD's, is copied to <path>.holden-saved first. Returns one line per saved copy.
function syncFromHead(root, paths, old = null) {
  if (!paths.length) return [];
  const at = blobsAt(root, 'HEAD', paths), was = old ? blobsAt(root, old, paths) : null, saved = [];
  if (was) {
    const files = paths.filter(p => { try { return fs.lstatSync(path.join(root, p)).isFile(); } catch (e) { return false; } });
    const hashes = files.length ? must(root, ['hash-object', '--no-filters', '--stdin-paths'], { input: files.join('\n') + '\n' }).out.trim().split('\n') : [];
    files.forEach((p, i) => {
      if (hashes[i] === (was.get(p) || {}).sha || hashes[i] === (at.get(p) || {}).sha) return;
      const file = path.join(root, p), keep = file + '.holden-saved';
      fs.copyFileSync(file, keep);
      saved.push(`kept an uncommitted edit of ${p} as ${p}.holden-saved: HEAD's copy replaced it; merge it in a new transaction`);
    });
  }
  for (const p of paths) {
    const e = at.get(p), file = path.join(root, p);
    if (e && (e.mode === '100644' || e.mode === '100755')) {
      writeAtomic(file, must(root, ['cat-file', 'blob', e.sha], { buffer: true }).out, e.mode === '100755' ? 0o755 : 0o644);
    } else if (e) {
      must(root, ['checkout', 'HEAD', '--', p]);
    } else {
      let st = null; try { st = fs.lstatSync(file); } catch (err) {}
      if (st && !st.isDirectory()) fs.unlinkSync(file);
      for (let d = path.dirname(file); d !== root && d.startsWith(root + path.sep); d = path.dirname(d)) {
        try { if (fs.readdirSync(d).length) break; fs.rmdirSync(d); } catch (err) { break; }
      }
    }
  }
  must(root, ['reset', '-q', '--pathspec-from-file=-', '--pathspec-file-nul', 'HEAD'], { input: paths.join('\0') });
  return saved;
}
// D01 step 5's empty `new/` directories: they live only in the token, so a replay makes them too.
const makeDirs = (root, dirs) => { for (const rel of dirs || []) if (safeRel(rel)) fs.mkdirSync(path.join(root, rel), { recursive: true }); };

// Published means `new` is an ancestor of HEAD, not equal to it: a later locked commit on top of a
// published one still leaves its paths to sync, and syncing from HEAD gives the tree HEAD's content.
function replayJournal(root) {
  const j = readJournal(root); if (!j) return [];
  const known = git(root, ['cat-file', '-e', j.new + '^{commit}']).status === 0;
  let lines;
  if (known && isAncestor(root, j.new, 'HEAD')) {
    const saved = syncFromHead(root, j.paths, j.old);
    makeDirs(root, j.emptyDirs);
    const d = tokenDir(root, j.token); if (d) fs.rmSync(d, { recursive: true, force: true });
    lines = [`replayed the metadata journal of ${j.new.slice(0, 7)}: ${j.paths.length} path(s) synced from HEAD`, ...saved];
  } else lines = [`the metadata journal of ${j.new.slice(0, 7)} was never published; token ${j.token} kept`];
  fs.unlinkSync(journalOf(root));
  return lines;
}

module.exports = { TOKEN_RE, dirOf, journalOf, tokenDir, git, writeAtomic, readJournal, writeJournal, isAncestor, syncFromHead, makeDirs, replayJournal };
