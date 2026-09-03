#!/usr/bin/env node
import process from 'node:process';
import { readFileSync } from 'node:fs';
import { repoRoot } from '../src/git.js';
import { whatran, snapshot, accept, pickRunner, projectDirFor, NOTICE } from '../src/whatran.js';
import { isFailing } from '../src/checks.js';
import { renderLedger, renderJson } from '../src/report.js';
import { runHook } from '../src/hook.js';
import { installHooks, uninstallHooks } from '../src/install.js';
import { detectRunners } from '../src/runners.js';

const HELP = `
  whatran — catches the test that stopped running.

  Usage
    whatran                     check the working tree against the recorded baseline
    whatran snapshot            record the current suite as the baseline
    whatran accept              accept the current state as the new normal
    whatran check [--base REF]  check; with --base, compare against a git ref instead
    whatran init                snapshot + install the agent hook for this repo
    whatran uninstall           remove the agent hook
    whatran hook                stdin/stdout hook protocol (called by your agent)
    whatran detect              show which test runner would be used

  Options
    --base <ref>     compare against a git ref (CI/PR mode) rather than a snapshot
    --runner <id>    force a runner: pytest, jest, vitest, go, node-test, nextest
    --json           machine-readable output
    --quiet          print nothing unless something is denied
    --timeout <sec>  cap the test run (default 900)
    --no-fail        never exit non-zero for findings (tool errors still exit 2)
    --harness <id>   tell the hook which agent invoked it (cursor)
    --version        print the version

  Exit codes
    0  nothing to report, or inconclusive
    1  something is missing or broke (also notices, with --strict)
    2  whatran itself could not run
`;

const argv = process.argv.slice(2);
const flags = parseFlags(argv);
const cmd = argv.find((a) => !a.startsWith('-')) ?? 'check';

if (flags.help) { process.stdout.write(HELP); process.exit(0); }
if (flags.version) {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  process.stdout.write(pkg.version + '\n');
  process.exit(0);
}

const root = repoRoot();
if (!root && cmd !== 'help') {
  fatal('whatran needs to run inside a git repository (it compares against git state).');
}

try {
  switch (cmd) {
    case 'hook': await cmdHook(); break;
    case 'snapshot': cmdSnapshot(); break;
    case 'accept': cmdAccept(); break;
    case 'init': cmdInit(); break;
    case 'uninstall': cmdUninstall(); break;
    case 'detect': cmdDetect(); break;
    case 'check': default: cmdCheck(); break;
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
  });

  if (flags.json) {
    process.stdout.write(renderJson(serialise(result)) + '\n');
  } else if (!flags.quiet || isFailing(result.findings)) {
    process.stdout.write(renderLedger(result));
  }

  if (flags.noFail) process.exit(0);
  if (isFailing(result.findings)) process.exit(1);
  if (flags.strict && result.verdict === NOTICE) process.exit(1);
  process.exit(0);
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
      `\n  Baseline recorded — ${res.runner}\n`
      + `  ${s.total} tests: ${s.passed} passed, ${s.failed} failed, ${s.skipped} skipped\n`
      + `  Saved to ${res.path}\n\n`
      + `  Anything that stops running from here on will be reported.\n\n`,
    );
  }
}

function cmdInit() {
  const runner = pickRunner(root, flags.runner, process.cwd());
  if (!runner) {
    fatal('no supported test runner detected. Supported: pytest, jest, vitest, go test, node:test, cargo nextest.');
  }
  process.stdout.write(`\n  Detected ${runner.label}. Recording a baseline…\n`);
  const res = snapshot(root, {
    cwd: process.cwd(), runner: flags.runner, timeoutMs: flags.timeout ? flags.timeout * 1000 : undefined });
  if (!res.ok) fatal(res.reason);
  const s = res.summary;
  process.stdout.write(`  ${s.total} tests: ${s.passed} passed, ${s.failed} failed, ${s.skipped} skipped\n`);

  const installed = installHooks(root);
  for (const line of installed) process.stdout.write(`  ${line}\n`);
  process.stdout.write('\n  Done. Your agent will now be stopped if it removes coverage.\n\n');
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
  const code = await runHook(root, flags);
  process.exit(code);
}

function serialise(r) {
  return {
    verdict: r.verdict,
    inconclusive: r.inconclusive,
    runner: r.runner,
    baseSource: r.baseSource,
    summary: r.summary,
    baseSummary: r.baseSummary,
    // Whether a second run confirmed the findings. CI consumers should know
    // the difference between "checked twice" and "seen once".
    confirmed: r.confirmed ?? false,
    elapsedMs: r.elapsedMs,
    findings: r.findings.map((f) => ({
      level: f.level, code: f.code, title: f.title, detail: f.detail, evidence: f.evidence,
    })),
  };
}

function parseFlags(args) {
  const f = { json: false, quiet: false, strict: false, noFail: false, help: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') f.json = true;
    else if (a === '--quiet' || a === '-q') f.quiet = true;
    else if (a === '--strict') f.strict = true;
    else if (a === '--no-fail') f.noFail = true;
    else if (a === '--help' || a === '-h') f.help = true;
    else if (a === '--base') f.base = args[++i];
    else if (a.startsWith('--base=')) f.base = a.slice(7);
    else if (a === '--harness') f.harness = args[++i];
    else if (a.startsWith('--harness=')) f.harness = a.slice(10);
    else if (a === '--version' || a === '-v') f.version = true;
    else if (a === '--event') f.event = args[++i];
    else if (a.startsWith('--event=')) f.event = a.slice(8);
    else if (a === '--runner') f.runner = args[++i];
    else if (a.startsWith('--runner=')) f.runner = a.slice(9);
    else if (a === '--timeout') f.timeout = Number(args[++i]);
    else if (a.startsWith('--timeout=')) f.timeout = Number(a.slice(10));
  }
  return f;
}

// 0 clean · 1 findings · 2 whatran itself could not run.
// A typo in --runner exiting 1 was indistinguishable from removed coverage,
// which no CI pipeline can work around.
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
  process.stdout.write(`\n  Accepted — ${res.runner}\n`);
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
    `  ${s.total} tests: ${s.passed} passed, ${s.failed} failed, ${s.skipped} skipped\n\n`,
  );
}
