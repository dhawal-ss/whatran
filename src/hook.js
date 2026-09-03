import { whatran, snapshot } from './whatran.js';
import { isBlocking, FAILING_LEVELS } from './checks.js';
import { renderAgentFeedback } from './report.js';
import { loadBaseline } from './baseline.js';
import { projectDirFor } from './whatran.js';
import { head as gitHead } from './git.js';
import { couldAffectTests } from './relevance.js';

const STALE_MS = 8 * 60 * 60 * 1000;

// Hook protocol shared, with small differences, by Claude Code, Codex CLI,
// Gemini CLI and Copilot: a JSON object on stdin, and either exit 2 with a
// message on stderr, or exit 0 with a decision object on stdout.
//
// Exit 2 does not merely warn — it prevents the turn from ending and hands the
// message back to the agent as its next instruction. That is the difference
// between a report a human might read later and a correction that happens now.
export async function runHook(root, flags = {}) {
  const input = await readStdinJson();
  const event = input.hook_event_name ?? input.hookEventName ?? flags.event ?? 'Stop';

  if (event === 'SessionStart' || flags.event === 'SessionStart') {
    return handleSessionStart(root);
  }

  // Claude Code sets this when the current stop was itself triggered by a hook.
  // Without this guard a failing check would fight the agent in a loop.
  if (input.stop_hook_active === true || input.stopHookActive === true) return 0;

  // This runs on every single turn, and a real suite takes minutes rather than
  // the milliseconds a fixture does. If nothing that could possibly change a
  // test outcome was touched, running the suite is pure latency — and a tool
  // that adds minutes to a turn that edited only a README gets uninstalled for
  // being slow rather than for being wrong.
  const recorded = loadBaseline(projectDirFor(root, null, process.cwd()));
  if (!couldAffectTests(root, recorded?.ref ?? null)) return 0;

  const result = whatran(root, { cwd: process.cwd(), timeoutMs: flags.timeout ? flags.timeout * 1000 : undefined });

  // Inconclusive must never block. If we cannot obtain trustworthy evidence,
  // the honest answer is silence, not an accusation.
  if (!result.ok) {
    if (process.env.WHATRAN_DEBUG) process.stderr.write(`whatran: ${result.inconclusive}\n`);
    return 0;
  }

  // Only interrupt for things that would otherwise go unnoticed. A test that
  // now fails is already red in the output; a test that stopped running is not.
  if (!isBlocking(result.findings)) return 0;

  // Deciding to interrupt is narrow, but once we are interrupting, report
  // everything that is wrong — the agent is listening and it costs nothing.
  const message = renderAgentFeedback(result.findings, FAILING_LEVELS);

  // Cursor cannot be blocked and never reads stderr: its only documented
  // channel is a followup_message on stdout, which it submits as the next
  // turn. Writing to stderr and exiting 2 there — as this did — was a silent
  // no-op, so the Cursor integration did nothing at all.
  if (flags.harness === 'cursor') {
    process.stdout.write(JSON.stringify({ followup_message: message }) + '\n');
    return 0;
  }

  process.stderr.write(message + '\n');
  return 2;
}

function handleSessionStart(root) {
  const existing = loadBaseline(projectDirFor(root, null, process.cwd()));
  const current = gitHead(root);
  const fresh = existing
    && !existing.stale
    && existing.ref === current
    && Date.now() - Date.parse(existing.createdAt) < STALE_MS;
  if (fresh) return 0;

  const res = snapshot(root, { cwd: process.cwd() });
  if (!res.ok) {
    if (process.env.WHATRAN_DEBUG) process.stderr.write(`whatran: ${res.reason}\n`);
    return 0;
  }
  return 0;
}

function readStdinJson() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve({});
    let buf = '';
    const timer = setTimeout(() => resolve(safeParse(buf)), 2000);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { buf += d; });
    process.stdin.on('end', () => { clearTimeout(timer); resolve(safeParse(buf)); });
    process.stdin.on('error', () => { clearTimeout(timer); resolve({}); });
  });
}

function safeParse(s) {
  try { return JSON.parse(s) ?? {}; } catch { return {}; }
}
