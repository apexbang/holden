'use strict';
// Minimal YAML reader for holden's own files: maps, lists, scalars, flow lists, quotes, comments.
// Not a general YAML parser. Anchors, multi-line scalars and non-empty flow maps are unsupported.
function scalar(raw) {
  let s = raw.trim();
  if (s === '' ) return null;
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    // Double-quoted: honour the YAML escapes we actually write (\" \\ \n \t).
    return s.slice(1, -1).replace(/\\(["\\nt])/g, (_, c) => ({ '"': '"', '\\': '\\', n: '\n', t: '\t' })[c]);
  }
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) return s.slice(1, -1).replace(/''/g, "'");
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    return inner === '' ? [] : inner.split(',').map(x => scalar(x));
  }
  if (s === '{}') return {};                    // empty flow map; non-empty flow maps stay unsupported
  if (s === 'null' || s === '~') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d+\.\d+$/.test(s)) return parseFloat(s);
  return s;
}
function stripComment(line) {
  let inQ = null, out = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      out += c;
      if (inQ === '"' && c === '\\' && i + 1 < line.length) { out += line[++i]; continue; } // escaped char inside "..."
      if (c === inQ) inQ = null;
      continue;
    }
    if (c === '"' || c === "'") { inQ = c; out += c; continue; }
    if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) break;
    out += c;
  }
  return out.replace(/\s+$/, '');
}
function parse(text) {
  const lines = text.split(/\r?\n/).map(stripComment).filter(l => l.trim() !== '');
  let i = 0;
  function indentOf(l) { return l.match(/^ */)[0].length; }
  function parseBlock(indent) {
    if (i >= lines.length) return null;
    const first = lines[i];
    if (first.trim().startsWith('- ')) return parseList(indent);
    return parseMap(indent);
  }
  function parseMap(indent) {
    const obj = {};
    while (i < lines.length) {
      const l = lines[i]; const ind = indentOf(l);
      if (ind < indent) break;
      if (ind > indent) throw new Error('bad indent at: ' + l);
      const t = l.trim();
      if (t.startsWith('- ')) break;
      const m = t.match(/^([^:]+):(.*)$/);
      if (!m) throw new Error('bad line: ' + l);
      const key = m[1].trim(); const rest = m[2];
      i++;
      if (rest.trim() === '') {
        if (i < lines.length && indentOf(lines[i]) > indent) obj[key] = parseBlock(indentOf(lines[i]));
        else if (i < lines.length && indentOf(lines[i]) === indent && lines[i].trim().startsWith('- ')) obj[key] = parseList(indent);
        else obj[key] = null;
      } else obj[key] = scalar(rest);
    }
    return obj;
  }
  function parseList(indent) {
    const arr = [];
    while (i < lines.length) {
      const l = lines[i]; const ind = indentOf(l);
      if (ind !== indent || !l.trim().startsWith('- ')) break;
      const rest = l.trim().slice(2);
      const m = rest.match(/^([^:\[\]"']+):(.*)$/);
      if (m && !rest.startsWith('[')) {
        // map item: "- key: value" then continuation lines at indent+2
        lines[i] = ' '.repeat(indent + 2) + rest;
        arr.push(parseMap(indent + 2));
      } else { i++; arr.push(scalar(rest)); }
    }
    return arr;
  }
  return parseBlock(0);
}
function load(file) { const fs = require('fs'); return parse(fs.readFileSync(file, 'utf8')); }
module.exports = { parse, load };
