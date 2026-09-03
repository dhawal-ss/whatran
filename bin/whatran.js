#!/usr/bin/env node
import process from 'node:process';
import { readFileSync } from 'node:fs';
import { repoRoot } from '../src/git.js';
import {
  whatran, snapshot, accept, status, pickRunner, projectDirFor, NOTICE,
} from '../src/whatran.js';
import { isFailing } from '../src/checks.js';
import { renderLedger, renderJson, describeAge } from '../src/report.js';
import { runHook } from '../src/hook.js';
import { installHooks, uninstallHooks, installedTargets } from '../src/install.js';
import { detectRunners } from '../src/runners.js';

const HELP = `
  whatran: catches the test that stopped running.

  Usage
    whatran                     check the working tree; records a baseline first if there is none
    whatran status              what is set up here, without running anything
    whatran snapshot            record the current suite as the baseline
    whatran accept              accept the current state as the new normal
    whatran check [--base REF]  check; with --base, compare against a git ref instead
    whatran init                snapshot + install the agent hook and /whatran command
    whatran uninstall           remove the agent hook and /whatran command
    whatran hook                stdin/stdout hook protocol (called by your agent)
    whatran detect              show which test runner would be used

  Options
    --base <ref>     compare against a git ref (CI/PR mode) rather than a snapshot
    --runner <id>    force a runner: pytest, jest, vitest, go, node-test, nextest
    --json           machine-readable output
    --quiet          print nothing unless something is denied
    --strict         also fail on notices (exit 1) and on inconclusive (exit 3)
    --timeout <sec>  cap the whole check (default 900)
    --no-fail        never exit non-zero for findings (tool errors still exit 2)
    --no-baseline    do not record a baseline automatically; report and stop
    --harness <id>   tell the hook which agent invoked it (cursor, codex)
    --version        print the version

  Exit codes
    0  nothing to report, or no claim could be made (see --strict)
    1  something is missing or broke (also notices, with --strict)
    2  whatran itself could not run
    3  inconclusive, with --strict: the check did not happen
`;

// Flags that consume the next argument. Without this list the subcommand was
// taken to be the first argument that did not start with a dash, so
// `whatran --runner pytest snapshot` ran `check` against a project called
// "pytest" and cheerfully printed INTACT.
const VALUED = new Set(['--base', '--harness', '--event', '--runner', '--timeout']);

const argv = process.argv.slice(2);
const { flags, positional } = parseArgs(argv);
const cmd = positional[0] ?? 'check';

if (flags.help || cmd === 'help') { process.stdout.write(HELP); process.exit(0); }
if (flags.version) {
  process.stdout.write(pkg().version + '\n');
  process.exit(0);
}
if (flags.timeout !== undefined && !Number.isFinite(flags.timeout)) {
  fatal('--timeout needs a number of seconds');
}

const root = repoRoot();
if (!root) {
  fatal('whatran needs to run inside a git repository (it compares against git state).');
}

try {
  switch (cmd) {
    case 'hook': await cmdHook(); break;
    case 'status': cmdStatus(); break;
    case 'snapshot': cmdSnapshot(); break;
    case 'accept': cmdAccept(); break;
    case 'init': cmdInit(); break;
    case 'uninstall': cmdUninstall(); break;
    case 'detect': cmdDetect(); break;
    case 'check': cmdCheck(); break;
    default:
      fatal(`unknown command "${cmd}". Run \`whatran --help\` to see what there is.`);
  }
} catch (err) {
  fatal(err && err.message ? err.message : String(err));
}

function cmdCheck() {
  const result = whatran(root, {
    cwd: process.cwd(),
    baseRef: flags.base,
    runner: flags.runner,
    timeoutMs: flags.timeout ? flags.timeout * 1000 : undefined,
    // The single worst friction point in the tool was telling a first-time user
    // to go and run a different command before this one would do anything.
    // ensureBaseline never records from a tree that already has uncommitted
    // work in it, so this cannot absorb what the agent already did.
    autoBaseline: !flags.noBaseline && !flags.base,
  });

  if (flags.json) {
    process.stdout.write(renderJson(serialise(result)) + '\n');
  } else if (!flags.quiet || isFailing(result.findings)) {
    process.stdout.write(renderLedger(result));
  }

  if (flags.noFail) process.exit(0);
  if (isFailing(result.findings)) process.exit(1);
  if (flags.strict && !result.ok) process.exit(3);
  if (flags.strict && result.verdict === NOTICE) process.exit(1);
  process.exit(0);
}

