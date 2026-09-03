import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installHooks, uninstallHooks, hookCommand, installedTargets, __test } from '../src/install.js';

let root;

// Running from a clone produces a machine-specific absolute command, which must
// go to the settings file git ignores rather than the shared one. Which file
// that is decides where every assertion below looks.
const settingsRel = () => (hookCommand(root).local ? '.claude/settings.local.json' : '.claude/settings.json');
const settingsPath = () => path.join(root, settingsRel());
const readSettings = () => JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
const writeSettings = (doc) => {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(doc, null, 2));
};

// A hook the user wrote, whose command happens to mention whatran's own path.
// This is not contrived: anyone with this repo checked out has such a path.
const THEIRS = {
  hooks: [{ type: 'command', command: 'node /home/me/whatran-notes/my-own-thing.js' }],
};
const UNRELATED = { hooks: [{ type: 'command', command: 'npm run lint' }] };

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'whatran-inst-'));
  // installHooks deliberately refuses to create config for a harness that is
  // not there, so every case starts with a Claude Code project.
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
});
afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('installing into somebody else\'s config', () => {
  test('adds a hook without disturbing existing ones', () => {
    writeSettings({ hooks: { Stop: [structuredClone(UNRELATED)] } });
    installHooks(root);
    const stop = readSettings().hooks.Stop;
    assert.strictEqual(stop.length, 2);
    assert.strictEqual(stop[0].hooks[0].command, 'npm run lint');
  });

  // The bug: install used to see the substring "whatran" anywhere in the file
  // and conclude its own hook was present, so it installed nothing at all.
  test('still installs when an unrelated hook merely mentions whatran', () => {
    writeSettings({ hooks: { Stop: [structuredClone(THEIRS)] } });
    const out = installHooks(root);
    assert.ok(out.lines.some((l) => l.startsWith('+')), 'expected an install, got: ' + out.lines.join(' | '));
    assert.strictEqual(readSettings().hooks.Stop.length, 2);
  });

  test('installing twice does not duplicate the hook', () => {
    installHooks(root);
    installHooks(root);
    const stop = readSettings().hooks.Stop.filter((h) => h._whatran);
    assert.strictEqual(stop.length, 1);
  });

  // A config carrying our marker but a stale or half-written command was
  // treated as done, so it was never repaired and never upgraded.
  test('a stale command of ours is replaced, not left alone', () => {
    installHooks(root);
    const doc = readSettings();
    doc.hooks.Stop.find((h) => h._whatran).hooks[0].command = 'whatran-from-2019 hook';
    writeSettings(doc);

    installHooks(root);
    const ours = readSettings().hooks.Stop.filter((h) => h._whatran);
    assert.strictEqual(ours.length, 1, 'still exactly one of ours');
    assert.strictEqual(ours[0].hooks[0].command, hookCommand(root).command);
  });

  // A partially installed config (Stop written, SessionStart missing) used to
  // satisfy the "already installed" check forever.
  test('a missing event is filled in rather than reported as installed', () => {
    installHooks(root);
    const doc = readSettings();
    delete doc.hooks.SessionStart;
    writeSettings(doc);

    installHooks(root);
    assert.ok(readSettings().hooks.SessionStart.some((h) => h._whatran));
  });

  test('a settings file that is not valid JSON is left alone', () => {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), '{ not json');
    const out = installHooks(root);
    assert.ok(out.lines.some((l) => l.startsWith('!')), out.lines.join(' | '));
    assert.strictEqual(out.failed, 1);
    assert.strictEqual(fs.readFileSync(settingsPath(), 'utf8'), '{ not json');
  });

  // A byte order mark is what a Windows editor leaves behind. Refusing on it
  // reported a perfectly good settings file as corrupt.
  test('a byte order mark does not make the config unreadable', () => {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), '﻿' + JSON.stringify({ hooks: {} }));
    const out = installHooks(root);
    assert.ok(out.lines.some((l) => l.startsWith('+')), out.lines.join(' | '));
    assert.strictEqual(out.failed, 0);
  });

  // The caller has to be able to say "you are protected" only when that is
  // true. Parsing prose to find out is how it came to say it when it wasn't.
  test('reports a machine-readable count, not just prose', () => {
    const out = installHooks(root);
    assert.strictEqual(out.installed, 1);
    assert.strictEqual(out.failed, 0);
  });

  test('nothing is installed, and nothing is claimed, without a harness', () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'whatran-bare-'));
    try {
      const out = installHooks(bare);
      assert.strictEqual(out.installed, 0);
      assert.ok(!fs.existsSync(path.join(bare, '.claude')));
      assert.ok(!fs.existsSync(path.join(bare, '.codex')));
    } finally { fs.rmSync(bare, { recursive: true, force: true }); }
  });

  // AGENTS.md is a cross-tool convention now. Treating it as evidence of Codex
  // wrote .codex/hooks.json into repositories that never ran Codex.
  test('AGENTS.md alone does not create a Codex config', () => {
    fs.writeFileSync(path.join(root, 'AGENTS.md'), '# agents\n');
    installHooks(root);
    assert.ok(!fs.existsSync(path.join(root, '.codex')));
  });

  // The absolute path names this machine's node binary and this checkout.
  // Committing it gives every teammate a hook that silently does nothing.
  test('a machine-specific command is written to the local settings file', () => {
    const cmd = hookCommand(root);
    if (!cmd.local) return; // installed as a dependency; nothing to prove here
    installHooks(root);
    assert.ok(fs.existsSync(path.join(root, '.claude/settings.local.json')));
    assert.ok(!fs.existsSync(path.join(root, '.claude/settings.json')));
  });
});

