'use strict';
// A file's importers in any language, without a map: Python dotted imports, a quoted path ending
// in the file's name with any extension (JS/TS imports, C `#include "x.h"`), Rust `mod x;` and
// `crate::...::x`. bin/h-radius lists them for a file hub; bin/h-queue admit reads their top-level
// directories for a quick.
const path = require('path'), cp = require('child_process');

// pathspecs that reproduce h-radius's searchable files for git grep without listing every file
const CODE_SPEC = ['.', ':!.planning', ':!.holden', ':!*.md', ':!*.lock', ':!package-lock.json', ':!*.min.js', ':!*.map', ':!*.svg', ':!*.png', ':!*.jpg', ':!*.ico', ':!*.woff', ':!*.woff2',
  ':!node_modules', ':!**/node_modules/**', ':!dist', ':!**/dist/**', ':!build', ':!**/build/**', ':!vendor', ':!**/vendor/**'];
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function globToRe(g) {
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') { if (g[i + 1] === '*') { if (g[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i++; } } else re += '[^/]*'; }
    else if (c === '?') re += '[^/]';
    else if ('.+^${}()|[]\\'.includes(c)) re += '\\' + c;
    else re += c;
  }
  return new RegExp('^' + re + '$');
}
function gitGrep(flags, pattern, pathspecs, cwd) { const r = cp.spawnSync('git', ['grep', ...flags, '-e', pattern, '--', ...pathspecs], { cwd, encoding: 'utf8', maxBuffer: 1 << 28 }); return (r.stdout || '').replace(/\n$/, ''); }
// Each file with a line matching pat, with its count of matching lines; `self` is left out.
function grepFiles(pat, self, { cwd = process.cwd() } = {}) {
  const files = new Map();
  for (const line of gitGrep(['-n', '-I', '-E'], pat, CODE_SPEC, cwd).split('\n')) { const m = line.match(/^([^:]+):(\d+):/); if (m && m[1] !== self) files.set(m[1], (files.get(m[1]) || 0) + 1); }
  return files;
}
function importers(file, { cwd = process.cwd() } = {}) {
  const noExt = file.replace(/\.[^.]+$/, '');
  const base = escRe(path.basename(noExt));
  const dotted = escRe(noExt.replace(/\//g, '.'));
  return grepFiles(`(from ${dotted} import|import ${dotted}\\b|from ${dotted}\\.|['"\\./]${base}(\\.[A-Za-z0-9]+)?['"]|\\bmod ${base}[[:space:]]*;|(crate|super|self)(::[A-Za-z0-9_]+)*::${base}\\b)`, file, { cwd });
}
// A path's language family by its extension. Any other extension, or none (a shell or node script,
// a document), is null: such a file's importers, and such an importer, count in every family.
const FAMILY = { py: 'python', pyi: 'python', js: 'js', jsx: 'js', mjs: 'js', cjs: 'js', ts: 'js', tsx: 'js', mts: 'js', cts: 'js',
  svelte: 'js', vue: 'js', go: 'go', rs: 'rust', c: 'c', h: 'c', cc: 'c', cpp: 'c', cxx: 'c', hpp: 'c', hh: 'c' };
const family = f => FAMILY[path.extname(f).slice(1).toLowerCase()] || null;
// The top-level directories whose code imports any of `files`, sorted, `.` for an importer at the
// repo's top level. A test is not an entry point and is left out. An importer of another language
// family than the file is a basename collision (a Svelte store named settings.js against a Python
// settings.py) and is left out too.
function importerRoots(files, { cwd = process.cwd(), isTest = () => false } = {}) {
  const roots = new Set();
  for (const file of files) {
    const fam = family(file);
    for (const imp of importers(file, { cwd }).keys()) {
      if (isTest(imp)) continue;
      const f2 = family(imp);
      if (fam && f2 && f2 !== fam) continue;
      roots.add(imp.includes('/') ? imp.split('/')[0] : '.');
    }
  }
  return [...roots].sort();
}
module.exports = { CODE_SPEC, escRe, globToRe, grepFiles, importers, family, importerRoots };
