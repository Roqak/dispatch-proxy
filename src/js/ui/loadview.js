// Load test tab: run one request with many virtual users and watch the numbers.

import { h, icon, toast, errText, fmtBytes } from './dom.js';
import * as C from '../ctx.js';
import { state, emit } from '../store.js';
import { bridge } from '../bridge.js';
import { loadVault } from '../vault.js';

const runs = new Map(); // load tab id → { id, report, running, error }
const ms = (v) => (v == null ? '–' : v < 10 ? `${v.toFixed(1)} ms` : v < 1000 ? `${Math.round(v)} ms` : `${(v / 1000).toFixed(2)} s`);

export function renderLoadTab(root, t) {
  const d = t.draft;
  const src = state.tabs.find((x) => x.id === t.ref.src);
  const run = runs.get(t.id);
  const r = run?.report;
  const num = (key, { min = 0, max, step = 1, width = '90px' } = {}) => h('input', { class: 'input mono', type: 'number', min, max, step, value: d[key], disabled: run?.running, style: { width }, oninput: (e) => { d[key] = Math.max(min, Math.min(max ?? Infinity, Number(e.target.value) || 0)); C.saveTabsLater(); } });

  const start = async () => {
    if (!src) return toast('Open the request this load test belongs to first.', { error: true });
    let outgoing;
    try { await loadVault().catch(() => {}); outgoing = C.outgoingFor(src, { vault: true }); } catch (e) { return toast(errText(e), { error: true }); }
    const id = `load-${Math.random().toString(36).slice(2, 10)}`;
    const entry = { id, report: null, running: true, error: null };
    runs.set(t.id, entry);
    emit('main');
    const config = { vus: d.vus, rampUpS: d.rampUpS, rps: d.rps, ...(d.mode === 'duration' ? { durationS: d.durationS } : { requests: d.requests }) };
    try {
      entry.report = await bridge.loadtestRun(id, outgoing, config, (rep) => { entry.report = rep; if (C.activeTab()?.id === t.id) emit('main'); });
    } catch (e) { entry.error = errText(e); }
    entry.running = false;
    emit('main');
  };

  const controls = h('div', { class: 'mock-controls' },
    h('div', { class: 'row', style: { gap: '18px', flexWrap: 'wrap' } },
      h('label', { class: 'row', style: { gap: '6px' } }, h('span', { class: 'faint' }, 'Virtual users'), num('vus', { min: 1, max: 500 })),
      h('label', { class: 'row', style: { gap: '6px' } },
        h('select', { class: 'select', disabled: run?.running, onchange: (e) => { d.mode = e.target.value; C.saveTabsLater(); emit('main'); } },
          h('option', { value: 'duration', selected: d.mode === 'duration' }, 'For (seconds)'),
          h('option', { value: 'requests', selected: d.mode === 'requests' }, 'Total requests')),
        d.mode === 'duration' ? num('durationS', { min: 1, max: 3600 }) : num('requests', { min: 1, max: 1000000, width: '110px' })),
      h('label', { class: 'row', style: { gap: '6px' } }, h('span', { class: 'faint' }, 'Ramp-up'), num('rampUpS', { max: 3600, width: '70px' }), h('span', { class: 'faint' }, 's')),
      h('label', { class: 'row', style: { gap: '6px' } }, h('span', { class: 'faint' }, 'Max rate'), num('rps', { max: 100000, width: '90px' }), h('span', { class: 'faint' }, 'req/s (0 = no cap)')),
      h('span', { class: 'grow' }),
      run?.running
        ? h('button', { class: 'btn', onclick: () => bridge.loadtestStop(run.id) }, icon('stop'), 'Stop')
        : h('button', { class: 'btn primary', onclick: start }, icon('play'), r ? 'Run again' : 'Start')),
    h('p', { class: 'hint', style: { margin: '10px 0 0' } },
      src ? `Sends "${src.draft.name}" as it is now: variables, auth and vault secrets filled in once; scripts don't run for each request. ` : 'The request tab this belongs to is closed. ',
      h('b', null, 'Only load-test servers you own or have permission to test.')));

  const card = (label, value, cls) => h('div', { class: ['load-card', cls] }, h('div', { class: 'faint' }, label), h('div', { class: 'load-val mono' }, value));
  const errPct = r && r.done ? (r.failed / r.done) * 100 : 0;
  const results = r ? [
    h('div', { class: 'load-cards' },
      card('Requests', r.done.toLocaleString()),
      card('Throughput', `${r.rps.toFixed(1)}/s`),
      card('p50', ms(r.p50Ms)), card('p95', ms(r.p95Ms)), card('p99', ms(r.p99Ms)),
      card('Errors', `${errPct.toFixed(errPct && errPct < 1 ? 2 : 0)}%`, errPct ? 'bad' : 'ok'),
      card(r.finished ? 'Duration' : 'Running', `${(r.elapsedMs / 1000).toFixed(1)} s${r.finished ? '' : ` · ${r.activeVus} VUs`}`)),
    chart(r.timeline),
    h('div', { class: 'load-cols' },
      h('div', null, h('div', { class: 'pane-title' }, 'Status codes'),
        r.statuses.length ? h('table', { class: 'kv' }, h('tbody', null, r.statuses.map(([code, n]) => h('tr', null, h('td', null, h('span', { class: ['status-pill', `s${String(code)[0]}`] }, code)), h('td', { class: 'mono' }, n.toLocaleString()))))) : h('p', { class: 'hint' }, 'No responses.')),
      h('div', null, h('div', { class: 'pane-title' }, 'Latency'),
        h('table', { class: 'kv' }, h('tbody', null, [['min', r.minMs], ['mean', r.meanMs], ['p90', r.p90Ms], ['max', r.maxMs]].map(([k, v]) => h('tr', null, h('td', null, k), h('td', { class: 'mono' }, ms(v))))), h('tr', null, h('td', null, 'received'), h('td', { class: 'mono' }, fmtBytes(r.bytes))))),
      r.errors.length ? h('div', null, h('div', { class: 'pane-title' }, 'Errors'), h('table', { class: 'kv' }, h('tbody', null, r.errors.map(([msg, n]) => h('tr', null, h('td', { style: { color: 'var(--err)' } }, msg), h('td', { class: 'mono' }, n.toLocaleString())))))) : null),
    r.stopped ? h('p', { class: 'hint' }, 'Stopped early.') : null,
  ] : [run?.error ? h('div', { class: 'note err' }, icon('alert'), h('span', null, run.error)) : h('div', { class: 'md-empty' }, run?.running ? 'Starting…' : 'Set the load and press Start.')];

  root.replaceChildren(
    h('div', { class: 'crumbs' }, icon('play'), h('b', null, d.name)),
    h('div', { class: 'pane' }, run?.running ? h('div', { class: 'loading-bar' }) : null, controls, h('div', { style: { height: '14px' } }), ...results));
}

