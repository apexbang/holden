'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { makeRepo, run } = require('./fixtures/repo.js');

// One importer per branch of lib/importers.js importers' pattern: a dotted import, `import x`, a quoted
// path from another language, an extensionless script; a test apart; a comment naming a deleted file.
const FILES = {
  'a.txt': 'a\n', 'b.txt': 'b\n',
  'services/settings.py': 'def get(k):\n    return k\n',
  'routes/orders.py': 'from services.settings import get\n',
  'app.py': 'import services.settings\n',
  'client/src/App.svelte': "<script>\nimport s from './stores/settings.js';\n</script>\n",
  'bin/tool': "#!/usr/bin/env node\nrequire('../services/settings');\n",
  'tests/test_settings.py': 'from services.settings import get\n',
  'lib/x.js': '// reads services/gone.py\nmodule.exports = 1;\n',
};

test("h-radius lists a file's importers in every language, tests apart", () => {
  const t = makeRepo({ files: FILES });
  const r = run('h-radius', ['services/settings.py'], { cwd: t.root, env: t.env });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^- importers:$/m);
  assert.match(r.out, /^  - routes\/orders\.py \(1\)$/m);
  assert.match(r.out, /^  - app\.py \(1\)$/m);
  assert.match(r.out, /^  - client\/src\/App\.svelte \(1\)$/m);
  assert.match(r.out, /^  - bin\/tool \(1\)$/m);
  assert.match(r.out, /^- tests naming it:\n  - tests\/test_settings\.py$/m);
});

test("h-radius finds a symbol's readers through the code pathspecs", () => {
  const t = makeRepo({ files: FILES });
  const r = run('h-radius', ['get'], { cwd: t.root, env: t.env });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^- readers:$/m);
  assert.match(r.out, /^  - routes\/orders\.py \(1\): 1$/m);
});

test('h-radius --check-refs with no files scans the code pathspecs', () => {
  const t = makeRepo({ files: FILES });
  const r = run('h-radius', ['--check-refs'], { cwd: t.root, env: t.env });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /^DELETED lib\/x\.js:1  services\/gone\.py$/m);
});

// check-ids: every fixture is a one-line string, so no fixture opens a physical line of this file
// with a comment marker or a test call, and a line marker inside one is split in two.
const cp = require('node:child_process'), fs = require('node:fs'), path = require('node:path');
const edit = (t, rel, text) => { fs.mkdirSync(path.dirname(path.join(t.root, rel)), { recursive: true }); fs.writeFileSync(path.join(t.root, rel), text); };
const ids = (t, args = []) => run('h-radius', ['--check-ids', ...args], { cwd: t.root, env: t.env });
const gitIn = (t, cmd) => cp.execSync(cmd, { cwd: t.root, env: t.env, encoding: 'utf8' });
const SLASH2 = '/' + '/';

test('check-ids flags a tag on an added comment line and nothing the change did not add', () => {
  const t = makeRepo({ files: { 'src/a.py': '# Phase 100 D01 old note\nx = 0\n' } });
  edit(t, 'src/a.py', '# Phase 100 D01 old note\nx = 0\n# Phase 200 D02: why\nx = 1\n');
  let r = ids(t);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /^IDS src\/a\.py:3  phase id/m);
  assert.match(r.out, /1 added line\(s\)/);
  assert.doesNotMatch(r.out, /src\/a\.py:1 /);
  edit(t, 'src/a.py', '# Phase 100 D01 old note\nx = 0\ny = 2\n');
  r = ids(t);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /ids: no planning id/);
});

