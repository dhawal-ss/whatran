// Runner definitions. Each knows how to detect itself, how to ask its test
// framework for machine-readable output, and which parser reads that output.
//
// Every command below uses a reporter that ships with the framework itself.
// Requiring the user to install a reporter plugin would break the "works on
// your repo with no setup" promise, which is the whole point.

import fs from 'node:fs';
import path from 'node:path';
import { parseJUnitXml, parseJestJson, parseGoTestJson, parseMochaJson } from './parse.js';

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
      if (/\bpytest\b/.test(testScript(root))) return CONFIDENCE.DECLARED;
      if (exists(root, 'pytest.ini') || exists(root, 'conftest.py')) return CONFIDENCE.CONFIGURED;
      if (/\[tool\.pytest/.test(read(path.join(root, 'pyproject.toml')))) return CONFIDENCE.CONFIGURED;
      if (/\[(tool:)?pytest\]/.test(read(path.join(root, 'setup.cfg')) + read(path.join(root, 'tox.ini')))) return CONFIDENCE.CONFIGURED;
      return hasTestFiles(root, /^test_.*\.py$|.*_test\.py$/) ? CONFIDENCE.GUESSED : CONFIDENCE.NONE;
    },
    command(outFile) {
      return {
        cmd: pythonBin(),
        args: [
          '-m', 'pytest', '-q', '--junitxml=' + outFile,
          // A repo with `addopts = -x` truncates the report at the first
          // failure and still exits 1, so every later test looks deleted.
          // Same argparse dest, last one wins, and 0 is falsy so nothing stops.
          '--maxfail=0',
          // pytest-randomly reorders every run; a baseline taken at one seed
          // and a check at another can flip an order-dependent test and read
          // as a regression. Harmless when the plugin is absent.
          '-p', 'no:randomly',
        ],
      };
    },
    parse: (outFile, _stdout, ctx) => parseJUnitXml(read(outFile), ctx),
    outExt: '.xml',
    // pytest: 0 ok, 1 tests failed, 2 interrupted, 3 internal, 4 usage, 5 nothing collected.
    // Anything above 1 means the suite did not run properly, which is not the same
    // as tests failing and must never be reported as removed coverage.
    structuralExit: (code) => code !== null && code >= 2,
  },
  {
    id: 'vitest',
    label: 'Vitest',
    lang: 'js',
    detect(root) {
      if (/\bvitest\b/.test(testScript(root))) return CONFIDENCE.DECLARED;
      if (hasDep(pkgJson(root), 'vitest')) return CONFIDENCE.CONFIGURED;
      return ['vitest.config.ts', 'vitest.config.js', 'vitest.config.mjs'].some((f) => exists(root, f))
        ? CONFIDENCE.CONFIGURED : CONFIDENCE.NONE;
    },
    command(outFile, root) {
      return nodeTool(root, 'vitest', ['run', '--reporter=json', '--outputFile=' + outFile]);
    },
    parse: (outFile, _stdout, ctx) => parseJestJson(read(outFile), ctx),
    outExt: '.json',
  },
  {
    id: 'jest',
    label: 'Jest',
    lang: 'js',
    detect(root) {
      if (/\bjest\b/.test(testScript(root))) return CONFIDENCE.DECLARED;
      const pkg = pkgJson(root);
      if (hasDep(pkg, 'jest') || pkg?.jest) return CONFIDENCE.CONFIGURED;
      return ['jest.config.js', 'jest.config.ts', 'jest.config.mjs', 'jest.config.json'].some((f) => exists(root, f))
        ? CONFIDENCE.CONFIGURED : CONFIDENCE.NONE;
    },
    command(outFile, root) {
      // `bail` in a config file makes jest exit before it writes the report at
      // all, no file, no stdout, exit 1, indistinguishable from a plain test
      // failure. `--bail=0` overrides it.
      return nodeTool(root, 'jest', ['--ci', '--bail=0', '--json', '--outputFile=' + outFile]);
    },
    parse: (outFile, _stdout, ctx) => parseJestJson(read(outFile), ctx),
    outExt: '.json',
  },
  {
    id: 'go',
    label: 'go test',
    lang: 'go',
    detect: (root) => (exists(root, 'go.mod') ? CONFIDENCE.CONFIGURED : CONFIDENCE.NONE),
    command() {
      // Go writes its machine-readable output to stdout, which runSuite passes
      // to every parser as the second argument.
      return { cmd: 'go', args: ['test', '-json', './...'] };
    },
    parse: (_outFile, stdout) => parseGoTestJson(stdout),
    outExt: '.json',
  },
  {
    id: 'node-test',
    label: 'node:test',
    lang: 'js',
    detect(root) {
      return /node\s+--test|node:test/.test(testScript(root)) ? CONFIDENCE.DECLARED : CONFIDENCE.NONE;
    },
    command(outFile) {
      return {
        cmd: process.execPath,
        args: ['--test', '--test-reporter=junit', '--test-reporter-destination=' + outFile],
      };
    },
    parse: (outFile, _stdout, ctx) => parseJUnitXml(read(outFile), ctx),
    outExt: '.xml',
  },
  {
    id: 'mocha',
    label: 'Mocha',
    lang: 'js',
    detect(root) {
      if (/\bmocha\b/.test(testScript(root))) return CONFIDENCE.DECLARED;
      if (hasDep(pkgJson(root), 'mocha')) return CONFIDENCE.CONFIGURED;
      return ['.mocharc.json', '.mocharc.yml', '.mocharc.yaml', '.mocharc.js', '.mocharc.cjs']
        .some((f) => exists(root, f)) ? CONFIDENCE.CONFIGURED : CONFIDENCE.NONE;
    },
    command(outFile, root) {
      // Mocha's default spec is ./test/*.spec.js only. Projects routinely put
      // their globs in the npm test script instead, and running bare `mocha`
      // would then collect a smaller suite than the project actually has. The
      // baseline and the check run the same command, so this cannot produce a
      // false accusation, but it would quietly check less than it appears to.
      return nodeTool(root, 'mocha', [
        ...mochaArgsFromScript(root),
        '--reporter', 'json', '--reporter-option', 'output=' + outFile,
      ]);
    },
    parse: (outFile, _stdout, ctx) => parseMochaJson(read(outFile), ctx),
    outExt: '.json',
  },
  {
    id: 'nextest',
    label: 'cargo nextest',
    lang: 'rust',
    // Plain `cargo test -- --format json` is still nightly-gated, so nextest's
    // stable JUnit output is the only dependable machine-readable path in Rust.
    detect: (root) => (exists(root, 'Cargo.toml') ? CONFIDENCE.CONFIGURED : CONFIDENCE.NONE),
    command(outFile) {
      return {
        cmd: 'cargo',
        args: ['nextest', 'run', '--message-format', 'none'],
        env: { NEXTEST_JUNIT_PATH: outFile, NEXTEST_PROFILE: 'default' },
        junitFallback: true,
      };
    },
    parse: (outFile, _stdout, ctx) => parseJUnitXml(read(outFile), ctx),
    outExt: '.xml',
  },
];

