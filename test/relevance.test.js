import { test, describe } from 'node:test';
import assert from 'node:assert';
import { stripNonCode } from '../src/strip.js';
import { isRelevantFile } from '../src/relevance.js';
import { focusLocks } from '../src/checks.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

// These matter because a false MISSING on a test file that merely *mentions*
// focus locks would be an embarrassing and trust-destroying bug.
//
// Deliberately routed through the real `focusLocks`, on real files. These used
// to re-declare the pattern locally and test that copy, so every one of them
// would still have passed if checks.js had been deleted outright.
describe('focus detection, through the real check', () => {
  const fires = (src) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatran-rel-'));
    try {
      fs.writeFileSync(path.join(dir, 'a.test.js'), src);
      return focusLocks(dir, ['a.test.js']).length > 0;
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  };

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

  test('does NOT fire on a file that was never edited', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatran-rel-'));
    try {
      fs.writeFileSync(path.join(dir, 'a.test.js'), "test.only('a', () => {});");
      assert.deepStrictEqual(focusLocks(dir, []), []);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

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
