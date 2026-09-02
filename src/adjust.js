import { detectRunners, getRunner } from './runners.js';
import { runSuite, summarise } from './run.js';
import { loadBaseline, captureFromRef, saveBaseline } from './baseline.js';
import { changedFiles, head as gitHead, mergeBase } from './git.js';
import {
  outcomeTransitions, harnessTampering, focusLocks, suiteShrank, verdict,
  DENIED, FLAGGED, ALLOWED,
} from './checks.js';

export { DENIED, FLAGGED, ALLOWED };

export function pickRunner(root, explicit) {
  if (explicit) {
    const r = getRunner(explicit);
    if (!r) throw new Error(`unknown runner "${explicit}"`);
    return r;
  }
  const found = detectRunners(root);
  return found[0] ?? null;
}

// The single entry point. Returns a structured result; rendering lives elsewhere
// so the CLI, the JSON output and the agent hook all agree on the facts.
export function adjust(root, opts = {}) {
  const started = Date.now();
  const runner = pickRunner(root, opts.runner);
  if (!runner) {
    return inconclusive('no supported test runner detected in this repository', { root });
  }

  // --- obtain the baseline -------------------------------------------------
  let base = null;
  let baseSource = null;
  if (opts.baseRef) {
    const ref = mergeBase(root, opts.baseRef);
    const cap = captureFromRef(root, ref, runner);
    if (!cap.ok) return inconclusive(cap.reason, { runner: runner.label });
    base = cap.outcomes;
    baseSource = `${opts.baseRef} (${ref.slice(0, 8)})`;
  } else {
    const saved = loadBaseline(root);
    if (!saved) {
      return inconclusive(
        'no baseline recorded yet — run `adjuster snapshot` on a known-good tree first, '
        + 'or pass --base <ref> to compare against a git ref',
        { runner: runner.label },
      );
    }
    if (saved.runner !== runner.id) {
      return inconclusive(
        `the baseline was recorded with ${saved.runner} but ${runner.id} was detected now`,
        { runner: runner.label },
      );
    }
    base = saved.outcomes;
    baseSource = `snapshot ${saved.createdAt}`;
  }

  // --- run the suite as it stands now --------------------------------------
  const now = runSuite(runner, root, { timeoutMs: opts.timeoutMs });
  if (!now.ok) {
    return inconclusive(now.reason, { runner: runner.label });
  }

  // A suite that failed to collect looks exactly like a suite whose tests were
  // deleted: the ids simply aren't there. Accusing someone of removing coverage
  // when their import is broken is the fastest way to get uninstalled, so both
  // signals below force silence instead.
  if (runner.structuralExit?.(now.exitCode)) {
    return inconclusive(
      `${runner.label} exited ${now.exitCode}, which means the suite did not run to completion `
      + '(a collection or configuration error, not a test failure)',
      { runner: runner.label },
    );
  }
  const missing = countMissing(base, now.outcomes);
  if (base.size > 0 && missing / base.size > 0.5) {
    return inconclusive(
      `${missing} of ${base.size} baseline tests are missing — that is a collection failure, `
      + 'not a targeted removal. Fix the suite, then re-check.',
      { runner: runner.label },
    );
  }

  // --- checks --------------------------------------------------------------
  const changed = changedFiles(root, opts.sinceRef ?? null);
  const findings = [
    ...outcomeTransitions(base, now.outcomes),
    ...focusLocks(root, changed),
    ...harnessTampering(changed),
  ];
  const explained = findings.some((f) =>
    f.code === 'failing-test-removed' || f.code === 'test-vanished' || f.code === 'focus-lock');
  findings.push(...suiteShrank(base, now.outcomes, explained));

  return {
    ok: true,
    inconclusive: null,
    verdict: verdict(findings),
    findings,
    runner: runner.label,
    runnerId: runner.id,
    baseSource,
    summary: summarise(now.outcomes),
    baseSummary: summarise(base),
    suiteExitCode: now.exitCode,
    elapsedMs: Date.now() - started,
  };

  function countMissing(baseMap, headMap) {
    let n = 0;
    for (const id of baseMap.keys()) if (!headMap.has(id)) n++;
    return n;
  }

  function inconclusive(reason, extra = {}) {
    return {
      ok: false,
      inconclusive: reason,
      verdict: null,
      findings: [],
      runner: extra.runner ?? null,
      runnerId: runner?.id ?? null,
      baseSource: null,
      summary: null,
      baseSummary: null,
      elapsedMs: Date.now() - started,
    };
  }
}

// Record the current state of the suite as the thing future runs are measured
// against. Deliberately does not care whether tests are passing: a baseline
// with red tests is the interesting case, because it is the one an agent is
// about to be asked to fix.
export function snapshot(root, opts = {}) {
  const runner = pickRunner(root, opts.runner);
  if (!runner) return { ok: false, reason: 'no supported test runner detected in this repository' };

  const res = runSuite(runner, root, { timeoutMs: opts.timeoutMs });
  if (!res.ok) return { ok: false, reason: res.reason, runner: runner.label };

  const saved = saveBaseline(root, {
    runner: runner.id,
    outcomes: res.outcomes,
    ref: gitHead(root),
  });
  return { ok: true, runner: runner.label, summary: saved.summary, path: '.adjuster/baseline.json' };
}
