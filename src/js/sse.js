// Server-Sent Events: parse an event stream (whole or as it arrives).

/** Incremental parser: push(text) returns the events completed by that text. */
export function sseParser() {
  let buf = '';
  let ev = { event: '', data: [], id: '', retry: null };
  const done = [];
  const flush = () => {
    if (ev.data.length || ev.event) done.push({ event: ev.event || 'message', data: ev.data.join('\n'), id: ev.id || null, ...(ev.retry != null ? { retry: ev.retry } : {}) });
    ev = { event: '', data: [], id: ev.id, retry: null };
  };
  const line = (l) => {
    if (l === '') return flush();
    if (l.startsWith(':')) return undefined; // comment / heartbeat
    const i = l.indexOf(':');
    const field = i < 0 ? l : l.slice(0, i);
    let value = i < 0 ? '' : l.slice(i + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') ev.data.push(value);
    else if (field === 'event') ev.event = value;
    else if (field === 'id') ev.id = value;
    else if (field === 'retry' && /^\d+$/.test(value)) ev.retry = Number(value);
    return undefined;
  };
  return {
    push(text) {
      buf += text;
      const lines = buf.split(/\r\n|\r|\n/);
      buf = lines.pop();
      for (const l of lines) line(l);
      return done.splice(0);
    },
    /** End of stream: a final event without its blank line still counts. */
    end() { if (buf) { line(buf); buf = ''; } flush(); return done.splice(0); },
  };
}

export function parseSse(text) {
  const p = sseParser();
  return [...p.push(text), ...p.end()];
}

/** NDJSON / JSON Lines: one value per line. */
export function parseNdjson(text) {
  return String(text || '').split(/\r?\n/).filter((l) => l.trim()).map((l, i) => {
    try { return { event: 'line', data: l, json: JSON.parse(l), index: i }; } catch { return { event: 'line', data: l, index: i }; }
  });
}

export const isEventStream = (ct) => /text\/event-stream/i.test(ct || '');
export const isLineStream = (ct) => /ndjson|jsonl|stream\+json/i.test(ct || '');
