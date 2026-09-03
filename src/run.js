import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Executes a runner and returns { outcomes, exitCode, ok, reason }.
//
// `ok: false` means we could not obtain a trustworthy outcome map, NOT that
// the tests failed. That distinction is the whole reason this tool can be left
// switched on: an environment problem must never be reported as a lie.
export function runSuite(runner, cwd, { timeoutMs = 15 * 60 * 1000, env = {} } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whatran-'));
  const outFile = path.join(tmp, 'report' + runner.outExt);
  const spec = runner.command(outFile, cwd);

  const res = spawnSync(spec.cmd, spec.args, {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    shell: spec.shell === true,
    maxBuffer: 64 * 1024 * 1024,
    env: childEnv(env, spec.env),
  });

  const stdout = res.stdout ?? '';
  const stderr = res.stderr ?? '';

  const cleanup = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } };

  if (res.error) {
    cleanup();
    if (res.error.code === 'ENOENT') return fail(`\`${spec.cmd}\` is not on PATH`, res.status);
    if (res.error.code === 'ETIMEDOUT') {
      return fail(`test run exceeded ${Math.round(timeoutMs / 1000)}s`, res.status);
    }
    // Anything else, EINVAL from spawning a .cmd without a shell on Windows,
    // EACCES, EPERM, used to fall through to the generic "no results" message
    // with nothing attached, which told the user nothing at all.
    return fail(`could not start ${runner.label}: ${res.error.code ?? res.error.message}`, res.status);
  }

  let parsed;
  try {
    parsed = runner.parse(outFile, stdout, { root: cwd });
  } catch (err) {
    cleanup();
    return fail(`could not parse ${runner.label} output: ${err.message}`, res.status);
  }
  cleanup();

  const outcomes = parsed?.outcomes;
  if (!outcomes || outcomes.size === 0) {
    // No report and a non-zero exit almost always means the suite never got as
    // far as running, a missing dependency, an import error, a bad config.
    const detail = firstMeaningfulLine(stderr) || firstMeaningfulLine(stdout);
    return fail(
      `${runner.label} produced no test results${detail ? `: ${detail}` : ''}`,
      res.status,
    );
  }

  // A file that failed to load takes every test in it with it, at an exit code
  // identical to an ordinary failure. Concluding those tests were deleted would
  // be an accusation caused by a syntax error.
  if (parsed.unloadable?.length) {
    return fail(
      `${parsed.unloadable.length} test file${parsed.unloadable.length === 1 ? '' : 's'} could not `
      + `be loaded, so the tests inside are missing from the report: ${parsed.unloadable.slice(0, 3).join(', ')}`,
      res.status,
    );
  }
  if (parsed.buildFailures?.length) {
    return fail(
      `${parsed.buildFailures.length} package${parsed.buildFailures.length === 1 ? '' : 's'} failed `
      + `to build, so their tests never ran: ${parsed.buildFailures.slice(0, 3).join(', ')}`,
      res.status,
    );
  }

  // The runner's own count against ours. If we built fewer distinct ids than it
  // says it ran, two tests share an id, and every comparison downstream is
  // unsound. Silently losing tests is worse than any false positive, because
  // nobody argues with it.
  if (Number.isFinite(parsed.declared) && parsed.declared > outcomes.size) {
    return fail(
      `${runner.label} reported ${parsed.declared} tests but only ${outcomes.size} have distinct `
      + 'identities, some share a name, so before-and-after cannot be compared reliably',
      res.status,
    );
  }

  return { ok: true, outcomes, exitCode: res.status ?? 0, stdout, stderr, reason: null };

  function fail(reason, exitCode) {
    return { ok: false, outcomes: new Map(), exitCode: exitCode ?? null, stdout, stderr, reason };
  }
}

// Variables that make a nested test run misbehave. NODE_TEST_CONTEXT is the
// important one: node:test refuses to run recursively, so a suite invoked from
// inside another test run silently reports nothing at all.
const STRIP = ['NODE_TEST_CONTEXT', 'JEST_WORKER_ID', 'VITEST', 'VITEST_POOL_ID', 'VITEST_WORKER_ID'];

function childEnv(extra, specEnv) {
  const env = { ...process.env, ...extra, ...(specEnv ?? {}) };
  for (const key of STRIP) delete env[key];
  // Runners behave more deterministically in CI mode: no watch, no colour,
  // and Vitest treats a stray `.only` as an error rather than a filter.
  env.CI = '1';
  env.FORCE_COLOR = '0';
  return env;
}

function firstMeaningfulLine(text) {
  if (!text) return '';
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !/^\s*$/.test(l));
  if (!line) return '';
  return line.length > 160 ? line.slice(0, 157) + '...' : line;
}

export function summarise(outcomes) {
  let passed = 0, failed = 0, skipped = 0;
  for (const v of outcomes.values()) {
    if (v === 'passed') passed++;
    else if (v === 'failed') failed++;
    else if (v === 'skipped') skipped++;
  }
  return { total: outcomes.size, passed, failed, skipped };
}
