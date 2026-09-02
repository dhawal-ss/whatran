import fs from 'node:fs';
import path from 'node:path';

const MARKER = 'adjuster hook';

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
      const cmd = 'npx --no-install adjuster hook';
      addHook(doc.hooks, 'SessionStart', {
        hooks: [{ type: 'command', command: cmd + ' --event SessionStart', timeout: 900 }],
      });
      addHook(doc.hooks, 'Stop', {
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
        hooks: [{ type: 'command', command: 'npx --no-install adjuster hook', timeout: 900 }],
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
      if (!JSON.stringify(doc.hooks.stop).includes('adjuster')) {
        doc.hooks.stop.push({ command: 'npx --no-install adjuster hook' });
      }
      return doc;
    },
  },
];

function addHook(hooks, event, entry) {
  hooks[event] ??= [];
  if (JSON.stringify(hooks[event]).includes('adjuster')) return;
  hooks[event].push(entry);
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
      if (JSON.stringify(existing).includes('adjuster')) {
        out.push(`· ${t.label} hook already installed`);
        continue;
      }
    }
    const doc = t.build(existing);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
    out.push(`+ ${t.label} hook installed (${t.file})`);
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
    const before = JSON.stringify(doc);
    stripAdjuster(doc);
    const after = JSON.stringify(doc);
    if (before !== after) {
      fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
      out.push(`- ${t.label} hook removed (${t.file})`);
    }
  }
  if (!out.length) out.push('· no adjuster hooks found');
  return out;
}

function stripAdjuster(node) {
  if (Array.isArray(node)) {
    for (let i = node.length - 1; i >= 0; i--) {
      if (JSON.stringify(node[i]).includes('adjuster')) node.splice(i, 1);
      else stripAdjuster(node[i]);
    }
  } else if (node && typeof node === 'object') {
    for (const v of Object.values(node)) stripAdjuster(v);
  }
}

function ensureGitignore(root, out) {
  const gi = path.join(root, '.gitignore');
  let text = '';
  try { text = fs.readFileSync(gi, 'utf8'); } catch { /* none yet */ }
  if (text.split(/\r?\n/).some((l) => l.trim() === '.adjuster/' || l.trim() === '.adjuster')) return;
  fs.writeFileSync(gi, (text && !text.endsWith('\n') ? text + '\n' : text) + `\n# ${MARKER} — local baseline, not shared\n.adjuster/\n`);
  out.push('+ .adjuster/ added to .gitignore');
}
