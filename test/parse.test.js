import { test, describe } from 'node:test';
import assert from 'node:assert';
import { parseJUnitXml, parseJestJson, parseGoTestJson } from '../src/parse.js';

describe('JUnit XML', () => {
  // Shape emitted by `pytest --junit-xml`. The skip reason is a real attribute
  // here, which is why JUnit is preferred over the JSON report plugin.
  const pytest = `<?xml version="1.0" encoding="utf-8"?>
<testsuites><testsuite name="pytest" errors="0" failures="1" skipped="1" tests="4">
<testcase classname="test_auth" name="test_ok" time="0.001" />
<testcase classname="test_auth" name="test_bad" time="0.002"><failure message="assert False">boom</failure></testcase>
<testcase classname="test_auth" name="test_skipped" time="0.000"><skipped type="pytest.skip" message="flaky">test_auth.py:6: flaky</skipped></testcase>
<testcase classname="test_auth" name="test_err" time="0.000"><error message="setup failed">bad</error></testcase>
</testsuite></testsuites>`;

  test('reads outcomes for pass, fail, skip and error', () => {
    const out = parseJUnitXml(pytest);
    assert.strictEqual(out.get('test_auth::test_ok'), 'passed');
    assert.strictEqual(out.get('test_auth::test_bad'), 'failed');
    assert.strictEqual(out.get('test_auth::test_skipped'), 'skipped');
    assert.strictEqual(out.get('test_auth::test_err'), 'failed');
    assert.strictEqual(out.size, 4);
  });

  test('a <failure> body containing markup does not break the scanner', () => {
    const xml = `<testsuite><testcase classname="c" name="a"><failure>expected &lt;testcase name="x"/&gt; got nothing</failure></testcase>
<testcase classname="c" name="b" /></testsuite>`;
    const out = parseJUnitXml(xml);
    assert.strictEqual(out.get('c::a'), 'failed');
    assert.strictEqual(out.get('c::b'), 'passed');
  });

  test('decodes entities in names', () => {
    const out = parseJUnitXml('<testsuite><testcase classname="c" name="a &amp; b" /></testsuite>');
    assert.ok(out.has('c::a & b'));
  });

  test('a rerun resolves to the worst outcome, so a retry cannot mask a failure', () => {
    const xml = `<testsuite>
<testcase classname="c" name="flaky"><failure>x</failure></testcase>
<testcase classname="c" name="flaky" /></testsuite>`;
    assert.strictEqual(parseJUnitXml(xml).get('c::flaky'), 'failed');
  });

  test('empty and malformed input yield an empty map rather than throwing', () => {
    assert.strictEqual(parseJUnitXml('').size, 0);
    assert.strictEqual(parseJUnitXml('<not-xml').size, 0);
  });
});

describe('Jest / Vitest JSON', () => {
  const doc = JSON.stringify({
    testResults: [{
      name: '/abs/path/to/repo/test/sum.test.js',
      assertionResults: [
        { fullName: 'sum adds', status: 'passed' },
        { fullName: 'sum fails', status: 'failed' },
        { fullName: 'sum pending', status: 'pending' },
        { ancestorTitles: ['math'], title: 'multiplies', status: 'todo' },
      ],
    }],
  });

  test('maps jest statuses onto the three outcomes', () => {
    const out = parseJestJson(doc);
    const ids = [...out.keys()];
    assert.strictEqual(out.get(ids.find((k) => k.endsWith('sum adds'))), 'passed');
    assert.strictEqual(out.get(ids.find((k) => k.endsWith('sum fails'))), 'failed');
    assert.strictEqual(out.get(ids.find((k) => k.endsWith('sum pending'))), 'skipped');
    assert.strictEqual(out.get(ids.find((k) => k.endsWith('math > multiplies'))), 'skipped');
  });

  // Absolute paths differ between the repo and a temporary worktree; if they
  // leaked into ids, every test would look new and nothing would ever compare.
  test('test ids do not contain absolute paths', () => {
    for (const id of parseJestJson(doc).keys()) {
      assert.ok(!id.includes('/abs/path'), `leaked absolute path: ${id}`);
    }
  });
});

describe('go test -json', () => {
  const stream = [
    '{"Action":"run","Package":"ex/pkg","Test":"TestA"}',
    '{"Action":"pass","Package":"ex/pkg","Test":"TestA"}',
    '{"Action":"fail","Package":"ex/pkg","Test":"TestB"}',
    '{"Action":"skip","Package":"ex/pkg","Test":"TestC"}',
    '{"Action":"skip","Package":"ex/empty"}',
    'not json at all',
  ].join('\n');

  test('takes the final action per test', () => {
    const out = parseGoTestJson(stream);
    assert.strictEqual(out.get('ex/pkg::TestA'), 'passed');
    assert.strictEqual(out.get('ex/pkg::TestB'), 'failed');
    assert.strictEqual(out.get('ex/pkg::TestC'), 'skipped');
  });

  // `skip` at package level means "no tests in this package", which is not a
  // skipped test and must not be counted as one.
  test('ignores package-level events and junk lines', () => {
    const out = parseGoTestJson(stream);
    assert.strictEqual(out.size, 3);
    assert.ok(![...out.keys()].some((k) => k.includes('ex/empty')));
  });
});
