import fs from 'node:fs';
import path from 'node:path';
import { runSuite, summarise } from './run.js';
import { addWorktree, removeWorktree, head as gitHead } from './git.js';

export const DIR = '.whatran';
export const FILE = 'baseline.json';
// 2 added harness hashes; 3 added the unstable-test ledger; 4 is a forced
// invalidation, because the JUnit parser was rewritten and the test ids it
// produces are no longer the same strings. Comparing new ids against old ones
// would report every test in a nested describe as both removed and added.
const VERSION = 4;

export function baselinePath(root) {
  return path.join(root, DIR, FILE);
}

// `check` now writes to the baseline (the unstable ledger), so a run that is
// interrupted mid-write must not leave a half-written file behind. Write to a
// sibling and rename, rename is atomic on the same filesystem, so a reader
// sees either the old file or the new one, never a truncated one.
function writeAtomic(file, body) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, body);
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    // Windows will refuse a rename over a file another process has open.
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw err;
  }
}

export function saveBaseline(root, { runner, outcomes, ref, harness, unstable }) {
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
    // Tests observed to change outcome without any code change. Recorded so a
    // known-flaky test is reported once and then stays quiet, rather than
    // producing a fresh accusation on every run.
    unstable: unstable ? [...unstable] : [],
    outcomes: Object.fromEntries(outcomes),
  };
  writeAtomic(baselinePath(root), JSON.stringify(payload, null, 2) + '\n');
  return payload;
}

export function loadBaseline(root) {
  let raw;
  try { raw = fs.readFileSync(baselinePath(root), 'utf8'); } catch { return null; }
  let doc;
  try { doc = JSON.parse(raw); } catch { return { stale: 'unreadable' }; }
  if (!doc.outcomes) return { stale: 'unreadable' };
  // A baseline written by an older version is not the same thing as no
  // baseline at all, and saying "none recorded yet" when one is plainly sitting
  // there is the kind of message that makes people distrust the whole tool.
  if (doc.version !== VERSION) return { stale: `version ${doc.version}` };
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
export function captureFromRef(root, ref, runner, { link = true, projectDir = root, timeoutMs } = {}) {
  if (runner.lang === 'python') {
    const editable = detectEditableInstall(root);
    if (editable) {
      return {
        ok: false,
        reason: `this project is installed in editable mode (${editable.venv}/…/${editable.marker}), `
          + 'so a baseline run in a worktree would import the current source rather than the '
          + 'source at that ref, and every difference would silently disappear. Use '
          + '`whatran snapshot` before the change instead of --base.',
      };
    }
  }
  if (runner.lang === 'js' && link) {
    const workspace = detectWorkspaceLinks(root);
    if (workspace) {
      return {
        ok: false,
        reason: `this project's node_modules links back into the repository `
          + `(node_modules/${workspace} is a symlink to a package in this checkout), which is how `
          + 'every npm/pnpm/yarn workspace is laid out. Linking it into a worktree would make the '
          + 'baseline run import the CURRENT source instead of the source at that ref, so every '
          + 'difference would silently disappear. Use `whatran snapshot` before the change '
          + 'instead of --base.',
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
    // Mirror the project sub-path inside the worktree.
    const rel = path.relative(root, projectDir);
    const runIn = rel && !rel.startsWith('..') ? path.join(dir, rel) : dir;
    const res = runSuite(runner, runIn, { timeoutMs });
    if (!res.ok) {
      return {
        ok: false,
        reason: `the baseline run at ${ref.slice(0, 12)} could not complete, ${res.reason}. `
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
// commit's, base and head come out identical, every transition vanishes, and
// the tool reports a confident INTACT on a change it never actually measured.
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

// The JavaScript equivalent of an editable install. In any workspace layout
// (npm, pnpm and yarn all do this) node_modules/<pkg> is a symlink to a package
// inside the repository, so linking node_modules into a base worktree makes the
// "baseline" run execute HEAD's source. Base and head then come out identical
// and whatran reports a confident INTACT on a change it never measured, which
// is exactly the false green detectEditableInstall exists to prevent.
//
// Returns the first offending entry's name, or null.
export function detectWorkspaceLinks(root) {
  const modules = path.join(root, 'node_modules');
  const resolvedRoot = path.resolve(root);
  const insideModules = path.resolve(modules);
  const scan = (dir, prefix) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.name.startsWith('@') && e.isDirectory()) {
        const nested = scan(full, `${prefix}${e.name}/`);
        if (nested) return nested;
        continue;
      }
      if (!e.isSymbolicLink()) continue;
      let target;
      try { target = fs.realpathSync(full); } catch { continue; }
      if (!isInside(target, resolvedRoot) || isInside(target, insideModules)) continue;
      return prefix + e.name;
    }
    return null;
  };
  return scan(modules, '');
}

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// How long ago the baseline was recorded, in ms, or null if there isn't one.
// The human ledger never said this, so a baseline recorded before a long
// refactor looked exactly like one recorded a minute ago.
export function baselineAge(root) {
  const doc = loadBaseline(root);
  if (!doc || doc.stale || !doc.createdAt) return null;
  const at = Date.parse(doc.createdAt);
  return Number.isFinite(at) ? Math.max(0, Date.now() - at) : null;
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

// Updates only the unstable ledger, leaving the recorded outcomes alone. A
// check that discovers flakiness should remember it without silently moving
// the baseline it is measuring against.
export function recordUnstable(root, unstable) {
  const doc = loadBaseline(root);
  // `stale` carries no outcomes, so spreading it produced
  // "undefined is not iterable" and crashed the whole check.
  if (!doc || doc.stale) return false;
  const payload = {
    ...doc,
    outcomes: Object.fromEntries(doc.outcomes),
    unstable: [...new Set(unstable)],
  };
  try {
    writeAtomic(baselinePath(root), JSON.stringify(payload, null, 2) + '\n');
    return true;
  } catch { return false; }
}
