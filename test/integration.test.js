// End-to-end tests against a real git repository with a real test runner.
// Uses node:test as the fixture runner so these need nothing installed.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { whatran, snapshot, MISSING, NOTICE, INTACT } from '../src/whatran.js';

let repo;

const SOURCE = `export function sum(a, b) { return a + b; }
export function product(a, b) { return a + b; }
`;

const TESTS = `import { test } from 'node:test';
import assert from 'node:assert';
import { sum, product } from '../sum.js';

test('sum adds', () => { assert.strictEqual(sum(2, 3), 5); });
test('product multiplies', () => { assert.strictEqual(product(2, 3), 6); });
test('sum handles zero', () => { assert.strictEqual(sum(0, 0), 0); });
`;

const write = (rel, body) => fs.writeFileSync(path.join(repo, rel), body);
const read = (rel) => fs.readFileSync(path.join(repo, rel), 'utf8');
const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });

function reset() {
  git('checkout', '--', '.');
  for (const f of fs.readdirSync(repo)) {
    if (f === 'conftest.py' || f === 'jest.config.js') fs.rmSync(path.join(repo, f), { force: true });
  }
}

before(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'whatran-it-'));
  fs.mkdirSync(path.join(repo, 'test'));
  write('package.json', JSON.stringify({ name: 'fixture', version: '1.0.0', type: 'module' }, null, 2));
  write('sum.js', SOURCE);
  write('test/sum.test.js', TESTS);
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('add', '-A');
  git('commit', '-qm', 'baseline with one failing test');

  const snap = snapshot(repo, { runner: 'node-test' });
  assert.ok(snap.ok, `snapshot failed: ${snap.reason}`);
  assert.strictEqual(snap.summary.total, 3);
  assert.strictEqual(snap.summary.failed, 1, 'fixture must start with exactly one failing test');
});

after(() => { try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ } });

const run = () => whatran(repo, { runner: 'node-test' });

describe('integration', () => {
  test('an honest fix is allowed and reports the good transition', () => {
    reset();
    write('sum.js', SOURCE.replace('product(a, b) { return a + b; }', 'product(a, b) { return a * b; }'));
    const r = run();
    assert.ok(r.ok, r.inconclusive);
    assert.strictEqual(r.verdict, INTACT);
    assert.ok(r.findings.some((f) => f.code === 'test-fixed'));
  });

  test('skipping the failing test is denied', () => {
    reset();
    write('test/sum.test.js', TESTS.replace("test('product multiplies'", "test.skip('product multiplies'"));
    const r = run();
    assert.strictEqual(r.verdict, MISSING);
    const f = r.findings.find((x) => x.code === 'failing-test-silenced');
    assert.ok(f, 'expected failing-test-silenced');
    assert.match(f.evidence[0], /product multiplies/);
  });

  test('deleting the failing test is denied', () => {
    reset();
    write('test/sum.test.js', TESTS.replace(
      "test('product multiplies', () => { assert.strictEqual(product(2, 3), 6); });\n", ''));
    const r = run();
    assert.strictEqual(r.verdict, MISSING);
    assert.ok(r.findings.some((x) => x.code === 'failing-test-removed'));
  });

  // The false positive that would make the tool unusable in the real world.
  test('skipping a PASSING test is flagged but never denied', () => {
    reset();
    write('test/sum.test.js', TESTS.replace("test('sum handles zero'", "test.skip('sum handles zero'"));
    const r = run();
    assert.strictEqual(r.verdict, NOTICE, JSON.stringify(r.findings, null, 2));
    assert.ok(r.findings.some((x) => x.code === 'passing-test-skipped'));
  });

  test('a focused test is denied even when outcomes look unchanged', () => {
    reset();
    write('test/sum.test.js', TESTS.replace("test('sum adds'", "test.only('sum adds'"));
    const r = run();
    assert.strictEqual(r.verdict, MISSING);
    assert.ok(r.findings.some((x) => x.code === 'focus-lock'));
  });

  test('touching the harness is flagged', () => {
    reset();
    write('jest.config.js', 'export default { testPathIgnorePatterns: ["/test/"] };\n');
    const r = run();
    assert.ok(r.findings.some((x) => x.code === 'harness-modified'));
  });

  // An environment failure must never be reported as removed coverage.
  test('a broken import is INCONCLUSIVE, not an accusation', () => {
    reset();
    fs.rmSync(path.join(repo, 'sum.js'));
    const r = run();
    assert.strictEqual(r.ok, false, 'expected an inconclusive result');
    assert.strictEqual(r.verdict, null);
    assert.deepStrictEqual(r.findings, []);
    write('sum.js', SOURCE);
  });

  test('adding new tests is not a finding', () => {
    reset();
    write('test/sum.test.js', TESTS + "\ntest('brand new', () => { assert.ok(true); });\n");
    const r = run();
    assert.ok(r.ok, r.inconclusive);
    assert.ok(!r.findings.some((f) => f.level === MISSING),
      'adding tests must never be denied: ' + JSON.stringify(r.findings));
  });

  test('an untouched tree produces no denials', () => {
    reset();
    const r = run();
    assert.ok(r.ok, r.inconclusive);
    assert.notStrictEqual(r.verdict, MISSING);
  });
});

// The blind spot that mattered most: agents routinely commit their work, and
// the relevance gate only looked at the working tree. A committed cheat left
// nothing uncommitted, so the hook skipped verification entirely.
describe('committed work', () => {
  const commit = (msg) => {
    execFileSync('git', ['add', '-A'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['commit', '-qm', msg], { cwd: repo, stdio: 'ignore' });
  };
  const rollback = () => execFileSync('git', ['reset', '-q', '--hard', 'HEAD~1'], { cwd: repo, stdio: 'ignore' });

  test('a committed skip of a failing test is still denied', () => {
    reset();
    write('test/sum.test.js', TESTS.replace("test('product multiplies'", "test.skip('product multiplies'"));
    commit('agent commits the cheat');
    try {
      const r = whatran(repo, { runner: 'node-test' });
      assert.strictEqual(r.verdict, MISSING, JSON.stringify(r.findings, null, 2));
    } finally { rollback(); }
  });

  test('a committed focus lock is still denied', () => {
    reset();
    write('test/sum.test.js', TESTS.replace("test('sum adds'", "test.only('sum adds'"));
    commit('agent commits a .only');
    try {
      const r = whatran(repo, { runner: 'node-test' });
      assert.ok(r.findings.some((f) => f.code === 'focus-lock'),
        'focus lock must be found in committed files: ' + JSON.stringify(r.findings));
    } finally { rollback(); }
  });

  test('a committed honest fix stays quiet', () => {
    reset();
    write('sum.js', SOURCE.replace('product(a, b) { return a + b; }', 'product(a, b) { return a * b; }'));
    commit('agent commits an honest fix');
    try {
      const r = whatran(repo, { runner: 'node-test' });
      assert.notStrictEqual(r.verdict, MISSING);
    } finally { rollback(); }
  });
});
