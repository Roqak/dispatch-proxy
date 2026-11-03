// Command palette (⌘K): jump to any request, folder, collection, environment,
// open tab or recent send, or run an action — all from the keyboard.

import { h, icon, methodClass, methodLabel, toast, errText } from './dom.js';
import { rank } from '../fuzzy.js';
import * as C from '../ctx.js';
import * as S from '../store.js';
import { state } from '../store.js';
import { isFolder, itemId, urlObject, clone } from '../model.js';

let open = null;

function collectItems() {
  const items = [];
  const t = C.activeTab();
  const cols = state.ws?.collections || [];

  // Open tabs first when nothing is typed.
  for (const tab of C.wsTabs()) {
    if (tab.id === state.activeTab) continue;
    const m = tab.draft?.request?.method;
    items.push({ kind: 'Tab', label: C.tabTitle(tab), method: tab.kind === 'request' ? m : null, icon: tab.kind === 'request' ? null : 'layers', fields: [[C.tabTitle(tab), 1]], boost: 40, run: () => C.focusTab(tab.id) });
  }

  for (const entry of cols) {
    items.push({ kind: 'Collection', label: entry.name, icon: 'box', fields: [[entry.name, 0.9]], run: () => { C.toggleExpanded(entry.uid, true); C.openContainer(entry); } });
    items.push({ kind: 'Action', label: `Run "${entry.name}"`, icon: 'play', fields: [[`Run ${entry.name}`, 0.7]], action: true, run: () => C.openRunner(entry, null) });
    items.push({ kind: 'Action', label: `Request chain of "${entry.name}"`, icon: 'link', fields: [[`Request chain ${entry.name}`, 0.7]], action: true, run: () => C.openChain(entry) });
    items.push({ kind: 'Action', label: `Mock server for "${entry.name}"`, icon: 'layers', fields: [[`Mock server ${entry.name}`, 0.7]], action: true, run: () => C.openMock(entry) });
    // Collections not opened yet aren't downloaded just to search them (Postman API calls are metered).
    if (!entry.data) continue;
    const walk = (list, path) => {
      for (const it of list || []) {
        if (isFolder(it)) {
          const p = [...path, it.name];
          items.push({ kind: 'Folder', label: it.name, detail: [entry.name, ...path].join(' / '), icon: 'folder', fields: [[it.name, 0.85], [p.join(' / '), 0.5]], run: () => { C.expandPath(entry, itemId(it)); C.openContainer(entry, itemId(it)); } });
          walk(it.item, p);
        } else {
          const raw = urlObject(it.request?.url).raw || '';
          const where = [entry.name, ...path].join(' / ');
          items.push({
            kind: 'Request', label: it.name, detail: where, method: it.request?.method || 'GET',
            fields: [[it.name, 1], [`${where} / ${it.name}`, 0.7], [`${it.request?.method || 'GET'} ${raw}`, 0.6]],
            run: () => { C.expandPath(entry, path.length ? findFolderId(entry, it) : null); C.openItem(entry, itemId(it)); },
          });
        }
      }
    };
    walk(entry.data.item, []);
  }

  for (const env of state.ws?.environments || []) {
    const active = S.activeEnvEntry() === env;
    items.push({ kind: 'Environment', label: active ? `${env.name} (active)` : `Use ${env.name}`, icon: 'globe', fields: [[env.name, 0.85], [`environment ${env.name}`, 0.6]], run: () => (active ? C.openEnv(env) : S.setActiveEnv(env.uid).then(() => toast(`Using "${env.name}"`))) });
  }

  for (const x of (state.history || []).slice(0, 40)) {
    const url = x.url || urlObject(x.request?.url).raw || '';
    items.push({ kind: 'History', label: x.name || url, detail: url, method: x.method, fields: [[`${x.method} ${url}`, 0.45], [x.name || '', 0.45]], boost: -10, run: () => C.openDraft({ id: crypto.randomUUID(), name: x.name || 'From history', request: clone(x.request) }) });
  }

  const action = (label, ic, run, key, when = true) => when && items.push({ kind: 'Action', label, icon: ic, key, action: true, fields: [[label, 0.95]], run });
  action('New request', 'plus', () => C.openDraft(), '⌘T');
  action('New gRPC request', 'layers', () => C.openGrpc());
  action('New collection', 'box', async () => (await import('./sidebar.js')).newCollection());
  action('New environment', 'globe', async () => (await import('./sidebar.js')).newEnvironment());
  action('Import…', 'download', async () => (await import('./sidebar.js')).doImport());
  action('Open collection from folder…', 'folderOpen', async () => { const e = await (await import('../folderlink.js')).openFolder(); if (e) toast(`Opened "${e.name}"`); });
  action('Cookies…', 'globe', async () => (await import('./cookies.js')).openCookieManager());
  action('Vault (secrets)', 'key', () => C.openVault());
  action('New request from a description (AI)…', 'send', async () => (await import('./assistview.js')).createRequestDialog());
  action('Write tests with AI', 'check', async () => (await import('./assistview.js')).writeTests(t), null, t?.kind === 'request' && !!t.response?.response);
  action('Explain this response (AI)', 'info', async () => (await import('./assistview.js')).explainResponse(t), null, t?.kind === 'request' && !!t.response);
  action('Settings', 'gear', async () => (await import('./panels.js')).openSettings(), '⌘,');
  action('Toggle response layout', 'columns', () => S.toggleLayout(), '⌥⌘V');
  action('Generate code snippet', 'code', async () => (await import('./request.js')).codeDialog(t), '⌥⌘C', t?.kind === 'request');
  action(S.activeProfile()?.kind === 'server' ? 'Sync with your Dispatch server' : 'Sync with Postman', 'sync', () => S.refreshAll().then(() => toast('Up to date'), (e) => toast(errText(e), { error: true })), null, state.hasKey);
  action('No environment', 'x', () => S.setActiveEnv(null), null, !!S.activeEnvEntry());
  for (const w of state.workspaces || []) {
    if (w.id === state.ws?.id) continue;
    action(`Switch to workspace: ${w.name}`, 'layers', () => { state.settings.wsChosen = true; return S.openWorkspace(w.id); });
  }
  return items;
}

