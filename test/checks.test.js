import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  outcomeTransitions, harnessTampering, suiteShrank, verdict, isHarnessFile,
  MISSING, NOTICE, INTACT,
} from '../src/checks.js';

const m = (obj) => new Map(Object.entries(obj));
const codes = (findings) => findings.map((f) => f.code).sort();

describe('outcome transitions', () => {
  test('a failing test that becomes skipped is denied', () => {
    const f = outcomeTransitions(m({ a: 'failed' }), m({ a: 'skipped' }));
    assert.strictEqual(verdict(f), MISSING);
    assert.strictEqual(f[0].code, 'failing-test-silenced');
    assert.deepStrictEqual(f[0].evidence, ['a']);
  });

  test('a failing test that disappears is denied', () => {
    const f = outcomeTransitions(m({ a: 'failed' }), m({}));
    assert.strictEqual(verdict(f), MISSING);
    assert.strictEqual(f[0].code, 'failing-test-removed');
  });

  // The regression that matters most: a platform guard on a green test is the
  // single most common legitimate skip in the wild. If this ever denies, the
  // tool is unusable.
  test('a PASSING test that becomes skipped is only flagged, never denied', () => {
    const f = outcomeTransitions(m({ a: 'passed' }), m({ a: 'skipped' }));
    assert.strictEqual(verdict(f), NOTICE);
    assert.strictEqual(f[0].code, 'passing-test-skipped');
  });

  test('a failing test that passes is reported as the honest transition', () => {
    const f = outcomeTransitions(m({ a: 'failed' }), m({ a: 'passed' }));
    assert.strictEqual(verdict(f), INTACT);
    assert.strictEqual(f[0].code, 'test-fixed');
  });

  test('an unchanged suite produces nothing at all', () => {
    const same = m({ a: 'passed', b: 'failed', c: 'skipped' });
    assert.deepStrictEqual(outcomeTransitions(same, same).filter((f) => f.level !== INTACT), []);
  });

  test('newly added tests are not findings', () => {
    const f = outcomeTransitions(m({ a: 'passed' }), m({ a: 'passed', b: 'passed' }));
    assert.deepStrictEqual(f, []);
  });

  test('a passing test that vanishes is flagged, not denied', () => {
    const f = outcomeTransitions(m({ a: 'passed' }), m({}));
    assert.strictEqual(verdict(f), NOTICE);
    assert.strictEqual(f[0].code, 'test-vanished');
  });

  test('several transitions are reported together', () => {
    const f = outcomeTransitions(
      m({ a: 'failed', b: 'failed', c: 'passed', d: 'passed' }),
      m({ a: 'skipped', b: 'passed', c: 'skipped' }),
    );
    assert.deepStrictEqual(codes(f),
      ['failing-test-silenced', 'passing-test-skipped', 'test-fixed', 'test-vanished'].sort());
    assert.strictEqual(verdict(f), MISSING);
  });
});

describe('harness tampering', () => {
  const state = (obj) => new Map(Object.entries(obj));

  test('flags a harness file that changed since the baseline', () => {
    const f = harnessTampering({ 'conftest.py': 'aaa' }, state({ 'conftest.py': 'bbb' }));
    assert.strictEqual(f.length, 1);
    assert.match(f[0].evidence[0], /conftest\.py \(modified\)/);
  });

  test('flags a harness file that appeared since the baseline', () => {
    const f = harnessTampering({}, state({ 'conftest.py': 'aaa' }));
    assert.match(f[0].evidence[0], /conftest\.py \(added\)/);
  });

  test('flags a harness file that was removed', () => {
    const f = harnessTampering({ 'pytest.ini': 'aaa' }, state({}));
    assert.match(f[0].evidence[0], /pytest\.ini \(removed\)/);
  });

  // The noise regression: a config the developer edited last week is identical
  // at baseline time and now, so it must stay silent on every subsequent run.
  test('stays silent when harness files are unchanged since the baseline', () => {
    assert.deepStrictEqual(harnessTampering({ 'conftest.py': 'aaa' }, state({ 'conftest.py': 'aaa' })), []);
  });

  test('never denies on its own - editing config is often the point', () => {
    assert.strictEqual(harnessTampering({}, state({ 'conftest.py': 'x' }))[0].level, NOTICE);
  });

  for (const file of [
    'conftest.py', 'pytest.ini', 'tox.ini', 'jest.config.js', 'vitest.config.ts',
    '.github/workflows/ci.yml', 'pkg/conftest.py', 'Makefile',
  ]) {
    test(`recognises ${file} as a harness file`, () => {
      assert.strictEqual(isHarnessFile(file), true, file);
    });
  }

  for (const file of ['src/auth.py', 'test/sum.test.js', 'README.md']) {
    test(`does not treat ${file} as a harness file`, () => {
      assert.strictEqual(isHarnessFile(file), false, file);
    });
  }
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
