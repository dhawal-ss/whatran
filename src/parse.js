import path from 'node:path';

// Parsers turn a test runner's machine-readable output into
//   { outcomes: Map<testId, 'passed'|'failed'|'skipped'>, seen: number, declared: number|null }
//
// `seen` is how many test RECORDS the parser consumed, counted before any id
// was built. It exists so the caller can check one invariant that catches every
// id-collision bug at once: if we consumed more records than we produced
// distinct ids, two tests share an id and every comparison built on them is
// unsound. Losing tests silently is worse than any false positive, because
// nobody argues with it. It is parser-local and reporter-independent, which
// `declared` was not: `declared` came from the reporter's own `tests=` count,
// and the shapes where it is unreliable (nested suites) are exactly the shapes
// where collisions happen, so the guard was unreachable in the only cases that
// mattered.
//
// `declared` survives as a softer, separate signal for a different failure:
// records the reporter says it ran that never reached us at all. It is null
// whenever the document's shape makes the count ambiguous.
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

// The index of the '>' that ends the tag starting at `start`, or -1.
//
// A raw '>' inside an attribute value is perfectly legal XML, and node:test
// emits them constantly: it escapes '<' but not '>', so any test or describe
// named `maps a -> b` contains one. The previous scanner used `[^>]*?` to find
// the end of a tag, which stopped at that '>' and handed readAttrs a fragment
// with an unterminated quote. readAttrs then returned nothing at all, so name,
// classname and file were lost together, distinct tests collapsed onto one id,
// and a truncated self-closing tag swallowed every testcase up to the next
// `</testcase>`. Deleting a failing test in such a file was reported as
// "the honest transition": a silent false green, in the tool's own suite.
//
// Only a quote-aware scan is correct here. Raw '<' is not legal inside an
// attribute value, so nothing else needs tracking.
function endOfTag(text, start) {
  let quote = null;
  for (let i = start + 1; i < text.length; i++) {
    const ch = text[i];
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '>') return i;
  }
  return -1;
}

// Index just past a comment or CDATA section beginning at `at`, or -1 if one
// does not begin there. Both can contain anything at all, including text that
// looks like a tag, so they are stepped over rather than scanned.
function skipRegion(text, at) {
  if (text.startsWith('<!--', at)) {
    const e = text.indexOf('-->', at + 4);
    return e === -1 ? text.length : e + 3;
  }
  if (text.startsWith('<![CDATA[', at)) {
    const e = text.indexOf(']]>', at + 9);
    return e === -1 ? text.length : e + 3;
  }
  return -1;
}

// Finds `</name>` from `from`, stepping over comments and CDATA so a closing
// tag quoted inside a failure body cannot end the element early.
function findClosing(text, from, name) {
  const close = `</${name}`;
  let i = from;
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt === -1) break;
    const skipped = skipRegion(text, lt);
    if (skipped !== -1) { i = skipped; continue; }
    if (text.startsWith(close, lt)) {
      const gt = endOfTag(text, lt);
      return { at: lt, next: gt === -1 ? text.length : gt + 1 };
    }
    const gt = endOfTag(text, lt);
    if (gt === -1) break;
    i = gt + 1;
  }
  return { at: text.length, next: text.length };
}

