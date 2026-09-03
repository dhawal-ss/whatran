import { runSuite } from './run.js';
import { outcomeTransitions, NOTICE, FAILING_LEVELS } from './checks.js';

// Findings that come from comparing two runs of the suite, and so can be faked
// by a flaky test. The static file checks cannot flake, and re-running a whole
// suite because a stray `.only` appeared would cost minutes for nothing.
const OUTCOME_DERIVED = new Set([
  'test-regressed', 'failing-test-silenced', 'failing-test-removed',
  'test-stopped-running', 'family-lost-failures',
]);

// Every finding produced by outcomeTransitions, including the reassuring ones.
// An id we have decided we cannot compare must be removed from ALL of them:
// leaving it in `test-fixed` meant a deleted failing case was actively reported
// as "the honest transition", which is worse than saying nothing.
const FROM_OUTCOMES = new Set([
  ...OUTCOME_DERIVED, 'test-fixed', 'test-vanished', 'passing-test-skipped',
]);

// Which axis a test was seen to be unstable on.
//
// A test that appeared in one run and not the other is unstable in PRESENCE; a
// test that passed once and failed once is unstable in OUTCOME. Conflating them
// let a second flaky run buy a permanent exemption from the wrong kind of
// finding: one outcome flip and the test could thereafter be deleted outright
// without a word. An exemption now only covers the axis it was earned on.
const PRESENCE = 'presence';
const OUTCOME = 'outcome';

const AXIS_OF_CODE = {
  'test-regressed': OUTCOME,
  'failing-test-silenced': OUTCOME,
  'failing-test-removed': PRESENCE,
  'test-stopped-running': PRESENCE,
  'family-lost-failures': PRESENCE,
};

// An entry is `<axis>:<id>`. Stored as strings so the baseline stays a plain
// JSON document that a person can read and edit.
export const entryFor = (axis, id) => `${axis}:${id}`;

function exemptSet(knownUnstable, axis) {
  const out = new Set();
  for (const e of knownUnstable ?? []) {
    const at = e.indexOf(':');
    if (at === -1) continue;
    if (e.slice(0, at) === axis) out.add(e.slice(at + 1));
  }
  return out;
}

// A single flaky test is enough to make whatran accuse someone on a tree they
// never touched, measured at 2 false reports in 5 runs on a fixture with one
// coin-flip test. That breaks the rule everything else here is built on.
//
// So: when, and only when, a run-comparison produces an accusation, run the
// suite once more and keep only what happens twice. A clean turn produces no
// findings and therefore costs nothing extra.
export function confirmFindings({
  findings, base, headOutcomes, runner, projectDir, timeoutMs, knownUnstable, changed,
}) {
  const suspect = findings.filter(
    (f) => OUTCOME_DERIVED.has(f.code) && FAILING_LEVELS.has(f.level),
  );
  if (!suspect.length) return { findings, unstable: knownUnstable, confirmed: false };

  const second = runSuite(runner, projectDir, { timeoutMs });
  if (!second.ok) {
    // Could not get a second opinion. Report the first run rather than inventing
    // certainty either way, but say the check was not confirmed.
    return { findings, unstable: knownUnstable, confirmed: false };
  }

  const moved = outcomesThatMoved(headOutcomes, second.outcomes);
  const unstable = [...new Set([
    ...knownUnstable,
    ...moved.presence.map((id) => entryFor(PRESENCE, id)),
    ...moved.outcome.map((id) => entryFor(OUTCOME, id)),
  ])];

  const secondFindings = outcomeTransitions(base, second.outcomes, changed);
  const kept = [];

  for (const f of findings) {
    if (!OUTCOME_DERIVED.has(f.code) || !FAILING_LEVELS.has(f.level)) { kept.push(f); continue; }
    // Intersect the evidence itself, not the finding. One flaky test in a batch
    // of five must not suppress the four real ones.
    const alsoInSecond = new Set(
      secondFindings.filter((g) => g.code === f.code).flatMap((g) => g.evidence),
    );
    const axis = AXIS_OF_CODE[f.code] ?? OUTCOME;
    const exempt = axis === PRESENCE ? new Set(moved.presence) : new Set(moved.outcome);
    const survived = f.evidence.filter((e) => alsoInSecond.has(e) && !exempt.has(e));
    if (survived.length) kept.push({ ...f, evidence: survived });
  }

  const allMoved = [...new Set([...moved.presence, ...moved.outcome])];
  if (allMoved.length) {
    kept.push({
      level: NOTICE,
      code: 'unstable-test',
      title: plural(allMoved.length, 'test gave a different result', 'tests gave different results')
        + ' on two identical runs',
      detail: 'Nothing changed between the runs, so this is flakiness or an order dependency, '
        + 'not something your change did. These are excluded from the findings above.',
      evidence: allMoved,
    });
  }

  return { findings: kept, unstable, confirmed: true };
}

function outcomesThatMoved(a, b) {
  const presence = [];
  const outcome = [];
  for (const [id, first] of a) {
    const other = b.get(id);
    if (other === undefined) presence.push(id);
    else if (other !== first) outcome.push(id);
  }
  for (const id of b.keys()) if (!a.has(id)) presence.push(id);
  return { presence: [...new Set(presence)], outcome: [...new Set(outcome)] };
}

// Tests already known to be unstable do not produce the same accusation again.
// The ledger is cleared by `whatran accept` and by a fresh snapshot, so a test
// does not stay exempt forever; otherwise genuinely breaking it would be silent.
//
// Returns what it removed as well as what survived. Dropping evidence with no
// trace anywhere in the output was the quiet half of every false green the
// ledger could produce: the finding simply stopped appearing and nothing said
// why. Now the caller reports the suppression.
export function dropKnownUnstable(findings, knownUnstable) {
  const suppressed = [];
  if (!knownUnstable?.length) return { findings, suppressed };
  const out = [];
  for (const f of findings) {
    if (!OUTCOME_DERIVED.has(f.code) || !FAILING_LEVELS.has(f.level)) { out.push(f); continue; }
    const known = exemptSet(knownUnstable, AXIS_OF_CODE[f.code] ?? OUTCOME);
    const survived = f.evidence.filter((e) => !known.has(e));
    for (const e of f.evidence) if (known.has(e)) suppressed.push(e);
    if (survived.length) out.push({ ...f, evidence: survived });
  }
  return { findings: out, suppressed: [...new Set(suppressed)] };
}

// Removes ids we have decided cannot be compared from every outcome-derived
// finding, reassuring ones included.
export function dropIds(findings, ids) {
  if (!ids || !ids.size) return findings;
  const out = [];
  for (const f of findings) {
    if (!FROM_OUTCOMES.has(f.code)) { out.push(f); continue; }
    const survived = f.evidence.filter((e) => !ids.has(e));
    if (survived.length) out.push({ ...f, evidence: survived });
  }
  return out;
}

export function suppressedByLedger(ids) {
  if (!ids.length) return [];
  return [{
    level: NOTICE,
    code: 'suppressed-by-ledger',
    title: plural(ids.length, 'finding was suppressed', 'findings were suppressed')
      + ' because the test is on the flake ledger',
    detail: 'These tests were previously seen to change on their own, so accusations about them '
      + 'are held back. If you believe this one is real, run `whatran accept` to clear the ledger '
      + 'and check again.',
    evidence: ids,
  }];
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

export const __test = { outcomesThatMoved, exemptSet, PRESENCE, OUTCOME };
