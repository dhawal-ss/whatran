import path from 'node:path';

// Parsers turn a test runner's machine-readable output into
//   { outcomes: Map<testId, 'passed'|'failed'|'skipped'>, declared: number|null }
//
// `declared` is the runner's OWN count of how many tests it ran. It exists so
// the caller can check one invariant that catches every id-collision bug at
// once: if we built fewer distinct ids than the runner says it ran, two tests
// share an id and every comparison built on them is unsound. Losing tests
// silently is worse than any false positive, because nobody argues with it.
//
// Test IDs must be stable across runs, because the entire product is a
// set-difference between two of these maps. Anything that varies run to run
// (durations, absolute paths, ordering) is deliberately discarded.

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (m, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[body] ?? m;
  });
}

function readAttrs(raw) {
  const attrs = {};
  const re = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    attrs[m[1]] = decodeEntities(m[3] ?? m[4] ?? '');
  }
  return attrs;
}

// Some reporters put something useless in `classname`. node:test sets it to the
// literal string "test" for every case in the run, which collapsed distinct
// tests into one id and silently lost them.
const USELESS_CLASSNAMES = new Set(['test', '', 'tests']);

// JUnit XML is the one format pytest, vitest, node:test, nextest, Surefire and
// Gradle all emit natively, which is why it is the primary substrate here.
// Written as a scanner rather than a regex over the whole document so that
// nested <failure> bodies containing markup can't break the outer match.
export function parseJUnitXml(text, { root } = {}) {
  const outcomes = new Map();
  if (!text) return { outcomes, declared: null };

  // Track the enclosing <testsuite>, which is where node:test and vitest put
  // the describe block that `classname` omits.
  const suiteOpen = /<testsuite\b([^>]*?)(\/?)>/g;
  const suiteAt = [];
  let sm;
  while ((sm = suiteOpen.exec(text)) !== null) {
    suiteAt.push({ index: sm.index, attrs: readAttrs(sm[1]) });
  }
  const suiteFor = (index) => {
    let found = null;
    for (const s of suiteAt) { if (s.index < index) found = s; else break; }
    return found?.attrs ?? {};
  };

  let declared = 0;
  let sawDeclared = false;
  for (const s of suiteAt) {
    const n = Number(s.attrs.tests);
    if (Number.isFinite(n)) { declared += n; sawDeclared = true; }
  }

  const open = /<testcase\b([^>]*?)(\/?)>/g;
  let m;
  while ((m = open.exec(text)) !== null) {
    const attrs = readAttrs(m[1]);
    const selfClosing = m[2] === '/';
    let body = '';
    if (!selfClosing) {
      const close = text.indexOf('</testcase>', open.lastIndex);
      body = close === -1 ? '' : text.slice(open.lastIndex, close);
      if (close !== -1) open.lastIndex = close + '</testcase>'.length;
    }
    const suite = suiteFor(m.index);
    const scope = [
      relativise(attrs.file, root),
      USELESS_CLASSNAMES.has(attrs.classname) ? '' : attrs.classname,
      // The suite name repeats the file for some reporters; keep it only when
      // it adds something.
      suite.name && suite.name !== attrs.classname && suite.name !== 'pytest' ? suite.name : '',
    ].filter(Boolean).join(' > ');

    const id = testId(scope, attrs.name);
    if (!id) continue;
    let outcome = 'passed';
    if (/<skipped\b/.test(body)) outcome = 'skipped';
    else if (/<(failure|error)\b/.test(body)) outcome = 'failed';
    outcomes.set(id, worst(outcomes.get(id), outcome));
  }
  return { outcomes, declared: sawDeclared ? declared : null };
}