// What is set up here, answered without running a suite. The question "am I
// actually covered?" had no cheap answer at all: you had to run the whole
// thing and read between the lines of the result.
function cmdStatus() {
  const s = status(root, { cwd: process.cwd(), runner: flags.runner });
  s.hooks = installedTargets(root);

  if (flags.json) {
    process.stdout.write(renderJson(s) + '\n');
    process.exit(0);
  }

  const out = [''];
  if (!s.runner) {
    out.push('  No supported test runner detected.');
    out.push(`  Looked in ${s.projectDir === '.' ? 'the repository root' : s.projectDir} and upwards for:`);
    out.push('    pytest, Vitest, Jest, node:test, go test, cargo nextest');
    out.push('  Pin one with --runner <id> if it is there but not being found.');
    out.push('');
    process.stdout.write(out.join('\n'));
    process.exit(0);
  }

  out.push(`  Runner    ${s.runner}${s.alternatives.length ? `  (also found: ${s.alternatives.join(', ')})` : ''}`);
  out.push(`  Project   ${s.projectDir}`);
  if (s.baseline) {
    const b = s.baseline;
    out.push(`  Baseline  ${describeAge(b.ageMs)} old, ${b.summary.total} tests`
      + ` (${b.summary.passed} passed, ${b.summary.failed} failed, ${b.summary.skipped} skipped)`);
    out.push(`            recorded at ${b.ref ? b.ref.slice(0, 8) : 'an unknown commit'}`
      + `${b.current ? ', which is still HEAD' : ', and HEAD has moved since'}`);
    if (b.unstable) out.push(`            ${b.unstable} test(s) on the flake ledger`);
  } else if (s.stale) {
    out.push(`  Baseline  unusable (${s.stale}); the next check will record a fresh one`);
  } else {
    out.push('  Baseline  none yet; the next check will record one');
  }
  out.push(`  Tree      ${s.dirty ? 'has uncommitted changes' : 'clean'}`);
  out.push(`  Hooks     ${s.hooks.length ? s.hooks.map((h) => h.label).join(', ') : 'none installed (run `whatran init`)'}`);
  for (const h of s.hooks) if (h.note) out.push(`            ! ${h.label}: ${h.note}`);
  if (s.otherProjects.length) {
    out.push(`  Not checked  ${s.otherProjects.join(', ')} (run whatran from there too)`);
  }
  out.push('');
  process.stdout.write(out.join('\n'));
}

function cmdSnapshot() {
  const res = snapshot(root, {
    cwd: process.cwd(),
    runner: flags.runner,
    timeoutMs: flags.timeout ? flags.timeout * 1000 : undefined,
  });
  if (!res.ok) fatal(res.reason);
  const s = res.summary;
  if (flags.json) {
    process.stdout.write(renderJson(res) + '\n');
  } else {
    process.stdout.write(
      `\n  Baseline recorded, ${res.runner}\n`
      + `  ${tests(s.total)}: ${s.passed} passed, ${s.failed} failed, ${s.skipped} skipped\n`
      + `  Saved to ${res.path}\n\n`
      + `  Anything that stops running from here on will be reported.\n\n`,
    );
  }
}

function cmdInit() {
  const runner = pickRunner(root, flags.runner, process.cwd());
  if (!runner) {
    fatal('no supported test runner detected here. whatran supports pytest, Vitest, Jest, '
      + 'node:test, go test and cargo nextest, and looks from this directory upwards. '
      + 'Pin one with --runner <id> if it is there but not being found.');
  }
  process.stdout.write(`\n  Detected ${runner.label}. Recording a baseline…\n`);
  const res = snapshot(root, {
    cwd: process.cwd(), runner: flags.runner, timeoutMs: flags.timeout ? flags.timeout * 1000 : undefined });
  if (!res.ok) fatal(res.reason);
  const s = res.summary;
  process.stdout.write(`  ${tests(s.total)}: ${s.passed} passed, ${s.failed} failed, ${s.skipped} skipped\n`);

  const installed = installHooks(root, { version: pkg().version });
  for (const line of installed.lines) process.stdout.write(`  ${line}\n`);

  // Saying "your agent will now be stopped" when nothing was installed is the
  // worst kind of lie a safety tool can tell: the user stops looking.
  if (installed.installed > 0) {
    process.stdout.write('\n  Done. Your agent will be stopped if it removes coverage.\n');
    process.stdout.write('  Type /whatran in Claude Code to check on demand.\n\n');
  } else {
    process.stdout.write('\n  The baseline is recorded, but no agent hook was installed, so nothing\n');
    process.stdout.write('  will happen automatically. Run `whatran` yourself, or add it to CI:\n');
    process.stdout.write('      npx whatran check --base main\n\n');
    process.exit(2);
  }
}

function cmdUninstall() {
  for (const line of uninstallHooks(root)) process.stdout.write(`  ${line}\n`);
}

