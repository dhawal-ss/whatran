import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';

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

// NUL-delimited output, returned as fields with no trimming.
//
// git quotes any path containing a space, a quote or a non-ASCII byte, and
// octal-escapes the bytes ("caf\303\251.js"). Reading that as a filename
// produced a path that does not exist, so the MISSING-level focus-lock check
// silently skipped every test file with an accent in its name, and the
// tree-moved-on guard silently ignored every file with a space. `-z` turns both
// off at once and hands back the raw bytes.
//
// Returns { ok, fields }. `ok: false` means git could not answer, which callers
// must not confuse with "there is nothing to report".
function gitFields(root, args) {
  try {
    const out = execFileSync('git', args, {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
    });
    return { ok: true, fields: out.split('\0').filter((s) => s.length > 0) };
  } catch {
    return { ok: false, fields: [] };
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
//
// Returns { ok, files }. Every caller has to know the difference between "git
// says nothing changed" and "git could not tell me". Collapsing the two meant a
// detached HEAD, an unborn branch or a garbage-collected baseline ref read as a
// clean turn: the hook skipped the suite entirely, and `check` rewrote genuine
// MISSING findings into a flakiness NOTICE and exempted them for good.
export function changedFiles(root, sinceRef) {
  const set = new Set();
  let ok = true;
  const add = (res) => {
    if (!res.ok) { ok = false; return; }
    for (const f of res.fields) if (f) set.add(toPosix(f));
  };
  add(gitFields(root, ['diff', '--name-only', '-z', 'HEAD']));
  add(gitFields(root, ['diff', '--name-only', '-z', '--cached']));
  add(gitFields(root, ['ls-files', '--others', '--exclude-standard', '-z']));
  if (sinceRef) {
    // The ref is written into .whatran/baseline.json, a file the agent being
    // checked can edit. Gluing it into `${ref}..HEAD` let a value like
    // `--output=…` reach git as an option rather than a revision, so the
    // background hook would write a file wherever it was pointed. Passing it as
    // its own argument after --end-of-options closes that off, and refusing
    // anything that is not a hex object name closes it off again.
    if (!isObjectName(sinceRef)) return { ok: false, files: [] };
    add(gitFields(root, ['diff', '--name-only', '-z', '--end-of-options', sinceRef, 'HEAD']));
  }
  return { ok, files: [...set] };
}

const isObjectName = (ref) => typeof ref === 'string' && /^[0-9a-f]{7,64}$/.test(ref);

export function fileAtRef(root, ref, relPath) {
  if (!isObjectName(ref)) return '';
  return git(root, ['show', '--end-of-options', `${ref}:${relPath}`], { tolerant: true });
}

// Returns null when there is no common ancestor, rather than pretending the
// ref's own tip is one. Falling back to the tip silently compared against the
// wrong commit, so in CI every deletion made on the base branch since the fork
// point was reported as coverage this change had removed.
export function mergeBase(root, ref) {
  try {
    const out = execFileSync('git', ['merge-base', '--end-of-options', 'HEAD', ref], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return out || null;
  } catch { return null; }
}

export function addWorktree(root, ref) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatran-base-'));
  // mkdtemp created it; git worktree add needs the path to not exist yet.
  fs.rmSync(dir, { recursive: true, force: true });
  git(root, ['worktree', 'add', '--detach', dir, ref]);
  return dir;
}

// `git worktree remove --force` walks INTO a symlink or a Windows junction and
// deletes what it points at. Since baseline.js links the real node_modules,
// .venv, vendor and target into the worktree so the base run has its
// dependencies, that turned `whatran check --base main` into a command that
// silently emptied the user's actual node_modules. Reproduced on Windows: the
// directories survive as empty shells and every file inside is gone.
//
// fs.rmSync unlinks a reparse point rather than following it, so severing the
// links first is safe. It is done here rather than only at the call site so the
// primitive itself stops being a loaded gun: any future caller that puts a link
// in a worktree would otherwise reintroduce the same data loss.
export function removeWorktree(root, dir) {
  severLinks(dir);
  git(root, ['worktree', 'remove', '--force', dir], { tolerant: true });
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

// Unlinks every top-level symlink or junction in `dir`, leaving real
// directories alone. Top-level is where dependencies are linked; a tracked
// `vendor/` that git materialised is a real directory and is left untouched.
function severLinks(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    try {
      if (!fs.lstatSync(p).isSymbolicLink()) continue;
      fs.rmSync(p, { recursive: true, force: true });
    } catch { /* leave it to git; better than aborting the cleanup */ }
  }
}

export function listFiles(root) {
  const tracked = gitFields(root, ['ls-files', '-z']);
  const untracked = gitFields(root, ['ls-files', '--others', '--exclude-standard', '-z']);
  return [...new Set([...tracked.fields, ...untracked.fields].map(toPosix))];
}

export function listFilesAtRef(root, ref) {
  if (!isObjectName(ref)) return [];
  const res = gitFields(root, ['ls-tree', '-r', '--name-only', '-z', '--end-of-options', ref]);
  return res.fields.map(toPosix);
}

// Raw bytes of a blob at a ref, without the trimming `git()` applies.
//
// Hashing a trimmed string here and raw bytes in the working tree made every
// harness file whose content ends in a newline, which is all of them, compare
// as modified on every single CI run.
export function blobAtRef(root, ref, relPath) {
  if (!isObjectName(ref)) return null;
  try {
    return execFileSync('git', ['show', '--end-of-options', `${ref}:${relPath}`], {
      cwd: root, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024,
    });
  } catch { return null; }
}

// A cheap fingerprint of "what the working tree looked like at this moment".
//
// A check that runs in the background can outlive the state it measured: the
// agent keeps working, or the person edits a file. Reporting a finding against
// code that no longer exists is a false accusation, and an especially confusing
// one because the evidence has already vanished by the time it is read.
//
// HEAD plus the porcelain status catches adds, deletes and staging changes;
// size and mtime of each dirty file catches edits to content without paying to
// hash it. Cheap enough to take twice around every run.
//
// `matters` decides which paths count. It must be supplied, because running a
// test suite writes files: __pycache__, coverage data, build caches. Without a
// filter the fingerprint changed on the tool's own side effects and every check
// reported that the tree had moved on, which silenced the whole tool.
export function treeFingerprint(root, matters = () => true) {
  const parts = [head(root) ?? 'no-head'];
  // `-z` for the same reason as everywhere else, and because it also makes
  // renames unambiguous: porcelain v1 emits `R  new\0old\0`, which read as
  // text put both paths in one field and matched neither.
  const res = gitFields(root, ['status', '--porcelain', '-z']);
  if (!res.ok) return null;
  for (let i = 0; i < res.fields.length; i++) {
    const entry = res.fields[i];
    const flags = entry.slice(0, 2);
    const rel = toPosix(entry.slice(3));
    // A rename or copy is followed by its original path in the next field.
    if (flags[0] === 'R' || flags[0] === 'C') i++;
    if (!rel || !matters(rel)) continue;
    parts.push(flags.trim() + ' ' + rel);
    try {
      const st = fs.statSync(path.join(root, rel));
      parts.push(`${rel}:${st.size}:${Math.round(st.mtimeMs)}`);
    } catch { parts.push(`${rel}:gone`); }
  }
  return crypto.createHash('sha1').update(parts.join('\n')).digest('hex');
}

export const __test = { isObjectName };
