import { MISSING, BROKE, NOTICE, INTACT } from './checks.js';

// NO_COLOR is honoured for ANY value, including an empty one, which is what the
// spec says. FORCE_COLOR turns colour on where stdout is not a TTY, which is
// most CI logs, and those render ANSI perfectly well.
const forced = process.env.FORCE_COLOR;
const useColour = process.env.NO_COLOR === undefined
  && process.env.TERM !== 'dumb'
  && (forced !== undefined && forced !== '0' ? true : Boolean(process.stdout.isTTY));
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

// A test name comes from the suite's own output, so it is attacker-controlled
// in the only sense that matters here: an agent chooses it. A name containing a
// newline used to inject arbitrary lines straight into the instruction handed
// back to the agent, which could forge whatever came next.
function safe(text) {
  return String(text).replace(/[\r\n\t]+/g, ' ').trim().slice(0, 300);
}

function more(n) {
  return `…and ${n - MAX_EVIDENCE} more`;
}

// Human-readable ledger. Deliberately quiet when there is nothing to say,
// a tool that prints a wall of text on every turn gets switched off.
export function renderLedger(result) {
  const {
    findings, summary, baseSummary, runner, elapsedMs, inconclusive,
    baseSource, confirmed, healed, baselineAge: age,
  } = result;
  const lines = [];

  if (inconclusive) {
    lines.push('');
    lines.push(`  ${yellow('INCONCLUSIVE')}  ${inconclusive}`);
    lines.push(dim('  No claim is being made about this change.'));
    lines.push('');
    return lines.join('\n');
  }

  lines.push('');
  if (healed) {
    lines.push(dim(`  Baseline: ${healed.why}, so one was recorded from ${healed.from}.`));
    lines.push('');
  }

  // Worst first, the reader should not have to scan for the important line.
  const ORDER = [MISSING, BROKE, NOTICE, INTACT];
  const ordered = ORDER.flatMap((level) => findings.filter((f) => f.level === level));

  for (const f of ordered) {
    lines.push(`  ${MARK[f.level]()}  ${bold(f.title)}`);
    if (f.detail) lines.push(dim(wrap(f.detail, 74, '            ')));
    for (const e of f.evidence.slice(0, MAX_EVIDENCE)) {
      lines.push(dim('            · ') + safe(e));
    }
    if (f.evidence.length > MAX_EVIDENCE) {
      lines.push(dim(`            · ${more(f.evidence.length)}`));
    }
    lines.push('');
  }

  if (!findings.length) {
    lines.push(`  ${green('INTACT ')}  Nothing stopped running.`);
    lines.push('');
  }

  // What it compared against, and whether the accusation was checked twice.
  // Both were in the JSON and neither was ever on screen, so a baseline
  // recorded before a long refactor looked exactly like a fresh one.
  const provenance = [baseSource && `vs ${baseSource}`, age !== null && age !== undefined && `${describeAge(age)} old`]
    .filter(Boolean).join(', ');
  if (provenance) lines.push(dim(`  ${provenance}${confirmed ? ', confirmed by a second run' : ''}`));

  lines.push(dim(`  ${runner} · ${describeSuite(baseSummary, summary)}${elapsedMs ? ` · ${(elapsedMs / 1000).toFixed(1)}s` : ''}`));
  lines.push('');
  return lines.join('\n');
}

export function describeAge(ms) {
  if (ms < 60000) return 'under a minute';
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${count(mins, 'minute')}`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${count(hours, 'hour')}`;
  return `${count(Math.round(hours / 24), 'day')}`;
}

const count = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function describeSuite(before, after) {
  if (!after) return 'no run';
  const now = `${count(after.total, 'test')}, ${after.passed} passed, ${after.failed} failed, ${after.skipped} skipped`;
  if (!before) return now;
  const delta = after.total - before.total;
  if (delta === 0) return now;
  return `${now} (${delta > 0 ? '+' : ''}${delta} vs baseline)`;
}

// What to tell the agent, per kind of finding. This string is the tool's entire
// influence over what happens next, so each finding gets advice that actually
// fits it, "restore these tests" is the wrong instruction for a regression,
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
  'test-stopped-running':
    'These were running before and are not now, in files you edited. If you renamed or moved them, '
    + 'say so. If you did not, find out what stopped collecting them and put them back.',
  'family-lost-failures':
    'A parametrised family lost failing cases. Renumbering means the exact case cannot be named, '
    + 'so check the family yourself: restore the case that was failing and fix the code under it.',
  'focus-lock':
    'Remove the `.only` / `fdescribe` / `fit` / module-level skip so the rest of the file runs '
    + 'again. It was almost certainly left behind by accident while debugging.',
  'harness-modified':
    'You changed how tests are collected or run. If that was not the point of this task, revert it. '
    + 'If it was, say so explicitly and describe what changed.',
  'test-vanished':
    'These tests are no longer collected. If you renamed or moved them, that is fine, say so. '
    + 'If you did neither, find out what stopped collecting them.',
};

const FALLBACK_GUIDANCE =
  'Address this by changing the code, not by changing what the tests measure.';

// The message fed back to the agent when a Stop hook blocks. Written as an
// instruction to whatever reads it next, not as a report to a human.
//
// Two things it must do that a report does not. It has to say how to VERIFY the
// fix, because an agent that cannot check its own work will simply assert that
// it is done. And it has to give a way out that is not the eraser: `whatran
// accept` would clear the finding without fixing anything, so the escape hatch
// offered here is to explain the situation to the person, never to silence it.
export function renderAgentFeedback(findings, levels) {
  const relevant = findings.filter((f) => levels.has(f.level));
  if (!relevant.length) return '';

  const parts = [
    'STOP. whatran compared what your test suite ran BEFORE this change with what it runs now, '
    + 'and coverage went missing. The suite being green does not settle this: these tests are '
    + 'green because they are no longer reporting.',
  ];
  for (const f of relevant) {
    parts.push(`\n${safe(f.title)}:`);
    for (const e of f.evidence.slice(0, MAX_EVIDENCE)) parts.push(`    ${safe(e)}`);
    if (f.evidence.length > MAX_EVIDENCE) parts.push(`    ${more(f.evidence.length)}`);
    parts.push(`  -> ${GUIDANCE[f.code] ?? FALLBACK_GUIDANCE}`);
  }
  parts.push(
    '\nThen verify it: re-run the test suite yourself and confirm by name that each test listed '
    + 'above now runs and passes. Do not report back until you have seen that output.',
  );
  parts.push(
    'Do not modify the test harness, the test configuration, or whatran itself to work around any '
    + 'of this. If you genuinely believe a test above should no longer exist, leave it in place, '
    + 'stop, and explain your reasoning to the user, so a person can decide.',
  );
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

export const __test = { GUIDANCE, safe, more, MAX_EVIDENCE };