function cmdDetect() {
  const found = detectRunners(projectDirFor(root, flags.runner, process.cwd()));
  if (!found.length) {
    process.stdout.write('  No supported test runner detected.\n');
    process.exit(1);
  }
  for (const r of found) {
    process.stdout.write(`  ${r === found[0] ? '→' : ' '} ${r.label} (${r.id}, ${r.lang})\n`);
  }
}

async function cmdHook() {
  // A hook exits 2 to BLOCK the agent's turn and hand it an instruction. An
  // uncaught exception reaching the top level therefore fabricated a blocking
  // instruction out of a stack trace. Nothing but a deliberate finding may
  // produce a 2 here.
  let code = 0;
  try {
    code = await runHook(root, flags);
  } catch (err) {
    if (process.env.WHATRAN_DEBUG) {
      process.stderr.write(`whatran: hook failed: ${err && err.message ? err.message : err}\n`);
    }
    code = 0;
  }
  process.exit(code === 2 ? 2 : 0);
}

function serialise(r) {
  return {
    // Versioned so a consumer can tell when this shape changes under it.
    schema: 1,
    verdict: r.verdict,
    inconclusive: r.inconclusive,
    runner: r.runner,
    runnerId: r.runnerId,
    baseSource: r.baseSource,
    baselineAgeMs: r.baselineAge ?? null,
    healed: r.healed ?? null,
    summary: r.summary,
    baseSummary: r.baseSummary,
    suiteExitCode: r.suiteExitCode ?? null,
    // Whether a second run confirmed the findings. CI consumers should know
    // the difference between "checked twice" and "seen once".
    confirmed: r.confirmed ?? false,
    elapsedMs: r.elapsedMs,
    findings: r.findings.map((f) => ({
      level: f.level, code: f.code, title: f.title, detail: f.detail, evidence: f.evidence,
    })),
  };
}

function parseArgs(args) {
  const f = { json: false, quiet: false, strict: false, noFail: false, help: false, noBaseline: false };
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('-')) { positional.push(a); continue; }
    if (a === '--json') f.json = true;
    else if (a === '--quiet' || a === '-q') f.quiet = true;
    else if (a === '--strict') f.strict = true;
    else if (a === '--no-fail') f.noFail = true;
    else if (a === '--no-baseline') f.noBaseline = true;
    else if (a === '--help' || a === '-h') f.help = true;
    else if (a === '--version' || a === '-v') f.version = true;
    else if (a === '--base') f.base = args[++i];
    else if (a.startsWith('--base=')) f.base = a.slice(7);
    else if (a === '--harness') f.harness = args[++i];
    else if (a.startsWith('--harness=')) f.harness = a.slice(10);
    else if (a === '--event') f.event = args[++i];
    else if (a.startsWith('--event=')) f.event = a.slice(8);
    else if (a === '--runner') f.runner = args[++i];
    else if (a.startsWith('--runner=')) f.runner = a.slice(9);
    else if (a === '--timeout') f.timeout = Number(args[++i]);
    else if (a.startsWith('--timeout=')) f.timeout = Number(a.slice(10));
    else if (VALUED.has(a)) i++;
  }
  return { flags: f, positional };
}

function pkg() {
  return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
}

// A function declaration, not a const: the command switch runs at the top of
// this module, before any const further down has been initialised.
function tests(n) {
  return `${n} test${n === 1 ? '' : 's'}`;
}

// 0 clean · 1 findings · 2 whatran itself could not run · 3 inconclusive, with
// --strict. A typo in --runner exiting 1 was indistinguishable from removed
// coverage, which no CI pipeline can work around.
function fatal(msg) {
  process.stderr.write(`\n  whatran: ${msg}\n\n`);
  process.exit(2);
}

function cmdAccept() {
  const res = accept(root, {
    cwd: process.cwd(),
    runner: flags.runner,
    timeoutMs: flags.timeout ? flags.timeout * 1000 : undefined,
  });
  if (!res.ok) fatal(res.reason);
  if (flags.json) { process.stdout.write(renderJson(res) + '\n'); return; }

  const s = res.summary;
  process.stdout.write(`\n  Accepted, ${res.runner}\n`);
  if (!res.hadBaseline) {
    process.stdout.write('  There was nothing recorded before, so this is simply the new baseline.\n');
  } else if (!res.accepted.length) {
    process.stdout.write('  Nothing had changed; the baseline is refreshed.\n');
  } else {
    process.stdout.write('  This is now the expected state:\n');
    for (const f of res.accepted) {
      process.stdout.write(`    · ${f.title}\n`);
      for (const e of f.evidence.slice(0, 8)) process.stdout.write(`        ${e}\n`);
      if (f.evidence.length > 8) process.stdout.write(`        …and ${f.evidence.length - 8} more\n`);
    }
  }
  process.stdout.write(
    `  ${tests(s.total)}: ${s.passed} passed, ${s.failed} failed, ${s.skipped} skipped\n\n`,
  );
}
