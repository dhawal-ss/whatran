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
export function hookCommand(root) {
  const binPath = fileURLToPath(new URL('../bin/whatran.js', import.meta.url));
  const segments = binPath.split(path.sep);

  // npx caches packages under <npm-cache>/_npx/<hash>/node_modules/<pkg>, so
  // "is it under node_modules" wrongly reported an npx run as a real install
  // and wrote `npx --no-install whatran hook` — which errors out, because the
  // package is not in the project. Claude Code treats a non-zero, non-2 exit as
  // a silent non-blocking error, so the hook died quietly and forever while
  // init reported success.
  if (segments.includes('_npx')) return { command: `npx --yes whatran hook`, ephemeral: true };

  // A project-local install: relative, so it survives being committed and
  // works for every teammate.
  if (root) {
    const rel = path.relative(root, binPath);
    if (segments.includes('node_modules') && rel && !rel.startsWith('..')) {
      return { command: `node ${quote(rel.split(path.sep).join('/'))} hook`, ephemeral: false };
    }
  }

  // Running from a clone: point straight at this checkout with the interpreter
  // running right now. Absolute and machine-specific, so it must not be
  // committed — the caller writes it to a local settings file.
  return { command: `${quote(process.execPath)} ${quote(binPath)} hook`, ephemeral: false, local: true };
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
    localFile: '.claude/settings.local.json',
    detect: (root) => fs.existsSync(path.join(root, '.claude')) || fs.existsSync(path.join(root, 'CLAUDE.md')),
    build: (existing, root) => {
      const doc = existing ?? {};
      doc.hooks ??= {};
      const cmd = hookCommand(root).command;
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
    build: (existing, root) => {
      const doc = existing ?? {};
      doc.hooks ??= {};
      addHook(doc.hooks, 'Stop', {
        [OWNED]: true,
        hooks: [{ type: 'command', command: hookCommand(root).command, timeout: 900 }],
      });
      return doc;
    },
  },
  {
    id: 'cursor',
    label: 'Cursor',
    file: '.cursor/hooks.json',
    detect: (root) => fs.existsSync(path.join(root, '.cursor')),
    build: (existing, root) => {
      const doc = existing ?? { version: 1 };
      doc.hooks ??= {};
      // Cursor's stop hook cannot block and cannot read stderr: its only
      // channel is a `followup_message` on stdout. The hook has to be told
      // which harness invoked it, because it has no other way to know.
      doc.hooks.stop ??= [];
      if (!doc.hooks.stop.some(isOurs)) {
        doc.hooks.stop.push({ [OWNED]: true, command: hookCommand(root).command + ' --harness cursor' });
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
    // Writing config for a harness that is not here is exactly the behaviour
    // people resent in other tools. Say what to do instead.
    out.push('· no agent harness detected here — nothing installed');
    out.push('  run `whatran check` yourself, or add it to CI with `whatran check --base main`');
    return out;
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
      writeJsonAtomic(file, t.build(existing, root));
      out.push(`+ ${t.label} hook installed (${t.file})`);
    } catch (err) {
      out.push(`! could not write ${t.file}: ${err.message}`);
    }
  }
  suggestGitignore(root, out);
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

// Deliberately does NOT edit the user's .gitignore. Appending to a file nobody
// asked you to touch is the most-resented behaviour in tools of this kind.
// saveBaseline already writes `.whatran/.gitignore` containing `*`, which is
// self-contained and is the convention ruff and pytest both use — so this is a
// suggestion for people who would rather have it listed in one place.
function suggestGitignore(root, out) {
  const gi = path.join(root, '.gitignore');
  let text = '';
  try { text = fs.readFileSync(gi, 'utf8'); } catch { /* none yet */ }
  if (text.split(/\r?\n/).some((l) => l.trim() === '.whatran/' || l.trim() === '.whatran')) return;
  out.push(`· ${MARKER}: .whatran/ already ignores itself — add it to .gitignore only if you prefer it listed there`);
}

// Drops event keys under `hooks` whose array is now empty.
function pruneEmptyEvents(doc) {
  const hooks = doc && typeof doc === 'object' ? doc.hooks : null;
  if (!hooks || typeof hooks !== 'object') return;
  for (const [event, entries] of Object.entries(hooks)) {
    if (Array.isArray(entries) && entries.length === 0) delete hooks[event];
  }
}
