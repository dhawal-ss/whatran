// Blanks out the parts of a source file that are not code, preserving length
// and line structure so positions still line up.
//
// This exists so the focus-lock check can anchor to statement position. Without
// it, a test whose own *name* mentions `test.only(` would be reported as a
// focus lock — a false denial in a file about focus locks.
export function stripNonCode(src) {
  const blank = (m) => m.replace(/[^\n]/g, ' ');
  return src
    // block comments
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    // line comments, without eating the "//" of a URL
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length))
    // string and template literals; keep the delimiters so the line still reads
    .replace(/(['"`])(?:\\.|(?!\1)[^\\\n])*\1/g,
      (m) => m[0] + ' '.repeat(Math.max(0, m.length - 2)) + m[m.length - 1]);
}
