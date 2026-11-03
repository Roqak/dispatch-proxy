// gRPC request tab: discover services (reflection or .proto files), write the
// message as JSON, invoke, and see each streamed reply.

import { h, icon, toast, errText } from './dom.js';
import { kvSection, codeArea, highlightJson, subtabs } from './components.js';
import * as C from '../ctx.js';
import { emit } from '../store.js';
import { bridge } from '../bridge.js';
import { beautifyJson } from './request.js';

const sessions = new Map(); // tab id → { services, running, result, live }

const sourceOf = (d) => ({ target: d.target || '', protos: d.protos || [], includes: [], metadata: (d.metadata || []).filter((m) => m.key && !m.disabled).map((m) => [m.key, C.resolverFor({ ref: null }).replace(m.value || '')]) });

export function renderGrpcTab(root, t) {
  const d = t.draft;
  d.metadata = d.metadata || [];
  const s = sessions.get(t.id) || {};
  sessions.set(t.id, s);
  const dirty = () => C.markDirty(t);
  const method = s.services?.flatMap((x) => x.methods).find((m) => m.path === d.method);

  const load = async () => {
    s.loading = true; emit('main');
    try {
      s.services = await bridge.grpcDescribe(sourceOf(d));
      if (!s.services.length) toast('The server has no services to show (besides reflection).');
      else if (!s.services.some((x) => x.methods.some((m) => m.path === d.method))) { d.method = s.services[0].methods[0]?.path || ''; dirty(); }
    } catch (e) { toast(errText(e), { error: true }); }
    s.loading = false; emit('main');
  };
  const invoke = async () => {
    if (!d.method) return toast('Load the services and pick a method first.', { error: true });
    s.running = true; s.result = null; s.live = [];
    emit('main');
    try {
      s.result = await bridge.grpcCall(sourceOf(d), d.method, d.message || '{}', (m) => { s.live.push(m); if (C.activeTab()?.id === t.id) emit('main'); });
    } catch (e) { s.result = { error: errText(e) }; }
    s.running = false;
    emit('main');
  };

  const target = h('input', { class: 'input mono grpc-target', value: d.target || '', placeholder: 'localhost:50051  (grpcs://host for TLS)', spellcheck: 'false', oninput: (e) => { d.target = e.target.value; dirty(); }, onkeydown: (e) => { if (e.key === 'Enter') load(); } });
  const methodSel = h('select', { class: 'select grpc-method', disabled: !s.services?.length, onchange: (e) => { d.method = e.target.value; dirty(); emit('main'); } },
    s.services?.length
      ? s.services.map((svc) => h('optgroup', { label: svc.name }, svc.methods.map((m) => h('option', { value: m.path, selected: m.path === d.method }, `${m.name}${m.serverStreaming ? ' (stream)' : ''}${m.clientStreaming ? ' (client stream)' : ''}`))))
      : h('option', null, d.method || 'Load services to pick a method'));
  const line = h('div', { class: 'reqline' },
    h('div', { class: 'reqline-box' }, h('span', { class: 'grpc-badge' }, 'gRPC'), target, methodSel),
    h('button', { class: 'btn primary send-btn', disabled: !!s.running, onclick: invoke }, s.running ? 'Invoking…' : 'Invoke'));
  const sourceRow = h('div', { class: 'row grpc-source' },
    h('button', { class: 'btn sm', disabled: !!s.loading, onclick: () => { d.protos = []; dirty(); load(); } }, icon('sync'), s.loading ? 'Loading…' : 'Use server reflection'),
    h('button', { class: 'btn ghost sm', onclick: async () => { const p = await bridge.pickProtoFiles(); if (p?.length) { d.protos = p; dirty(); load(); } } }, icon('file'), 'Use .proto files…'),
    h('span', { class: 'faint ellipsis', style: { fontSize: '12px' } }, d.protos?.length ? d.protos.map((p) => p.split(/[\\/]/).pop()).join(', ') : 'Services come from the server\'s reflection API'),
    method ? h('span', { class: 'faint mono', style: { marginLeft: 'auto', fontSize: '11.5px' } }, `${method.input} → ${method.output}`) : null);

  t.sub = ['message', 'metadata'].includes(t.sub) ? t.sub : 'message';
  const pane = h('div', { class: 'pane' });
  const renderPane = () => {
    if (t.sub === 'metadata') { pane.replaceChildren(kvSection({ title: 'Metadata', rows: d.metadata, kind: 'headers', resolver: () => C.resolverFor({ ref: null }), onChange: dirty })); return; }
    const ta = codeArea({ value: d.message || '', lang: 'json', minHeight: 180, placeholder: '{\n  "id": "123"\n}', oninput: (v) => { d.message = v; dirty(); } });
    pane.replaceChildren(
      h('div', { class: 'row', style: { marginBottom: '8px' } }, h('span', { class: 'faint', style: { fontSize: '12px' } }, 'Message (JSON)'), h('span', { class: 'grow' }),
        method ? h('button', { class: 'btn ghost sm', onclick: () => { ta.value = method.template; d.message = method.template; dirty(); } }, 'Use template') : null,
        h('button', { class: 'btn ghost sm', onclick: () => { try { const o = beautifyJson(ta.value); ta.value = o; d.message = o; dirty(); } catch (e) { toast(`That isn't valid JSON yet: ${e.message}`, { error: true }); } } }, 'Beautify')),
      h('div', { class: 'code-wrap' }, ta.el));
  };
  const tabs = h('div');
  const renderTabs = () => tabs.replaceChildren(subtabs([{ id: 'message', label: 'Message' }, { id: 'metadata', label: 'Metadata', count: d.metadata.filter((m) => m.key).length || '' }], t.sub, (id) => { t.sub = id; renderTabs(); renderPane(); }));
  renderTabs();
  renderPane();

  const editor = h('section', { id: 'editor' },
    h('div', { class: 'crumbs' }, h('input', { class: 'name-input', value: d.name, spellcheck: 'false', oninput: (e) => { d.name = e.target.value; dirty(); C.emitTabs(); } }), h('span', { class: 'grow' }), h('span', { class: 'faint', style: { fontSize: '11.5px' } }, 'Saved with your open tabs · not synced to Postman')),
    line, sourceRow, tabs, pane);

  const r = s.result;
  const msgs = s.running ? s.live : r?.messages || [];
  const resp = h('section', { id: 'response' },
    h('div', { class: 'resp-head' }, h('div', { class: 'subtabs' }, h('button', { class: 'subtab active' }, 'Response', msgs.length ? h('span', { class: 'count' }, ` ${msgs.length}`) : null)),
      r && !r.error ? h('div', { class: 'resp-meta' }, h('span', { class: ['status-pill', r.code === 0 ? 's2' : 's5'] }, `${r.code} ${r.codeName}`), h('span', null, h('b', null, `${r.timeMs} ms`))) : s.running ? h('div', { class: 'resp-meta' }, h('span', { class: 'chip ok live-chip' }, 'waiting for replies')) : null),
    h('div', { class: 'resp-body' },
      s.running ? h('div', { class: 'loading-bar' }) : null,
      r?.error ? h('div', { class: 'resp-error' }, h('h3', null, 'Could not invoke'), h('p', null, r.error)) : null,
      r && !r.error && r.code !== 0 ? h('div', { class: 'note err', style: { margin: '10px 14px' } }, icon('alert'), h('span', null, `${r.codeName}: ${r.message || 'no details'}`)) : null,
      ...msgs.map((m, i) => { const pre = h('pre', { class: 'body grpc-msg' }); pre.innerHTML = highlightJson(m); return h('div', null, msgs.length > 1 ? h('div', { class: 'faint grpc-n' }, `Message ${i + 1}`) : null, pre); }),
      !r && !s.running ? h('div', { class: 'resp-empty' }, h('div', null, 'Load the services, pick a method and press Invoke.')) : null,
      r && !r.error && (r.headers?.length || r.trailers?.length) ? h('details', { class: 'grpc-meta' }, h('summary', null, 'Headers and trailers'), h('table', { class: 'hdr-table' }, [...(r.headers || []), ...(r.trailers || [])].map(([k, v]) => h('tr', null, h('td', null, k), h('td', null, v))))) : null));

  root.replaceChildren(editor, resp);
}
