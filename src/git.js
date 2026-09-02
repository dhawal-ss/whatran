import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

export function git(root, args, opts = {}) {
  try {
    return execFileSync('git', args, {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts,
    }).trim();
  } catch (err) {
    if (opts.tolerant) return '';
    throw new Error(`git ${args.join(' ')} failed: ${String(err.stderr || err.message).trim()}`);
  }
}

export function repoRoot(from = process.cwd()) {
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: from, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out ? path.resolve(out) : null;
  } catch { return null; }
}

export function head(root) {
  return git(root, ['rev-parse', 'HEAD'], { tolerant: true }) || null;
}

export function isDirty(root) {
  return git(root, ['status', '--porcelain'], { tolerant: true }).length > 0;
}

const toPosix = (p) => p.split(path.win32.sep).join('/');

// Files touched since `sinceRef`, plus anything currently uncommitted. An agent
// may have staged, committed, or left work in the tree; all three count.
export function changedFiles(root, sinceRef) {
  const set = new Set();
  const add = (raw) => {
    for (const line of raw.split(/\r?\n/)) {
      const f = line.trim();
      if (f) set.add(toPosix(f));
    }
  };
  add(git(root, ['diff', '--name-only', 'HEAD'], { tolerant: true }));
  add(git(root, ['diff', '--name-only', '--cached'], { tolerant: true }));
  add(git(root, ['ls-files', '--others', '--exclude-standard'], { tolerant: true }));
  if (sinceRef) {
    add(git(root, ['diff', '--name-only', `${sinceRef}..HEAD`], { tolerant: true }));
  }
  return [...set];
}

export function fileAtRef(root, ref, relPath) {
  return git(root, ['show', `${ref}:${relPath}`], { tolerant: true });
}

export function mergeBase(root, ref) {
  return git(root, ['merge-base', 'HEAD', ref], { tolerant: true }) || ref;
}

export function addWorktree(root, ref) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatran-base-'));
  // mkdtemp created it; git worktree add needs the path to not exist yet.
  fs.rmSync(dir, { recursive: true, force: true });
  git(root, ['worktree', 'add', '--detach', dir, ref]);
  return dir;
}

export function removeWorktree(root, dir) {
  git(root, ['worktree', 'remove', '--force', dir], { tolerant: true });
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

export function listFiles(root) {
  const tracked = git(root, ['ls-files'], { tolerant: true });
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard'], { tolerant: true });
  return [...new Set((tracked + '\n' + untracked).split(/\r?\n/).map((l) => l.trim()).filter(Boolean))];
}

export function listFilesAtRef(root, ref) {
  const out = git(root, ['ls-tree', '-r', '--name-only', ref], { tolerant: true });
  return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}
