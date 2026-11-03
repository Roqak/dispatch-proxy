// Local mock servers from saved examples (the Rust side serves them).

import { bridge } from './bridge.js';
import * as S from './store.js';
import { emit } from './store.js';
import { urlObject } from './model.js';

const isFolder = (it) => Array.isArray(it?.item);

/** "{{baseUrl}}/pets/:id?x=1" or "https://api.test/pets/:id" → "/pets/:id". */
export function mockPath(raw) {
  let s = String(raw || '').trim().split('#')[0].split('?')[0];
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '');
  s = s.replace(/^(\{\{[^{}]+\}\})+/, '');
  if (!s.startsWith('/')) {
    const [first, ...rest] = s.split('/');
    // "api.example.com/pets" (no scheme): drop the host.
    s = /\.|:\d+$|^localhost$/i.test(first) ? `/${rest.join('/')}` : `/${s}`;
  }
  return s.replace(/\/{2,}/g, '/') || '/';
}

/** Every example in the collection, as a route the mock server can answer with. */
export function routesFor(collection, { delayMs = 0 } = {}) {
  const routes = [];
  const walk = (items) => {
    for (const it of items || []) {
      if (isFolder(it)) { walk(it.item); continue; }
      for (const ex of it.response || []) {
        const req = typeof ex.originalRequest === 'object' && ex.originalRequest ? ex.originalRequest : it.request || {};
        const url = urlObject(req.url ?? it.request?.url);
        routes.push({
          method: String(req.method || it.request?.method || 'GET').toUpperCase(),
          path: mockPath(url.raw),
          query: (url.query || []).filter((q) => q.key && !q.disabled && !String(q.value ?? '').includes('{{')).map((q) => [q.key, String(q.value ?? '')]),
          name: ex.name || `${ex.code || 200}`,
          code: Number(ex.code) || 200,
          headers: (ex.header || []).filter((x) => x.key && !x.disabled).map((x) => [x.key, String(x.value ?? '')]),
          body: typeof ex.body === 'string' ? ex.body : ex.body == null ? '' : JSON.stringify(ex.body, null, 2),
          delayMs,
          request: it.name,
        });
      }
    }
  };
  walk(collection?.item);
  return routes;
}

// ---------- running servers ----------

const running = new Map(); // entry → { id, port, log, delayMs, routes }
export const mockFor = (entry) => running.get(entry) || null;

export async function startMock(entry, { port = 0, delayMs = 0 } = {}) {
  await S.ensureCollection(entry);
  const prev = running.get(entry);
  const id = prev?.id || `mock-${Math.random().toString(36).slice(2, 10)}`;
  const routes = routesFor(entry.data, { delayMs });
  const state = { id, port: 0, log: prev?.log || [], delayMs, routes };
  const onLog = (e) => {
    state.log.unshift({ ...e, at: Date.now() });
    if (state.log.length > 300) state.log.length = 300;
    emit('mock');
  };
  state.port = await bridge.mockStart(id, Number(port) || 0, routes, onLog);
  running.set(entry, state);
  emit('mock');
  return state;
}

export async function stopMock(entry) {
  const m = running.get(entry);
  if (!m) return;
  running.delete(entry);
  await bridge.mockStop(m.id).catch(() => {});
  emit('mock');
}

// Serve new or edited examples straight away.
const pending = new WeakMap();
S.collectionHooks.add((entry) => {
  const m = running.get(entry);
  if (!m) return;
  clearTimeout(pending.get(entry));
  pending.set(entry, setTimeout(() => {
    m.routes = routesFor(entry.data, { delayMs: m.delayMs });
    bridge.mockUpdate(m.id, m.routes).catch(() => {});
    emit('mock');
  }, 300));
});