function findFolderId(entry, item) {
  let found = null;
  const walk = (list, parent) => { for (const it of list || []) { if (it === item) { found = parent; return true; } if (isFolder(it) && walk(it.item, itemId(it))) return true; } return false; };
  walk(entry.data.item, null);
  return found;
}

export function openPalette(initial = '') {
  if (open) { open.input.focus(); open.input.select(); return; }
  const all = collectItems();
  const input = h('input', { class: 'palette-input', placeholder: 'Search requests, folders, environments, history…   (type > for actions)', spellcheck: 'false', autocomplete: 'off', value: initial });
  const list = h('div', { class: 'palette-list', role: 'listbox' });
  let shown = [];
  let active = 0;
  const close = () => { overlay.remove(); open = null; };
  const choose = async (it) => {
    close();
    try { await it.run(); } catch (e) { toast(errText(e), { error: true }); }
  };
  const highlight = () => {
    [...list.children].forEach((el, i) => el.classList.toggle('on', i === active));
    list.children[active]?.scrollIntoView({ block: 'nearest' });
  };
  const render = () => {
    let q = input.value;
    let pool = all;
    if (q.startsWith('>')) { pool = all.filter((x) => x.action); q = q.slice(1); }
    shown = q.trim() ? rank(q, pool, 60) : pool.filter((x) => x.kind === 'Tab' || x.action).slice(0, 14).concat(pool.filter((x) => x.kind === 'History').slice(0, 6));
    active = 0;
    list.replaceChildren(...(shown.length ? shown.map((it, i) => h('div', {
      class: 'palette-row', role: 'option',
      onmousemove: () => { if (active !== i) { active = i; highlight(); } },
      onmousedown: (e) => { e.preventDefault(); choose(it); },
    },
      it.method ? h('span', { class: ['method', methodClass(it.method)] }, methodLabel(it.method)) : icon(it.icon || 'send', 'ico'),
      h('span', { class: 'palette-label' }, it.label),
      it.detail ? h('span', { class: 'palette-detail' }, it.detail) : null,
      h('span', { class: 'grow' }),
      it.key ? h('kbd', null, it.key) : null,
      h('span', { class: 'palette-kind' }, it.kind))) : [h('div', { class: 'palette-empty' }, 'Nothing matches.')]));
    highlight();
  };
  input.addEventListener('input', render);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (shown.length) { active = (active + (e.key === 'ArrowDown' ? 1 : shown.length - 1)) % shown.length; highlight(); }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (shown[active]) choose(shown[active]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  });
  const overlay = h('div', { class: 'overlay palette-overlay', onmousedown: (e) => { if (e.target === overlay) close(); } },
    h('div', { class: 'palette', role: 'dialog', 'aria-label': 'Command palette' },
      h('div', { class: 'palette-search' }, icon('search'), input),
      list,
      h('div', { class: 'palette-foot' }, h('span', null, h('kbd', null, '↑'), h('kbd', null, '↓'), ' move'), h('span', null, h('kbd', null, '↵'), ' open'), h('span', null, h('kbd', null, 'esc'), ' close'), h('span', { class: 'grow' }), h('span', null, h('kbd', null, '>'), ' actions only'))));
  document.body.append(overlay);
  open = { input };
  render();
  input.focus();
}