/** Requests per second (bars, errors in red) with the p95 latency line. */
function chart(timeline) {
  const NS = 'http://www.w3.org/2000/svg';
  const W = 760; const H = 150; const pad = 26;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'load-chart');
  if (!timeline.length) return svg;
  const maxC = Math.max(1, ...timeline.map((s) => s.count));
  const maxL = Math.max(1, ...timeline.map((s) => s.p95Ms));
  const bw = (W - pad * 2) / timeline.length;
  const el = (tag, attrs, text) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (text != null) e.textContent = text; return e; };
  timeline.forEach((s, i) => {
    const hOk = ((s.count - s.errors) / maxC) * (H - pad * 2);
    const hErr = (s.errors / maxC) * (H - pad * 2);
    const x = pad + i * bw + bw * 0.12;
    const g = el('g', {});
    g.append(el('title', {}, `${s.t}s: ${s.count} requests, ${s.errors} errors, p95 ${ms(s.p95Ms)}`));
    g.append(el('rect', { x, y: H - pad - hOk, width: Math.max(1, bw * 0.76), height: hOk, class: 'bar-ok' }));
    if (hErr) g.append(el('rect', { x, y: H - pad - hOk - hErr, width: Math.max(1, bw * 0.76), height: hErr, class: 'bar-err' }));
    svg.append(g);
  });
  const pts = timeline.map((s, i) => `${pad + i * bw + bw / 2},${H - pad - (s.p95Ms / maxL) * (H - pad * 2)}`).join(' ');
  svg.append(el('polyline', { points: pts, class: 'line-p95' }));
  svg.append(el('text', { x: pad, y: 14, class: 'chart-label' }, `${maxC} req/s`));
  svg.append(el('text', { x: W - pad, y: 14, class: 'chart-label', 'text-anchor': 'end' }, `p95 up to ${ms(maxL)}`));
  svg.append(el('text', { x: pad, y: H - 8, class: 'chart-label' }, '0s'));
  svg.append(el('text', { x: W - pad, y: H - 8, class: 'chart-label', 'text-anchor': 'end' }, `${timeline.length}s`));
  return svg;
}
