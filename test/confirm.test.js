import { test, describe } from 'node:test';
import assert from 'node:assert';
import { dropKnownUnstable, confirmFindings, entryFor } from '../src/confirm.js';
import { MISSING, BROKE, NOTICE } from '../src/checks.js';

const finding = (level, code, evidence) => ({ level, code, title: code, detail: '', evidence });

describe('known-unstable tests are never accused again', () => {
  const outcomeLedger = (id) => [entryFor('outcome', id)];

  test('evidence for a known-unstable test is dropped', () => {
    const f = [finding(BROKE, 'test-regressed', ['a::flaky'])];
    assert.deepStrictEqual(dropKnownUnstable(f, outcomeLedger('a::flaky')).findings, []);
  });

  // One flaky test in a batch must not suppress the real findings alongside it.
  test('only the unstable id is dropped, not the whole finding', () => {
    const f = [finding(BROKE, 'test-regressed', ['a::flaky', 'a::real'])];
    const out = dropKnownUnstable(f, outcomeLedger('a::flaky')).findings;
    assert.strictEqual(out.length, 1);
    assert.deepStrictEqual(out[0].evidence, ['a::real']);
  });

  // Every suppression has to leave a trace. Dropping evidence with no mention
  // anywhere in the output was the quiet half of a false green.
  test('what was suppressed is reported back, not swallowed', () => {
    const f = [finding(BROKE, 'test-regressed', ['a::flaky'])];
    const out = dropKnownUnstable(f, outcomeLedger('a::flaky'));
    assert.deepStrictEqual(out.suppressed, ['a::flaky']);
  });

  // An exemption earned by appearing-and-disappearing must not also excuse the
  // test being deleted outright: that is how two flaky runs bought permanent
  // immunity from the finding this tool exists to make.
  test('an exemption only covers the axis it was earned on', () => {
    const removed = [finding(MISSING, 'failing-test-removed', ['a::x'])];
    assert.strictEqual(dropKnownUnstable(removed, outcomeLedger('a::x')).findings.length, 1);
    assert.strictEqual(
      dropKnownUnstable(removed, [entryFor('presence', 'a::x')]).findings.length, 0,
    );
  });

  test('notices are left alone, they are not accusations', () => {
    const f = [finding(NOTICE, 'passing-test-skipped', ['a::flaky'])];
    assert.deepStrictEqual(dropKnownUnstable(f, outcomeLedger('a::flaky')).findings, f);
  });

  // Static file checks cannot flake, so the ledger must not touch them.
  test('file-based findings are untouched by the ledger', () => {
    const f = [finding(MISSING, 'focus-lock', ['a.test.js, .only'])];
    assert.deepStrictEqual(dropKnownUnstable(f, outcomeLedger('a.test.js, .only')).findings, f);
  });

  test('an empty ledger changes nothing', () => {
    const f = [finding(BROKE, 'test-regressed', ['a::x'])];
    assert.deepStrictEqual(dropKnownUnstable(f, []).findings, f);
  });
});

describe('when a second opinion is worth paying for', () => {
  const neverRun = () => { throw new Error('the suite must not be re-run here'); };

  // Re-running a whole suite because a stray `.only` appeared would cost
  // minutes for a check that cannot possibly flake.
  test('a focus lock alone does not trigger a re-run', () => {
    const findings = [finding(MISSING, 'focus-lock', ['a.test.js, .only'])];
    const out = confirmFindings({
      findings, base: new Map(), headOutcomes: new Map(),
      runner: { command: neverRun, label: 'x', outExt: '.xml', parse: neverRun },
      projectDir: '.', knownUnstable: [],
    });
    assert.strictEqual(out.confirmed, false);
    assert.deepStrictEqual(out.findings, findings);
  });

  test('a modified harness alone does not trigger a re-run', () => {
    const findings = [finding(NOTICE, 'harness-modified', ['conftest.py (added)'])];
    const out = confirmFindings({
      findings, base: new Map(), headOutcomes: new Map(),
      runner: { command: neverRun, label: 'x', outExt: '.xml', parse: neverRun },
      projectDir: '.', knownUnstable: [],
    });
    assert.strictEqual(out.confirmed, false);
  });

  test('a notice-level outcome finding does not trigger a re-run', () => {
    const findings = [finding(NOTICE, 'passing-test-skipped', ['a::x'])];
    const out = confirmFindings({
      findings, base: new Map(), headOutcomes: new Map(),
      runner: { command: neverRun, label: 'x', outExt: '.xml', parse: neverRun },
      projectDir: '.', knownUnstable: [],
    });
    assert.strictEqual(out.confirmed, false);
  });
});
