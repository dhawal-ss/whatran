import { resolveProject, otherProjects } from './project.js';
import { runSuite, summarise } from './run.js';
import {
  loadBaseline, captureFromRef, saveBaseline, recordUnstable, baselineAge,
} from './baseline.js';
import {
  changedFiles, head as gitHead, mergeBase, listFiles, listFilesAtRef, blobAtRef,
  fileAtRef, treeFingerprint, isDirty,
} from './git.js';
import {
  outcomeTransitions, harnessTampering, focusLocks, suiteShrank, verdict,
  collectHarnessState, isHarnessFile, assertionFreeTests, unverifiableIds, identityChanged,
  uncheckedProjects, familyLostFailures,
  MISSING, BROKE, NOTICE, INTACT, FAILING_LEVELS,
} from './checks.js';
import { newTestsWithoutAssertions } from './oracle.js';
import { confirmFindings, dropKnownUnstable, dropIds, suppressedByLedger } from './confirm.js';
import { relevantChanges, isTrackedEdit } from './relevance.js';
import { createHash } from 'node:crypto';
import fsMod from 'node:fs';
import pathMod from 'node:path';

export { MISSING, BROKE, NOTICE, INTACT };

export function pickRunner(root, explicit, cwd = root) {
  return resolveProject(cwd, root, explicit).runner;
}

// Where the suite runs and where its baseline lives. Not necessarily the git
// root, see project.js.
export function projectDirFor(root, explicit, cwd = root) {
  return resolveProject(cwd, root, explicit).dir;
}

