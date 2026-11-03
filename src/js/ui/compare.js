// Compare one request across two environments (e.g. staging vs production),
// and the shared body-diff table used by the response Diff tab.

import { h, icon, modal, toast, errText, fmtMs, fmtBytes } from './dom.js';
import { diffResponses } from '../jsondiff.js';
import * as C from '../ctx.js';
import * as S from '../store.js';
import { state } from '../store.js';

const fmtValue = (v) => (v === undefined ? '' : JSON.stringify(v)?.slice(0, 160) ?? String(v));

/** Summary chip and diff table for two bodies (JSON value diff, else lines). */
export function diffTable(aText, bText, { ignoreArrayOrder = false, labels } = {}) {
  const { mode, rows, stats } = diffResponses(aText, bText, { ignoreArrayOrder });
  const head = h('div', { class: 'diff-summary' },
    h('span', { class: ['chip', stats.added + stats.removed + stats.changed ? 'bad' : 'ok'] }, mode === 'json' ? `${stats.changed} changed · ${stats.added} added · ${stats.removed} removed` : `${stats.added} newer · ${stats.removed} older lines`),
    h('span', { class: 'muted', style: { fontSize: '12px' } }, stats.same));
  const table = h('table', { class: 'diff-table' });
  if (labels && mode === 'json') table.append(h('tr', { class: 'diff-head' }, h('th', null, 'Path'), h('th', null, labels[0]), h('th', null, labels[1])));
  for (const row of rows) {
    table.append(mode === 'json'
      ? h('tr', { class: `diff-${row.type}` }, h('td', null, row.path || '(root)'), h('td', null, fmtValue(row.a)), h('td', null, fmtValue(row.b)))
      : h('tr', { class: `diff-${row.type}` }, h('td', null, `${row.line}`), h('td', { class: 'mono' }, row.text)));
  }
  return [head, h('div', { class: 'diff-scroll' }, table)];
}

// Headers that differ on every response and say nothing about behaviour.
const VOLATILE = /^(date|age|expires|last-modified|etag|set-cookie|x-request-id|x-amzn-requestid|x-amz-cf-id|cf-ray|server-timing|x-runtime|x-response-time|report-to|nel|content-length|x-trace-id|traceparent|x-envoy-upstream-service-time)$/i;

export function openCompare(t) {
  const envs = state.ws?.environments || [];
  if (envs.length < 1) { toast('Add an environment first: comparing sends this request once per environment.', { error: true }); return; }
  const active = S.activeEnvEntry();
  const pick = (sel) => (sel.value === '' ? null : envs.find((e) => e.uid === sel.value));
  const select = (def) => h('select', { class: 'select' }, h('option', { value: '' }, 'No environment'), envs.map((e) => h('option', { value: e.uid, selected: e === def }, e.name)));
  const selA = select(active || envs[0]);
  const selB = select(envs.find((e) => e !== (active || envs[0])) || null);
  let ignoreOrder = false;
  const out = h('div', { class: 'compare-out' }, h('p', { class: 'hint' }, 'Sends the request once with each environment. Scripts run, but nothing they set is kept.'));
  const go = h('button', { class: 'btn primary', onclick: run }, icon('send'), 'Send to both');

  async function run() {
    const ea = pick(selA);
    const eb = pick(selB);
    if (ea === eb) { toast('Pick two different environments.', { error: true }); return; }
    go.disabled = true;
    out.replaceChildren(h('div', { class: 'loading-bar' }), h('p', { class: 'hint' }, 'Sending…'));
    try {
      const [a, b] = await Promise.all([C.runAgainst(t, ea), C.runAgainst(t, eb)]);
      render(ea, a, eb, b);
    } catch (e) { out.replaceChildren(h('p', { class: 'hint', style: { color: 'var(--err)' } }, errText(e))); }
    go.disabled = false;
  }

  function side(env, r) {
    const res = r.response;
    const tests = r.tests || [];
    const failed = tests.filter((x) => x.passed === false).length;
    return h('div', { class: 'compare-side' },
      h('div', { class: 'compare-env' }, env?.name || 'No environment'),
      h('div', { class: 'mono faint compare-url', title: r.outgoing?.url || '' }, r.outgoing ? `${r.outgoing.method} ${r.outgoing.url}` : ''),
      res ? h('div', { class: 'resp-meta', style: { padding: 0 } },
        h('span', { class: ['status-pill', `s${String(res.status)[0]}`] }, `${res.status} ${res.statusText || ''}`.trim()),
        h('span', null, h('b', null, fmtMs(res.timeMs))),
        h('span', null, h('b', null, fmtBytes(res.size))),
        tests.length ? h('span', { style: { color: failed ? 'var(--err)' : 'var(--ok)' } }, `tests ${tests.length - failed}/${tests.length}`) : null)
        : h('div', { style: { color: 'var(--err)' } }, r.error || (r.notes || []).join(' ') || 'Nothing was sent'));
  }

  function render(ea, a, eb, b) {
    const ra = a.response;
    const rb = b.response;
    const parts = [h('div', { class: 'compare-sides' }, side(ea, a), side(eb, b))];
    if (ra && rb) {
      if (ra.status !== rb.status) parts.push(h('div', { class: 'note warn' }, icon('alert'), h('span', null, `Different status: ${ra.status} vs ${rb.status}`)));
      const ha = new Map(ra.headers.map((x) => [x.key.toLowerCase(), x.value]));
      const hb = new Map(rb.headers.map((x) => [x.key.toLowerCase(), x.value]));
      const keys = [...new Set([...ha.keys(), ...hb.keys()])].filter((k) => ha.get(k) !== hb.get(k)).sort((x, y) => VOLATILE.test(x) - VOLATILE.test(y) || x.localeCompare(y));
      parts.push(h('div', { class: 'pane-title', style: { marginTop: '14px' } }, `Headers that differ · ${keys.filter((k) => !VOLATILE.test(k)).length}`));
      parts.push(keys.length ? h('table', { class: 'diff-table compare-headers' }, keys.map((k) => h('tr', { class: VOLATILE.test(k) ? 'volatile' : 'diff-changed' }, h('td', null, k), h('td', null, ha.get(k) ?? '—'), h('td', null, hb.get(k) ?? '—')))) : h('p', { class: 'hint' }, 'None.'));
      const orderSel = h('label', { class: 'check', style: { marginLeft: 'auto' } }, h('input', { type: 'checkbox', checked: ignoreOrder, onchange: (e) => { ignoreOrder = e.target.checked; render(ea, a, eb, b); } }), 'Ignore array order');
      parts.push(h('div', { class: 'pane-title', style: { marginTop: '14px' } }, 'Body', orderSel));
      parts.push(...(ra.bodyBase64 || rb.bodyBase64 ? [h('p', { class: 'hint' }, 'Binary bodies: compare sizes above.')] : diffTable(ra.bodyText ?? '', rb.bodyText ?? '', { ignoreArrayOrder: ignoreOrder, labels: [ea?.name || 'No environment', eb?.name || 'No environment'] })));
    }
    out.replaceChildren(...parts);
  }

  modal({
    title: `Compare "${t.draft.name}" across environments`,
    wide: true,
    body: h('div', { class: 'compare' }, h('div', { class: 'row' }, selA, h('span', { class: 'faint' }, 'vs'), selB, h('span', { class: 'grow' }), go), out),
  });
}
