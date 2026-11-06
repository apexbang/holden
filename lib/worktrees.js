'use strict';
// Shared by bin/h-test and bin/h-worktree: find and remove h-test proof worktrees whose owner
// process is gone. A proof worktree is named h-test-wt-<pid>-<random> in the tmp dir; h-test
// removes its own on exit, and a killed h-test (SIGKILL, or a signal while its tests block the
// event loop) leaves one behind. The next h-test in the same repo, or h-worktree sweep, reaps it.
const fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process');

function listWorktrees(root) {
  const out = cp.execSync('git worktree list --porcelain', { cwd: root, encoding: 'utf8' });
  return out.split('\n\n').filter(Boolean).map(block => {
    const w = {};
    for (const line of block.split('\n')) {
      const i = line.indexOf(' ');
      const k = i < 0 ? line : line.slice(0, i), v = i < 0 ? true : line.slice(i + 1);
      w[k] = v;
    }
    return w;
  });
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
// A pre-pid name (h-test-wt-XXXXXX) has no owner to ask; it counts as dead after six hours.
function proofOwnerDead(dir) {
  const m = path.basename(dir).match(/^h-test-wt-(\d+)-/);
  if (m) return !alive(Number(m[1]));
  try { return Date.now() - fs.statSync(dir).mtimeMs > 6 * 3600 * 1000; } catch (e) { return true; }
}
function deadProofs(root) {
  const tmp = os.tmpdir() + path.sep;
  return listWorktrees(root).map(w => w.worktree).filter(d => d && d.startsWith(tmp + 'h-test-wt-') && proofOwnerDead(d));
}
// Proof worktrees hold nothing but a checkout and test output, so --force is right here and only here.
function reapDeadProofs(root) {
  const gone = [];
  for (const d of deadProofs(root)) {
    try { cp.execSync(`git worktree remove --force "${d}"`, { cwd: root, stdio: 'ignore' }); gone.push(d); } catch (e) {}
  }
  try { cp.execSync('git worktree prune', { cwd: root, stdio: 'ignore' }); } catch (e) {}
  return gone;
}
module.exports = { listWorktrees, deadProofs, reapDeadProofs, alive };
