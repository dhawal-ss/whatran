import fs from 'node:fs';
import path from 'node:path';
import { runSuite, summarise } from './run.js';
import { addWorktree, removeWorktree, head as gitHead } from './git.js';

export const DIR = '.adjuster';
export const FILE = 'baseline.json';
const VERSION = 1;

export function baselinePath(root) {
  return path.join(root, DIR, FILE);
}

export function saveBaseline(root, { runner, outcomes, ref }) {
  const dir = path.join(root, DIR);
  fs.mkdirSync(dir, { recursive: true });
  // The baseline is a machine artefact tied to one checkout. Committing it
  // would produce constant merge conflicts and leak nothing useful.
  const ignore = path.join(dir, '.gitignore');
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n');

  const payload = {
    version: VERSION,
    createdAt: new Date().toISOString(),
    ref: ref ?? gitHead(root),
    runner,
    summary: summarise(outcomes),
    outcomes: Object.fromEntries(outcomes),
  };
  fs.writeFileSync(baselinePath(root), JSON.stringify(payload, null, 2) + '\n');
  return payload;
}

export function loadBaseline(root) {
  let raw;
  try { raw = fs.readFileSync(baselinePath(root), 'utf8'); } catch { return null; }
  let doc;
  try { doc = JSON.parse(raw); } catch { return null; }
  if (doc.version !== VERSION || !doc.outcomes) return null;
  doc.outcomes = new Map(Object.entries(doc.outcomes));
  return doc;
}

export function clearBaseline(root) {
  try { fs.rmSync(baselinePath(root)); return true; } catch { return false; }
}

// CI path: materialise `ref` in a detached worktree and run the suite there.
//
// A worktree does not carry untracked files, so node_modules and .venv are
// absent. Rather than guess, we link the ones we can and let runSuite report
// an unusable result honestly if that wasn't enough.
export function captureFromRef(root, ref, runner, { link = true } = {}) {
  let dir;
  try {
    dir = addWorktree(root, ref);
  } catch (err) {
    return { ok: false, reason: `could not create a worktree at ${ref}: ${err.message}` };
  }
  try {
    if (link) linkDependencies(root, dir);
    const res = runSuite(runner, dir);
    if (!res.ok) {
      return {
        ok: false,
        reason: `the baseline run at ${ref.slice(0, 12)} could not complete — ${res.reason}. `
          + 'A fresh worktree has no installed dependencies, so this is usually an environment '
          + 'problem rather than a real difference.',
      };
    }
    return { ok: true, outcomes: res.outcomes };
  } finally {
    if (dir) removeWorktree(root, dir);
  }
}

const LINKABLE = ['node_modules', '.venv', 'venv', 'vendor', 'target', '.tox'];

function linkDependencies(root, worktree) {
  for (const name of LINKABLE) {
    const src = path.join(root, name);
    const dest = path.join(worktree, name);
    if (!fs.existsSync(src) || fs.existsSync(dest)) continue;
    try {
      fs.symlinkSync(src, dest, process.platform === 'win32' ? 'junction' : 'dir');
    } catch { /* symlinks may be unavailable; runSuite will report honestly */ }
  }
}