// The single entry point. Returns a structured result; rendering lives elsewhere
// so the CLI, the JSON output and the agent hook all agree on the facts.
export function whatran(root, opts = {}) {
  const started = Date.now();
  // Claude Code does not enforce `timeout` on a background hook when it is
  // running detached, so this is the only ceiling that reliably exists. It
  // covers the whole operation, not one suite run: a check can involve a
  // baseline run, a main run and a confirmation run.
  const budgetMs = opts.budgetMs ?? 15 * 60 * 1000;
  const remaining = () => Math.max(0, budgetMs - (Date.now() - started));

  const { runner, dir: projectDir } = resolveProject(opts.cwd ?? root, root, opts.runner);
  if (!runner) {
    return inconclusive('no supported test runner detected in this repository', { root });
  }

  // --- obtain the baseline -------------------------------------------------
  let base = null;
  let baseSource = null;
  let baselineHarness = null;
  let sinceRef = null;
  let knownUnstable = [];
  let healed = null;
  if (opts.baseRef) {
    const ref = mergeBase(root, opts.baseRef);
    // Falling back to the ref's own tip compared against the wrong commit, so
    // everything deleted on the base branch since the fork point was reported
    // as coverage this change had removed.
    if (!ref) {
      return inconclusive(
        `could not find a common ancestor of HEAD and ${opts.baseRef}. In CI this usually means a `
        + 'shallow clone: fetch the base commit (actions/checkout with fetch-depth: 0) and re-run.',
        { runner: runner.label },
      );
    }
    const cap = captureFromRef(root, ref, runner, { projectDir });
    if (!cap.ok) return inconclusive(cap.reason, { runner: runner.label });
    base = cap.outcomes;
    baselineHarness = Object.fromEntries(harnessStateAtRef(root, ref));
    sinceRef = ref;
    baseSource = `${opts.baseRef} (${ref.slice(0, 8)})`;
  } else {
    let saved = loadBaseline(projectDir);
    // Self-healing. A first-time user who is told to go and run a different
    // command before this one will do anything is the single worst friction
    // point in the tool, and a version bump that silently invalidates everyone's
    // baseline is the same dead-end arriving later.
    if (opts.autoBaseline && (!saved || saved.stale)) {
      const why = !saved ? 'none recorded yet' : `the recorded one is unusable (${saved.stale})`;
      const made = ensureBaseline(root, { runner, projectDir });
      if (!made.ok) {
        return inconclusive(`${why}, and ${made.reason}`, { runner: runner.label });
      }
      healed = { ...made, why };
      saved = loadBaseline(projectDir);
    }
    if (!saved) {
      return inconclusive(
        'no baseline recorded yet, run `whatran snapshot` on a known-good tree first, '
        + 'or pass --base <ref> to compare against a git ref',
        { runner: runner.label },
      );
    }
    if (saved.stale) {
      return inconclusive(
        `the recorded baseline is unusable (${saved.stale}), it was probably written by an `
        + 'older whatran. Run `whatran snapshot` to record a fresh one.',
        { runner: runner.label },
      );
    }
    if (saved.runner !== runner.id) {
      // Never overwritten automatically: that would discard the record of an
      // entire suite on what is far more often a cwd mistake than a migration.
      return inconclusive(
        `the baseline was recorded with ${saved.runner} but ${runner.id} was detected now. `
        + `Pin one with --runner ${saved.runner}, or run \`whatran accept\` if you really `
        + 'changed runners.',
        { runner: runner.label },
      );
    }
    base = saved.outcomes;
    baselineHarness = saved.harness ?? {};
    // Work the agent committed since the snapshot must be visible to the
    // file-based checks, not just what is still sitting in the working tree.
    sinceRef = saved.ref ?? null;
    knownUnstable = saved.unstable ?? [];
    baseSource = `snapshot ${saved.createdAt}`;
  }

  // --- run the suite as it stands now --------------------------------------
  // A suite can take minutes, and in the background it can outlive the state it
  // measured: the agent keeps working, or the person edits a file. A finding
  // reported against code that no longer exists is a false accusation, and a
  // confusing one, because the evidence is already gone by the time it is read.
  //
  // `isTrackedEdit` deliberately excludes everything a test run writes for
  // itself. Without that the fingerprint changed on the tool's own side effects
  // and every single check reported that the tree had moved on, which silences
  // the entire tool with no message anywhere.
  const treeBefore = treeFingerprint(root, isTrackedEdit);

  const now = runSuite(runner, projectDir, { timeoutMs: capTimeout(opts.timeoutMs, remaining()) });
  if (!now.ok) {
    return inconclusive(now.reason, { runner: runner.label });
  }

  if (movedOnSince(treeBefore)) return movedOn();

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
  // The ratio exists to catch a wholesale collection failure, where hundreds of
  // tests vanish at once. On a small suite it fired on exactly the thing the
  // tool is for: deleting 1 of 1, or 2 of 3, is >50% and used to report nothing
  // at all. An absolute floor keeps it aimed at what it was written for.
  if (base.size >= 10 && missing / base.size > 0.5) {
    return inconclusive(
      `${missing} of ${base.size} baseline tests are missing, that is a collection failure, `
      + 'not a targeted removal. Fix the suite, then re-check.',
      { runner: runner.label },
    );
  }

  // --- checks --------------------------------------------------------------
  // Includes work the agent committed, not just what is still in the tree.
  const changedRes = changedFiles(root, sinceRef);
  const changed = changedRes.files;

  // A parametrised family that changed size renumbers its own cases, so the
  // same id no longer names the same input. Exclude those before anything is
  // claimed about them, including the "honest transition", which is how this
  // produced a silent clean bill on a failure that had merely moved.
  const identity = unverifiableIds(base, now.outcomes);

  let outcomeFindings = dropIds(outcomeTransitions(base, now.outcomes, changed), identity.ids);
  const ledger = dropKnownUnstable(outcomeFindings, knownUnstable);
  outcomeFindings = ledger.findings;

  // If nothing that could affect a test outcome changed, then a "regression"
  // is impossible by construction: whatever moved, this change did not move it.
  // A confirmation run cannot establish that, two runs of a coin-flip test
  // agree a quarter of the time, but the absence of any relevant edit can.
  //
  // It is only trustworthy when git actually answered. A git failure that read
  // as "nothing changed" used to rewrite real MISSING findings into a NOTICE
  // and exempt them permanently, which is a false green built out of an error.
  const relevant = changedRes.ok ? relevantChanges(root, sinceRef) : null;
  const nothingChanged = relevant !== null && relevant.length === 0;
  if (nothingChanged && outcomeFindings.some((f) => FAILING_LEVELS.has(f.level))) {
    const moved = outcomeFindings
      .filter((f) => FAILING_LEVELS.has(f.level))
      .flatMap((f) => f.evidence);
    // Deliberately NOT persisted to the ledger. The confirmation path demands
    // two observations before it will exempt a test; earning a permanent
    // exemption from ONE observation here, on the strength of a file-extension
    // guess about what is inert, is the weaker evidence buying the stronger
    // privilege. Downgrade this run and let the next one judge afresh.
    outcomeFindings = outcomeFindings.filter((f) => !FAILING_LEVELS.has(f.level));
    outcomeFindings.push({
      level: NOTICE,
      code: 'unstable-test',
      title: plural(moved.length, 'test changed outcome', 'tests changed outcome')
        + ' with no relevant edit',
      detail: 'Nothing that could affect a test was touched, so this is flakiness or an order '
        + 'dependency rather than anything your change did.',
      evidence: moved,
    });
  }

  // Then, only if an accusation survived, get a second opinion.
  let confirmed = false;
  let unstable = knownUnstable;
  // A second run needs room to finish. Starting one with no budget left would
  // report a half-measured result as if it were confirmed, and passing it the
  // caller's timeout rather than what is left of the budget let the whole
  // operation run to twice its stated ceiling.
  if (!opts.noConfirm && remaining() > 30 * 1000) {
    const c = confirmFindings({
      findings: outcomeFindings,
      base,
      headOutcomes: now.outcomes,
      runner,
      projectDir,
      timeoutMs: capTimeout(opts.timeoutMs, remaining()),
      knownUnstable,
      changed,
    });
    outcomeFindings = c.findings;
    unstable = c.unstable;
    confirmed = c.confirmed;
    if (confirmed && unstable.length !== knownUnstable.length) {
      recordUnstable(projectDir, unstable);
    }
  }

  // The confirmation run above can itself outlive the tree, so check once more
  // before committing to a verdict.
  if (movedOnSince(treeBefore)) return movedOn();

  const findings = [
    ...outcomeFindings,
    ...dropIds(familyLostFailures(base, now.outcomes), new Set()),
    ...suppressedByLedger(ledger.suppressed),
    ...identityChanged(identity.families),
    ...uncheckedProjects(otherProjects(root, projectDir)),
    ...focusLocks(root, changed),
    ...harnessTampering(baselineHarness, collectHarnessState(root, () => listFiles(root))),
    // Needs a ref to diff against, without one, every test looks new.
    ...(sinceRef ? assertionFreeTests(newTestsWithoutAssertions(
      changed,
      (rel) => { try { return fsMod.readFileSync(pathMod.join(root, rel), 'utf8'); } catch { return ''; } },
      (rel) => fileAtRef(root, sinceRef, rel),
    )) : []),
  ];
  const explained = findings.some((f) =>
    f.code === 'failing-test-removed' || f.code === 'test-vanished'
    || f.code === 'test-stopped-running' || f.code === 'focus-lock');
  findings.push(...suiteShrank(base, now.outcomes, explained));

  // Git could not answer, so the file-based checks above saw an empty change
  // list and proved nothing. Saying so is the difference between "we looked"
  // and "we could not look".
  if (!changedRes.ok) {
    findings.push({
      level: NOTICE,
      code: 'changes-unknown',
      title: 'git could not say what this change touched',
      detail: 'The outcome comparison is unaffected, but the checks that read the diff, focus '
        + 'locks and new tests without assertions, had nothing to look at.',
      evidence: [],
    });
  }

  return {
    ok: true,
    inconclusive: null,
    verdict: verdict(findings),
    findings,
    runner: runner.label,
    runnerId: runner.id,
    baseSource,
    healed,
    baselineAge: baselineAge(projectDir),
    summary: summarise(now.outcomes),
    baseSummary: summarise(base),
    suiteExitCode: now.exitCode,
    confirmed,
    elapsedMs: Date.now() - started,
  };

  // A null fingerprint means git could not answer, which is not evidence the
  // tree moved. Treating it as movement silenced every check on a repo git was
  // temporarily unhappy with.
  function movedOnSince(before) {
    if (before === null) return false;
    const nowPrint = treeFingerprint(root, isTrackedEdit);
    return nowPrint !== null && nowPrint !== before;
  }

  function movedOn() {
    return inconclusive(
      'the working tree changed while the suite was running, so this result describes code '
      + 'that has already moved on',
      { runner: runner.label },
    );
  }

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
      healed,
      summary: null,
      baseSummary: null,
      elapsedMs: Date.now() - started,
    };
  }
}

