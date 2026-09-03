import { test, describe } from 'node:test';
import assert from 'node:assert';
import { stripNonCode } from '../src/strip.js';
import { focusLocks } from '../src/checks.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BT = String.fromCharCode(96);
const BS = String.fromCharCode(92);

// Two checks depend on this being right, and both of them accuse someone. The
// focus-lock one blocks the agent's turn outright.
const shape = (src, out) => {
  assert.strictEqual(out.length, src.length, 'length must be preserved so offsets still line up');
  assert.strictEqual(out.split('\n').length, src.split('\n').length, 'line count must be preserved');
};

describe('blanking JavaScript that is not code', () => {
  const strip = (s) => { const o = stripNonCode(s, 'js'); shape(s, o); return o; };

  // The three-regex version ran block comments first, so a string containing
  // `/*` opened a comment that blanked every line up to a later `*/` and hid a
  // real `.only` in between. A silent false green.
  test('a string containing /* does not open a comment', () => {
    const src = "const open = '/*';\ntest.only('real', () => {});\nconst close = '*/';\n";
    const out = strip(src);
    assert.ok(out.includes('test.only('), 'the real statement must survive:\n' + out);
  });

  // The opposite direction: a `.only` written inside a fixture string is not
  // code, and reporting it blocks the turn over nothing.
  test('a multi-line template literal is not mistaken for code', () => {
    const src = 'const FIXTURE = ' + BT + '\ntest.only("x", () => {});\n' + BT + ';\n';
    const out = strip(src);
    assert.ok(!out.includes('test.only('), 'the fixture must be blanked:\n' + out);
  });

  test('an escaped backtick does not end a template early', () => {
    const src = 'const t = ' + BT + 'a ' + BS + BT + ' b' + BT + '; assert.ok(1);\n';
    const out = strip(src);
    assert.ok(out.includes('assert.ok(1)'), out);
  });

  test('a nested template closes at the right backtick', () => {
    const src = 'const a = ' + BT + 'x ${ ' + BT + 'y' + BT + ' } z' + BT + '; assert.ok(1);\n';
    const out = strip(src);
    assert.ok(out.includes('assert.ok(1)'), out);
  });

  // A regex is neither a string nor a comment, and treating its contents as
  // either swallowed the rest of the line, erasing the assertion after it.
  test('a quote inside a regex does not start a string', () => {
    const src = String.raw`const re = /['"]/; assert.ok(1);` + '\n';
    const out = strip(src);
    assert.ok(out.includes('assert.ok(1)'), out);
  });

  test('a // inside a regex does not comment out the rest of the line', () => {
    const src = String.raw`const u = /https:\/\//; assert.ok(1);` + '\n';
    const out = strip(src);
    assert.ok(out.includes('assert.ok(1)'), out);
  });

  test('division is not mistaken for a regex', () => {
    const src = 'const a = (b) / c; assert.ok(1);\n';
    assert.strictEqual(strip(src), src);
  });

  test('comments really are blanked', () => {
    const out = strip('const a = 1; // test.only("nope")\n');
    assert.ok(!out.includes('test.only'), out);
  });

  test('an apostrophe in a comment does not open a string', () => {
    const out = strip("// don't do this\nassert.ok(1);\n");
    assert.ok(out.includes('assert.ok(1)'), out);
  });

  test('an unterminated string does not swallow the file', () => {
    const out = strip("const a = 'oops\nassert.ok(1);\n");
    assert.ok(out.includes('assert.ok(1)'), out);
  });
});

describe('blanking Python that is not code', () => {
  const strip = (s) => { const o = stripNonCode(s, 'py'); shape(s, o); return o; };

  // Python was passed through the JavaScript rules, which know nothing about
  // `#` or `'''`, so the oracle's "prose is not an assertion" guarantee simply
  // did not hold for any Python test.
  test('a hash comment is blanked', () => {
    const out = strip('def test_a():\n    # assert something\n    x = 1\n');
    assert.ok(!out.includes('assert'), out);
  });

  test('a docstring mentioning assert is blanked', () => {
    const out = strip('def test_a():\n    """asserts nothing really"""\n    x = 1\n');
    assert.ok(!out.includes('assert'), out);
  });

  test('a real assertion survives', () => {
    const out = strip('def test_a():\n    """docs"""\n    assert x == 1\n');
    assert.ok(out.includes('assert x == 1'), out);
  });

  test('a triple-quoted block spanning lines keeps its line count', () => {
    const src = 'x = """\nassert 1\nassert 2\n"""\nassert 3\n';
    const out = strip(src);
    assert.ok(!out.includes('assert 1'), out);
    assert.ok(out.includes('assert 3'), out);
  });
});

// The end-to-end consequence, through the check that actually blocks a turn.
describe('focus locks, through the real check', () => {
  let dir;
  const write = (rel, body) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  };

  test('a .only in a fixture string is not an accusation', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatran-focus-'));
    try {
      write('a.test.js', 'const SRC = ' + BT + '\ntest.only("x", () => {});\n' + BT + ';\n');
      assert.deepStrictEqual(focusLocks(dir, ['a.test.js']), []);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('a real .only still is', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatran-focus-'));
    try {
      write('a.test.js', "const open = '/*';\ntest.only('real', () => {});\n");
      const found = focusLocks(dir, ['a.test.js']);
      assert.strictEqual(found.length, 1, 'a real focus lock must still be caught');
      assert.match(found[0].evidence[0], /a\.test\.js/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('a module-level pytest skip disables a file just as thoroughly', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatran-focus-'));
    try {
      write('test_a.py', 'import pytest\npytestmark = pytest.mark.skip(reason="later")\n\ndef test_x():\n    assert 1\n');
      const found = focusLocks(dir, ['test_a.py']);
      assert.strictEqual(found.length, 1, 'a module-level skip must be caught');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('an ordinary conditional skip is not an accusation', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatran-focus-'));
    try {
      write('test_a.py', 'import pytest\n\n@pytest.mark.skipif(True, reason="windows")\ndef test_x():\n    assert 1\n');
      assert.deepStrictEqual(focusLocks(dir, ['test_a.py']), []);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
