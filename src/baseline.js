import fs from 'node:fs';
import path from 'node:path';
import { runSuite, summarise } from './run.js';
import { addWorktree, removeWorktree, head as gitHead } from './git.js';

export const DIR = '.adjuster';
export const FILE = 'baseline.json';
const VERSION = 2; // 2 adds recorded harness-file hashes

export function baselinePath(root) {
  return path.join(root, DIR, FILE);
}

export function saveBaseline(root, { runner, outcomes, ref, harness }) {
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
    harness: harness ? Object.fromEntries(harness) : {},
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
  if (runner.lang === 'python') {
    const editable = detectEditableInstall(root);
    if (editable) {
      return {
        ok: false,
        reason: `this project is installed in editable mode (${editable.venv}/…/${editable.marker}), `
          + 'so a baseline run in a worktree would import the current source rather than the '
          + 'source at that ref, and every difference would silently disappear. Use '
          + '`adjuster snapshot` before the change instead of --base.',
      };
    }
  }
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

// A Python editable install (`pip install -e .`) writes a .pth or .egg-link
// into site-packages pointing at the ORIGINAL checkout. Linking that venv into
// a worktree means the base run imports HEAD's source instead of the base
// commit's — base and head come out identical, every transition vanishes, and
// the tool reports a confident ALLOWED on a change it never actually measured.
//
// A false green is the worst possible failure direction, so this refuses to
// guess. Detection is a directory scan, not a heuristic about behaviour.
export function detectEditableInstall(root) {
  for (const venv of ['.venv', 'venv']) {
    const base = path.join(root, venv);
    if (!fs.existsSync(base)) continue;
    for (const sp of sitePackages(base)) {
      let entries;
      try { entries = fs.readdirSync(sp); } catch { continue; }
      for (const name of entries) {
        if (name.endsWith('.egg-link')) return { venv, marker: name };
        if (!name.endsWith('.pth')) continue;
        if (name.startsWith('__editable__')) return { venv, marker: name };
        // A plain .pth whose body points back at the repo is the same hazard.
        try {
          const body = fs.readFileSync(path.join(sp, name), 'utf8');
          const normalisedRoot = path.resolve(root).replace(/\\/g, '/').toLowerCase();
          if (body.replace(/\\/g, '/').toLowerCase().includes(normalisedRoot)) {
            return { venv, marker: name };
          }
        } catch { /* unreadable; ignore */ }
      }
    }
  }
  return null;
}

function sitePackages(venvRoot) {
  const out = [];
  const candidates = [path.join(venvRoot, 'Lib', 'site-packages')];
  const libDir = path.join(venvRoot, 'lib');
  try {
    for (const d of fs.readdirSync(libDir)) candidates.push(path.join(libDir, d, 'site-packages'));
  } catch { /* no posix lib dir */ }
  for (const c of candidates) if (fs.existsSync(c)) out.push(c);
  return out;
}