// `timeout: 0` means "no timeout" to Node, so an exhausted budget used to
// remove the ceiling instead of enforcing it. NaN, from `--timeout abc`, did
// the same. Both now floor at one second, which fails fast and honestly.
function capTimeout(requested, remaining) {
  const wanted = Number.isFinite(requested) && requested > 0 ? requested : remaining;
  return Math.max(1000, Math.min(wanted, remaining));
}

// Obtain a baseline for a project that has none, without ever absorbing work
// that has already been done in the working tree.
//
// The hazard this exists to avoid: recording a baseline from a tree the agent
// has already modified writes whatever it did into the definition of normal,
// and the evidence is gone for good. So a dirty tree is measured against HEAD,
// taken from a scratch worktree, rather than against itself.
export function ensureBaseline(root, { runner, projectDir }) {
  if (!isDirty(root)) {
    const res = snapshot(root, { cwd: projectDir, runner: runner.id });
    if (!res.ok) return { ok: false, reason: res.reason };
    return { ok: true, from: 'clean tree', summary: res.summary };
  }

  const ref = gitHead(root);
  if (!ref) {
    return {
      ok: false,
      reason: 'this repository has no commits yet, so there is nothing to take a baseline from. '
        + 'Commit your work, then run `whatran snapshot`.',
    };
  }
  const cap = captureFromRef(root, ref, runner, { projectDir });
  if (!cap.ok) {
    // Deliberately does NOT fall back to snapshotting the dirty tree. That
    // fallback is the laundering move: it would quietly define whatever is
    // already in the tree as correct.
    return {
      ok: false,
      reason: `${cap.reason} Your tree has uncommitted changes, so recording a baseline from it `
        + 'would define those changes as the expected state. Either commit or stash them and run '
        + '`whatran` again, or run `whatran snapshot` if this tree really is your known-good state.',
    };
  }
  const saved = saveBaseline(projectDir, {
    runner: runner.id,
    outcomes: cap.outcomes,
    ref,
    harness: harnessStateAtRef(root, ref),
  });
  return { ok: true, from: `HEAD (${ref.slice(0, 8)})`, summary: saved.summary };
}

