import { runSuite } from './run.js';
import { outcomeTransitions, NOTICE, FAILING_LEVELS } from './checks.js';

// Findings that come from comparing two runs of the suite, and so can be faked
// by a flaky test. The static file checks cannot flake, and re-running a whole
// suite because a stray `.only` appeared would cost minutes for nothing.
const OUTCOME_DERIVED = new Set([
  'test-regressed', 'failing-test-silenced', 'failing-test-removed',
]);

// A single flaky test is enough to make whatran accuse someone on a tree they
// never touched, measured at 2 false reports in 5 runs on a fixture with one
// coin-flip test. That breaks the rule everything else here is built on.
//
// So: when, and only when, a run-comparison produces an accusation, run the
// suite once more and keep only what happens twice. A clean turn produces no
// findings and therefore costs nothing extra.
export function confirmFindings({ findings, base, headOutcomes, runner, projectDir, timeoutMs, knownUnstable }) {
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

  const differed = outcomesThatMoved(headOutcomes, second.outcomes);
  const unstable = [...new Set([...knownUnstable, ...differed])];

  const secondFindings = outcomeTransitions(base, second.outcomes);
  const kept = [];

  for (const f of findings) {
    if (!OUTCOME_DERIVED.has(f.code) || !FAILING_LEVELS.has(f.level)) { kept.push(f); continue; }
    // Intersect the evidence itself, not the finding. One flaky test in a batch
    // of five must not suppress the four real ones.
    const alsoInSecond = new Set(
      secondFindings.filter((g) => g.code === f.code).flatMap((g) => g.evidence),
    );
    const survived = f.evidence.filter((e) => alsoInSecond.has(e) && !unstable.includes(e));
    if (survived.length) kept.push({ ...f, evidence: survived });
  }

  if (differed.length) {
    kept.push({
      level: NOTICE,
      code: 'unstable-test',
      title: plural(differed.length, 'test gave a different result', 'tests gave different results')
        + ' on two identical runs',
      detail: 'Nothing changed between the runs, so this is flakiness or an order dependency, '
        + 'not something your change did. These are excluded from the findings above.',
      evidence: differed,
    });
  }

  return { findings: kept, unstable, confirmed: true };
}

function outcomesThatMoved(a, b) {
  const moved = [];
  for (const [id, first] of a) {
    const secondOutcome = b.get(id);
    if (secondOutcome === undefined || secondOutcome !== first) moved.push(id);
  }
  for (const id of b.keys()) if (!a.has(id)) moved.push(id);
  return [...new Set(moved)];
}

// Tests already known to be unstable never produce an accusation again. The
// ledger is cleared by `whatran accept` and by a fresh snapshot, so a test does
// not stay exempt forever, otherwise genuinely breaking it would be silent.
export function dropKnownUnstable(findings, knownUnstable) {
  if (!knownUnstable.length) return findings;
  const known = new Set(knownUnstable);
  const out = [];
  for (const f of findings) {
    if (!OUTCOME_DERIVED.has(f.code) || !FAILING_LEVELS.has(f.level)) { out.push(f); continue; }
    const survived = f.evidence.filter((e) => !known.has(e));
    if (survived.length) out.push({ ...f, evidence: survived });
  }
  return out;
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}
