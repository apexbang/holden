'use strict';
// hooks/detach-guard-hook as Claude Code runs it: the executable, the tool call's JSON on stdin (bin/link:55).
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path'), cp = require('child_process');
const HOOK = path.join(__dirname, '..', 'hooks', 'detach-guard-hook');
function guard(command) {
  const r = cp.spawnSync(HOOK, [], { input: JSON.stringify({ tool_input: { command } }), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput : null;
}

test('a bare codex-ask is denied, and the reason names codex-ask', () => {
  for (const cmd of [
    '~/.claude/holden/bin/codex-ask --file /tmp/q.md',
    'bin/codex-ask --continue 2026-10-19-x --file f.md',
    'CODEX_ASK_SKIP_LIMITS=1 codex-ask --sheet --slug g --file l.md',
    'cd /x && codex-ask --file q',
    "bash -c 'codex-ask --file q'",
  ]) {
    const v = guard(cmd);
    assert.equal(v && v.permissionDecision, 'deny', cmd);
    assert.match(v.permissionDecisionReason, /codex-ask/, cmd);
  }
});

test('a detached codex-ask is allowed', () => {
  assert.equal(guard('~/.claude/bin/detach ask-1 "~/.claude/holden/bin/codex-ask --file /tmp/q.md"'), null);
});

test('codex-ask help, dry runs and reads of the file are allowed', () => {
  for (const cmd of [
    'bin/codex-ask --help',
    'bin/codex-ask --dry-run --file q.md',
    'sed -n 1,20p bin/codex-ask | head',
    'grep -n x bin/codex-ask tests/codex-ask.test.js',
    'node --test tests/codex-ask.test.js',
    'bin/codex-ask -h',
    'xcodex-ask --file q',
  ]) assert.equal(guard(cmd), null, cmd);
});

test('a bare codex-review and h-test --full are still denied', () => {
  for (const cmd of ['codex-review --kind plan 003', '~/.claude/holden/bin/h-test --full']) {
    const v = guard(cmd);
    assert.equal(v && v.permissionDecision, 'deny', cmd);
  }
  assert.equal(guard('~/.claude/bin/detach r1 "codex-review --kind plan 003"'), null);
});

test('input that is not JSON is allowed', () => {
  const r = cp.spawnSync(HOOK, [], { input: '{', encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});