test('check-ids reads docstrings, trailing, block and markup comments', () => {
  const t = makeRepo();
  const cases = {
    'src/d1.py': ['def f():\n    """Doc.\n\n    Phase 200 D02 rule\n    """\n    return 1\n', 4],
    'src/d2.py': ['#!/usr/bin/env python\n# -*- coding: utf-8 -*-\n"""Mod.\n\nPhase 200 D02 here\n"""\nx = 1\n', 5],
    'src/d3.py': ['def f():  # noqa\n    """Doc\n    Phase 200 D02\n    """\n', 3],
    'src/d4.py': ['sql = """\nselect 1\n"""\ndef g():\n    """Phase 200 D02 doc\n    """\n', 5],
    'src/d5.py': ['def f():\n    """Phase 200 D02"""\n', 2],
    'src/d6.py': ['x = 1  # quick 261021-a note\n', 1],
    'src/b.js': ['var a = 1;\n/* start\n   middle Phase 200 D02 text\n*/\n', 3],
    'src/c.svelte': ['<div>\n<!-- one\n  two Phase 200 D02\n-->\n</div>\n', 3],
    'src/e.html': ['<p>x</p>\n{# one\n two Phase 200 D02\n#}\n', 3],
    'src/q.sql': ['select 1; -- Phase 200 D02\n', 1],
  };
  for (const [f, [text]] of Object.entries(cases)) edit(t, f, text);
  const r = ids(t);
  assert.equal(r.code, 1, r.out);
  for (const [f, [, line]] of Object.entries(cases)) assert.match(r.out, new RegExp(`^IDS ${f.replace(/\./g, '\\.')}:${line} `, 'm'), f + '\n' + r.out);
  assert.match(r.out, new RegExp(`ids: ${Object.keys(cases).length} added line`));
});

