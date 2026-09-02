// Runner definitions. Each knows how to detect itself, how to ask its test
// framework for machine-readable output, and which parser reads that output.
//
// Every command below uses a reporter that ships with the framework itself.
// Requiring the user to install a reporter plugin would break the "works on
// your repo with no setup" promise, which is the whole point.

import fs from 'node:fs';
import path from 'node:path';
import { parseJUnitXml, parseJestJson, parseGoTestJson } from './parse.js';

const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
const exists = (root, ...rel) => fs.existsSync(path.join(root, ...rel));

function pkgJson(root) {
  try { return JSON.parse(read(path.join(root, 'package.json'))); } catch { return null; }
}
function hasDep(pkg, name) {
  if (!pkg) return false;
  return Boolean(pkg.dependencies?.[name] || pkg.devDependencies?.[name] || pkg.peerDependencies?.[name]);
}

export const RUNNERS = [
  {
    id: 'pytest',
    label: 'pytest',
    lang: 'python',
    detect(root) {
      if (exists(root, 'pytest.ini') || exists(root, 'conftest.py')) return true;
      if (/\[tool\.pytest/.test(read(path.join(root, 'pyproject.toml')))) return true;
      if (/\[(tool:)?pytest\]/.test(read(path.join(root, 'setup.cfg')) + read(path.join(root, 'tox.ini')))) return true;
      return hasTestFiles(root, /^test_.*\.py$|.*_test\.py$/);
    },
    command(outFile) {
      return { cmd: pythonBin(), args: ['-m', 'pytest', '-q', '--junitxml=' + outFile] };
    },
    parse: (outFile) => parseJUnitXml(read(outFile)),
    outExt: '.xml',
    // pytest: 0 ok, 1 tests failed, 2 interrupted, 3 internal, 4 usage, 5 nothing collected.
    // Anything above 1 means the suite did not run properly, which is not the same
    // as tests failing and must never be reported as removed coverage.
    structuralExit: (code) => code !== null && code >= 2,
    testGlobs: [/(^|\/)tests?\//, /(^|\/)test_.*\.py$/, /_test\.py$/, /conftest\.py$/],
  },
  {
    id: 'vitest',
    label: 'Vitest',
    lang: 'js',
    detect(root) {
      const pkg = pkgJson(root);
      if (hasDep(pkg, 'vitest')) return true;
      return ['vitest.config.ts', 'vitest.config.js', 'vitest.config.mjs'].some((f) => exists(root, f));
    },
    command(outFile) {
      return { cmd: npxBin(), args: ['--no-install', 'vitest', 'run', '--reporter=json', '--outputFile=' + outFile] };
    },
    parse: (outFile) => parseJestJson(read(outFile)),
    outExt: '.json',
    testGlobs: [/\.(test|spec)\.[jt]sx?$/, /(^|\/)__tests__\//],
  },
  {
    id: 'jest',
    label: 'Jest',
    lang: 'js',
    detect(root) {
      const pkg = pkgJson(root);
      if (hasDep(pkg, 'jest')) return true;
      if (pkg?.jest) return true;
      return ['jest.config.js', 'jest.config.ts', 'jest.config.mjs', 'jest.config.json'].some((f) => exists(root, f));
    },
    command(outFile) {
      return { cmd: npxBin(), args: ['--no-install', 'jest', '--ci', '--json', '--outputFile=' + outFile] };
    },
    parse: (outFile) => parseJestJson(read(outFile)),
    outExt: '.json',
    testGlobs: [/\.(test|spec)\.[jt]sx?$/, /(^|\/)__tests__\//],
  },
  {
    id: 'go',
    label: 'go test',
    lang: 'go',
    detect: (root) => exists(root, 'go.mod'),
    command() {
      return { cmd: 'go', args: ['test', '-json', './...'], captureStdout: true };
    },
    parse: (_outFile, stdout) => parseGoTestJson(stdout),
    outExt: '.json',
    testGlobs: [/_test\.go$/],
  },
  {
    id: 'node-test',
    label: 'node:test',
    lang: 'js',
    detect(root) {
      const pkg = pkgJson(root);
      if (!pkg) return false;
      return /node\s+--test|node:test/.test(pkg.scripts?.test ?? '');
    },
    command(outFile) {
      return {
        cmd: process.execPath,
        args: ['--test', '--test-reporter=junit', '--test-reporter-destination=' + outFile],
      };
    },
    parse: (outFile) => parseJUnitXml(read(outFile)),
    outExt: '.xml',
    testGlobs: [/\.(test|spec)\.[cm]?js$/, /(^|\/)test\//],
  },
  {
    id: 'nextest',
    label: 'cargo nextest',
    lang: 'rust',
    // Plain `cargo test -- --format json` is still nightly-gated, so nextest's
    // stable JUnit output is the only dependable machine-readable path in Rust.
    detect: (root) => exists(root, 'Cargo.toml'),
    command(outFile) {
      return {
        cmd: 'cargo',
        args: ['nextest', 'run', '--message-format', 'none'],
        env: { NEXTEST_JUNIT_PATH: outFile, NEXTEST_PROFILE: 'default' },
        junitFallback: true,
      };
    },
    parse: (outFile) => parseJUnitXml(read(outFile)),
    outExt: '.xml',
    testGlobs: [/(^|\/)tests?\//, /\.rs$/],
  },
];

function hasTestFiles(root, re, depth = 3) {
  const stack = [[root, 0]];
  while (stack.length) {
    const [dir, d] = stack.pop();
    if (d > depth) continue;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'venv' || e.name === '.venv') continue;
      if (e.isDirectory()) stack.push([path.join(dir, e.name), d + 1]);
      else if (re.test(e.name)) return true;
    }
  }
  return false;
}

function pythonBin() {
  return process.platform === 'win32' ? 'python' : 'python3';
}
function npxBin() {
  return process.platform === 'win32' ? 'npx.cmd' : 'npx';
}

export function detectRunners(root) {
  return RUNNERS.filter((r) => {
    try { return r.detect(root); } catch { return false; }
  });
}

export function getRunner(id) {
  return RUNNERS.find((r) => r.id === id) ?? null;
}