// Evidence strength. A runner named in the project's own test script is a
// statement of intent; a stray file matching a pattern three folders down is a
// guess. Treating them as equal made a Vitest app with some Python infra
// scripts detect as a pytest project.
export const CONFIDENCE = { DECLARED: 3, CONFIGURED: 2, GUESSED: 1, NONE: 0 };

function testScript(root) {
  const pkg = pkgJson(root);
  return pkg?.scripts?.test ?? '';
}

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

// Resolve a locally installed tool's own JS entry point and run it with the
// current Node binary.
//
// The obvious alternative, `npx <tool>`, resolves to `npx.cmd` on Windows, 
// and since the CVE-2024-27980 fix Node refuses to spawn .cmd or .bat without
// a shell, so it fails with EINVAL and no output at all. Going straight to the
// script sidesteps shells entirely and is faster besides.
function localTool(root, pkgName) {
  try {
    const pkgDir = path.join(root, 'node_modules', pkgName);
    const meta = JSON.parse(read(path.join(pkgDir, 'package.json')));
    let rel = meta.bin;
    if (rel && typeof rel === 'object') rel = rel[pkgName] ?? Object.values(rel)[0];
    if (typeof rel !== 'string') return null;
    const abs = path.join(pkgDir, rel);
    return fs.existsSync(abs) ? abs : null;
  } catch { return null; }
}

// Prefer the local install; fall back to npx through a shell so a globally
// installed or auto-fetched tool still works.
function nodeTool(root, pkgName, args) {
  const local = localTool(root, pkgName);
  if (local) return { cmd: process.execPath, args: [local, ...args] };
  // With `shell: true`, Node joins the args array with spaces and hands the
  // result to cmd.exe unquoted, so a temp path containing a space, which every
  // Windows path under "Local Settings" or a user's full name has, broke the
  // command apart. Build the line ourselves and quote every part.
  if (process.platform === 'win32') {
    const line = ['npx.cmd', '--no-install', pkgName, ...args].map(winQuote).join(' ');
    return { cmd: line, args: [], shell: true };
  }
  return { cmd: 'npx', args: ['--no-install', pkgName, ...args] };
}

const winQuote = (a) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);

// Everything the project's own test script passes to mocha, minus the reporter
// flags we are about to set ourselves. Best effort by design: an unparseable
// script simply yields nothing and mocha uses its defaults.
function mochaArgsFromScript(root) {
  const script = testScript(root);
  const at = script.search(/(^|[\s'"])mocha(\s|$)/);
  if (at === -1) return [];
  const rest = script.slice(script.indexOf('mocha', at) + 'mocha'.length).trim();
  if (!rest || rest.includes('&&') || rest.includes('|')) return [];
  const out = [];
  for (const tok of rest.split(/\s+/)) {
    if (/^--reporter/.test(tok)) return out; // ours wins; stop before theirs
    out.push(tok.replace(/^['"]|['"]$/g, ''));
  }
  return out;
}

// Strongest evidence first, so `detect` and every default pick agree.
export function detectRunners(root) {
  return RUNNERS
    .map((r) => {
      let score = CONFIDENCE.NONE;
      try { score = r.detect(root) || CONFIDENCE.NONE; } catch { /* unreadable repo */ }
      return { r, score };
    })
    .filter((x) => x.score > CONFIDENCE.NONE)
    .sort((a, b) => b.score - a.score)
    .map((x) => Object.assign(Object.create(Object.getPrototypeOf(x.r)), x.r, { confidence: x.score }));
}

export function getRunner(id) {
  return RUNNERS.find((r) => r.id === id) ?? null;
}
