// A small JSONPath for filtering responses:
//   $ · .key · ['key'] · [0] · [-1] · [*] · .* · ..key · ..* · [0,2] · ['a','b']
//   [1:3] · [?(@.price < 10)] · [?(@.tags)] · [?(@.name == 'x' && @.n > 1)]
// Returns every match, in document order.

export function jsonPath(root, path) {
  const steps = parse(String(path || '').trim());
  let nodes = [root];
  for (const step of steps) nodes = nodes.flatMap((n) => apply(step, n));
  return nodes;
}

function parse(path) {
  if (!path.startsWith('$')) path = path.startsWith('.') || path.startsWith('[') ? `$${path}` : `$.${path}`;
  const steps = [];
  let i = 1;
  const fail = (msg) => { throw new Error(`${msg} at position ${i + 1}`); };
  while (i < path.length) {
    const c = path[i];
    if (c === '.') {
      const deep = path[i + 1] === '.';
      i += deep ? 2 : 1;
      if (path[i] === '[') { if (deep) steps.push({ type: 'descend' }); continue; }
      const m = /^(\*|[^.[\]\s]+)/.exec(path.slice(i));
      if (!m) fail('Expected a name');
      i += m[0].length;
      steps.push(m[0] === '*' ? { type: deep ? 'descendAll' : 'wild' } : { type: deep ? 'descendKey' : 'key', key: m[0] });
    } else if (c === '[') {
      const end = closing(path, i);
      if (end < 0) fail('Missing ]');
      steps.push(bracket(path.slice(i + 1, end).trim(), fail));
      i = end + 1;
    } else if (/\s/.test(c)) {
      i++;
    } else {
      fail(`Unexpected "${c}"`);
    }
  }
  // "..[x]" is descend + bracket; fold into one step.
  const out = [];
  for (const s of steps) {
    const prev = out[out.length - 1];
    if (prev?.type === 'descend') { out[out.length - 1] = { type: 'deep', inner: s }; continue; }
    out.push(s);
  }
  return out;
}

/** Index of the ] matching the [ at `start`, skipping quotes and nested brackets. */
function closing(s, start) {
  let depth = 0;
  let quote = null;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
    if (c === "'" || c === '"') quote = c;
    else if (c === '[') depth++;
    else if (c === ']' && --depth === 0) return i;
  }
  return -1;
}

