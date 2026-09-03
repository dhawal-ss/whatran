import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { stripNonCode } from './strip.js';

// What the tool is willing to say, worst first.
//
// MISSING — something that used to run does not run any more.
// BROKE   — something that used to pass now fails.
// NOTICE  — worth a glance, but legitimate explanations are common.
// INTACT  — nothing stopped running.
//
// MISSING and BROKE are treated differently on purpose. A broken test SHOUTS:
// it is red in the output, the agent sees it, CI sees it, nobody can miss it.
// A silenced test HIDES: the suite goes green and the only trace is a line in
// a diff. whatran exists for the second kind, so it blocks the agent's turn on
// MISSING alone. BROKE still fails `check` and CI, but blocking every turn
// where a test happens to be red would make the tool unusable mid-refactor.
export const MISSING = 'missing';
export const BROKE = 'broke';
export const NOTICE = 'notice';
export const INTACT = 'intact';

// Levels that mean "this run is not acceptable" for `check` and CI.
export const FAILING_LEVELS = new Set([MISSING, BROKE]);
// Levels that justify interrupting the agent mid-conversation.
export const BLOCKING_LEVELS = new Set([MISSING]);

// ---------------------------------------------------------------------------
// Check 1 — outcome transitions.
//
// The signal is NOT "a test is skipped". Plenty of tests are legitimately
// skipped, and grepping a diff for skip markers fires on every
// `skipif(sys.platform == "win32")` in the world. The signal is a test that was
// FAILING and is now NOT RUNNING: the failing test is the specification of the
// bug, so anything other than failed -> passed means the specification moved.
// ---------------------------------------------------------------------------
export function outcomeTransitions(base, head) {
  const findings = [];
  const silenced = [];
  const removed = [];
  const fixed = [];
  const newlySkipped = [];
  const vanished = [];

  const regressed = [];

  for (const [id, was] of base) {
    const now = head.get(id);
    if (now === undefined) {
      (was === 'failed' ? removed : vanished).push(id);
    } else if (was === 'failed' && now === 'skipped') {
      silenced.push(id);
    } else if (was === 'failed' && now === 'passed') {
      fixed.push(id);
    } else if (was === 'passed' && now === 'skipped') {
      newlySkipped.push(id);
    } else if (was === 'passed' && now === 'failed') {
      regressed.push(id);
    }
  }

  if (silenced.length) {
    findings.push({
      level: MISSING,
      code: 'failing-test-silenced',
      title: plural(silenced.length, 'failing test was', 'failing tests were') + ' skipped instead of fixed',
      detail: 'These tests were failing before the change and are now not running at all. '
        + 'The suite reports green because they no longer report anything.',
      evidence: silenced,
    });
  }
  if (removed.length) {
    findings.push({
      level: MISSING,
      code: 'failing-test-removed',
      title: plural(removed.length, 'failing test', 'failing tests') + ' disappeared from the suite',
      detail: 'These tests were failing before the change and are no longer collected — '
        + 'deleted, renamed, or excluded by config.',
      evidence: removed,
    });
  }
  if (regressed.length) {
    findings.push({
      level: BROKE,
      code: 'test-regressed',
      title: plural(regressed.length, 'test that passed now fails', 'tests that passed now fail'),
      detail: 'These were green before the change and are red now.',
      evidence: regressed,
    });
  }
  if (vanished.length) {
    findings.push({
      level: NOTICE,
      code: 'test-vanished',
      title: plural(vanished.length, 'passing test', 'passing tests') + ' no longer collected',
      detail: 'Legitimate after a deliberate deletion or a rename. Worth a glance if you did neither.',
      evidence: vanished,
    });
  }
  if (newlySkipped.length) {
    findings.push({
      level: NOTICE,
      code: 'passing-test-skipped',
      title: plural(newlySkipped.length, 'passing test is', 'passing tests are') + ' now skipped',
      detail: 'Usually a legitimate platform or feature guard. Not treated as a contradiction.',
      evidence: newlySkipped,
    });
  }
  if (fixed.length) {
    findings.push({
      level: INTACT,
      code: 'test-fixed',
      title: plural(fixed.length, 'failing test now passes', 'failing tests now pass'),
      detail: 'The honest transition.',
      evidence: fixed,
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Check 2 — harness tampering.
//
// Cheap, binary, and it catches the strongest known attack: a single new
// conftest.py can force every test to report as passed without touching a line
// of source. Benchmarks have been scored 100% this way. Almost nobody looks
// outside the test files themselves.
// ---------------------------------------------------------------------------
const HARNESS_FILES = [
  'conftest.py', 'pytest.ini', 'tox.ini', 'setup.cfg', 'noxfile.py',
  'jest.config', 'vitest.config', 'karma.conf', 'playwright.config',
  'phpunit.xml', 'Makefile', 'justfile', 'Taskfile',
  '.mocharc', 'nextest.toml', 'codecov.yml', '.coveragerc',
];
const HARNESS_DIRS = ['.github/workflows/', '.gitlab-ci', '.circleci/', '.whatran/'];

export function isHarnessFile(f) {
  const base = f.split('/').pop() ?? '';
  if (HARNESS_FILES.some((h) => base === h || base.startsWith(h + '.'))) return true;
  return HARNESS_DIRS.some((d) => f.startsWith(d) || f.includes('/' + d));
}

// Compares content hashes recorded with the baseline against the tree as it is
// now. Using "anything uncommitted" instead would flag a config the developer
// edited last week on every single run, and noise like that is how a tool
// teaches people to ignore it.
export function harnessTampering(baselineHashes, currentHashes) {
  if (!baselineHashes) return [];
  const hits = [];
  for (const [file, hash] of currentHashes) {
    const was = baselineHashes[file];
    if (was === undefined) hits.push(`${file} (added)`);
    else if (was !== hash) hits.push(`${file} (modified)`);
  }
  for (const file of Object.keys(baselineHashes)) {
    if (!currentHashes.has(file)) hits.push(`${file} (removed)`);
  }
  if (!hits.length) return [];
  return [{
    level: NOTICE,
    code: 'harness-modified',
    title: 'The test harness itself was modified',
    detail: 'Changing how tests are collected, run, or reported can turn a red suite green '
      + 'without fixing anything. Confirm this was the point of the change.',
    evidence: hits,
  }];
}

// ---------------------------------------------------------------------------
// Check 3 — focus locks.
//
// A single stray `.only` silently disables every other test in its file while
// the suite still reports green and exits 0. Vitest errors on this in CI;
// Jest and node:test do not.
// ---------------------------------------------------------------------------
// Anchored to statement position. A bare \b match would fire on a test whose
// own name mentions `test.only`, which is exactly the kind of false denial that
// gets a tool switched off.
const FOCUS_PATTERNS = [
  { re: /^\s*(?:await\s+)?(?:describe|it|test|suite|bench)\s*\.\s*only\s*[.(]/, label: '.only' },
  { re: /^\s*(?:await\s+)?(?:fdescribe|fit)\s*\(/, label: 'fdescribe/fit' },
];

export function focusLocks(root, changed) {
  const hits = [];
  for (const rel of changed) {
    if (!/\.(test|spec)\.[cm]?[jt]sx?$/.test(rel) && !/(^|\/)(__tests__|tests?)\//.test(rel)) continue;
    if (!/\.[cm]?[jt]sx?$/.test(rel)) continue;
    let src;
    try { src = fs.readFileSync(path.join(root, rel), 'utf8'); } catch { continue; }
    for (const line of stripNonCode(src).split(/\r?\n/)) {
      const found = FOCUS_PATTERNS.find((p) => p.re.test(line));
      if (found) { hits.push(`${rel} — ${found.label}`); break; }
    }
  }
  if (!hits.length) return [];
  return [{
    level: MISSING,
    code: 'focus-lock',
    title: 'A focused test is disabling the rest of its file',
    detail: 'Under Jest, and under Vitest outside CI, every other test in these files silently '
      + 'stops running while the suite still reports green. Almost always left behind by accident.',
    evidence: hits,
  }];
}

// Comments and string literals are blanked (not deleted) so line numbers and
// statement positions survive. Without this, a test whose *name* mentions
// `test.only` would be reported as a focus lock.

// ---------------------------------------------------------------------------
// Check 4 — the suite got smaller.
//
// A blunt backstop for every mechanism the specific checks miss: a broken
// import that drops a whole module from collection, an edited CI filter, a
// renamed directory. Only reported when nothing more specific explains it.
// ---------------------------------------------------------------------------
export function suiteShrank(base, head, alreadyExplained) {
  const drop = base.size - head.size;
  if (drop <= 0 || alreadyExplained) return [];
  return [{
    level: NOTICE,
    code: 'suite-shrank',
    title: `The suite collects ${drop} fewer test${drop === 1 ? '' : 's'} than before`,
    detail: `${base.size} before, ${head.size} now. Often a rename; sometimes an import error `
      + 'that quietly removed a whole file from collection.',
    evidence: [],
  }];
}

export function verdict(findings) {
  for (const level of [MISSING, BROKE, NOTICE]) {
    if (findings.some((f) => f.level === level)) return level;
  }
  return INTACT;
}

// Should `check` / CI treat this run as a failure?
export function isFailing(findings) {
  return findings.some((f) => FAILING_LEVELS.has(f.level));
}

// Should the agent's turn be interrupted? Deliberately narrower — see the
// note on the level constants above.
export function isBlocking(findings) {
  return findings.some((f) => BLOCKING_LEVELS.has(f.level));
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

// ---------------------------------------------------------------------------
// Harness state capture. Hashes every harness-shaped file in the repo so a
// later run can tell what actually changed since the baseline.
// ---------------------------------------------------------------------------
export function collectHarnessState(root, listFiles) {
  const state = new Map();
  for (const rel of listFiles()) {
    if (!isHarnessFile(rel)) continue;
    try {
      const buf = fs.readFileSync(path.join(root, rel));
      state.set(rel, crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16));
    } catch { /* unreadable or deleted between listing and reading */ }
  }
  return state;
}

// ---------------------------------------------------------------------------
// Check 5 — new tests that do not check anything.
//
// A test that runs but verifies nothing is worse than no test at all: the suite
// looks larger and coverage looks better while nothing is actually proven. It
// is also the most common weakness in agent-written tests.
//
// Always a NOTICE. A test that only asserts "this does not throw" is a real and
// legitimate practice, so this is a nudge, never a verdict.
// ---------------------------------------------------------------------------
export function assertionFreeTests(bare) {
  if (!bare.length) return [];
  return [{
    level: NOTICE,
    code: 'test-without-assertion',
    title: plural(bare.length, 'new test does not appear to check anything',
      'new tests do not appear to check anything'),
    detail: 'These were added by this change and contain no assertion we can see. '
      + 'A smoke test that only proves the code does not throw is legitimate — but if that '
      + 'was not the intent, the test is passing for free.',
    evidence: bare,
  }];
}

// ---------------------------------------------------------------------------
// Identity guard — parametrised families whose size changed.
//
// The worst bug this tool can have is a silent false negative, and positional
// parametrisation produces one. pytest ids a parametrised case by position
// when the value has no readable form: [v0], [v1], [v2]. Insert a case at the
// front and every later id now labels a different value — so a failing case
// silently becomes "the honest transition" while the failure just moved along
// one. Nothing is missing, nothing broke, and whatran hands out a clean bill.
//
// The fix is to notice that the family changed size at all. When it has, no
// comparison inside it means anything, so say so rather than guessing.
// ---------------------------------------------------------------------------

// `mod::test_x[v0]` -> `mod::test_x`;  `pkg::TestF/sub#01` -> `pkg::TestF/sub`
function familyOf(id) {
  return id.replace(/\[[^\]]*\]$/, '').replace(/#\d+$/, '');
}

function countByFamily(ids) {
  const counts = new Map();
  for (const id of ids) {
    const f = familyOf(id);
    if (f === id) continue; // not parametrised; identity is its own name
    counts.set(f, (counts.get(f) ?? 0) + 1);
  }
  return counts;
}

// Ids whose before/after comparison cannot be trusted, because the family they
// belong to changed size between the two runs.
export function unverifiableIds(base, head) {
  const b = countByFamily(base.keys());
  const h = countByFamily(head.keys());
  const shifted = new Set();
  for (const [fam, n] of b) if (h.get(fam) !== n) shifted.add(fam);
  for (const [fam, n] of h) if (b.get(fam) !== n) shifted.add(fam);
  if (!shifted.size) return { ids: new Set(), families: [] };

  const ids = new Set();
  for (const id of [...base.keys(), ...head.keys()]) {
    if (shifted.has(familyOf(id))) ids.add(id);
  }
  return { ids, families: [...shifted] };
}

export function identityChanged(families) {
  if (!families.length) return [];
  return [{
    level: NOTICE,
    code: 'identity-shifted',
    title: plural(families.length, 'parametrised test changed size', 'parametrised tests changed size'),
    detail: 'Adding or removing a case renumbers the others, so the same name no longer refers to '
      + 'the same input. Outcomes inside these cannot be compared before and after, and are '
      + 'excluded from the findings above.',
    evidence: families,
  }];
}