// Record the current state of the suite as the thing future runs are measured
// against. Deliberately does not care whether tests are passing: a baseline
// with red tests is the interesting case, because it is the one an agent is
// about to be asked to fix.
export function snapshot(root, opts = {}) {
  const { runner, dir: projectDir } = resolveProject(opts.cwd ?? root, root, opts.runner);
  if (!runner) return { ok: false, reason: 'no supported test runner detected in this repository' };

  const res = runSuite(runner, projectDir, { timeoutMs: opts.timeoutMs });
  if (!res.ok) return { ok: false, reason: res.reason, runner: runner.label };
  // A half-collected suite must never become the definition of normal. Without
  // this, one broken import at snapshot time records a baseline missing every
  // test in that file, and restoring them later reads as new tests appearing.
  if (runner.structuralExit?.(res.exitCode)) {
    return {
      ok: false,
      runner: runner.label,
      reason: `${runner.label} exited ${res.exitCode}, which means the suite did not run to `
        + 'completion. A baseline recorded now would be missing tests that exist, so nothing '
        + 'was written. Fix the collection error and try again.',
    };
  }

  const saved = saveBaseline(projectDir, {
    runner: runner.id,
    outcomes: res.outcomes,
    ref: gitHead(root),
    harness: collectHarnessState(root, () => listFiles(root)),
  });
  return { ok: true, runner: runner.label, summary: saved.summary, path: '.whatran/baseline.json' };
}