test('check-ids skips data and test names outside test files', () => {
  const t = makeRepo();
  edit(t, 'src/m.py', 'msg = "see Phase 200 D02"\nsql = """\nPhase 200 D02 data\n"""\nq = f("""Phase 200 D02\nmore""")\n');
  edit(t, 'svc/x.service', 'Description=x (phase 190 D10)\n');
  edit(t, 'src/c.js', 'const a = b; # Phase 200 D02\n');
  edit(t, 'src/s.svelte', '{#if Phase 203 mode}\n<p>hi</p>\n{/if}\n');
  edit(t, 'src/b.js', "it('x (203 D02)', f)\n");
  edit(t, 'tests/b.test.js', `w('x', "it('r (203 D02)', f)")\n`);
  let r = ids(t);
  assert.equal(r.code, 0, r.out);
  edit(t, 'tests/a.test.js', "it('reset (203 D02)', f)\n");
  edit(t, 'tests/c.test.js', 'describe.only("Phase 203 group", f)\n');
  edit(t, 'tests/test_a.py', 'def test_phase_193_x():\n    pass\n');
  r = ids(t);
  assert.equal(r.code, 1, r.out);
  for (const f of ['tests/a.test.js:1', 'tests/c.test.js:1', 'tests/test_a.py:1']) assert.ok(r.out.includes('IDS ' + f + ' '), f + '\n' + r.out);
  assert.doesNotMatch(r.out, /IDS (src|svc)\//);
  assert.doesNotMatch(r.out, /IDS tests\/b\.test/);
});

test('check-ids reads one-line strings as data where # opens a comment, and every comment after them', () => {
  const t = makeRepo();
  const S = SLASH2;
  edit(t, 'src/s.py', 'x = "a # Phase 200 b"\ny = f\'it # Phase 200\'\nsql = """\nselect 1\n"""  # Phase 201 after\n');
  edit(t, 'src/h.sh', 'echo "a # Phase 200 b"\ncat <<EOF\n# Phase 207 heading\nEOF\necho done # Phase 203 after\n');
  edit(t, 'src/c.yaml', "name: don't # Phase 205 after\n");
  edit(t, 'src/l.rs', "fn f(x: &'a str) {} " + S + ' Phase 204 after\n');
  edit(t, 'src/t.js', 'const sql = `\nselect 1\n`; ' + S + ' Phase 202 after\n');
  const shq = "const q = w => `'${w.replace(/'/g, `'\\\\''`)}'`;\n";
  const rx = 'const m = /source:\\s*`?https?:/;\n';
  const tail = S + ' Phase 208 why\n/* Phase 209 block */\n' + "it('Phase 210 name', f)\n";
  edit(t, 'tests/q.test.js', shq + tail);
  edit(t, 'tests/r.test.js', rx + tail);
  const r = ids(t);
  assert.equal(r.code, 1, r.out);
  const hits = r.out.split('\n').filter(l => l.startsWith('IDS ')).map(l => l.split(' ')[1]).sort();
  assert.deepEqual(hits, ['src/c.yaml:1', 'src/h.sh:3', 'src/h.sh:5', 'src/l.rs:1', 'src/s.py:5', 'src/t.js:3',
    'tests/q.test.js:2', 'tests/q.test.js:3', 'tests/q.test.js:4', 'tests/r.test.js:2', 'tests/r.test.js:3', 'tests/r.test.js:4']);
  gitIn(t, 'git add -A && git commit -q -m s && git config diff.external /bin/true');
  edit(t, 'src/s.py', 'z = 1  # Phase 206 z\n');
  assert.equal(ids(t).code, 1);
});

test('check-ids pairs every triple quote on a Python line in order', () => {
  const t = makeRepo();
  edit(t, 'src/m.py', 'SQL = """\nselect a,""" + X + """\nfrom t\n"""\ndef f():\n    # Phase 200 heading\n    return 1  # Phase 201 why\n');
  edit(t, 'src/n.py', 'def g():\n    return """a""" + """b\n    # inside data\n    """\n    # Phase 301 heading\n');
  edit(t, 'src/q.py', 'q = \'"""\'  # Phase 202 why\ndef h():\n    # Phase 203 heading\n    return """x"""  # Phase 204 after\n');
  const r = ids(t);
  assert.equal(r.code, 1, r.out);
  const hits = r.out.split('\n').filter(l => l.startsWith('IDS ')).map(l => l.split(' ')[1]).sort();
  assert.deepEqual(hits, ['src/m.py:6', 'src/m.py:7', 'src/n.py:5', 'src/q.py:1', 'src/q.py:3', 'src/q.py:4']);
  const u = makeRepo();
  edit(u, 'src/b1.py', 'x = f"{\'"\'}"  # Phase 201 why\n');
  edit(u, 'src/b2.py', 'z = f"{x + \"\"\"y\"\"\"}"\ndef f():\n    w = 2  # Phase 203 why\n    return 1  # Phase 213 later\n');
  edit(u, 'src/b3.py', 'v = "abc \\\ndef"  # Phase 204 why\n');
  edit(u, 'src/b5.py', 'v = "abc \\\n\"\"\" # x"\n# Phase 205 heading\ny = 1  # Phase 206 why\n');
  edit(u, 'tests/test_fix.py', 'SRC = """\ndef test_phase_210_fixture():\n    pass\n"""\ndef test_ok():\n    pass  # Phase 211 real comment\n');
  const r2 = ids(u);
  const hits2 = r2.out.split('\n').filter(l => l.startsWith('IDS ')).map(l => l.split(' ')[1]).sort();
  assert.deepEqual(hits2, ['src/b1.py:1', 'src/b2.py:3', 'src/b2.py:4', 'src/b3.py:2', 'src/b5.py:3', 'src/b5.py:4',
    'tests/test_fix.py:6']);
});

test('check-ids reads untracked, staged and committed changes', () => {
  const t = makeRepo();
  const tagged = '# Phase 200 D02: why\nx = 1\n';
  edit(t, 'src/n.py', tagged);
  let r = ids(t);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /^IDS src\/n\.py:1 /m);
  gitIn(t, 'git add src/n.py');
  assert.equal(ids(t).code, 1);
  gitIn(t, 'git commit -q -m n');
  assert.equal(ids(t).code, 0);
  edit(t, 'src/n.py', 'x = 1\n');
  assert.equal(ids(t, ['--range', 'HEAD~1..HEAD']).code, 1);
  edit(t, 'src/n.py', tagged + 'y = 2\n');
  gitIn(t, 'git add src/n.py && git commit -q -m clean');
  r = ids(t, ['--range', 'HEAD~1..HEAD']);
  assert.equal(r.code, 0, r.out);
  edit(t, 'u"v.py', '# Phase 200 D02 x\n');
  r = ids(t);
  assert.equal(r.code, 1, r.out);
  assert.ok(r.out.includes('IDS u"v.py:1 '), r.out);
});

