import { test, describe } from 'node:test';
import assert from 'node:assert';
import { runSuite, summarise } from '../src/run.js';

// A fake runner, so these can exercise the refusal paths without any test
// framework being installed. The command is a node one-liner that exits with
// whatever code the case needs; the parse function returns whatever shape is
// being tested.
const fake = (parsed, exitCode = 0) => ({
  id: 'fake',
  label: 'fake',
  outExt: '.json',
  command: () => ({ cmd: process.execPath, args: ['-e', `process.exit(${exitCode})`] }),
  parse: () => (typeof parsed === 'function' ? parsed() : parsed),
});

const outcomes = (entries) => new Map(entries);

// `ok: false` means we could not obtain a trustworthy outcome map, NOT that the
// tests failed. Every one of these paths exists so an environment problem is
// never reported as removed coverage. None of them had a test.
describe('refusing to report on evidence it does not trust', () => {
  test('a runner that is not on PATH', () => {
    const res = runSuite({
      ...fake({ outcomes: outcomes([]) }),
      command: () => ({ cmd: 'definitely-not-a-real-binary-xyz', args: [] }),
    }, process.cwd());
    assert.strictEqual(res.ok, false);
    assert.match(res.reason, /not on PATH/);
  });

  test('a report with no tests in it at all', () => {
    const res = runSuite(fake({ outcomes: outcomes([]) }), process.cwd());
    assert.strictEqual(res.ok, false);
    assert.match(res.reason, /produced no test results/);
  });

  test('a parser that throws', () => {
    const res = runSuite(fake(() => { throw new Error('bad xml'); }), process.cwd());
    assert.strictEqual(res.ok, false);
    assert.match(res.reason, /could not parse/);
  });

  // A file that failed to load takes every test in it with it, at an exit code
  // identical to an ordinary failure.
  test('a test file that would not load', () => {
    const res = runSuite(fake({
      outcomes: outcomes([['a::x', 'passed']]), seen: 1, unloadable: ['b.test.js'],
    }), process.cwd());
    assert.strictEqual(res.ok, false);
    assert.match(res.reason, /could not be loaded/);
  });

  test('a package that would not build', () => {
    const res = runSuite(fake({
      outcomes: outcomes([['a::x', 'passed']]), seen: 1, buildFailures: ['pkg/foo'],
    }), process.cwd());
    assert.strictEqual(res.ok, false);
    assert.match(res.reason, /failed to build/);
  });

  // Started and never reported: a panic or a timeout. The ids are simply
  // absent, which is indistinguishable from deletion.
  test('a test that started and never reported', () => {
    const res = runSuite(fake({
      outcomes: outcomes([['a::x', 'passed']]), seen: 1, incomplete: ['a::y'],
    }), process.cwd());
    assert.strictEqual(res.ok, false);
    assert.match(res.reason, /never reported an outcome/);
  });

  // The guard that exists to stop tests being silently lost. It used to compare
  // the reporter's own `tests=` total, which is unreliable in exactly the
  // documents where collisions happen, so it was unreachable when it mattered.
  test('two tests that collided onto one id', () => {
    const res = runSuite(fake({
      outcomes: outcomes([['a::x', 'passed']]), seen: 2,
    }), process.cwd());
    assert.strictEqual(res.ok, false);
    assert.match(res.reason, /distinct\s+identities/);
  });

  test('a reporter claiming more tests than it wrote down', () => {
    const res = runSuite(fake({
      outcomes: outcomes([['a::x', 'passed']]), seen: 1, declared: 5,
    }), process.cwd());
    assert.strictEqual(res.ok, false);
    assert.match(res.reason, /lost before whatran could read them/);
  });

  test('a report the parser could not read the way it expects', () => {
    const res = runSuite(fake({
      outcomes: outcomes([['a::x', 'passed']]), seen: 1, malformed: 2,
    }), process.cwd());
    assert.strictEqual(res.ok, false);
    assert.match(res.reason, /could not be read/);
  });
});

describe('accepting evidence it does trust', () => {
  test('a clean run with matching counts', () => {
    const res = runSuite(fake({
      outcomes: outcomes([['a::x', 'passed'], ['a::y', 'failed']]), seen: 2, declared: 2,
    }), process.cwd());
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.outcomes.size, 2);
  });

  // Test failures are not a reason to refuse: a red suite is the interesting
  // case, because it is the one an agent is about to be asked to fix.
  test('a failing suite is still a usable result', () => {
    const res = runSuite(fake({
      outcomes: outcomes([['a::x', 'failed']]), seen: 1,
    }, 1), process.cwd());
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.exitCode, 1);
  });

  test('fewer records than ids is not a collision', () => {
    const res = runSuite(fake({
      outcomes: outcomes([['a::x', 'passed'], ['a::y', 'passed']]), seen: 2, declared: 1,
    }), process.cwd());
    assert.strictEqual(res.ok, true);
  });
});

describe('summarising', () => {
  test('counts each outcome', () => {
    const s = summarise(outcomes([['a', 'passed'], ['b', 'failed'], ['c', 'skipped'], ['d', 'passed']]));
    assert.deepStrictEqual(s, { total: 4, passed: 2, failed: 1, skipped: 1 });
  });

  test('an empty suite is all zeroes', () => {
    assert.deepStrictEqual(summarise(new Map()), { total: 0, passed: 0, failed: 0, skipped: 0 });
  });
});