// Harness file hashes as of a git ref, for CI mode where there is no recorded
// snapshot to compare against.
// Returns a Map, matching collectHarnessState, so either can be handed to
// saveBaseline. The comparison side wants a plain object and converts.
function harnessStateAtRef(root, ref) {
  const state = new Map();
  for (const rel of listFilesAtRef(root, ref)) {
    if (!isHarnessFile(rel)) continue;
    // Raw bytes, hashed exactly as collectHarnessState hashes the working tree.
    // Reading this through the trimming text helper made every harness file
    // whose content ends in a newline compare as modified on every CI run, and
    // with --strict that is a guaranteed exit 1 on a clean pull request.
    const body = blobAtRef(root, ref, rel);
    if (body === null) continue;
    state.set(rel, createHash('sha1').update(body).digest('hex').slice(0, 16));
  }
  return state;
}

// Re-records the baseline from the current state, and says plainly what that
// changed. Without this there is no way to tell whatran "yes, that was
// deliberate", deleting a genuinely obsolete test would mean being nagged
// until someone thought to re-run `snapshot`. Every linter needs an escape
// hatch; without one people switch the tool off rather than argue with it.
export function accept(root, opts = {}) {
  const { runner, dir: projectDir } = resolveProject(opts.cwd ?? root, root, opts.runner);
  if (!runner) return { ok: false, reason: 'no supported test runner detected in this repository' };

  const loaded = loadBaseline(projectDir);
  const previous = loaded && !loaded.stale ? loaded : null;
  const res = runSuite(runner, projectDir, { timeoutMs: opts.timeoutMs });
  if (!res.ok) return { ok: false, reason: res.reason, runner: runner.label };

  // What is being accepted, described before it stops being visible.
  const accepted = previous
    ? outcomeTransitions(previous.outcomes, res.outcomes)
        .filter((f) => f.level !== INTACT)
    : [];

  const saved = saveBaseline(projectDir, {
    runner: runner.id,
    outcomes: res.outcomes,
    ref: gitHead(root),
    harness: collectHarnessState(root, () => listFiles(root)),
    // An accepted baseline starts clean: a test previously judged unstable gets
    // another chance to prove itself, rather than being exempt forever.
    unstable: [],
  });

  return {
    ok: true,
    runner: runner.label,
    summary: saved.summary,
    accepted,
    hadBaseline: Boolean(previous),
  };
}

// Everything the CLI and the /whatran command need to say what state this
// project is in, without running the suite. One resolver, so the two cannot
// drift apart.
export function status(root, opts = {}) {
  const { runner, dir: projectDir, alternatives } = resolveProject(opts.cwd ?? root, root, opts.runner);
  const saved = runner ? loadBaseline(projectDir) : null;
  const rel = pathMod.relative(root, projectDir).split(pathMod.sep).join('/') || '.';
  return {
    root,
    projectDir: rel,
    runner: runner ? runner.label : null,
    runnerId: runner ? runner.id : null,
    alternatives: (alternatives ?? []).map((r) => r.id),
    hooks: null,
    baseline: saved && !saved.stale
      ? {
        createdAt: saved.createdAt,
        ageMs: baselineAge(projectDir),
        ref: saved.ref,
        runner: saved.runner,
        summary: saved.summary,
        unstable: (saved.unstable ?? []).length,
        current: saved.ref === gitHead(root),
      }
      : null,
    stale: saved && saved.stale ? saved.stale : null,
    dirty: isDirty(root),
    otherProjects: runner ? otherProjects(root, projectDir) : [],
  };
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}
