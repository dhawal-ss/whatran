# whatran v3 — earn the right to be left switched on

## The problem, measured
A single flaky test makes whatran accuse the user on an UNTOUCHED tree.
Measured on a fixture with one deliberately flaky test: 2 false BROKE reports
in 5 runs with zero changes.

Measured on a real 596-test project (career-os), 5 consecutive runs, untouched:
silent every time. So flakiness is NOT universal, and the plan must not claim it
is. The justification is simply that a tool which can accuse on an unchanged
tree is broken, however rarely it happens - it violates the one rule everything
else here is built on.

## Fix: a confirmation run
When, and only when, a FAILING finding is produced:
  1. run the suite a second time
  2. recompute the transitions
  3. report only findings that survive BOTH runs
  4. any test whose outcome differed between the two runs is UNSTABLE, not
     broken - reported as a NOTICE, never as an accusation
Cost is zero on a clean turn, because a clean turn produces no findings.
Chosen over per-test re-runs because it needs no per-runner test-selection
support and preserves ordering and isolation, which is where flakiness lives.

## Then: remember what is unstable
Record confirmed-unstable test ids in the baseline. A test already known to be
unstable never produces a FAILING finding again - it is reported once, as a
NOTICE, and then stays quiet. Flakiness is a property of the test, not of a run.

## Then: `whatran accept`
There is currently no way to say "yes, that was deliberate". Deleting a genuinely
obsolete test means whatran nags until someone thinks to re-run `snapshot`.
Every linter has an escape hatch; without one people disable the tool rather
than argue with it. `whatran accept` re-records the baseline from the current
state and says plainly what it just accepted.

## Non-negotiables, unchanged
- Never accuse when unsure.
- Silence on a clean turn.
- Deterministic. No LLM in the verification path.
- Fast: no extra cost unless something was actually found.
