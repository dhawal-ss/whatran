import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installHooks, uninstallHooks } from '../src/install.js';

let root;
const settingsPath = () => path.join(root, '.claude', 'settings.json');
const readSettings = () => JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
const writeSettings = (doc) => {
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
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
    assert.ok(out.some((l) => l.startsWith('+')), 'expected an install, got: ' + out.join(' | '));
    assert.strictEqual(readSettings().hooks.Stop.length, 2);
  });

  test('installing twice does not duplicate the hook', () => {
    installHooks(root);
    installHooks(root);
    const stop = readSettings().hooks.Stop.filter((h) => h._whatran);
    assert.strictEqual(stop.length, 1);
  });

  test('a settings file that is not valid JSON is left alone', () => {
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    fs.writeFileSync(settingsPath(), '{ not json');
    const out = installHooks(root);
    assert.ok(out.some((l) => l.startsWith('!')), out.join(' | '));
    assert.strictEqual(fs.readFileSync(settingsPath(), 'utf8'), '{ not json');
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
