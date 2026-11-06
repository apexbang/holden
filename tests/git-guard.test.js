'use strict';
// The executor git guard sees through bin/h-machine run (phase 001 D06): executors run every
// Verify through it, so a git command or a test runner behind it is judged as if typed bare.
const { test } = require('node:test');
const assert = require('node:assert');
const { verdict, isTestRun } = require('../hooks/holden-executor-git-guard.js');

test('h-machine run -- git merge is refused', () => {
  assert.match(String(verdict('h-machine run -- git merge x')), /merging belongs to h-worktree land/);
});

test('h-machine run --label x -- git stash is refused', () => {
  assert.match(String(verdict('h-machine run --label x -- git stash')), /git stash/);
});

test('h-machine run -- pytest is a test run', () => {
  assert.equal(isTestRun('h-machine run -- pytest tests/x.py'), true);
});

test('h-machine run -- echo is allowed', () => {
  assert.equal(verdict('~/.claude/holden/bin/h-machine run -- echo hi'), null);
});

test('timeout 60 git merge is still refused', () => {
  assert.notEqual(verdict('timeout 60 git merge x'), null);
});

test('h-machine run with one quoted shell string is judged as typed', () => {
  assert.match(String(verdict(`h-machine run -- 'git merge x'`)), /merging belongs to h-worktree land/);
  assert.equal(isTestRun(`h-machine run -- 'pytest tests/x.py -q'`), true);
  assert.equal(verdict(`h-machine run -- 'node --test tests/x.test.js'`), null);
});

// Phase 002 D04 routes every main-checkout commit through `h-queue lock -- '...'`; the guard judges
// the wrapped command as typed.
test('h-queue lock -- with a quoted git reset --hard is refused', () => {
  assert.match(String(verdict("~/.claude/holden/bin/h-queue lock -- 'git add a.txt && git reset --hard'")), /reset/);
});

test('h-queue freeze --label x -- git stash is refused', () => {
  assert.match(String(verdict('h-queue freeze --label x -- git stash')), /git stash/);
});

test('h-queue lock -- a plain commit is allowed', () => {
  assert.equal(verdict("h-queue lock -- 'git add a.txt && git commit -m \"feat: x\"'"), null);
});