function bracket(inner, fail) {
  if (inner === '*') return { type: 'wild' };
  if (inner.startsWith('?')) {
    const m = /^\?\s*\((.*)\)$/s.exec(inner);
    if (!m) fail('Filters look like [?(@.field == value)]');
    return { type: 'filter', test: compileFilter(m[1], fail) };
  }
  const slice = /^(-?\d*)\s*:\s*(-?\d*)(?:\s*:\s*(-?\d+))?$/.exec(inner);
  if (slice) return { type: 'slice', start: slice[1] === '' ? null : +slice[1], end: slice[2] === '' ? null : +slice[2], step: slice[3] ? +slice[3] : 1 };
  const parts = splitTop(inner, ',').map((p) => p.trim());
  const keys = parts.map((p) => {
    if (/^-?\d+$/.test(p)) return { index: +p };
    const q = /^(['"])(.*)\1$/s.exec(p);
    if (q) return { key: q[2].replace(/\\(['"\\])/g, '$1') };
    return fail(`Can't read "${p}"`);
  });
  return { type: 'pick', keys };
}

function splitTop(s, sep) {
  const out = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) { cur += c; if (c === '\\') cur += s[++i] ?? ''; else if (c === quote) quote = null; continue; }
    if (c === "'" || c === '"') { quote = c; cur += c; continue; }
    if (c === sep) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

// ---------- filters ----------

function compileFilter(src, fail) {
  const tokens = tokenize(src, fail);
  let p = 0;
  const peek = () => tokens[p];
  const next = () => tokens[p++];
  const orExpr = () => { let l = andExpr(); while (peek()?.op === '||') { next(); const r = andExpr(); const a = l; l = (x) => a(x) || r(x); } return l; };
  const andExpr = () => { let l = unary(); while (peek()?.op === '&&') { next(); const r = unary(); const a = l; l = (x) => a(x) && r(x); } return l; };
  const unary = () => {
    if (peek()?.op === '!') { next(); const e = unary(); return (x) => !e(x); }
    if (peek()?.op === '(') { next(); const e = orExpr(); if (next()?.op !== ')') fail('Missing ) in filter'); return e; }
    const left = value();
    const cmp = peek()?.cmp;
    if (!cmp) return (x) => truthy(left(x));
    next();
    const right = value();
    return (x) => compare(left(x), cmp, right(x));
  };
  const value = () => {
    const t = next();
    if (!t) fail('Filter ended early');
    if (t.path) return (x) => (t.path.length ? getPath(x, t.path) : x);
    if ('lit' in t) return () => t.lit;
    return fail(`Unexpected "${t.op || t.cmp}" in filter`);
  };
  const fn = orExpr();
  if (p < tokens.length) fail('Unexpected text after filter');
  return fn;
}

function tokenize(src, fail) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const rest = src.slice(i);
    let m;
    if (/^\s/.test(rest)) { i++; continue; }
    if ((m = /^(===|!==|==|!=|<=|>=|<|>|=~)/.exec(rest))) { out.push({ cmp: m[1] }); i += m[1].length; continue; }
    if ((m = /^(&&|\|\||!|\(|\))/.exec(rest))) { out.push({ op: m[1] }); i += m[1].length; continue; }
    if (rest[0] === '@') {
      i++;
      const path = [];
      while (i < src.length) {
        if (src[i] === '.' && (m = /^\.([A-Za-z_$][\w$-]*)/.exec(src.slice(i)))) { path.push(m[1]); i += m[0].length; continue; }
        if (src[i] === '[' && (m = /^\[\s*(?:(-?\d+)|(['"])(.*?)\2)\s*\]/.exec(src.slice(i)))) { path.push(m[1] !== undefined ? +m[1] : m[3]); i += m[0].length; continue; }
        break;
      }
      if (path[path.length - 1] === 'length') { path.pop(); path.push({ length: true }); }
      out.push({ path });
      continue;
    }
    if ((m = /^(['"])((?:\\.|(?!\1).)*)\1/.exec(rest))) { out.push({ lit: m[2].replace(/\\(.)/g, '$1') }); i += m[0].length; continue; }
    if ((m = /^\/((?:\\.|[^/])+)\/([a-z]*)/.exec(rest))) { out.push({ lit: new RegExp(m[1], m[2]) }); i += m[0].length; continue; }
    if ((m = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(rest))) { out.push({ lit: Number(m[0]) }); i += m[0].length; continue; }
    if ((m = /^(true|false|null)\b/.exec(rest))) { out.push({ lit: JSON.parse(m[1]) }); i += m[0].length; continue; }
    fail(`Can't read "${rest.slice(0, 10)}" in filter`);
  }
  return out;
}

const MISSING = Symbol('missing');
function getPath(x, path) {
  let v = x;
  for (const k of path) {
    if (k && typeof k === 'object') { v = v != null && (Array.isArray(v) || typeof v === 'string') ? v.length : MISSING; continue; }
    if (v == null || typeof v !== 'object' || !(k in v)) return MISSING;
    v = v[k < 0 && Array.isArray(v) ? v.length + k : k];
  }
  return v;
}
const truthy = (v) => v !== MISSING && v !== null && v !== false && v !== undefined;

function compare(a, op, b) {
  if (a === MISSING || b === MISSING) return op === '!=' || op === '!==' ? a !== b : false;
  switch (op) {
    case '==': case '===': return a === b || (typeof a === 'object' && JSON.stringify(a) === JSON.stringify(b));
    case '!=': case '!==': return !(a === b || (typeof a === 'object' && JSON.stringify(a) === JSON.stringify(b)));
    case '<': return a < b;
    case '<=': return a <= b;
    case '>': return a > b;
    case '>=': return a >= b;
    case '=~': return b instanceof RegExp && typeof a === 'string' && b.test(a);
    default: return false;
  }
}

// ---------- steps ----------

const isObj = (v) => v !== null && typeof v === 'object';
const children = (n) => (Array.isArray(n) ? n : isObj(n) ? Object.values(n) : []);
function descendants(n) {
  const out = [n];
  for (const c of children(n)) out.push(...descendants(c));
  return out;
}

function apply(step, n) {
  switch (step.type) {
    case 'key': return isObj(n) && !Array.isArray(n) && step.key in n ? [n[step.key]] : Array.isArray(n) && step.key === 'length' ? [n.length] : [];
    case 'wild': return children(n);
    case 'descendKey': return descendants(n).flatMap((d) => (isObj(d) && !Array.isArray(d) && step.key in d ? [d[step.key]] : []));
    case 'descendAll': return descendants(n).slice(1);
    case 'deep': return descendants(n).flatMap((d) => apply(step.inner, d));
    case 'pick': return step.keys.flatMap(({ index, key }) => {
      if (index !== undefined) { if (!Array.isArray(n)) return []; const i = index < 0 ? n.length + index : index; return i >= 0 && i < n.length ? [n[i]] : []; }
      return isObj(n) && key in n ? [n[key]] : [];
    });
    case 'slice': {
      if (!Array.isArray(n)) return [];
      const len = n.length;
      const norm = (v, d) => (v == null ? d : v < 0 ? Math.max(0, len + v) : Math.min(len, v));
      const out = [];
      if (step.step > 0) for (let i = norm(step.start, 0); i < norm(step.end, len); i += step.step) out.push(n[i]);
      return out;
    }
    case 'filter': return children(n).filter((c) => { try { return step.test(c); } catch { return false; } });
    default: return [];
  }
}
