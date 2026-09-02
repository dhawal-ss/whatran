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
  { match: /\.py$/, extract: extractPython },
  { match: /\.[cm]?[jt]sx?$/, extract: (src) => extractBrace(src, JS_TEST, 2) },
  { match: /\.go$/, extract: (src) => extractBrace(src, GO_TEST, 1) },
  { match: /\.rs$/, extract: (src) => extractBrace(src, RS_TEST, 1) },
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

    // Extract from the raw source: stripNonCode blanks string contents, and in
    // JS the test's NAME is a string literal, so stripping first made every
    // test in a file look identically named.
    let headTests, baseNames;
    try {
      headTests = lang.extract(headSrc);
      baseNames = new Set(lang.extract(baseSrc).map((t) => t.name));
    } catch { continue; }

    // Names defined anywhere in the file — used to spot delegation to a helper.
    const localNames = definedNames(headSrc);

    for (const t of headTests) {
      if (baseNames.has(t.name)) continue;
      // Comments and string literals are blanked only now, so an assertion
      // mentioned in prose is not mistaken for a real one.
      const body = stripNonCode(t.body);
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
function extractPython(src) {
  const out = [];
  const lines = src.split(/\r?\n/);
  PY_TEST.lastIndex = 0;
  let m;
  while ((m = PY_TEST.exec(src)) !== null) {
    const indent = m[1].length;
    const startLine = src.slice(0, m.index).split(/\r?\n/).length - 1;
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

// Brace languages: find the declaration, then walk to the matching close.
// `nameGroup` says which capture holds the test's name.
function extractBrace(src, re, nameGroup) {
  const out = [];
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(src)) !== null) {
    const open = src.indexOf('{', m.index + m[0].length - 1);
    if (open === -1) continue;
    let depth = 0, end = -1;
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end === -1) continue;
    out.push({ name: m[nameGroup] ?? m[1], body: src.slice(open + 1, end) });
  }
  return out;
}

function definedNames(src) {
  const names = new Set();
  const patterns = [
    /\bfunction\s+([A-Za-z_$][\w$]*)/g,
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g,
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
