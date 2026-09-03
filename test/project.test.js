import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveProject, otherProjects } from '../src/project.js';
import { detectRunners, CONFIDENCE } from '../src/runners.js';
import { uncheckedProjects, NOTICE } from '../src/checks.js';

let root;

const write = (rel, body) => {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, typeof body === 'string' ? body : JSON.stringify(body, null, 2));
};

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'whatran-proj-'));

  // A monorepo: nothing at the top, a real Vitest app one level down, and some
  // Python infra scripts alongside it. This is the shape that made a live repo
  // report "no test runner detected", and then report the wrong one.
  write('README.md', '# monorepo\n');
  write('app/package.json', {
    name: 'app',
    scripts: { test: 'vitest run' },
    devDependencies: { vitest: '^2.0.0' },
  });
  write('app/src/thing.test.ts', 'test("x", () => {});\n');
  write('app/infra/scripts/tests/test_deploy.py', 'def test_deploy():\n    assert True\n');
});

after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('finding the project inside a repo', () => {
  // The bug: detection only ever looked at the git root, so an app in a
  // subfolder was invisible and the tool reported "no test runner detected"
  // for a repository that obviously had one.
  test('finds a runner in a subfolder when run from there', () => {
    const { runner, dir } = resolveProject(path.join(root, 'app'), root);
    assert.ok(runner, 'expected a runner to be found');
    assert.strictEqual(runner.id, 'vitest');
    assert.strictEqual(dir, path.join(root, 'app'));
  });

  test('walks up from a nested directory to find the project', () => {
    const { runner, dir } = resolveProject(path.join(root, 'app', 'src'), root);
    assert.strictEqual(runner?.id, 'vitest');
    assert.strictEqual(dir, path.join(root, 'app'), 'should run in the package, not the src folder');
  });

  test('reports nothing when the repo genuinely has no suite', () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'whatran-bare-'));
    try {
      assert.strictEqual(resolveProject(bare, bare).runner, null);
    } finally { fs.rmSync(bare, { recursive: true, force: true }); }
  });

  test('an explicit --runner still resolves a sensible directory', () => {
    const { runner } = resolveProject(path.join(root, 'app'), root, 'vitest');
    assert.strictEqual(runner.id, 'vitest');
  });

  test('an unknown --runner is rejected rather than silently ignored', () => {
    assert.throws(() => resolveProject(root, root, 'nope'), /unknown runner/);
  });
});

describe('weighing the evidence', () => {
  // The bug: a Vitest app with some Python infra scripts detected as pytest,
  // because "a file matched a pattern" counted the same as "the project's own
  // test script names this runner".
  test('a runner named in the test script beats one merely guessed at', () => {
    const found = detectRunners(path.join(root, 'app'));
    assert.strictEqual(found[0].id, 'vitest', 'vitest is named in scripts.test');
    assert.ok(found.some((r) => r.id === 'pytest'), 'pytest should still be offered as an option');
    const vitest = found.find((r) => r.id === 'vitest');
    const pytest = found.find((r) => r.id === 'pytest');
    assert.ok(vitest.confidence > pytest.confidence,
      `expected vitest (${vitest.confidence}) to outrank pytest (${pytest.confidence})`);
  });

  test('being named in the test script is the strongest signal', () => {
    const found = detectRunners(path.join(root, 'app'));
    assert.strictEqual(found.find((r) => r.id === 'vitest').confidence, CONFIDENCE.DECLARED);
  });

  test('a stray test file is the weakest signal', () => {
    const found = detectRunners(path.join(root, 'app'));
    assert.strictEqual(found.find((r) => r.id === 'pytest').confidence, CONFIDENCE.GUESSED);
  });
});

// whatran checks one project. Saying nothing about the others made a clean
// result read as a clean verdict for the whole repository, which is a false
// green: the one failure direction everything else here is careful about.
describe('what it did not check', () => {
  // The fixture is the monorepo shape from the tests above: a Vitest app with
  // Python infra scripts beside it. Checking the app says nothing about those,
  // so they have to be named.
  test('names other test suites in the repository', () => {
    const found = otherProjects(root, path.join(root, 'app'));
    assert.deepStrictEqual(found, ['app/infra']);
  });

  test('a second package is reported as unchecked', () => {
    const mono = fs.mkdtempSync(path.join(os.tmpdir(), 'whatran-mono-'));
    try {
      for (const p of ['a', 'b']) {
        fs.mkdirSync(path.join(mono, 'packages', p), { recursive: true });
        fs.writeFileSync(
          path.join(mono, 'packages', p, 'package.json'),
          JSON.stringify({ name: p, scripts: { test: 'node --test' } }),
        );
      }
      const found = otherProjects(mono, path.join(mono, 'packages', 'a'));
      assert.deepStrictEqual(found, ['packages/b']);
    } finally { fs.rmSync(mono, { recursive: true, force: true }); }
  });

  test('the finding is a notice, never an accusation', () => {
    const f = uncheckedProjects(['packages/b']);
    assert.strictEqual(f[0].level, NOTICE);
    assert.deepStrictEqual(f[0].evidence, ['packages/b']);
  });

  test('nothing is said when there is only one project', () => {
    assert.deepStrictEqual(uncheckedProjects([]), []);
  });
});
