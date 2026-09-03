import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  changedFiles, treeFingerprint, listFiles, addWorktree, removeWorktree, mergeBase, head,
} from '../src/git.js';
import { isTrackedEdit } from '../src/relevance.js';

let dir;
const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
const write = (rel, body) => {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
};

before(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'whatran-git-')));
  git('init', '-q');
  git('config', 'user.email', 'a@b.c');
  git('config', 'user.name', 't');
  git('config', 'commit.gpgsign', 'false');
  write('a.js', 'export const a = 1;\n');
  git('add', '-A');
  git('commit', '-qm', 'one');
});
after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

// git quotes any path containing a space, a quote or a non-ASCII byte, and
// octal-escapes the bytes ("caf\303\251.js"). Read as a filename that is a path
// which does not exist, so the checks that OPEN these files silently skipped
// them: the focus-lock check, which is the one that blocks a turn.
describe('paths git would otherwise quote or escape', () => {
  const awkward = ['two words.test.js', 'café.test.js', "quote'name.test.js"];

  test('come back as paths that can actually be opened', () => {
    for (const name of awkward) write(name, 'test.only("x", () => {});\n');
    const { ok, files } = changedFiles(dir, null);
    assert.ok(ok);
    for (const name of awkward) {
      assert.ok(files.includes(name), `${name} missing from ${JSON.stringify(files)}`);
      assert.ok(fs.existsSync(path.join(dir, name)), `${name} is not a real path`);
    }
  });

  test('listFiles sees them too', () => {
    const listed = listFiles(dir);
    for (const name of awkward) assert.ok(listed.includes(name), `${name} missing`);
  });

  test('and an edit to one moves the tree fingerprint', () => {
    const before = treeFingerprint(dir, isTrackedEdit);
    write('two words.test.js', 'test.only("changed", () => {});\n');
    assert.notStrictEqual(treeFingerprint(dir, isTrackedEdit), before);
  });

  after(() => {
    for (const name of awkward) { try { fs.rmSync(path.join(dir, name)); } catch { /* ignore */ } }
  });
});

describe('saying so when git cannot answer', () => {
  // Collapsing "nothing changed" into "I could not tell" made a git failure
  // read as a clean turn: the hook skipped the suite entirely, and check
  // rewrote real findings into a flakiness notice and exempted them for good.
  test('an unusable ref is reported as a failure, not as no changes', () => {
    const res = changedFiles(dir, 'not-a-real-ref');
    assert.strictEqual(res.ok, false);
  });

  test('a real ref answers cleanly', () => {
    const res = changedFiles(dir, head(dir));
    assert.strictEqual(res.ok, true);
  });

  // The ref comes out of .whatran/baseline.json, which the agent under test can
  // edit. Glued into `${ref}..HEAD` a value like `--output=…` reached git as an
  // option, so a background hook would write a file wherever it was pointed.
  test('a ref that looks like an option is refused, not executed', () => {
    const target = path.join(dir, 'PWNED.txt');
    const res = changedFiles(dir, `--output=${target}`);
    assert.strictEqual(res.ok, false);
    assert.ok(!fs.existsSync(target), 'git must not have been given an option to obey');
  });
});

describe('finding a merge base', () => {
  // Falling back to the ref's own tip silently compared against the wrong
  // commit, so in CI every deletion made on the base branch since the fork
  // point was reported as coverage this change had removed.
  test('returns null when there is no common ancestor', () => {
    assert.strictEqual(mergeBase(dir, 'no-such-branch'), null);
  });

  test('returns the commit when there is one', () => {
    assert.strictEqual(mergeBase(dir, 'HEAD'), head(dir));
  });
});

// The data-loss bug: `git worktree remove --force` walks INTO a junction or
// symlink and deletes what it points at. baseline.js links the real
// node_modules / .venv into the worktree so the base run has its dependencies,
// so `whatran check --base main` emptied the user's actual node_modules.
describe('removing a worktree that has dependencies linked into it', () => {
  test('does not delete what the links point at', () => {
    const real = path.join(dir, 'node_modules');
    fs.mkdirSync(real, { recursive: true });
    fs.mkdirSync(path.join(real, 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(real, 'PRECIOUS.txt'), 'do not delete');
    fs.writeFileSync(path.join(real, 'pkg', 'index.js'), 'module.exports = 1;\n');

    const wt = addWorktree(dir, head(dir));
    try {
      fs.symlinkSync(real, path.join(wt, 'node_modules'),
        process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      // Symlinks may be unavailable for this user; nothing to prove then.
      removeWorktree(dir, wt);
      return;
    }
    assert.ok(fs.existsSync(path.join(wt, 'node_modules', 'PRECIOUS.txt')), 'link is live');

    removeWorktree(dir, wt);

    assert.ok(fs.existsSync(path.join(real, 'PRECIOUS.txt')), 'the real file must survive');
    assert.ok(fs.existsSync(path.join(real, 'pkg', 'index.js')), 'nested files must survive too');
    assert.ok(!fs.existsSync(wt), 'and the worktree must still be gone');

    fs.rmSync(real, { recursive: true, force: true });
  });
});