test('check-ids exempts docs, rules and planning, and allows ledger and flag ids', () => {
  const t = makeRepo();
  for (const f of ['docs/x.md', 'README.md', '.claude/rules/r.md', '.claude/rules/x.yaml', 'docs/x.py', '.planning/p.py', 'vendor/x.py']) edit(t, f, '# Phase 200 D02 x\n');
  let r = ids(t);
  assert.equal(r.code, 0, r.out);
  edit(t, 'src/f.py', '# was FLAG-123-07 (ledger.md L005)\n# see (L022)\n');
  r = ids(t);
  assert.equal(r.code, 0, r.out);
  edit(t, 'src/g.py', '# Phase 123 FLAG-123-07\n');
  r = ids(t);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /^IDS src\/g\.py:1 /m);
});

test('check-ids bare decision ids and lookalikes', () => {
  const t = makeRepo();
  edit(t, 'a1.py', '# D03: why\n');
  edit(t, 'a2.py', '# reason (D06)\n');
  edit(t, 'a3.py', '# (D14/D15)\n');
  edit(t, 'a4.py', '# reason (see 203 D02)\n');
  let r = ids(t);
  assert.equal(r.code, 1, r.out);
  for (const f of ['a1', 'a2', 'a3', 'a4']) assert.ok(r.out.includes(`IDS ${f}.py:1 `), f + '\n' + r.out);
  const c = makeRepo();
  fs.appendFileSync(path.join(c.root, '.holden/config.yaml'), '# holden 001 D02\n');
  r = ids(c, ['.holden/config.yaml']);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /^IDS \.holden\/config\.yaml:\d+ /m);
  const l = makeRepo();
  edit(l, 'l.py', '# AD30 and XD421 and 11D222E3AB5E\n# the d06_flag column\n# version L100\n# phase 12 of the import\n# Phase 2000\n');
  r = ids(l);
  assert.equal(r.code, 0, r.out);
});

test('check-ids usage and combined flags', () => {
  const base = { ...FILES, 'src/a.py': 'x = 0\n', 'src/p.txt': 'a\nb\nc\n', 'x"y.js': 'var a = 1;\n' };
  const t = makeRepo({ files: base });
  const code = args => run('h-radius', args, { cwd: t.root, env: t.env }).code;
  assert.equal(code(['--range', 'HEAD~1..HEAD']), 2);
  assert.equal(code(['--check-ids', '--range', 'abc']), 2);
  assert.equal(code(['--check-ids', '--range']), 2);
  const h = run('h-radius', ['-h'], { cwd: t.root, env: t.env });
  assert.match(h.out, /--check-ids/);
  assert.match(h.out, /Exit 0 always for a search; 1 when/);
  assert.equal(code(['--check-ids', '--range', 'nosuch..HEAD']), 2);
  edit(t, 'src/a.py', 'x = 0\ny = 1\n');
  let r = ids(t, ['src/a.py']);
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /## src\/a\.py/);
  r = run('h-radius', ['--check-ids', '--check-refs'], { cwd: t.root, env: t.env });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /## comment path references/);
  assert.match(r.out, /ids: no planning id/);
  edit(t, 'src/p.txt', 'a\n++ b/zz\nb\nc\n# Phase 200 D02 x\n');
  r = ids(t, ['src/p.txt']);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /^IDS src\/p\.txt:5 /m);
  edit(t, 'x"y.js', 'var a = 1;\n' + SLASH2 + ' Phase 200 D02 x\n');
  r = ids(t);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /cannot read the diff header/);
});
