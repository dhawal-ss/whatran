import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { parseJUnitXml, parseMochaJson } from '../src/parse.js';

// This fixture is REAL output from `node --test --test-reporter=junit`, with
// only the absolute path prefix and the hostname replaced. That matters: every
// hand-written fixture in parse.test.js dutifully escapes `>`, and node:test
// does not, which is precisely why the bug below survived a suite of 131 tests
// and a previous audit. A fixture written by hand would re-create the blind
// spot it exists to close.
const XML = fs.readFileSync(new URL('./fixtures/node-test-junit.xml', import.meta.url), 'utf8');
const ROOT = 'C:\\repo';

describe('real node:test JUnit output', () => {
  const parsed = () => parseJUnitXml(XML, { root: ROOT });

  // The source file declares exactly six tests. The old scanner produced four
  // ids from them, and one of the six was swallowed entirely.
  test('every test in the file gets its own id', () => {
    const { outcomes, seen } = parsed();
    assert.strictEqual(seen, 6);
    assert.strictEqual(outcomes.size, 6);
  });

  // node:test escapes `<` but not `>`, so `describe('maps a -> b')` puts a raw
  // `>` inside an attribute value. Stopping the tag at the first `>` lost the
  // name, the classname and the file all at once.
  test('a raw > inside an attribute value does not truncate the tag', () => {
    const { outcomes } = parsed();
    assert.ok(outcomes.has('test/a.test.js > maps a -> b::works'));
    assert.ok(outcomes.has('test/a.test.js::top level a > b'));
  });

  // Two different outer describes each containing `describe('inner')`. Keeping
  // only the innermost suite name collapses both onto one id.
  test('the same inner describe under two outer ones stays two tests', () => {
    const { outcomes } = parsed();
    assert.ok(outcomes.has('test/a.test.js > maps a -> b > inner::one'));
    assert.ok(outcomes.has('test/a.test.js > other > inner::one'));
  });

  test('outcomes are read correctly through a failure body containing markup', () => {
    const { outcomes } = parsed();
    assert.strictEqual(outcomes.get('test/a.test.js::fails here'), 'failed');
    assert.strictEqual(outcomes.get('test/a.test.js::skipped one'), 'skipped');
    assert.strictEqual(outcomes.get('test/a.test.js::works' in {} ? '' : 'test/a.test.js > maps a -> b::works'), 'passed');
  });

  // A truncated self-closing tag was treated as having a body, and the search
  // for `</testcase>` then ran past every test in between.
  test('no test is swallowed by the one before it', () => {
    const { outcomes } = parsed();
    assert.ok(outcomes.has('test/a.test.js::fails here'), 'the test after a `>` name must survive');
  });

  // Nested describes make the outer suite's `tests=` include the inner ones, so
  // summing every suite double-counted and refused the whole run.
  test('nested suites do not inflate the declared total into a refusal', () => {
    const { declared, seen } = parsed();
    assert.ok(declared === null || declared <= seen,
      `declared ${declared} must not exceed the ${seen} records actually present`);
  });
});

describe('telling a broken import from a crash after the tests ran', () => {
  const wrap = (body) => `<?xml version="1.0"?>\n<testsuites>\n${body}\n</testsuites>\n`;
  const fileCase = (rel, abs) =>
    `<testcase name="${rel}" classname="test" file="${abs}" failure="test failed">`
    + '<failure type="testCodeFailure" message="test failed">boom</failure></testcase>';

  // A file that fails to load reports ONLY the synthetic record named after
  // itself. Reading that as a test means a syntax error looks like every test
  // in the file was deleted, and the agent gets blocked over a typo.
  test('a file that would not load is reported as unloadable', () => {
    const xml = wrap(fileCase('test\\broken.test.js', 'C:\\repo\\test\\broken.test.js'));
    const { unloadable, outcomes } = parseJUnitXml(xml, { root: 'C:\\repo' });
    assert.deepStrictEqual(unloadable, ['test/broken.test.js']);
    assert.strictEqual(outcomes.size, 0);
  });

  // Node 22 on Linux omits the `file` attribute from this record entirely,
  // while Node 24 and Windows include it. Keying the detection on that
  // attribute therefore worked on the development machine and, everywhere
  // else, turned a broken import into an accusation that a whole file of tests
  // had been deleted. These are the exact bytes the CI runner produced.
  test('a broken import is recognised even with no file attribute', () => {
    const xml = wrap(
      '<testcase name="test/sum.test.js" time="0.028" classname="test" failure="test failed">'
      + '<failure type="testCodeFailure" message="test failed">boom</failure></testcase>',
    );
    const { unloadable, outcomes, seen } = parseJUnitXml(xml, { root: '/tmp/repo' });
    assert.deepStrictEqual(unloadable, ['test/sum.test.js']);
    assert.strictEqual(outcomes.size, 0);
    assert.strictEqual(seen, 0, 'the synthetic record is not a test');
  });

  // The flip side: an ordinary test must never be mistaken for a file.
  test('an ordinary test with no file attribute stays a test', () => {
    const xml = wrap('<testcase name="sum adds" classname="test"/>');
    const { unloadable, outcomes } = parseJUnitXml(xml, { root: '/tmp/repo' });
    assert.deepStrictEqual(unloadable, []);
    assert.strictEqual(outcomes.size, 1);
  });

  // node:test emits the SAME synthetic record when the tests ran fine and the
  // process died afterwards. Refusing there would silence the tool on a repo
  // that merely has an unhandled rejection somewhere.
  test('a crash after the tests ran is not reported as unloadable', () => {
    const xml = wrap(
      '<testcase name="passes fine" classname="test" file="C:\\repo\\test\\late.test.js"/>\n'
      + fileCase('test\\late.test.js', 'C:\\repo\\test\\late.test.js'),
    );
    const { unloadable, outcomes } = parseJUnitXml(xml, { root: 'C:\\repo' });
    assert.deepStrictEqual(unloadable, []);
    assert.ok(outcomes.has('test/late.test.js::passes fine'));
  });
});

describe('mocha json', () => {
  // Shape verified against mocha 11's own --reporter json output.
  const DOC = JSON.stringify({
    stats: { tests: 4, passes: 2, pending: 1, failures: 1 },
    passes: [
      { fullTitle: 'outer a -> b works', file: 'C:\\repo\\test\\a.spec.js' },
      { fullTitle: 'outer a -> b inner one', file: 'C:\\repo\\test\\a.spec.js' },
    ],
    failures: [{ fullTitle: 'fails', file: 'C:\\repo\\test\\a.spec.js' }],
    pending: [{ fullTitle: 'skipped', file: 'C:\\repo\\test\\a.spec.js' }],
  });

  test('reads outcomes from the three disjoint arrays', () => {
    const { outcomes, seen, declared } = parseMochaJson(DOC, { root: 'C:\\repo' });
    assert.strictEqual(seen, 4);
    assert.strictEqual(declared, 4);
    assert.strictEqual(outcomes.get('test/a.spec.js::fails'), 'failed');
    assert.strictEqual(outcomes.get('test/a.spec.js::skipped'), 'skipped');
    assert.strictEqual(outcomes.get('test/a.spec.js::outer a -> b works'), 'passed');
  });

  test('nested describes stay distinct', () => {
    const { outcomes } = parseMochaJson(DOC, { root: 'C:\\repo' });
    assert.ok(outcomes.has('test/a.spec.js::outer a -> b inner one'));
  });

  test('garbage in is not results out', () => {
    const { outcomes, seen } = parseMochaJson('not json', {});
    assert.strictEqual(outcomes.size, 0);
    assert.strictEqual(seen, 0);
  });
});