// JUnit XML is the one format pytest, node:test, nextest, Surefire and Gradle
// all emit natively, which is why it is the primary substrate here. Written as
// a single forward scan rather than regexes over the whole document: a nested
// <failure> body containing markup must not break the outer match, and the
// enclosing <testsuite> elements nest, so they have to be tracked on a stack.
export function parseJUnitXml(text, { root } = {}) {
  const outcomes = new Map();
  const unloadable = [];
  if (!text) return { outcomes, seen: 0, declared: null, unloadable };

  // Names of the <testsuite> elements currently open, outermost first. The
  // whole chain forms the scope, not just the innermost one: node:test emits a
  // <testsuite> per describe, so two different outer describes each containing
  // `describe('inner')` would otherwise produce the same id for both inner
  // tests. The previous code kept a flat list of every suite ever opened and
  // took the last one before the testcase, which attributed a test to whichever
  // suite happened to open most recently rather than to the one enclosing it.
  const stack = [];
  let seen = 0;
  let looseCases = 0;
  let declared = 0;
  let sawDeclared = false;
  let malformed = 0;
  // file -> how many testcases came from it, and whether the reporter emitted a
  // synthetic record named after the file itself.
  const perFile = new Map();
  const fileOf = (f) => {
    let e = perFile.get(f);
    if (!e) { e = { cases: 0, selfFailed: false }; perFile.set(f, e); }
    return e;
  };

  let i = 0;
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt === -1) break;

    const skipped = skipRegion(text, lt);
    if (skipped !== -1) { i = skipped; continue; }

    const gt = endOfTag(text, lt);
    if (gt === -1) break;

    const closing = text[lt + 1] === '/';
    const raw = text.slice(lt + (closing ? 2 : 1), gt);
    const tag = /^[\w:.-]+/.exec(raw)?.[0] ?? '';
    const trimmed = raw.trimEnd();
    const selfClosing = !closing && trimmed.endsWith('/');
    const attrText = selfClosing ? trimmed.slice(0, -1) : raw;

    if (closing) {
      // Matched by exact tag name: `</testsuites>` must not pop the stack.
      if (tag === 'testsuite') stack.pop();
      i = gt + 1;
      continue;
    }

    if (tag === 'testsuite') {
      const attrs = readAttrs(attrText);
      if (attrText.trim() && !Object.keys(attrs).length) malformed++;
      // Only an outermost suite states an independent total. node:test nests a
      // <testsuite> per describe and the outer `tests=` already counts the
      // inner ones, so summing every suite double-counted and made whatran
      // permanently refuse any project using nested describes.
      if (!stack.length) {
        const n = Number(attrs.tests);
        if (Number.isFinite(n)) { declared += n; sawDeclared = true; }
      }
      if (!selfClosing) stack.push(attrs.name ?? '');
      i = gt + 1;
      continue;
    }

    if (tag !== 'testcase') { i = gt + 1; continue; }

    const attrs = readAttrs(attrText);
    if (attrText.trim() && !Object.keys(attrs).length) malformed++;

    let body = '';
    if (selfClosing) {
      i = gt + 1;
    } else {
      const end = findClosing(text, gt + 1, 'testcase');
      body = text.slice(gt + 1, end.at);
      i = end.next;
    }
    if (!stack.length) looseCases++;

    let outcome = 'passed';
    if (/<skipped\b/.test(body)) outcome = 'skipped';
    else if (/<(failure|error)\b/.test(body)) outcome = 'failed';

    const file = relativise(attrs.file, root);

    // node:test reports a file that failed to load as a synthetic testcase
    // whose name IS that file's path. Treating it as a test means a broken
    // import looks like every test in the file was deleted, which blocks the
    // agent over a syntax error. But the same synthetic record is ALSO emitted
    // when a file's tests all ran and the process then crashed, so the record
    // alone does not mean the file failed to load. What distinguishes them is
    // whether any real test from that file also reported. Both shapes verified
    // against node:test directly.
    //
    // The `file` attribute cannot be relied on to spot it: Node 22 on Linux
    // omits it from this record entirely (verified on the runner), while 24 and
    // Windows include it. Keying on the attribute therefore worked on the
    // development machine and turned a broken import into an accusation
    // everywhere else, so the name's own shape is what decides.
    const named = normaliseSep(attrs.name);
    const key = file || named;
    if (named && (named === file || (!file && looksLikeTestFile(named)))) {
      const e = fileOf(key);
      if (outcome === 'failed') e.selfFailed = true;
      continue;
    }

    // Counted here, after the synthetic record is filtered out and before the
    // id is built: `seen` must mean "records that should have become an id",
    // so that seen > outcomes.size means precisely that two of them collided.
    seen++;

    const scope = [
      file,
      USELESS_CLASSNAMES.has(attrs.classname) ? '' : attrs.classname,
      // The suite name repeats the file or the classname for some reporters;
      // keep each only where it adds something.
      ...stack.filter((n) => n && n !== attrs.classname && n !== file && n !== 'pytest'),
    ].filter(Boolean).join(' > ');

    const id = testId(scope, attrs.name);
    // A dropped record is not silently lost: `seen` was already incremented, so
    // the caller's seen-vs-size guard refuses the run.
    if (!id) continue;
    if (key) fileOf(key).cases++;
    outcomes.set(id, worst(outcomes.get(id), outcome));
  }

  for (const [file, e] of perFile) {
    if (e.selfFailed && e.cases === 0) unloadable.push(file);
  }

  return {
    outcomes,
    seen,
    // Ambiguous when the reporter mixes suite-scoped and bare testcases, since
    // the suite totals then cover only part of the document.
    declared: sawDeclared && !looseCases ? declared : null,
    unloadable,
    malformed,
  };
}

