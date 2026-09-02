import { test, describe } from 'node:test';
import assert from 'node:assert';
import { stripNonCode } from '../src/strip.js';
import { isRelevantFile } from '../src/relevance.js';

describe('stripNonCode', () => {
  test('blanks line comments but keeps the line count', () => {
    const src = 'const a = 1; // test.only( here\nconst b = 2;';
    const out = stripNonCode(src);
    assert.strictEqual(out.split('\n').length, 2);
    assert.ok(!out.includes('test.only('));
    assert.ok(out.includes('const a = 1;'));
  });

  test('blanks block comments across lines', () => {
    const out = stripNonCode('a\n/* test.only(\n   more */\nb');
    assert.ok(!out.includes('test.only('));
    assert.strictEqual(out.split('\n').length, 4);
  });

  test('blanks string contents but keeps the quotes', () => {
    const out = stripNonCode(`it('handles test.only( gracefully', fn)`);
    assert.ok(!out.includes('test.only('), out);
    assert.ok(out.startsWith("it('"), out);
  });

  test('leaves the // in a URL alone', () => {
    const out = stripNonCode('const u = 1; // note\nconst v = 2;');
    assert.ok(out.includes('const v = 2;'));
  });

  test('does not corrupt ordinary code', () => {
    const src = 'export function f(a, b) { return a + b; }';
    assert.strictEqual(stripNonCode(src), src);
  });
});

// These matter because a false DENIED on a test file that merely *mentions*
// focus locks would be an embarrassing and trust-destroying bug.
describe('focus detection via stripNonCode', () => {
  const FOCUS = /^\s*(?:await\s+)?(?:describe|it|test|suite|bench)\s*\.\s*only\s*[.(]/;
  const fires = (src) => stripNonCode(src).split('\n').some((l) => FOCUS.test(l));

  test('fires on a real focused test', () => {
    assert.strictEqual(fires("test.only('a', () => {});"), true);
  });

  test('fires on an indented focused test', () => {
    assert.strictEqual(fires("  describe.only('a', () => {});"), true);
  });

  test('does NOT fire on a test whose name mentions test.only(', () => {
    assert.strictEqual(fires("it('rejects test.only( in a diff', () => {});"), false);
  });

  test('does NOT fire on a comment about test.only(', () => {
    assert.strictEqual(fires('// never write test.only( in committed code'), false);
  });

  test('does NOT fire on a property access mid-expression', () => {
    assert.strictEqual(fires('const x = config.test.only;'), false);
  });
});

// Regression: a repo that tracks build artefacts must not defeat the gate.
// __pycache__/*.pyc is rewritten by the act of running the suite itself, so
// treating it as relevant makes every turn look like a code change.
describe('relevance gate', () => {
  const fixture = (files) => files.filter(isRelevantFile);

  test('documentation alone is irrelevant', () => {
    assert.deepStrictEqual(fixture(['README.md', 'docs/guide.mdx', 'LICENSE']), []);
  });

  test('compiled caches alone are irrelevant', () => {
    assert.deepStrictEqual(fixture(['__pycache__/auth.cpython-312.pyc', 'coverage/lcov.info']), []);
  });

  test('agent config alone is irrelevant', () => {
    assert.deepStrictEqual(fixture(['.claude/settings.json', '.whatran/baseline.json']), []);
  });

  test('source and test files are always relevant', () => {
    assert.deepStrictEqual(fixture(['src/auth.py']), ['src/auth.py']);
    assert.deepStrictEqual(fixture(['test/sum.test.js']), ['test/sum.test.js']);
  });

  test('an unrecognised extension is treated as relevant, not skipped', () => {
    assert.deepStrictEqual(fixture(['weird.zig']), ['weird.zig']);
  });

  test('one real change among many inert ones still triggers a run', () => {
    assert.deepStrictEqual(
      fixture(['README.md', '__pycache__/x.pyc', 'src/auth.py']),
      ['src/auth.py'],
    );
  });
});
