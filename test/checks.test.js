import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  outcomeTransitions, harnessTampering, suiteShrank, verdict,
  DENIED, FLAGGED, ALLOWED,
} from '../src/checks.js';

const m = (obj) => new Map(Object.entries(obj));
const codes = (findings) => findings.map((f) => f.code).sort();

describe('outcome transitions', () => {
  test('a failing test that becomes skipped is denied', () => {
    const f = outcomeTransitions(m({ a: 'failed' }), m({ a: 'skipped' }));
    assert.strictEqual(verdict(f), DENIED);
    assert.strictEqual(f[0].code, 'failing-test-silenced');
    assert.deepStrictEqual(f[0].evidence, ['a']);
  });

  test('a failing test that disappears is denied', () => {
    const f = outcomeTransitions(m({ a: 'failed' }), m({}));
    assert.strictEqual(verdict(f), DENIED);
    assert.strictEqual(f[0].code, 'failing-test-removed');
  });

  // The regression that matters most: a platform guard on a green test is the
  // single most common legitimate skip in the wild. If this ever denies, the
  // tool is unusable.
  test('a PASSING test that becomes skipped is only flagged, never denied', () => {
    const f = outcomeTransitions(m({ a: 'passed' }), m({ a: 'skipped' }));
    assert.strictEqual(verdict(f), FLAGGED);
    assert.strictEqual(f[0].code, 'passing-test-skipped');
  });

  test('a failing test that passes is reported as the honest transition', () => {
    const f = outcomeTransitions(m({ a: 'failed' }), m({ a: 'passed' }));
    assert.strictEqual(verdict(f), ALLOWED);
    assert.strictEqual(f[0].code, 'test-fixed');
  });

  test('an unchanged suite produces nothing at all', () => {
    const same = m({ a: 'passed', b: 'failed', c: 'skipped' });
    assert.deepStrictEqual(outcomeTransitions(same, same).filter((f) => f.level !== ALLOWED), []);
  });

  test('newly added tests are not findings', () => {
    const f = outcomeTransitions(m({ a: 'passed' }), m({ a: 'passed', b: 'passed' }));
    assert.deepStrictEqual(f, []);
  });

  test('a passing test that vanishes is flagged, not denied', () => {
    const f = outcomeTransitions(m({ a: 'passed' }), m({}));
    assert.strictEqual(verdict(f), FLAGGED);
    assert.strictEqual(f[0].code, 'test-vanished');
  });

  test('several transitions are reported together', () => {
    const f = outcomeTransitions(
      m({ a: 'failed', b: 'failed', c: 'passed', d: 'passed' }),
      m({ a: 'skipped', b: 'passed', c: 'skipped' }),
    );
    assert.deepStrictEqual(codes(f),
      ['failing-test-silenced', 'passing-test-skipped', 'test-fixed', 'test-vanished'].sort());
    assert.strictEqual(verdict(f), DENIED);
  });
});

describe('harness tampering', () => {
  for (const file of [
    'conftest.py', 'pytest.ini', 'tox.ini', 'jest.config.js', 'vitest.config.ts',
    '.github/workflows/ci.yml', 'pkg/conftest.py', 'Makefile',
  ]) {
    test(`flags ${file}`, () => {
      assert.strictEqual(harnessTampering([file]).length, 1, file);
    });
  }

  test('ignores ordinary source and test files', () => {
    assert.deepStrictEqual(harnessTampering(['src/auth.py', 'test/sum.test.js', 'README.md']), []);
  });

  test('never denies on its own — modifying config is often legitimate', () => {
    assert.strictEqual(harnessTampering(['conftest.py'])[0].level, FLAGGED);
  });
});

describe('suite shrinkage', () => {
  test('reports a drop when nothing more specific explains it', () => {
    const f = suiteShrank(m({ a: 'passed', b: 'passed' }), m({ a: 'passed' }), false);
    assert.strictEqual(f.length, 1);
    assert.match(f[0].title, /1 fewer test/);
  });

  test('stays quiet when a specific check already explained the drop', () => {
    assert.deepStrictEqual(suiteShrank(m({ a: 'passed', b: 'passed' }), m({ a: 'passed' }), true), []);
  });

  test('stays quiet when the suite grew', () => {
    assert.deepStrictEqual(suiteShrank(m({ a: 'passed' }), m({ a: 'passed', b: 'passed' }), false), []);
  });
});
