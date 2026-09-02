import { MISSING, BROKE, NOTICE, INTACT } from './checks.js';

const useColour = process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb';
const ESC = String.fromCharCode(27);
const c = (code) => (s) => (useColour ? ESC + `[${code}m` + s + ESC + `[0m` : s);
const red = c('31'), yellow = c('33'), green = c('32'), dim = c('2'), bold = c('1');

const MARK = {
  [MISSING]: () => red('MISSING'),
  [BROKE]: () => red('BROKE  '),
  [NOTICE]: () => yellow('NOTICE '),
  [INTACT]: () => green('INTACT '),
};

const MAX_EVIDENCE = 8;

// Human-readable ledger. Deliberately quiet when there is nothing to say —
// a tool that prints a wall of text on every turn gets switched off.
export function renderLedger({ findings, verdict, summary, baseSummary, runner, elapsedMs, inconclusive }) {
  const lines = [];

  if (inconclusive) {
    lines.push('');
    lines.push(`  ${yellow('INCONCLUSIVE')}  ${inconclusive}`);
    lines.push(dim('  No claim is being made about this change.'));
    lines.push('');
    return lines.join('\n');
  }

  // Worst first — the reader should not have to scan for the important line.
  const ORDER = [MISSING, BROKE, NOTICE, INTACT];
  const ordered = ORDER.flatMap((level) => findings.filter((f) => f.level === level));

  lines.push('');
  for (const f of ordered) {
    lines.push(`  ${MARK[f.level]()}  ${bold(f.title)}`);
    if (f.detail) lines.push(dim(wrap(f.detail, 74, '            ')));
    for (const e of f.evidence.slice(0, MAX_EVIDENCE)) {
      lines.push(dim('            · ') + e);
    }
    if (f.evidence.length > MAX_EVIDENCE) {
      lines.push(dim(`            · …and ${f.evidence.length - MAX_EVIDENCE} more`));
    }
    lines.push('');
  }

  if (!findings.length) {
    lines.push(`  ${green('INTACT ')}  Nothing stopped running.`);
    lines.push('');
  }

  lines.push(dim(`  ${runner} · ${describeSuite(baseSummary, summary)}${elapsedMs ? ` · ${(elapsedMs / 1000).toFixed(1)}s` : ''}`));
  lines.push('');
  return lines.join('\n');
}

function describeSuite(before, after) {
  if (!after) return 'no run';
  const now = `${after.total} tests, ${after.passed} passed, ${after.failed} failed, ${after.skipped} skipped`;
  if (!before) return now;
  const delta = after.total - before.total;
  if (delta === 0) return now;
  return `${now} (${delta > 0 ? '+' : ''}${delta} vs baseline)`;
}

// The message fed back to the agent when a Stop hook blocks. Written as an
// instruction to the agent, not as a report to a human: it has to be actionable
// by whatever is reading it next.
// What to tell the agent, per kind of finding. This string is the tool's entire
// influence over what happens next, so each finding gets advice that actually
// fits it — "restore these tests" is the wrong instruction for a regression,
// and worse than useless for uncovered code.
const GUIDANCE = {
  'failing-test-silenced':
    'Restore these tests and make them pass by fixing the underlying problem. Do not skip them. '
    + 'If one is genuinely obsolete, say so explicitly and explain why rather than silencing it.',
  'failing-test-removed':
    'Put these tests back and make them pass by fixing the underlying problem. '
    + 'If one is genuinely obsolete, say so explicitly and explain why rather than deleting it.',
  'test-regressed':
    'Your change broke these. Fix the code so they pass again. Do not edit the tests to match the '
    + 'new behaviour unless changing that behaviour was the point, in which case say so explicitly.',
  'focus-lock':
    'Remove the `.only` / `fdescribe` / `fit` so the rest of the file runs again. It was almost '
    + 'certainly left behind by accident while debugging.',
  'harness-modified':
    'You changed how tests are collected or run. If that was not the point of this task, revert it. '
    + 'If it was, say so explicitly and describe what changed.',
  'uncovered-change':
    'Add tests that actually exercise these lines, or explain why they cannot be tested.',
  'test-vanished':
    'These tests are no longer collected. If you renamed or moved them, that is fine — say so. '
    + 'If you did neither, find out what stopped collecting them.',
};

const FALLBACK_GUIDANCE =
  'Address this by changing the code, not by changing what the tests measure.';

export function renderAgentFeedback(findings, levels) {
  const relevant = findings.filter((f) => levels.has(f.level));
  if (!relevant.length) return '';

  const parts = ['whatran compared what your test suite ran before this change with what it runs now.'];
  for (const f of relevant) {
    parts.push(`\n${f.title}:`);
    for (const e of f.evidence.slice(0, MAX_EVIDENCE)) parts.push(`    ${e}`);
    if (f.evidence.length > MAX_EVIDENCE) {
      parts.push(`    …and ${f.evidence.length - MAX_EVIDENCE} more`);
    }
    parts.push(`  -> ${GUIDANCE[f.code] ?? FALLBACK_GUIDANCE}`);
  }
  parts.push('\nDo not modify the test harness to work around any of this.');
  return parts.join('\n');
}

export function renderJson(payload) {
  return JSON.stringify(payload, null, 2);
}

function wrap(text, width, indent) {
  const words = text.split(/\s+/);
  const out = [];
  let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > width) { out.push(indent + line.trim()); line = w; }
    else line += ' ' + w;
  }
  if (line.trim()) out.push(indent + line.trim());
  return out.join('\n');
}
