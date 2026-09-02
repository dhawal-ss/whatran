import path from 'node:path';
import { detectRunners, getRunner } from './runners.js';

// A git repository is not the same thing as a project. Monorepos, and any
// layout where the app lives in a subfolder, put the test runner somewhere
// below the repo root — so detecting only at the root reports "no test runner"
// for repositories that obviously have one.
//
// Search from where the user actually is, walking upwards, and stop at the
// first folder that looks like a project. Git operations still happen at the
// repo root, because that is where git paths are anchored.
export function resolveProject(cwd, gitRoot, explicitRunner) {
  const dirs = ancestors(cwd, gitRoot);

  if (explicitRunner) {
    const runner = getRunner(explicitRunner);
    if (!runner) throw new Error(`unknown runner "${explicitRunner}"`);
    const dir = dirs.find((d) => safeDetect(runner, d)) ?? cwd;
    return { runner, dir };
  }

  for (const dir of dirs) {
    const found = detectRunners(dir);
    if (found.length) return { runner: found[0], dir, alternatives: found.slice(1) };
  }
  return { runner: null, dir: cwd, alternatives: [] };
}

// From `cwd` up to and including `gitRoot`. Nearest first: a package's own
// config should win over one inherited from the repo root.
function ancestors(cwd, gitRoot) {
  const start = path.resolve(cwd);
  const stop = gitRoot ? path.resolve(gitRoot) : start;
  const out = [start];
  let dir = start;
  while (dir !== stop && path.dirname(dir) !== dir) {
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
    out.push(dir);
    if (dir === stop) break;
  }
  if (!out.includes(stop)) out.push(stop);
  return [...new Set(out)];
}

function safeDetect(runner, dir) {
  try { return runner.detect(dir); } catch { return false; }
}