// jest --json and vitest --reporter=json share a shape.
export function parseJestJson(text, { root } = {}) {
  const outcomes = new Map();
  if (!text) return { outcomes, seen: 0, declared: null, unloadable: [] };
  let doc;
  try { doc = JSON.parse(text); } catch { return { outcomes, seen: 0, declared: null, unloadable: [] }; }

  // A file that fails to load takes every test in it with it: the entry has no
  // assertions and a failed status, and the exit code is indistinguishable from
  // an ordinary test failure. Report it so the caller can refuse rather than
  // conclude the tests were deleted.
  //
  // A file whose tests were all DELETED produces the same shape, and refusing
  // there would be silence on exactly the removal this tool exists to catch.
  // Both runners say which one it is in the message, so read it.
  const unloadable = [];
  const emptied = [];
  let seen = 0;
  for (const file of doc.testResults ?? []) {
    const name = relativise(file.name ?? file.testFilePath ?? '', root);
    const assertions = file.assertionResults ?? [];
    if (!assertions.length && file.status === 'failed') {
      (isEmptyFileMessage(file.message) ? emptied : unloadable).push(name);
    }
    for (const a of assertions) {
      seen++;
      const title = a.fullName || [...(a.ancestorTitles ?? []), a.title].filter(Boolean).join(' > ');
      const id = testId(name, title);
      if (!id) continue;
      outcomes.set(id, worst(outcomes.get(id), normalise(a.status)));
    }
  }
  const declared = Number.isFinite(doc.numTotalTests) ? doc.numTotalTests : null;
  return { outcomes, seen, declared, unloadable, emptied };
}

// "This file contains no tests" is a different fact from "this file would not
// load", and only the second one justifies refusing to report.
const EMPTY_FILE_MESSAGES = [
  'no test suite found in file',
  'no test found in suite',
  'must contain at least one test',
  'your test suite must contain at least one test',
];

function isEmptyFileMessage(message) {
  if (typeof message !== 'string') return false;
  const m = message.toLowerCase();
  return EMPTY_FILE_MESSAGES.some((s) => m.includes(s));
}

// `go test -json` is a stream of events, one JSON object per line. The final
// action for a given (Package, Test) pair is its outcome. Events with no Test
// field are package-level and deliberately ignored, `skip` there means
// "package contained no tests", which is not a skipped test.
export function parseGoTestJson(text) {
  const outcomes = new Map();
  const buildFailures = [];
  const started = new Set();
  let seen = 0;
  if (!text) return { outcomes, seen: 0, declared: null, buildFailures, incomplete: [] };
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
    const id = testId(ev.Package, ev.Test);
    if (ev.Action === 'run') { started.add(id); continue; }
    const outcome = normalise(ev.Action);
    if (!outcome) continue;
    seen++;
    outcomes.set(id, worst(outcomes.get(id), outcome));
  }
  // A test that started and never reported was interrupted: a panic, a timeout,
  // a killed process. Its id is simply absent, which is indistinguishable from
  // deletion, so say so rather than let it read as removed coverage.
  const incomplete = [...started].filter((id) => !outcomes.has(id));
  return { outcomes, seen, declared: null, buildFailures: [...new Set(buildFailures)], incomplete };
}

