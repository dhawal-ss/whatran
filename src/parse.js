// Parsers that turn a test runner's machine-readable output into a flat
// Map<testId, outcome>. outcome is one of: 'passed' | 'failed' | 'skipped'.
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

// JUnit XML is the one format pytest, vitest, node:test, nextest, Surefire and
// Gradle all emit natively, which is why it is the primary substrate here.
// Written as a scanner rather than a regex over the whole document so that
// nested <failure> bodies containing markup can't break the outer match.
export function parseJUnitXml(text) {
  const out = new Map();
  if (!text) return out;
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
    const id = testId(attrs.classname, attrs.name, attrs.file);
    if (!id) continue;
    let outcome = 'passed';
    if (/<skipped\b/.test(body)) outcome = 'skipped';
    else if (/<(failure|error)\b/.test(body)) outcome = 'failed';
    // A rerun of the same id (parametrised retries) resolves to the worst
    // outcome seen, so a flaky pass can never mask a recorded failure.
    out.set(id, worst(out.get(id), outcome));
  }
  return out;
}

// jest --json and vitest --reporter=json share a shape.
export function parseJestJson(text) {
  const out = new Map();
  if (!text) return out;
  let doc;
  try { doc = JSON.parse(text); } catch { return out; }
  for (const file of doc.testResults ?? []) {
    const fileName = shortenPath(file.name ?? file.testFilePath ?? '');
    for (const a of file.assertionResults ?? []) {
      const title = a.fullName || [...(a.ancestorTitles ?? []), a.title].filter(Boolean).join(' > ');
      const id = testId(fileName, title);
      if (!id) continue;
      out.set(id, worst(out.get(id), normalise(a.status)));
    }
  }
  return out;
}

// `go test -json` is a stream of events, one JSON object per line. The final
// action for a given (Package, Test) pair is its outcome. Events with no Test
// field are package-level and deliberately ignored — `skip` there means
// "package contained no tests", which is not a skipped test.
export function parseGoTestJson(text) {
  const out = new Map();
  if (!text) return out;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('{')) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (!ev.Test) continue;
    const outcome = normalise(ev.Action);
    if (!outcome) continue;
    out.set(testId(ev.Package, ev.Test), outcome);
  }
  return out;
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
function worst(a, b) {
  if (!a) return b;
  return RANK[b] > RANK[a] ? b : a;
}

function testId(scope, name, file) {
  const left = (scope || file || '').trim();
  const right = (name || '').trim();
  if (!right && !left) return null;
  return left ? `${left}::${right}` : right;
}

// Absolute paths differ between a worktree and the real checkout, which would
// make every id look new. Keep only the repo-relative tail.
function shortenPath(p) {
  if (!p) return '';
  const norm = p.replace(/\\/g, '/');
  const marker = norm.lastIndexOf('/src/');
  if (marker !== -1) return norm.slice(marker + 1);
  const parts = norm.split('/');
  return parts.slice(-3).join('/');
}

export const __test = { decodeEntities, readAttrs, worst, shortenPath };