describe('the /whatran command', () => {
  test('is installed for Claude Code and carries the ownership marker', () => {
    installHooks(root);
    const body = fs.readFileSync(path.join(root, '.claude/commands/whatran.md'), 'utf8');
    assert.ok(body.includes(__test.MD_MARKER));
    assert.ok(body.startsWith('---'), 'needs frontmatter to be a slash command');
    assert.match(body, /^description:/m);
  });

  // Same rule as the JSON marker: never remove or overwrite what we did not
  // write.
  test('a file we did not write is left untouched', () => {
    const file = path.join(root, '.claude/commands/whatran.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'my own command\n');
    installHooks(root);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'my own command\n');

    uninstallHooks(root);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'my own command\n');
  });

  test('uninstall removes the one we did write', () => {
    installHooks(root);
    uninstallHooks(root);
    assert.ok(!fs.existsSync(path.join(root, '.claude/commands/whatran.md')));
  });
});

describe('uninstalling', () => {
  // The demonstrated data-loss bug: `uninstall` removed any entry whose
  // serialised JSON contained "whatran", including hooks the user wrote.
  test('removes only its own entries, never the user\'s', () => {
    writeSettings({ hooks: { Stop: [structuredClone(THEIRS), structuredClone(UNRELATED)] } });
    installHooks(root);
    assert.strictEqual(readSettings().hooks.Stop.length, 3);

    uninstallHooks(root);
    const stop = readSettings().hooks.Stop;
    assert.strictEqual(stop.length, 2, 'both user hooks must survive');
    assert.deepStrictEqual(
      stop.map((h) => h.hooks[0].command),
      ['node /home/me/whatran-notes/my-own-thing.js', 'npm run lint'],
    );
    assert.ok(!stop.some((h) => h._whatran), 'our own entry must be gone');
  });

  test('reports honestly when there is nothing of ours to remove', () => {
    writeSettings({ hooks: { Stop: [structuredClone(THEIRS)] } });
    const out = uninstallHooks(root);
    assert.ok(out.some((l) => l.includes('no whatran hooks found')), out.join(' | '));
    assert.strictEqual(readSettings().hooks.Stop.length, 1);
  });

  test('install then uninstall leaves the file as it started', () => {
    const original = { hooks: { Stop: [structuredClone(UNRELATED)] } };
    writeSettings(original);
    const before = fs.readFileSync(settingsPath(), 'utf8');
    installHooks(root);
    uninstallHooks(root);
    assert.deepStrictEqual(readSettings(), JSON.parse(before));
  });
});

describe('reporting what is actually wired up', () => {
  test('says nothing is installed before install', () => {
    assert.deepStrictEqual(installedTargets(root), []);
  });

  test('finds the hook after install', () => {
    installHooks(root);
    const found = installedTargets(root);
    assert.strictEqual(found.length, 1);
    assert.strictEqual(found[0].id, 'claude');
  });

  test('says nothing is installed again after uninstall', () => {
    installHooks(root);
    uninstallHooks(root);
    assert.deepStrictEqual(installedTargets(root), []);
  });
});