// jest --json and vitest --reporter=json share a shape.
export function parseJestJson(text, { root } = {}) {
  const outcomes = new Map();
  if (!text) return { outcomes, declared: null };
  let doc;
  try { doc = JSON.parse(text); } catch { return { outcomes, declared: null }; }

  // A file that fails to load takes every test in it with it: the entry has no
  // assertions and a failed status, and the exit code is indistinguishable from
  // an ordinary test failure. Report it so the caller can refuse rather than
  // conclude the tests were deleted.
  const unloadable = [];
  for (const file of doc.testResults ?? []) {
    const name = relativise(file.name ?? file.testFilePath ?? '', root);
    const assertions = file.assertionResults ?? [];
    if (!assertions.length && file.status === 'failed') unloadable.push(name);
    for (const a of assertions) {
      const title = a.fullName || [...(a.ancestorTitles ?? []), a.title].filter(Boolean).join(' > ');
      const id = testId(name, title);
      if (!id) continue;
      outcomes.set(id, worst(outcomes.get(id), normalise(a.status)));
    }
  }
  const declared = Number.isFinite(doc.numTotalTests) ? doc.numTotalTests : null;
  return { outcomes, declared, unloadable };
}

// `go test -json` is a stream of events, one JSON object per line. The final
// action for a given (Package, Test) pair is its outcome. Events with no Test
// field are package-level and deliberately ignored, `skip` there means
// "package contained no tests", which is not a skipped test.
export function parseGoTestJson(text) {
  const outcomes = new Map();
  const buildFailures = [];
  if (!text) return { outcomes, declared: null, buildFailures };
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('{')) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    // A package that fails to compile exits 1, exactly like a test failure,
    // and its tests simply never appear. Since Go 1.24 those lines carry
    // ImportPath rather than Package.
    if (ev.Action === 'build-fail' || ev.FailedBuild) {
      buildFailures.push(ev.ImportPath || ev.Package || 'unknown package');
      continue;
    }
    if (!ev.Test) continue;
    const outcome = normalise(ev.Action);
    if (!outcome) continue;
    outcomes.set(testId(ev.Package, ev.Test), outcome);
  }
  return { outcomes, declared: null, buildFailures: [...new Set(buildFailures)] };
}

function normalise(status) {
  switch (status) {
    case 'passed': case 'pass': case 'ok': return 'passed';
    case 'failed': case 'fail': case 'error': return 'failed';
    case 'skipped': case 'skip': case 'pending': case 'todo': case 'disabled': return 'skipped';
    default: return null;
  }
}

const RANK = { passed: 0, skipped: 1, failed: 2 };
// A backstop only. No runner we support emits duplicate entries for a retry, 
// they all report the final outcome, so in practice this fires only when two
// tests have collided into one id, and the declared-total check above refuses
// that case before it gets here.
function worst(a, b) {
  if (!a) return b;
  return RANK[b] > RANK[a] ? b : a;
}

function testId(scope, name) {
  const left = (scope || '').trim();
  const right = (name || '').trim();
  if (!right && !left) return null;
  return left ? `${left}::${right}` : right;
}

// Absolute paths differ between a worktree and the real checkout, which would
// make every id look new. Make them relative to the project root instead of
// guessing at a suffix: taking the last few segments merged
// packages/a/src/foo.test.ts and packages/b/src/foo.test.ts into one id.
export function relativise(p, root) {
  if (!p) return '';
  const norm = p.replace(/\\/g, '/');
  if (!root) return norm;
  // Jest emits native Windows separators and Vitest emits forward slashes for
  // the same file, so compare on a normalised form. Try the literal prefix
  // first: resolving through Windows path semantics mangles POSIX-style input.
  const under = (child, base) => {
    const b = base.replace(/\/+$/, '');
    return b && child.toLowerCase().startsWith(b.toLowerCase() + '/') ? child.slice(b.length + 1) : null;
  };
  const direct = under(norm, root.replace(/\\/g, '/'));
  if (direct !== null) return direct;
  const resolved = under(
    path.resolve(root, norm).replace(/\\/g, '/'),
    path.resolve(root).replace(/\\/g, '/'),
  );
  return resolved !== null ? resolved : norm;
}

export const __test = { decodeEntities, readAttrs, worst, relativise };
