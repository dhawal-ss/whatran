import { test, describe } from 'node:test';
import assert from 'node:assert';
import { newTestsWithoutAssertions } from '../src/oracle.js';

// `head` is the file after the change, `base` before it.
const scan = (file, head, base = '') =>
  newTestsWithoutAssertions([file], () => head, () => base);

const finds = (file, head, base = '') => scan(file, head, base).length;

describe('tests that check nothing — Python', () => {
  test('a plain assert counts', () => {
    assert.strictEqual(finds('test_a.py', 'def test_a():\n    assert 1 == 1\n'), 0);
  });

  test('a test with no assertion is reported', () => {
    const hits = scan('test_a.py', 'def test_a():\n    do_thing()\n');
    assert.deepStrictEqual(hits, ['test_a.py::test_a']);
  });

  test('pytest.raises counts', () => {
    assert.strictEqual(
      finds('test_a.py', 'def test_a():\n    with pytest.raises(ValueError):\n        boom()\n'), 0);
  });

  test('unittest self.assertEqual counts', () => {
    assert.strictEqual(finds('test_a.py', 'def test_a(self):\n    self.assertEqual(1, 1)\n'), 0);
  });

  // Legacy weak tests are somebody else's problem. Nagging about them on every
  // turn is exactly the noise that gets a tool switched off.
  test('a weak test that already existed is left alone', () => {
    const src = 'def test_a():\n    do_thing()\n';
    assert.strictEqual(finds('test_a.py', src, src), 0);
  });
});

describe('tests that check nothing — JavaScript', () => {
  test('expect() counts', () => {
    assert.strictEqual(finds('a.test.js', "test('x', () => { expect(1).toBe(1); });"), 0);
  });

  test('a test with no assertion is reported', () => {
    assert.strictEqual(finds('a.test.js', "test('x', () => { doThing(); });"), 1);
  });

  test('a snapshot assertion counts', () => {
    assert.strictEqual(
      finds('a.test.js', "test('x', () => { expect(a).toMatchSnapshot(); });"), 0);
  });

  // Asserting through a shared helper is a real pattern and would look empty to
  // a naive scan, so it is treated as inconclusive rather than as a finding.
  test('delegating to a helper defined in the file is inconclusive', () => {
    assert.strictEqual(finds('a.test.js',
      "function check(v) { expect(v).toBe(1); }\ntest('x', () => { check(1); });"), 0);
  });

  test('only tests added by this change are considered', () => {
    const hits = scan('a.test.js',
      "test('old', () => { doThing(); });\ntest('new', () => { other(); });",
      "test('old', () => { doThing(); });");
    assert.deepStrictEqual(hits, ['a.test.js::new']);
  });

  test('an assertion inside a comment does not count', () => {
    assert.strictEqual(
      finds('a.test.js', "test('x', () => { /* expect(1).toBe(1) */ doThing(); });"), 1);
  });

  test('an assertion inside a string does not count', () => {
    assert.strictEqual(finds('a.test.js', "test('x', () => { log('assert this'); });"), 1);
  });
});

describe('tests that check nothing — Go and Rust', () => {
  test('t.Fatal counts', () => {
    assert.strictEqual(
      finds('a_test.go', 'func TestA(t *testing.T) {\n if x { t.Fatal("no") }\n}'), 0);
  });

  test('require.NoError counts', () => {
    assert.strictEqual(
      finds('a_test.go', 'func TestA(t *testing.T) {\n require.NoError(t, err)\n}'), 0);
  });

  test('a Go test with no assertion is reported', () => {
    assert.strictEqual(finds('a_test.go', 'func TestA(t *testing.T) {\n doThing()\n}'), 1);
  });

  // Rust declares tests inline in ordinary source files, so a filename filter
  // would never find them.
  test('assert_eq! in an inline module counts', () => {
    assert.strictEqual(finds('src/lib.rs', '#[test]\nfn works() {\n    assert_eq!(1, 1);\n}'), 0);
  });

  test('a Rust test with no assertion is reported', () => {
    assert.strictEqual(finds('src/lib.rs', '#[test]\nfn works() {\n    do_thing();\n}'), 1);
  });
});

describe('what it refuses to look at', () => {
  test('ordinary source files are ignored', () => {
    assert.strictEqual(finds('src/app.js', 'function f() { doThing(); }'), 0);
  });

  test('an unreadable file is skipped rather than reported', () => {
    assert.deepStrictEqual(newTestsWithoutAssertions(['a.test.js'], () => '', () => ''), []);
  });

  test('an empty test body is not reported — that is a different problem', () => {
    assert.strictEqual(finds('a.test.js', "test('x', () => {});"), 0);
  });
});