// mocha --reporter json. Its document carries three disjoint arrays that
// together cover every completed test, which is more dependable than reading
// the `err` field off the combined list: a pending test also has an empty err.
//
// Verified against mocha 11's own output, including a `>` in a suite name,
// which its JSON reporter handles correctly (unlike the JUnit shape).
export function parseMochaJson(text, { root } = {}) {
  const outcomes = new Map();
  if (!text) return { outcomes, seen: 0, declared: null };
  let doc;
  try { doc = JSON.parse(text); } catch { return { outcomes, seen: 0, declared: null }; }

  let seen = 0;
  const take = (list, outcome) => {
    for (const t of list ?? []) {
      seen++;
      const id = testId(relativise(t.file ?? '', root), t.fullTitle ?? t.title ?? '');
      if (!id) continue;
      outcomes.set(id, worst(outcomes.get(id), outcome));
    }
  };
  take(doc.passes, 'passed');
  take(doc.failures, 'failed');
  take(doc.pending, 'skipped');

  const declared = Number.isFinite(doc.stats?.tests) ? doc.stats.tests : null;
  return { outcomes, seen, declared };
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
// A backstop for a runner that reports the same test twice. The seen-vs-size
// guard in run.js refuses a genuine id collision before any comparison is made,
// so this only decides what the refused run happens to contain.
function worst(a, b) {
  if (!a) return b;
  if (!b) return a;
  return RANK[b] > RANK[a] ? b : a;
}

function testId(scope, name) {
  const left = (scope || '').trim();
  const right = (name || '').trim();
  if (!right && !left) return null;
  return left ? `${left}::${right}` : right;
}

const normaliseSep = (p) => (p || '').replace(/\\/g, '/');

// Does this string name a test FILE rather than a test? Used only to recognise
// the synthetic record a runner emits for a file it could not load, in the
// shapes where there is no `file` attribute to compare the name against.
const TEST_FILE_NAME =
  /(\.(test|spec)\.[cm]?[jt]sx?|_test\.[cm]?[jt]sx?|_test\.go|_test\.py|\.rs)$|(^|\/)test_[^/]*\.py$/;

function looksLikeTestFile(name) {
  return TEST_FILE_NAME.test(name);
}

// Absolute paths differ between a worktree and the real checkout, which would
// make every id look new. Make them relative to the project root instead of
// guessing at a suffix: taking the last few segments merged
// packages/a/src/foo.test.ts and packages/b/src/foo.test.ts into one id.
export function relativise(p, root) {
  if (!p) return '';
  const norm = normaliseSep(p);
  if (!root) return norm;
  // Jest emits native Windows separators and Vitest emits forward slashes for
  // the same file, so compare on a normalised form. Try the literal prefix
  // first: resolving through Windows path semantics mangles POSIX-style input.
  //
  // Case is folded only on Windows. Doing it everywhere merged Foo.test.ts and
  // foo.test.ts on case-sensitive filesystems, where they are two files.
  const fold = process.platform === 'win32';
  const under = (child, base) => {
    const b = base.replace(/\/+$/, '');
    if (!b) return null;
    const c = fold ? child.toLowerCase() : child;
    const bb = fold ? b.toLowerCase() : b;
    return c.startsWith(bb + '/') ? child.slice(b.length + 1) : null;
  };
  const direct = under(norm, normaliseSep(root));
  if (direct !== null) return direct;
  const resolved = under(
    normaliseSep(path.resolve(root, norm)),
    normaliseSep(path.resolve(root)),
  );
  return resolved !== null ? resolved : norm;
}

export const __test = { decodeEntities, readAttrs, worst, relativise, endOfTag, findClosing };
