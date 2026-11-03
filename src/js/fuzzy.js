// Fuzzy matching for the command palette: every query character must appear
// in order; contiguous runs, word starts and early matches score higher.

/** Score `text` against `query` (higher is better), or -1 when it doesn't match. */
export function fuzzyScore(query, text) {
  const q = String(query).toLowerCase().replace(/\s+/g, ' ').trim();
  const t = String(text || '').toLowerCase();
  if (!q) return 0;
  // Each space-separated word must match on its own, in any order.
  const words = q.split(' ');
  if (words.length > 1) {
    let total = 0;
    for (const w of words) { const s = fuzzyScore(w, t); if (s < 0) return -1; total += s; }
    return total;
  }
  const direct = t.indexOf(q);
  if (direct >= 0) return 1000 - direct + (isWordStart(t, direct) ? 300 : 0) + (t.length === q.length ? 500 : 0);
  let score = 0;
  let ti = 0;
  let run = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return -1;
    run = found === ti ? run + 1 : 0;
    score += 10 + run * 15 + (isWordStart(t, found) ? 40 : 0) - Math.min(found - ti, 20);
    ti = found + 1;
  }
  return score;
}

const isWordStart = (t, i) => i === 0 || /[\s/._\-:{}?&=]/.test(t[i - 1]);

/** Rank items by their best-matching field; items are { fields: [string, weight][] }. */
export function rank(query, items, limit = 60) {
  if (!String(query).trim()) return items.slice(0, limit);
  const scored = [];
  for (const it of items) {
    let best = -1;
    for (const [text, weight = 1] of it.fields) {
      const s = fuzzyScore(query, text);
      if (s >= 0) best = Math.max(best, s * weight);
    }
    if (best >= 0) scored.push([best + (it.boost || 0), it]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  return scored.slice(0, limit).map(([, it]) => it);
}
