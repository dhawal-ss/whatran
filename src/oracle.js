import { stripNonCode } from './strip.js';

// Finds tests the change ADDED that do not appear to check anything.
//
// A test that runs but verifies nothing is worse than no test: it makes the
// suite look larger and the coverage look better while proving nothing. It is
// also the single most common weakness in agent-written tests.
//
// Deliberately scoped to newly added tests. Plenty of long-standing tests are
// weak, and nagging about those on every turn is exactly the noise that gets a
// tool switched off.

const PY_TEST = /^([ \t]*)(?:async[ \t]+)?def[ \t]+(test\w*)[ \t]*\(/gm;
const JS_TEST = /^[ \t]*(?:await[ \t]+)?(?:it|test|bench)(?:\.\w+)*[ \t]*\(\s*(['"`])((?:\\.|(?!\1).)*)\1/gm;
const GO_TEST = /^func[ \t]+(Test\w+)[ \t]*\(/gm;
const RS_TEST = /#\[(?:tokio::)?test\][\s\S]{0,80}?fn[ \t]+(\w+)[ \t]*\(/g;

// What counts as checking something. Deliberately generous: a false "this test
// asserts nothing" is far more damaging than missing a weak test.
const ASSERTION = new RegExp([
  '\\bassert\\b', '\\bassert[_!(]', '\\bassert\\.', '\\bassertThat\\b',
  '\\bself\\.assert\\w*\\(', '\\bexpect\\s*\\(', '\\bexpectTypeOf\\s*\\(',
  '\\bpytest\\.(raises|warns|approx|fail)\\b', '\\bunittest\\.',
  '\\bshould\\b', '\\bchai\\b', '\\bverify\\s*\\(',
  '\\bt\\.(Error|Fatal|Errorf|Fatalf|Fail)\\b', '\\brequire\\.\\w+\\(',
  '\\bassert_(eq|ne|matches)!', '\\bpanic!', '\\bdebug_assert',
  '\\bto(Be|Equal|Match|Throw|Contain|Have|Strict)\\w*\\s*\\(',
  '\\btoMatchSnapshot\\b', '\\btoMatchInlineSnapshot\\b',
  '\\bsnapshot\\s*\\(', '\\bmatchSnapshot\\b',
].join('|'));

// A test whose only body is a call to something defined nearby is very often
// asserting through that helper. Treat it as inconclusive, not as empty.
const CALL = /\b([A-Za-z_$][\w$]*)\s*\(/g;

const LANGS = [
  { match: /\.py$/, strip: 'py', extract: extractPython },
  // `requireCallable` marks the languages where the first `{` after the
  // declaration is NOT the body: in JS the test's options object or a
  // destructured parameter comes first, so a brace only counts once a `=>` or
  // `function` has introduced it.
  { match: /\.[cm]?[jt]sx?$/, strip: 'js', extract: (s, b) => extractBrace(s, b, JS_TEST, 2, true) },
  { match: /\.go$/, strip: 'js', extract: (s, b) => extractBrace(s, b, GO_TEST, 1, false) },
  { match: /\.rs$/, strip: 'js', extract: (s, b) => extractBrace(s, b, RS_TEST, 1, false) },
];

const TEST_FILE = /(\.(test|spec)\.[cm]?[jt]sx?|_test\.go|_test\.py|(^|\/)test_[^/]*\.py)$/;

export function newTestsWithoutAssertions(changed, readHead, readBase) {
  const bare = [];

  for (const rel of changed) {
    const lang = LANGS.find((l) => l.match.test(rel));
    if (!lang) continue;

    const headSrc = readHead(rel);
    if (!headSrc) continue;
    // Rust declares tests inline in ordinary source files, so a filename filter
    // would never see them; fall back to looking for the attribute itself.
    const looksLikeTests = TEST_FILE.test(rel)
      || /(^|\/)(tests?|__tests__)\//.test(rel)
      || (/\.rs$/.test(rel) && /#\[(tokio::)?test\]/.test(headSrc));
    if (!looksLikeTests) continue;
    const baseSrc = readBase(rel) ?? '';

    // Names come from the raw source, because in JS the test's NAME is a string
    // literal and stripping first made every test in a file look identically
    // named. Structure comes from the blanked copy, whose offsets are identical,
    // so a `{` or `}` inside a string cannot truncate or extend a test body.
    let headTests, baseNames;
    try {
      headTests = lang.extract(headSrc, stripNonCode(headSrc, lang.strip));
      baseNames = new Set(lang.extract(baseSrc, stripNonCode(baseSrc, lang.strip)).map((t) => t.name));
    } catch { continue; }

    // Names defined anywhere in the file, used to spot delegation to a helper.
    const localNames = definedNames(headSrc);

    for (const t of headTests) {
      if (baseNames.has(t.name)) continue;
      // Comments and string literals are blanked only now, so an assertion
      // mentioned in prose is not mistaken for a real one.
      const body = stripNonCode(t.body, lang.strip);
      if (!body.trim()) continue; // an empty stub is a different problem
      if (ASSERTION.test(body)) continue;
      if (callsLocal(body, localNames)) continue;
      bare.push(`${rel}::${t.name}`);
    }
  }
  return bare;
}

// Python bodies are found by indentation: everything more indented than the
// `def` line, up to the first line that is not.
function extractPython(src, blanked = src) {
  const out = [];
  const lines = src.split(/\r?\n/);
  const blankLines = blanked.split(/\r?\n/);
  PY_TEST.lastIndex = 0;
  let m;
  while ((m = PY_TEST.exec(src)) !== null) {
    const indent = m[1].length;
    const defLine = src.slice(0, m.index).split(/\r?\n/).length - 1;
    // A signature can span several lines. Walking straight from the `def` line
    // treated the parameters as the body and stopped at the closing `):`, whose
    // indentation is the same as the `def`, so the body was the parameter list
    // and every such test read as asserting nothing.
    const startLine = endOfSignature(blankLines, defLine);
    if (startLine === -1) continue;
    const body = [];
    for (let i = startLine + 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) { body.push(line); continue; }
      const lead = line.length - line.trimStart().length;
      if (lead <= indent) break;
      body.push(line);
    }
    out.push({ name: m[2], body: body.join('\n') });
  }
  return out;
}

// The line on which a `def`'s parameter list closes, so the body starts after
// it. Counted on the blanked copy, so a bracket inside a default string value
// does not shift the count.
function endOfSignature(blankLines, defLine) {
  let depth = 0;
  for (let i = defLine; i < blankLines.length; i++) {
    for (const ch of blankLines[i]) {
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') depth--;
    }
    if (depth <= 0) return i;
  }
  return -1;
}

// Brace languages: find the declaration, then walk to the matching close.
// `nameGroup` says which capture holds the test's name. Structure is read from
// `blanked`, which has identical offsets with comments and string literals
// blanked out, so a brace inside a string cannot end the body early.
function extractBrace(src, blanked, re, nameGroup, requireCallable) {
  const out = [];
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(src)) !== null) {
    const span = bodySpan(blanked, m.index + m[0].length, requireCallable);
    if (!span) continue;
    out.push({ name: m[nameGroup] ?? m[1], body: src.slice(span.start, span.end) });
  }
  return out;
}

// The callback body, not merely the first `{` after the declaration.
//
// `test('x', { timeout: 50 }, () => { ... })` put the options object in the
// body slot, so the test read as having no assertion in it. And a test with no
// inline body at all, `test('x', helper)`, used to run off the end of its own
// call and adopt the NEXT test's body, so the finding named one test and quoted
// another's code. Tracking the call's parentheses bounds the search to the
// declaration it started from.
function bodySpan(blanked, from, requireCallable) {
  let sawCallable = !requireCallable;
  let depth = requireCallable ? 1 : Infinity;
  for (let i = from; i < blanked.length; i++) {
    const c = blanked[i];
    if (c === '(') { depth++; continue; }
    if (c === ')') { depth--; if (depth <= 0) return null; continue; }
    if (c === '=' && blanked[i + 1] === '>') { sawCallable = true; i++; continue; }
    if (blanked.startsWith('function', i) && !/[\w$]/.test(blanked[i - 1] ?? '')) {
      sawCallable = true; i += 'function'.length - 1; continue;
    }
    if (c !== '{') continue;
    const end = matchBrace(blanked, i);
    if (end === -1) return null;
    if (sawCallable) return { start: i + 1, end };
    i = end; // an options object or a destructured parameter; step over it
  }
  return null;
}

function matchBrace(blanked, open) {
  let depth = 0;
  for (let i = open; i < blanked.length; i++) {
    if (blanked[i] === '{') depth++;
    else if (blanked[i] === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function definedNames(src) {
  const names = new Set();
  const patterns = [
    /\bfunction\s+([A-Za-z_$][\w$]*)/g,
    // Both arrow forms: `const check = (x) => …` and `const check = x => …`.
    // Only the parenthesised one was recognised, so a test delegating to a
    // single-argument helper was reported as asserting nothing.
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(|[A-Za-z_$][\w$]*\s*=>)/g,
    /^[ \t]*def[ \t]+(\w+)/gm,
    /^func[ \t]+(\w+)/gm,
    /^[ \t]*fn[ \t]+(\w+)/gm,
  ];
  for (const p of patterns) {
    let m;
    p.lastIndex = 0;
    while ((m = p.exec(src)) !== null) names.add(m[1]);
  }
  return names;
}

function callsLocal(body, localNames) {
  CALL.lastIndex = 0;
  let m;
  while ((m = CALL.exec(body)) !== null) {
    if (localNames.has(m[1])) return true;
  }
  return false;
}
