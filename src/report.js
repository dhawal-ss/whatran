import { DENIED, FLAGGED, ALLOWED } from './checks.js';

const useColour = process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb';
const ESC = String.fromCharCode(27);
const c = (code) => (s) => (useColour ? ESC + `[${code}m` + s + ESC + `[0m` : s);
const red = c('31'), yellow = c('33'), green = c('32'), dim = c('2'), bold = c('1');

const MARK = {
  [DENIED]: () => red('DENIED '),
  [FLAGGED]: () => yellow('FLAGGED'),
  [ALLOWED]: () => green('ALLOWED'),
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

  const denied = findings.filter((f) => f.level === DENIED);
  const flagged = findings.filter((f) => f.level === FLAGGED);
  const allowed = findings.filter((f) => f.level === ALLOWED);

  lines.push('');
  for (const f of [...denied, ...flagged, ...allowed]) {
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
    lines.push(`  ${green('ALLOWED')}  Nothing stopped running.`);
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
export function renderAgentFeedback(findings) {
  const denied = findings.filter((f) => f.level === DENIED);
  if (!denied.length) return '';
  const parts = ['Verification failed. Your change removed test coverage that existed before:'];
  for (const f of denied) {
    parts.push(`\n- ${f.title}`);
    for (const e of f.evidence.slice(0, MAX_EVIDENCE)) parts.push(`    ${e}`);
  }
  parts.push(
    '\nRestore these tests and make them pass by fixing the underlying problem. '
    + 'Do not skip, delete, or weaken them, and do not modify the test harness to work around this. '
    + 'If a test is genuinely obsolete, say so explicitly and explain why rather than removing it silently.',
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
