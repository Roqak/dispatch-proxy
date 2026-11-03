// Mock server tab: start/stop a local server for a collection's examples.

import { h, icon, toast, errText, methodClass, methodLabel } from './dom.js';
import * as S from '../store.js';
import { state } from '../store.js';
import { startMock, stopMock, mockFor, routesFor } from '../mockserver.js';

export function renderMockTab(root, t) {
  const entry = S.collectionEntry(t.ref.col);
  if (!entry) { root.replaceChildren(h('div', { class: 'pane' }, 'This collection is no longer in the workspace.')); return; }
  const m = mockFor(entry);
  const prefs = (state.settings.mockPrefs = state.settings.mockPrefs || {});
  const pref = (prefs[entry.uid] = prefs[entry.uid] || { port: 4010, delayMs: 0 });
  const url = m ? `http://localhost:${m.port}` : null;
  const routes = m?.routes || (entry.data ? routesFor(entry.data) : []);

  const portIn = h('input', { class: 'input mono', type: 'number', min: 0, max: 65535, value: pref.port, disabled: !!m, style: { width: '90px' }, oninput: (e) => { pref.port = Number(e.target.value) || 0; S.saveSettings(); } });
  const delayIn = h('input', { class: 'input mono', type: 'number', min: 0, max: 60000, value: pref.delayMs, disabled: !!m, style: { width: '90px' }, oninput: (e) => { pref.delayMs = Math.max(0, Number(e.target.value) || 0); S.saveSettings(); } });
  const toggle = h('button', { class: ['btn', !m && 'primary'], onclick: async () => {
    try {
      if (m) await stopMock(entry);
      else { const s = await startMock(entry, pref); toast(`Mock server running at http://localhost:${s.port}`); }
    } catch (e) { toast(errText(e), { error: true }); }
  } }, icon(m ? 'stop' : 'play'), m ? 'Stop' : 'Start');

  const useEnv = async () => {
    const name = `Mock: ${entry.name}`;
    let env = state.ws.environments.find((e) => e.name === name);
    const values = [{ key: 'baseUrl', value: url, type: 'default', enabled: true }];
    try {
      if (!env) env = await S.createEnvironment(name);
      await S.ensureEnvironment(env).catch(() => {});
      const rows = env.data?.values || [];
      const row = rows.find((r) => r.key === 'baseUrl');
      if (row) row.value = url; else rows.push(...values);
      env.data = { ...(env.data || { name }), name, values: rows };
      await S.environmentChanged(env);
      await S.setActiveEnv(env.uid);
      toast(`"${name}" is active: {{baseUrl}} → ${url}`);
    } catch (e) { toast(errText(e), { error: true }); }
  };

  const head = h('div', { class: 'mock-controls' },
    h('div', { class: 'row' },
      h('span', { class: ['mock-dot', m && 'on'] }),
      h('b', null, m ? 'Running' : 'Stopped'),
      url ? h('span', { class: 'mono mock-url' }, url) : null,
      url ? h('button', { class: 'icon-btn sm', title: 'Copy URL', onclick: async () => { await navigator.clipboard.writeText(url); toast('Copied'); } }, icon('copy')) : null,
      h('span', { class: 'grow' }),
      url ? h('button', { class: 'btn sm', title: 'Point {{baseUrl}} at the mock with an environment', onclick: useEnv }, icon('globe'), 'Use in an environment') : null,
      toggle),
    h('div', { class: 'row', style: { marginTop: '10px', gap: '16px' } },
      h('label', { class: 'row', style: { gap: '6px' } }, h('span', { class: 'faint' }, 'Port'), portIn, h('span', { class: 'hint', style: { margin: 0 } }, '0 = any free port')),
      h('label', { class: 'row', style: { gap: '6px' } }, h('span', { class: 'faint' }, 'Delay'), delayIn, h('span', { class: 'faint' }, 'ms'))));

  const table = routes.length
    ? h('table', { class: 'kv mock-routes' },
      h('thead', null, h('tr', null, h('th', null, 'Method'), h('th', null, 'Path'), h('th', null, 'Example'), h('th', null, 'Status'))),
      h('tbody', null, routes.map((r) => h('tr', null,
        h('td', null, h('span', { class: ['method', methodClass(r.method)] }, methodLabel(r.method))),
        h('td', { class: 'mono' }, r.path, r.query.length ? h('span', { class: 'faint' }, `?${r.query.map(([k, v]) => `${k}=${v}`).join('&')}`) : null),
        h('td', null, r.name, h('span', { class: 'faint' }, ` · ${r.request}`)),
        h('td', null, h('span', { class: ['status-pill', `s${String(r.code)[0]}`] }, r.code))))))
    : h('div', { class: 'md-empty' }, 'No examples to serve yet. Send a request and choose ⋯ → Save as example, or add one from a request\'s menu in the sidebar.');

  const log = m?.log || [];
  const logView = h('div', { class: 'mock-log' }, log.length
    ? log.map((e) => h('div', { class: 'mock-log-row' },
      h('span', { class: 'faint mono' }, new Date(e.at).toLocaleTimeString()),
      h('span', { class: ['method', methodClass(e.method)] }, methodLabel(e.method)),
      h('span', { class: 'mono ellipsis' }, e.path),
      h('span', { class: ['status-pill', `s${String(e.status)[0]}`] }, e.status),
      h('span', { class: 'faint ellipsis' }, e.example || 'no matching example'),
      h('span', { class: 'faint mono' }, `${e.ms} ms`)))
    : h('div', { class: 'md-empty' }, m ? `Waiting for requests to ${url}…` : 'Requests to the mock show up here.'));

  root.replaceChildren(
    h('div', { class: 'crumbs' }, icon('layers'), h('b', null, `Mock server · ${entry.name}`)),
    h('div', { class: 'pane' },
      head,
      h('div', { class: 'pane-title', style: { marginTop: '18px' } }, `Routes · ${routes.length}`), table,
      h('p', { class: 'hint' }, 'Matches the method and path (":id" and "{{var}}" segments match anything); query parameters break ties. Send ', h('span', { class: 'mono' }, 'x-mock-response-name'), ' or ', h('span', { class: 'mono' }, 'x-mock-response-code'), ' to pick an example, like Postman. Only this computer can reach it; CORS is open for front ends. Edits to examples are served straight away.'),
      h('div', { class: 'pane-title', style: { marginTop: '18px' } }, 'Requests'), logView));
}
