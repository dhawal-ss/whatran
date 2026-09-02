import fs from 'node:fs';
import path from 'node:path';

// Severity vocabulary, borrowed from the job the tool is named after.
// DENIED  — the evidence contradicts the change. Deterministic; no judgement.
// FLAGGED — worth a look, but legitimate explanations are common.
// ALLOWED — positive evidence, shown so the tool is not purely negative.
export const DENIED = 'denied';
export const FLAGGED = 'flagged';
export const ALLOWED = 'allowed';

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
    }
  }

  if (silenced.length) {
    findings.push({
      level: DENIED,
      code: 'failing-test-silenced',
      title: plural(silenced.length, 'failing test was', 'failing tests were') + ' skipped instead of fixed',
      detail: 'These tests were failing before the change and are now not running at all. '
        + 'The suite reports green because they no longer report anything.',
      evidence: silenced,
    });
  }
  if (removed.length) {
    findings.push({
      level: DENIED,
      code: 'failing-test-removed',
      title: plural(removed.length, 'failing test', 'failing tests') + ' disappeared from the suite',
      detail: 'These tests were failing before the change and are no longer collected — '
        + 'deleted, renamed, or excluded by config.',
      evidence: removed,
    });
  }
  if (vanished.length) {
    findings.push({
      level: FLAGGED,
      code: 'test-vanished',
      title: plural(vanished.length, 'passing test', 'passing tests') + ' no longer collected',
      detail: 'Legitimate after a deliberate deletion or a rename. Worth a glance if you did neither.',
      evidence: vanished,
    });
  }
  if (newlySkipped.length) {
    findings.push({
      level: FLAGGED,
      code: 'passing-test-skipped',
      title: plural(newlySkipped.length, 'passing test is', 'passing tests are') + ' now skipped',
      detail: 'Usually a legitimate platform or feature guard. Not treated as a contradiction.',
      evidence: newlySkipped,
    });
  }
  if (fixed.length) {
    findings.push({
      level: ALLOWED,
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
const HARNESS_DIRS = ['.github/workflows/', '.gitlab-ci', '.circleci/', '.adjuster/'];

export function harnessTampering(changed) {
  const hits = changed.filter((f) => {
    const base = f.split('/').pop() ?? '';
    if (HARNESS_FILES.some((h) => base === h || base.startsWith(h + '.') || base === h + '.js' || base === h + '.ts')) return true;
    return HARNESS_DIRS.some((d) => f.startsWith(d) || f.includes('/' + d));
  });
  if (!hits.length) return [];
  return [{
    level: FLAGGED,
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
const FOCUS_PATTERNS = [
  { re: /\b(?:describe|it|test|suite|bench)\s*\.\s*only\s*\(/, label: '.only' },
  { re: /(?:^|[^\w.])(?:fdescribe|fit)\s*\(/, label: 'fdescribe/fit' },
];

export function focusLocks(root, changed) {
  const hits = [];
  for (const rel of changed) {
    if (!/\.(test|spec)\.[cm]?[jt]sx?$/.test(rel) && !/(^|\/)(__tests__|tests?)\//.test(rel)) continue;
    if (!/\.[cm]?[jt]sx?$/.test(rel)) continue;
    let src;
    try { src = fs.readFileSync(path.join(root, rel), 'utf8'); } catch { continue; }
    for (const line of stripComments(src).split(/\r?\n/)) {
      const found = FOCUS_PATTERNS.find((p) => p.re.test(line));
      if (found) { hits.push(`${rel} — ${found.label}`); break; }
    }
  }
  if (!hits.length) return [];
  return [{
    level: DENIED,
    code: 'focus-lock',
    title: 'A focused test is disabling the rest of its file',
    detail: 'Under Jest, and under Vitest outside CI, every other test in these files silently '
      + 'stops running while the suite still reports green. Almost always left behind by accident.',
    evidence: hits,
  }];
}

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

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
    level: FLAGGED,
    code: 'suite-shrank',
    title: `The suite collects ${drop} fewer test${drop === 1 ? '' : 's'} than before`,
    detail: `${base.size} before, ${head.size} now. Often a rename; sometimes an import error `
      + 'that quietly removed a whole file from collection.',
    evidence: [],
  }];
}

export function verdict(findings) {
  if (findings.some((f) => f.level === DENIED)) return DENIED;
  if (findings.some((f) => f.level === FLAGGED)) return FLAGGED;
  return ALLOWED;
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}
