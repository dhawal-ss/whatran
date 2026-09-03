import { whatran, ensureBaseline, projectDirFor, pickRunner } from './whatran.js';
import { isBlocking, FAILING_LEVELS } from './checks.js';
import { renderAgentFeedback } from './report.js';
import { loadBaseline } from './baseline.js';
import { couldAffectTests } from './relevance.js';
import { shouldWake, clearWake, acquireLock } from './wake.js';

// Hook protocol shared, with small differences, by Claude Code, Codex CLI,
// Gemini CLI and Copilot: a JSON object on stdin, and either exit 2 with a
// message on stderr, or exit 0 with a decision object on stdout.
//
// Exit 2 does not merely warn, it prevents the turn from ending and hands the
// message back to the agent as its next instruction. That is the difference
// between a report a human might read later and a correction that happens now.
export async function runHook(root, flags = {}) {
  const input = await readStdinJson();
  const event = input.hook_event_name ?? input.hookEventName ?? flags.event ?? 'Stop';

  if (event === 'SessionStart') return handleSessionStart(root);

  // Claude Code sets this when the current stop was itself triggered by a hook.
  // Without this guard a failing check would fight the agent in a loop.
  if (input.stop_hook_active === true || input.stopHookActive === true) return 0;

  // This runs on every single turn, and a real suite takes minutes rather than
  // the milliseconds a fixture does. If nothing that could possibly change a
  // test outcome was touched, running the suite is pure latency, and a tool
  // that adds minutes to a turn that edited only a README gets uninstalled for
  // being slow rather than for being wrong.
  const projectDir = projectDirFor(root, null, process.cwd());
  const recorded = loadBaseline(projectDir);
  if (!couldAffectTests(root, recorded && !recorded.stale ? recorded.ref : null)) return 0;

  // Background hooks can overlap with themselves. Without this, a few quick
  // turns on a repo with a slow suite would start several full runs at once.
  const release = acquireLock(projectDir);
  if (!release) {
    debug('another check is already running');
    return 0;
  }
  let result;
  try {
    result = whatran(root, {
      cwd: process.cwd(),
      timeoutMs: flags.timeout ? flags.timeout * 1000 : undefined,
      // A first turn in a project that has never been snapshotted should still
      // check something, rather than reporting nothing forever because a setup
      // step was skipped. ensureBaseline never records from a dirty tree.
      autoBaseline: true,
    });
  } finally {
    release();
  }

  // Inconclusive must never block. If we cannot obtain trustworthy evidence,
  // the honest answer is silence, not an accusation.
  if (!result.ok) {
    debug(result.inconclusive);
    return 0;
  }

  // Only interrupt for things that would otherwise go unnoticed. A test that
  // now fails is already red in the output; a test that stopped running is not.
  if (!isBlocking(result.findings)) {
    clearWake(projectDir);
    return 0;
  }

  // Never say the same thing forever. Claude Code gives up after a run of
  // consecutive synchronous Stop blocks, but whether that counter covers a
  // background rewake is undocumented, and a hook that fires every turn with an
  // instruction the agent cannot satisfy is worse than no hook at all. So
  // whatran keeps its own count rather than relying on someone else's.
  const wake = shouldWake(projectDir, result.findings.filter((f) => FAILING_LEVELS.has(f.level)));
  if (!wake.allowed) {
    debug(`same findings ${wake.attempt} times, staying quiet`);
    return 0;
  }

  // Deciding to interrupt is narrow, but once we are interrupting, report
  // everything that is wrong, the agent is listening and it costs nothing.
  const message = renderAgentFeedback(result.findings, FAILING_LEVELS)
    + (wake.attempt > 1
      ? `\n\nThis is attempt ${wake.attempt} of ${wake.limit}. Repeating the same approach will `
        + 'not clear it: this reads what the suite actually ran, not how the change was made.'
      : '');

  // Cursor cannot be blocked and never reads stderr: its only documented
  // channel is a followup_message on stdout, which it submits as the next
  // turn. Writing to stderr and exiting 2 there, as this did, was a silent
  // no-op, so the Cursor integration did nothing at all.
  if (flags.harness === 'cursor') {
    process.stdout.write(JSON.stringify({ followup_message: message }) + '\n');
    return 0;
  }

  process.stderr.write(message + '\n');
  return 2;
}

// Recording a baseline at session start is the whole reason the tool knows what
// "before" means. But it must never overwrite one that already exists.
//
// It used to re-record whenever HEAD had moved, which is the normal case: an
// agent skips a failing test and commits, the next session starts, HEAD differs,
// and the skip is silently written into the definition of normal. The evidence
// is then gone permanently, and the suite is green. That is a false green
// manufactured by the tool itself, in the exact direction it exists to prevent.
//
// So: record only when there is nothing recorded. A stale baseline is left
// alone too, because a version bump whatran itself caused must not be the
// trigger for erasing everyone's history; the check path heals that safely,
// measuring a dirty tree against HEAD rather than against itself.
function handleSessionStart(root) {
  const projectDir = projectDirFor(root, null, process.cwd());
  const existing = loadBaseline(projectDir);
  if (existing) {
    debug(existing.stale ? `baseline is ${existing.stale}; left alone` : 'baseline already recorded');
    return 0;
  }
  const runner = pickRunner(root, null, process.cwd());
  if (!runner) { debug('no supported test runner detected'); return 0; }
  const made = ensureBaseline(root, { runner, projectDir });
  if (!made.ok) debug(made.reason);
  return 0;
}

function debug(msg) {
  if (process.env.WHATRAN_DEBUG && msg) process.stderr.write(`whatran: ${msg}\n`);
}

function readStdinJson() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve({});
    let buf = '';
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      process.stdin.removeAllListeners('data');
      process.stdin.removeAllListeners('end');
      process.stdin.removeAllListeners('error');
      resolve(value);
    };
    // A partial buffer parses to nothing, and the previous version left its
    // listeners attached afterwards, so a slow writer kept the process alive
    // with a result already returned.
    const timer = setTimeout(() => finish(safeParse(buf)), 2000);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { buf += d; });
    process.stdin.on('end', () => finish(safeParse(buf)));
    process.stdin.on('error', () => finish({}));
  });
}

function safeParse(s) {
  try { return JSON.parse(s) ?? {}; } catch { return {}; }
}
