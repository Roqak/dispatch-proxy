// Line diff + JSON-aware diff for response comparison. Pure functions.

/** Myers-free simple LCS line diff, O(n*m) but bounded by the caller. */
export function lineDiff(aLines, bLines) {
  // Trim common prefix/suffix first — the practical case (one field changed).
  let start = 0;
  while (start < aLines.length && start < bLines.length && aLines[start] === bLines[start]) start++;
  let endA = aLines.length, endB = bLines.length;
  while (endA > start && endB > start && aLines[endA - 1] === bLines[endB - 1]) { endA--; endB--; }
  const a = aLines.slice(start, endA), b = bLines.slice(start, endB);
  if (!a.length && !b.length) return [];
  if (!a.length) return b.map((l, i) => ({ type: 'add', line: start + i, text: l }));
  if (!b.length) return a.map((l, i) => ({ type: 'del', line: start + i, text: l }));

  // LCS table (bounded: callers keep the remainder small; a hard cap guards anyway).
  if (a.length * b.length > 4_000_000) {
    const rows = a.map((l, i) => ({ type: a[i] === b[0] ? 'same' : 'del', line: start + i, text: l }));
    rows.push(...b.map((l, i) => ({ type: 'add', line: start + i, text: l })));
    return rows;
  }
  if (a.length * b.length > 250_000) {
    // Hash-bucket fallback: align identical unique lines, emit others as del/add blocks.
    const out = [];
    const seen = new Map();
    for (const l of a) seen.set(l, (seen.get(l) || 0) + 1);
    let ai = 0, bi = 0;
    while (ai < a.length || bi < b.length) {
      if (ai < a.length && bi < b.length && a[ai] === b[bi]) { out.push({ type: 'same', line: start + ai, text: a[ai] }); ai++; bi++; }
      else if (ai < a.length && (seen.get(a[ai]) ?? 0) !== (b.filter((x) => x === a[ai]).length)) { out.push({ type: 'del', line: start + ai, text: a[ai] }); ai++; }
      else if (bi < b.length) { out.push({ type: 'add', line: start + bi, text: b[bi] }); bi++; }
      else { out.push({ type: 'del', line: start + ai, text: a[ai] }); ai++; }
    }
    return out;
  }

  // Real LCS.
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const rows = [];
  let i = 0, j = 0, line = start;
  while (i < n && j < m) {
    if (a[i] === b[j]) { rows.push({ type: 'same', line, text: a[i] }); i++; j++; line++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { rows.push({ type: 'del', line, text: a[i] }); i++; }
    else { rows.push({ type: 'add', line, text: b[j] }); j++; line++; }
  }
  for (; i < n; i++, line++) rows.push({ type: 'del', line, text: a[i] });
  for (; j < m; j++, line++) rows.push({ type: 'add', line, text: b[j] });
  return rows;
}

const pretty = (text) => {
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
};

/**
 * Compare two response body texts as JSON values when both parse.
 * opts: { ignoreWhitespace = false, ignoreArrayOrder = false }
 * Returns { mode: 'json' | 'lines', rows, stats: { added, removed, changed, same } }.
 */
export function diffResponses(aText, bText, opts = {}) {
  const ignoreWhitespace = opts.ignoreWhitespace !== false; // default on
  const ignoreArrayOrder = opts.ignoreArrayOrder === true;

  let mode = 'lines';
  let rows = [];
  const aObj = safeParse(aText), bObj = safeParse(bText);
  if (aObj !== undefined && bObj !== undefined) {
    mode = 'json';
    rows = valueDiff(aObj, bObj, '', ignoreArrayOrder);
  } else {
    const A = pretty(aText).split('\n'), B = pretty(bText).split('\n');
    const raw = lineDiff(A, B);
    rows = collapse(raw, aText, bText, ignoreWhitespace);
  }
  let added = 0, removed = 0, changed = 0;
  for (const r of rows) { if (r.type === 'add') added++; else if (r.type === 'del') removed++; else if (r.type === 'change') changed++; }
  return { mode, rows, stats: { added, removed, changed, same: aText === bText ? 'identical' : 'different' } };
}

function safeParse(text) {
  try { return JSON.parse(text); } catch { return undefined; }
}

/** Deep value diff for JSON: paths with add/del/change. */
function valueDiff(a, b, path, ignoreArrayOrder, out = []) {
  if (a === b) return out;
  const ta = typeOf(a), tb = typeOf(b);
  if (ta !== tb) { out.push({ type: 'change', path, a, b }); return out; }
  if (ta === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of [...keys].sort()) {
      const p = path ? `${path}.${k}` : k;
      if (!(k in a)) out.push({ type: 'add', path: p, a: null, b: b[k] });
      else if (!(k in b)) out.push({ type: 'del', path: p, a: a[k], b: null });
      else valueDiff(a[k], b[k], p, ignoreArrayOrder, out);
    }
    return out;
  }
  if (ta === 'array') {
    let A = a, B = b;
    if (ignoreArrayOrder && a.length === b.length) {
      A = [...a].sort((x, y) => (arraySortKey(x) < arraySortKey(y) ? -1 : arraySortKey(x) > arraySortKey(y) ? 1 : 0));
      B = [...b].sort((x, y) => (arraySortKey(x) < arraySortKey(y) ? -1 : arraySortKey(x) > arraySortKey(y) ? 1 : 0));
    }
    const len = Math.max(A.length, B.length);
    for (let i = 0; i < len; i++) {
      const p = `${path}[${i}]`;
      if (i >= A.length) out.push({ type: 'add', path: p, a: null, b: B[i] });
      else if (i >= B.length) out.push({ type: 'del', path: p, a: A[i], b: null });
      else valueDiff(A[i], B[i], p, ignoreArrayOrder, out);
    }
    return out;
  }
  if (ta !== 'undefined') out.push({ type: 'change', path, a, b });
  return out;
}

const arraySortKey = (x) => JSON.stringify(x);
function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (v === undefined) return 'undefined';
  return typeof v;
}

function collapse(rows, aText, bText, ignoreWhitespace) {
  // Merge per-line rows into hunks? Keep rows flat; the renderer groups them.
  if (!ignoreWhitespace) return rows;
  const norm = (s) => s.trim();
  return rows; // rendering compares whitespace-insensitively per row
}