// Blanks out the parts of a source file that are not code, preserving length
// and line structure so positions still line up.
//
// This exists so the focus-lock check can anchor to statement position, and so
// the assertion oracle does not mistake prose for an assertion. Both of those
// produce accusations, and the focus-lock one blocks the agent's turn, so a
// defect here is a false denial in two places at once.
//
// It used to be three regex passes: block comments, then line comments, then
// string literals. That ordering cannot be made correct, because comments and
// strings each nest inside the other and whichever pass runs first is wrong for
// the other. A string containing `/*` opened a block comment and blanked every
// line up to a later `*/`, hiding a real `.only`; a regex literal containing a
// quote or `//` swallowed the rest of its line; and a multi-line template
// literal was never blanked at all, so a `.only` stored in a fixture string was
// reported as a real focus lock and blocked the turn.
//
// A single left-to-right scan with one state is the only shape that gets this
// right, because it is the same shape the language's own tokeniser has.

// `lang` is 'js' for the brace languages and 'py' for Python. Python needs its
// own scanner: it has no `//` or `/* */` at all, and its `#` comments and
// triple-quoted strings were previously passed through untouched, which voided
// the oracle's "prose is not an assertion" guarantee for every Python test.
export function stripNonCode(src, lang = 'js') {
  if (!src) return src;
  return lang === 'py' || lang === 'python' ? stripPython(src) : stripJs(src);
}

// A `/` here starts a regex rather than a division. Exact disambiguation needs
// the full token stream; the previous significant character is enough in
// practice, and being wrong only means a regex body is left visible, never that
// code is hidden.
function regexAllowed(prev) {
  return prev === '' || !/[\w$)\]]/.test(prev);
}

function stripJs(src) {
  const out = [...src];
  const n = src.length;
  const blank = (a, b) => {
    for (let k = Math.max(0, a); k < b && k < n; k++) if (out[k] !== '\n') out[k] = ' ';
  };

  // Template literals contain `${ ... }` holes that are ordinary code, and that
  // code can contain another template. A stack is the only way to know which
  // backtick closes which template.
  const frames = [];                 // 'template' | { depth: number }
  const top = () => frames[frames.length - 1];
  let prev = '';
  let i = 0;

  while (i < n) {
    const c = src[i];

    if (top() === 'template') {
      if (c === '\\') { blank(i, i + 2); i += 2; continue; }
      if (c === '`') { frames.pop(); prev = '`'; i++; continue; }
      if (c === '$' && src[i + 1] === '{') { frames.push({ depth: 0 }); prev = '{'; i += 2; continue; }
      blank(i, i + 1); i++; continue;
    }

    if (c === '/' && src[i + 1] === '/') {
      const e = src.indexOf('\n', i);
      blank(i, e === -1 ? n : e);
      i = e === -1 ? n : e;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const e = src.indexOf('*/', i + 2);
      const stop = e === -1 ? n : e + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (c === '/' && regexAllowed(prev)) {
      const e = endOfRegex(src, i);
      if (e !== -1) { blank(i + 1, e - 1); i = e; prev = '/'; continue; }
    }
    if (c === '"' || c === "'") {
      const e = endOfQuoted(src, i, c);
      blank(i + 1, e - 1);
      i = e;
      prev = c;
      continue;
    }
    if (c === '`') { frames.push('template'); prev = '`'; i++; continue; }

    const frame = top();
    if (frame && typeof frame === 'object') {
      if (c === '{') frame.depth++;
      else if (c === '}') {
        if (frame.depth === 0) { frames.pop(); prev = '}'; i++; continue; }
        frame.depth--;
      }
    }

    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out.join('');
}

// Index just past the closing quote, or past the end of the line for an
// unterminated literal (which is a syntax error, not our problem to diagnose).
function endOfQuoted(src, start, quote) {
  for (let i = start + 1; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') { i++; continue; }
    if (c === '\n') return i;
    if (c === quote) return i + 1;
  }
  return src.length;
}

// Index just past a regex literal's flags, or -1 if this `/` does not start
// one. A newline inside means it was division after all.
function endOfRegex(src, start) {
  let inClass = false;
  for (let i = start + 1; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') { i++; continue; }
    if (c === '\n') return -1;
    if (inClass) { if (c === ']') inClass = false; continue; }
    if (c === '[') { inClass = true; continue; }
    if (c === '/') {
      let e = i + 1;
      while (e < src.length && /[a-z]/i.test(src[e])) e++;
      return e;
    }
  }
  return -1;
}

function stripPython(src) {
  const out = [...src];
  const n = src.length;
  const blank = (a, b) => {
    for (let k = Math.max(0, a); k < b && k < n; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === '#') {
      const e = src.indexOf('\n', i);
      blank(i, e === -1 ? n : e);
      i = e === -1 ? n : e;
      continue;
    }
    if (c === '"' || c === "'") {
      const triple = src.startsWith(c.repeat(3), i);
      const delim = triple ? c.repeat(3) : c;
      const e = endOfPyString(src, i, delim);
      blank(i + delim.length, e - delim.length);
      i = e;
      continue;
    }
    i++;
  }
  return out.join('');
}

function endOfPyString(src, start, delim) {
  const single = delim.length === 1;
  for (let i = start + delim.length; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') { i++; continue; }
    if (single && c === '\n') return i;
    if (src.startsWith(delim, i)) return i + delim.length;
  }
  return src.length;
}
