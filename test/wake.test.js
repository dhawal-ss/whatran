import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { shouldWake, clearWake, acquireLock, fingerprintFindings } from '../src/wake.js';
import { treeFingerprint, git } from '../src/git.js';
import { isRelevantFile } from '../src/relevance.js';

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatran-wake-')); });
afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

const finding = (evidence) => [{ code: 'failing-test-silenced', evidence }];

// A hook that fires every turn with an instruction the agent cannot satisfy is
// worse than no hook. Claude Code gives up after a run of consecutive
// synchronous blocks, but whether that counter covers a background rewake is
// undocumented, so whatran keeps its own.
describe('not saying the same thing forever', () => {
  test('allows a few attempts, then stops', () => {
    const f = finding(['a::x']);
    const results = [1, 2, 3, 4, 5].map(() => shouldWake(dir, f).allowed);
    assert.deepStrictEqual(results, [true, true, true, false, false]);
  });

  // Fixing one of several problems is progress, and progress should buy more
  // attempts rather than counting against the agent.
  test('a different finding resets the count', () => {
    const a = finding(['a::x']);
    shouldWake(dir, a); shouldWake(dir, a); shouldWake(dir, a);
    assert.strictEqual(shouldWake(dir, a).allowed, false, 'the same finding is exhausted');
    assert.strictEqual(shouldWake(dir, finding(['a::y'])).allowed, true, 'a new one starts fresh');
  });

  test('a clean run clears the count entirely', () => {
    const f = finding(['a::x']);
    shouldWake(dir, f); shouldWake(dir, f); shouldWake(dir, f);
    clearWake(dir);
    assert.strictEqual(shouldWake(dir, f).attempt, 1);
  });

  test('the fingerprint ignores the order evidence arrives in', () => {
    assert.strictEqual(
      fingerprintFindings([{ code: 'c', evidence: ['b', 'a'] }]),
      fingerprintFindings([{ code: 'c', evidence: ['a', 'b'] }]),
    );
  });
});

describe('one check at a time', () => {
  test('a second caller stands down while the first holds it', () => {
    const first = acquireLock(dir);
    assert.ok(first, 'the first caller should get the lock');
    assert.strictEqual(acquireLock(dir), null, 'the second should not');
    first();
    assert.ok(acquireLock(dir), 'releasing frees it again');
  });

  // A lock left behind by a killed process must not silence the tool forever.
  test('a lock held by a dead process is taken over', () => {
    fs.mkdirSync(path.join(dir, '.whatran'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.whatran', 'check.lock'),
      JSON.stringify({ pid: 999999999, at: Date.now() }),
    );
    assert.ok(acquireLock(dir), 'a lock from a process that no longer exists is not honoured');
  });
});

describe('noticing the tree move underneath a run', () => {
  const run = (args) => git(dir, args, { tolerant: true });

  beforeEach(() => {
    run(['init']);
    run(['config', 'user.email', 'test@example.com']);
    run(['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(dir, 'a.js'), 'export const a = 1;\n');
    run(['add', '-A']);
    run(['commit', '-qm', 'init']);
  });

  test('an edit to source changes the fingerprint', () => {
    const before = treeFingerprint(dir, isRelevantFile);
    fs.writeFileSync(path.join(dir, 'a.js'), 'export const a = 2;\n');
    assert.notStrictEqual(treeFingerprint(dir, isRelevantFile), before);
  });

  // The bug this filter exists for: running a suite writes __pycache__ and
  // other caches, so an unfiltered fingerprint changed on the tool's own side
  // effects and every check reported that the tree had moved on.
  test('build artefacts written by the suite do not', () => {
    const before = treeFingerprint(dir, isRelevantFile);
    fs.mkdirSync(path.join(dir, '__pycache__'), { recursive: true });
    fs.writeFileSync(path.join(dir, '__pycache__', 'a.pyc'), 'bytes');
    fs.writeFileSync(path.join(dir, 'coverage.log'), 'noise');
    assert.strictEqual(treeFingerprint(dir, isRelevantFile), before);
  });

  test('reverting a change restores the original fingerprint', () => {
    const before = treeFingerprint(dir, isRelevantFile);
    fs.writeFileSync(path.join(dir, 'b.js'), 'export const b = 1;\n');
    assert.notStrictEqual(treeFingerprint(dir, isRelevantFile), before);
    fs.rmSync(path.join(dir, 'b.js'));
    assert.strictEqual(treeFingerprint(dir, isRelevantFile), before);
  });
});
