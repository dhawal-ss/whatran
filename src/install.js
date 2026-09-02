import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MARKER = 'whatran hook';

// Every entry whatran writes into somebody else's config carries this flag, and
// nothing is ever removed without it.
//
// The previous version matched the substring "whatran" anywhere in the
// serialised config. That deleted a user's own unrelated hook whose command
// merely referenced a path containing the word — demonstrated, silently, with
// no way to get it back. Never identify your own data in someone else's file by
// guessing at its contents.
const OWNED = '_whatran';

// The hook config has to name a command that will actually resolve months from
// now, on a machine that may never have installed anything. Writing
// `npx whatran` when the package is not published — or is only checked out
// locally — produces a config that silently does nothing, which is worse than
// one that fails loudly.
export function hookCommand() {
  const binPath = fileURLToPath(new URL('../bin/whatran.js', import.meta.url));
  const installed = binPath.split(path.sep).includes('node_modules');
  if (installed) return 'npx --no-install whatran hook';
  // Running from a clone: point straight at this checkout with the interpreter
  // that is running right now. Absolute, dependency-free, always resolves.
  return `${quote(process.execPath)} ${quote(binPath)} hook`;
}

function quote(p) {
  return /[\s"]/.test(p) ? `"${p.replace(/"/g, '\\"')}"` : p;
}

// Hook wiring for each harness that supports blocking a turn. Claude Code,
// Codex and Copilot all cloned the same stdin-JSON / exit-2 mechanism, so the
// same command serves all three; only the file it goes in differs.
const TARGETS = [
  {
    id: 'claude',
    label: 'Claude Code',
    file: '.claude/settings.json',
    detect: (root) => fs.existsSync(path.join(root, '.claude')) || fs.existsSync(path.join(root, 'CLAUDE.md')),
    build: (existing) => {
      const doc = existing ?? {};
      doc.hooks ??= {};
      const cmd = hookCommand();
      addHook(doc.hooks, 'SessionStart', {
        [OWNED]: true,
        hooks: [{ type: 'command', command: cmd + ' --event SessionStart', timeout: 900 }],
      });
      addHook(doc.hooks, 'Stop', {
        [OWNED]: true,
        hooks: [{ type: 'command', command: cmd, timeout: 900 }],
      });
      return doc;
    },
  },
  {
    id: 'codex',
    label: 'Codex CLI',
    file: '.codex/hooks.json',
    detect: (root) => fs.existsSync(path.join(root, '.codex')) || fs.existsSync(path.join(root, 'AGENTS.md')),
    build: (existing) => {
      const doc = existing ?? {};
      doc.hooks ??= {};
      addHook(doc.hooks, 'Stop', {
        [OWNED]: true,
        hooks: [{ type: 'command', command: hookCommand(), timeout: 900 }],
      });
      return doc;
    },
  },
  {
    id: 'cursor',
    label: 'Cursor',
    file: '.cursor/hooks.json',
    detect: (root) => fs.existsSync(path.join(root, '.cursor')),
    build: (existing) => {
      const doc = existing ?? { version: 1 };
      doc.hooks ??= {};
      // Cursor's stop hook cannot block; it re-prompts instead.
      doc.hooks.stop ??= [];
      if (!doc.hooks.stop.some(isOurs)) {
        doc.hooks.stop.push({ [OWNED]: true, command: hookCommand() });
      }
      return doc;
    },
  },
];

function isOurs(entry) {
  return Boolean(entry && typeof entry === 'object' && entry[OWNED] === true);
}

function addHook(hooks, event, entry) {
  hooks[event] ??= [];
  if (hooks[event].some(isOurs)) return;
  hooks[event].push(entry);
}

// True when this config already carries an entry whatran put there.
function alreadyInstalled(doc) {
  let found = false;
  walk(doc, (node) => { if (isOurs(node)) found = true; });
  return found;
}

function walk(node, fn) {
  if (Array.isArray(node)) { for (const v of node) { fn(v); walk(v, fn); } return; }
  if (node && typeof node === 'object') {
    fn(node);
    for (const v of Object.values(node)) walk(v, fn);
  }
}

// Config belonging to someone else. Written the same way as the baseline:
// to a sibling, then renamed, so an interrupted run cannot leave a truncated
// settings file behind and stop their agent from starting.
function writeJsonAtomic(file, doc) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n');
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw err;
  }
}

export function installHooks(root) {
  const out = [];
  const targets = TARGETS.filter((t) => t.detect(root));
  if (!targets.length) {
    // Nothing detected: still wire Claude Code, since it is the most common
    // and an unused settings file is harmless.
    targets.push(TARGETS[0]);
  }
  for (const t of targets) {
    const file = path.join(root, t.file);
    let existing = null;
    if (fs.existsSync(file)) {
      try { existing = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {
        out.push(`! ${t.file} exists but is not valid JSON — left untouched`);
        continue;
      }
      if (alreadyInstalled(existing)) {
        out.push(`· ${t.label} hook already installed`);
        continue;
      }
    }
    try {
      writeJsonAtomic(file, t.build(existing));
      out.push(`+ ${t.label} hook installed (${t.file})`);
    } catch (err) {
      out.push(`! could not write ${t.file}: ${err.message}`);
    }
  }
  ensureGitignore(root, out);
  return out;
}

export function uninstallHooks(root) {
  const out = [];
  for (const t of TARGETS) {
    const file = path.join(root, t.file);
    if (!fs.existsSync(file)) continue;
    let doc;
    try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    const removed = stripOwned(doc);
    if (!removed) continue;
    // Removing our entry can leave an empty event array that only existed
    // because we created it. Leaving litter in someone else's config is a
    // small rudeness, and it means uninstall does not truly undo install.
    pruneEmptyEvents(doc);
    try {
      writeJsonAtomic(file, doc);
      out.push(`- ${t.label} hook removed (${t.file})`);
    } catch (err) {
      out.push(`! could not write ${t.file}: ${err.message}`);
    }
  }
  if (!out.length) out.push('· no whatran hooks found');
  return out;
}

// Removes only entries whatran itself marked. Returns how many went.
function stripOwned(node) {
  let removed = 0;
  if (Array.isArray(node)) {
    for (let i = node.length - 1; i >= 0; i--) {
      if (isOurs(node[i])) { node.splice(i, 1); removed++; }
      else removed += stripOwned(node[i]);
    }
  } else if (node && typeof node === 'object') {
    for (const v of Object.values(node)) removed += stripOwned(v);
  }
  return removed;
}

function ensureGitignore(root, out) {
  const gi = path.join(root, '.gitignore');
  let text = '';
  try { text = fs.readFileSync(gi, 'utf8'); } catch { /* none yet */ }
  if (text.split(/\r?\n/).some((l) => l.trim() === '.whatran/' || l.trim() === '.whatran')) return;
  fs.writeFileSync(gi, (text && !text.endsWith('\n') ? text + '\n' : text) + `\n# ${MARKER} — local baseline, not shared\n.whatran/\n`);
  out.push('+ .whatran/ added to .gitignore');
}

// Drops event keys under `hooks` whose array is now empty.
function pruneEmptyEvents(doc) {
  const hooks = doc && typeof doc === 'object' ? doc.hooks : null;
  if (!hooks || typeof hooks !== 'object') return;
  for (const [event, entries] of Object.entries(hooks)) {
    if (Array.isArray(entries) && entries.length === 0) delete hooks[event];
  }
}
