// JSON bodies with comments and {{variables}}, as Postman allows. Comments are
// stripped before sending; Beautify keeps them.

/** Splits text into strings, comments, {{variables}}, punctuation and bare values. */
function tokenize(text) {
  const out = [];
  let i = 0;
  let nl = false; // a line break came before this token
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) { if (c === '\n') nl = true; i++; continue; }
    let j = i + 1;
    let type = 'lit';
    if (c === '"') {
      type = 'str';
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      j = Math.min(j + 1, text.length);
    } else if (c === '/' && text[i + 1] === '/') {
      type = 'comment';
      while (j < text.length && text[j] !== '\n') j++;
    } else if (c === '/' && text[i + 1] === '*') {
      type = 'block';
      const end = text.indexOf('*/', i + 2);
      j = end < 0 ? text.length : end + 2;
    } else if (c === '{' && text[i + 1] === '{' && text.indexOf('}}', i + 2) > 0) {
      j = text.indexOf('}}', i + 2) + 2;
    } else if ('{}[],:'.includes(c)) {
      type = 'punc';
    } else {
      while (j < text.length && !/[\s{}[\],:"]/.test(text[j]) && !(text[j] === '/' && '/*'.includes(text[j + 1]))) j++;
    }
    out.push({ type, text: text.slice(i, j), nl });
    nl = false;
    i = j;
  }
  return out;
}

/**
 * Walks the text outside strings, replacing each comment, and with `vars` each
 * bare {{variable}}, via `swap`. Strings are copied exactly.
 */
function rewrite(text, swap, vars = false) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    let j = i + 1;
    if (c === '"') {
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      while (j < text.length && text[j] !== '\n') j++;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      j = end < 0 ? text.length : end + 2;
    } else if (vars && c === '{' && text[i + 1] === '{' && text.indexOf('}}', i + 2) > 0) {
      j = text.indexOf('}}', i + 2) + 2;
      out += swap(text.slice(i, j), true);
      i = j;
      continue;
    } else {
      out += c;
      i++;
      continue;
    }
    out += swap(text.slice(i, j), false);
    i = j;
  }
  return out;
}

/** Removes // and /* *\/ comments that sit outside strings. Everything else is left exactly as typed. */
export function stripJsonComments(text) {
  return rewrite(text, () => '');
}

/** Why the body isn't valid JSON once comments and {{variables}} are set aside, or null if it is. */
export function jsonProblem(text) {
  // Blank them out in place so the line and column in JSON.parse's message still match the editor.
  const plain = rewrite(text, (s, isVar) => (isVar ? `0${s.slice(1).replace(/[^\n]/g, ' ')}` : s.replace(/[^\n]/g, ' ')), true);
  try { JSON.parse(plain); return null; } catch (e) { return e.message; }
}

/**
 * Pretty-prints JSON with two-space indents, keeping comments where they were
 * (a comment at the end of a line stays at the end of that line) and leaving
 * {{variables}} untouched.
 */
export function formatJsonc(text) {
  const toks = tokenize(text);
  const lines = [];
  let depth = 0;
  let line = '';
  let pending = false; // a line break is due before the next value
  const pad = () => '  '.repeat(depth);
  const breakLine = () => { lines.push(line.trimEnd()); line = pad(); };
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.type === 'comment' || t.type === 'block') {
      if (!t.nl && line.trim()) line += t.type === 'block' ? ` ${t.text} ` : ` ${t.text}`;
      else { if (line.trim()) breakLine(); else line = pad(); line += t.text; }
      if (t.type === 'comment' || t.nl) pending = true;
      continue;
    }
    const close = t.text === '}' || t.text === ']';
    if (close) {
      depth = Math.max(0, depth - 1);
      pending = false;
      if (line.trim()) breakLine(); else line = pad();
      line += t.text;
      continue;
    }
    if (pending) { breakLine(); pending = false; }
    if (t.text === '{' || t.text === '[') {
      const next = toks[i + 1];
      if (next && next.text === (t.text === '{' ? '}' : ']')) { line += t.text + next.text; i++; continue; }
      line += t.text;
      depth++;
      pending = true;
    } else if (t.type === 'punc' && t.text === ',') {
      line += ',';
      pending = true;
    } else if (t.type === 'punc' && t.text === ':') {
      line += ': ';
    } else {
      line += t.text;
    }
  }
  if (line.trim()) lines.push(line.trimEnd());
  return lines.join('\n');
}
