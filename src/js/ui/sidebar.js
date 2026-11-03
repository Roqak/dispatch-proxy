import { h, icon, showMenu, pickerMenu, closeMenu, modal, promptDialog, toast, errText, methodClass, methodLabel, relTime, confirmDialog } from './dom.js';
import * as S from '../store.js';
import { bridge } from '../bridge.js';
import { state } from '../store.js';
import * as C from '../ctx.js';
import { mockFor } from '../mockserver.js';
import { linkToFolder, unlinkFolder, openFolder, checkFolders } from '../folderlink.js';
import { isFolder, itemId, exampleId, newExample, urlObject, clone } from '../model.js';

let sideTab = 'collections';
let filter = '';
// The sidebar is rebuilt on every state change; remember each tab's scroll so selecting an item doesn't jump to the top.
const scrollPos = {};

export function renderSidebar(root) {
  const current = state.workspaces.find((w) => w.id === state.ws?.id);
  const wsSelect = h('button', {
    class: 'select ws-select', title: 'Workspace',
    // Keep the open picker from closing on mousedown so a second click toggles it shut.
    onmousedown: (e) => e.stopPropagation(),
    onclick: () => {
      if (wsSelect.classList.contains('menu-open')) return closeMenu();
      pickerMenu(wsSelect, {
        placeholder: 'Search workspaces',
        current: state.ws?.id,
        items: state.workspaces.map((w) => ({ id: w.id, label: w.name, hint: w.type && w.type !== 'local' ? w.type[0].toUpperCase() + w.type.slice(1) : '' })),
        onPick: async (w) => {
          state.settings.wsChosen = true;
          await S.openWorkspace(w.id).catch((err) => toast(errText(err), { error: true }));
        },
      });
    },
  }, h('span', { class: 'ellipsis' }, current?.name || 'Workspace'));

  const syncBtn = h('button', {
    class: 'icon-btn', title: state.hasKey ? (S.activeProfile()?.kind === 'server' ? 'Sync with your Dispatch server' : 'Sync with Postman') : 'Connect Postman to sync',
    disabled: !S.isCloud() && state.hasKey,
    onclick: async () => {
      if (!state.hasKey) return (await import('./panels.js')).openSettings();
      try { await S.refreshAll(); toast(S.activeProfile()?.kind === 'server' ? 'Up to date with your Dispatch server' : 'Up to date with Postman'); } catch (e) { toast(errText(e), { error: true }); }
    },
  }, icon('sync', state.syncing ? 'spin' : ''));

  const tabs = h('div', { class: 'side-tabs' },
    [['collections', 'Collections'], ['environments', 'Environments'], ['history', 'History']].map(([id, label]) =>
      h('button', { class: ['side-tab', sideTab === id && 'active'], onclick: () => { sideTab = id; renderSidebar(root); } }, label)));

  const search = h('input', { class: 'input', placeholder: sideTab === 'history' ? 'Filter history' : 'Filter', value: filter, oninput: (e) => { filter = e.target.value; renderList(); } });
  const tools = h('div', { class: 'side-tools' },
    h('button', { class: 'icon-btn', title: 'New', onclick: (e) => newMenu(e) }, icon('plus')),
    search,
    sideTab === 'history'
      ? h('button', { class: 'icon-btn', title: 'Clear history', onclick: async () => { if (await confirmDialog({ title: 'Clear history?', message: 'This removes every request from your local history.', confirm: 'Clear', danger: true })) S.clearHistory(); } }, icon('trash'))
      : h('button', { class: 'icon-btn', title: 'Import (Postman, OpenAPI, Insomnia, HAR)', onclick: doImport }, icon('download')));

  const prevList = root.querySelector('.side-content');
  if (prevList && root.sideTab) scrollPos[root.sideTab] = prevList.scrollTop;
  const list = h('div', { class: 'side-content' });
  const foot = footer();

  root.replaceChildren(h('div', { class: 'titlebar-space drag' }), h('div', { class: 'ws-bar' }, wsSelect, syncBtn), tabs, tools, list, foot);

  function renderList() {
    if (sideTab === 'collections') list.replaceChildren(...collectionsView());
    else if (sideTab === 'environments') list.replaceChildren(...environmentsView());
    else list.replaceChildren(...historyView());
  }
  renderList();
  list.scrollTop = scrollPos[sideTab] || 0;
  root.sideTab = sideTab;
  root.renderList = renderList;
}

function footer() {
  const expired = state.sessionExpired && S.activeProfile()?.kind === 'server';
  const dotClass = expired ? 'err' : !state.hasKey ? 'off' : state.syncError ? 'err' : state.syncing ? 'busy' : '';
  const label = expired ? 'Server session expired' : !state.hasKey ? 'Local — nothing syncs' : state.syncError ? 'Sync problem' : state.syncing ? 'Syncing…' : S.isCloud() ? `Synced ${state.lastSync ? relTime(state.lastSync) : ''}`.trim() : 'Connected · local workspace';
  return h('div', { class: 'side-foot' },
    profileChip(),
    h('span', { class: ['sync-dot', dotClass] }),
    h('span', { class: 'grow ellipsis muted', title: state.syncError || '' }, label),
    expired && h('button', { class: 'btn sm', onclick: async () => (await import('./panels.js')).serverSignInDialog() }, 'Sign in again'),
    h('button', { class: 'icon-btn', title: 'Settings (⌘,)', onclick: async () => (await import('./panels.js')).openSettings() }, icon('gear')));
}

function profileChip() {
  const p = S.activeProfile();
  return h('button', {
    class: 'side-profile', title: 'Switch profile',
    onclick: (e) => showMenu(e, [
      ...state.profiles.map((pr) => ({
        label: `${pr.id === p.id ? '● ' : ''}${pr.name}${pr.kind === 'postman' ? (pr.region === 'eu' ? ' · EU' : ' · Postman') : pr.kind === 'server' ? ' · server' : ' · this device'}`,
        onClick: () => { if (pr.id !== p.id) S.switchProfile(pr.id).catch((er) => toast(errText(er), { error: true })); },
      })),
      '-',
      { label: 'Add profile…', icon: 'plus', onClick: async () => (await import('./panels.js')).addProfileDialog() },
      { label: 'Manage profiles…', icon: 'gear', onClick: async () => (await import('./panels.js')).openSettings() },
    ]),
  },
    h('div', { class: 'avatar' }, (state.account?.fullName || state.account?.username || p.name).slice(0, 1).toUpperCase()),
    h('span', { class: 'grow ellipsis' }, p.name));
}

const importedMsg = (r) => `Imported ${r.format && r.format !== 'Postman' ? `${r.format} as ` : ''}${r.kind} "${r.name}"${r.environments ? ` with ${r.environments} environment${r.environments === 1 ? '' : 's'}` : ''}${S.isCloud() ? ' and uploaded it to Postman' : ''}`;

/** Import from a file, pasted text, or a URL to a spec. */
export function doImport() {
  const ta = h('textarea', { class: 'textarea mono', rows: 9, spellcheck: 'false', placeholder: 'Paste a Postman collection or environment, an OpenAPI/Swagger spec (JSON or YAML), an Insomnia export or a HAR file, or a link to one.' });
  const status = h('p', { class: 'hint', style: { minHeight: '18px', margin: '8px 0 0' } }, 'Supports Postman v2.0/v2.1, OpenAPI 3, Swagger 2, Insomnia v4/v5 and HAR.');
  const done = (r) => { if (r) toast(importedMsg(r)); close(); };
  const fail = (e) => { status.textContent = errText(e); status.style.color = 'var(--err)'; };
  const fromText = async () => {
    const text = ta.value.trim();
    if (!text) return fail(new Error('Paste something to import, or choose a file.'));
    try {
      if (/^https?:\/\/\S+$/i.test(text)) {
        status.textContent = 'Downloading…';
        status.style.color = '';
        const res = await bridge.send({ method: 'GET', url: text, headers: [{ key: 'Accept', value: 'application/json, application/yaml, text/yaml, */*' }], body: { mode: 'none' }, settings: { timeoutMs: 30000, followRedirects: true, verifySsl: state.settings.verifySsl !== false } });
        if (res.status >= 400) throw new Error(`The link returned ${res.status} ${res.statusText || ''}`.trim());
        done(await S.importText(res.bodyText || '', text.split('?')[0]));
      } else {
        done(await S.importText(text));
      }
    } catch (e) { fail(e); }
    return false;
  };
  const close = modal({
    title: 'Import',
    wide: true,
    body: h('div', null, ta, status),
    actions: [
      { label: 'Choose file…', onClick: async () => { try { const r = await S.importFromFile(); if (r) done(r); } catch (e) { fail(e); } return false; } },
      { label: 'Import', primary: true, onClick: fromText },
    ],
  });
}

function newMenu(e) {
  showMenu(e, [
    { label: 'New request', icon: 'send', key: '⌘T', onClick: () => C.openDraft() },
    { label: 'New gRPC request', icon: 'layers', onClick: () => C.openGrpc() },
    { label: 'New collection', icon: 'box', onClick: newCollection },
    { label: 'New environment', icon: 'globe', onClick: newEnvironment },
    '-',
    { label: 'Import…', icon: 'download', onClick: doImport },
    { label: 'Open collection from folder…', icon: 'folderOpen', onClick: () => openFolder().then((e) => e && toast(`Opened "${e.name}" from ${e.linkedDir}`), (er) => toast(errText(er), { error: true })) },
  ]);
}

export async function newCollection() {
  const name = await promptDialog({ title: 'New collection', label: S.isCloud() ? `It will be created in "${state.ws.name}" in Postman.` : 'It will be stored on this device only.', value: 'New Collection' });
  if (!name) return;
  try { const entry = await S.createCollection(name); C.toggleExpanded(entry.uid, true); sideTab = 'collections'; } catch (e) { toast(errText(e), { error: true }); }
}

export async function newEnvironment() {
  const name = await promptDialog({ title: 'New environment', value: 'New Environment' });
  if (!name) return;
  try { const env = await S.createEnvironment(name); sideTab = 'environments'; C.openEnv(env); } catch (e) { toast(errText(e), { error: true }); }
}

// ---------- collections ----------

const matches = (it) => !filter || it.name?.toLowerCase().includes(filter.toLowerCase()) || (isFolder(it) && it.item.some(matches));

function collectionsView() {
  const cols = state.ws?.collections || [];
  if (!cols.length) {
    return [h('div', { class: 'side-empty' },
      h('div', { style: { fontWeight: 600, color: 'var(--text)' } }, 'No collections yet'),
      h('p', null, S.isCloud() ? (state.syncing ? 'Loading from Postman…' : 'Create one, or import a Postman export.') : 'Collections here stay on this device.'),
      h('div', { class: 'row', style: { justifyContent: 'center' } }, h('button', { class: 'btn sm', onclick: newCollection }, 'New collection'), h('button', { class: 'btn sm', onclick: doImport }, 'Import')))];
  }
  const open = C.expanded();
  const active = C.activeTab();
  const out = [];
  for (const entry of cols) {
    const isOpen = open.includes(entry.uid) || !!filter;
    if (filter && entry.data && !entry.data.item.some(matches) && !entry.name.toLowerCase().includes(filter.toLowerCase())) continue;
    out.push(collectionRow(entry, isOpen, active));
    if (isOpen) {
      if (!entry.data) out.push(h('div', { class: 'tree-row faint', style: { '--depth': 1 } }, h('span', { class: 'chev blank' }), 'Loading…'));
      else if (!entry.data.item.length) out.push(h('div', { class: 'tree-row faint', style: { '--depth': 1.6, fontSize: '12px' } }, 'Empty. ', h('a', { style: { color: 'var(--accent)', marginLeft: '4px' }, onclick: () => C.addRequest(entry) }, 'Add a request')));
      else out.push(...itemsRows(entry, entry.data.item, 1, open, active));
    }
  }
  return out;
}

function collectionRow(entry, isOpen, active) {
  const status = entry.pushing ? h('span', { class: 'badge local' }, 'syncing')
    : entry.conflict ? h('span', { class: 'badge err', title: 'Changed in Postman and here' }, 'conflict')
    : entry.deletedRemotely ? h('span', { class: 'badge err', title: 'Deleted in Postman' }, 'deleted')
    : entry.dirty && S.isCloud() ? h('span', { class: 'badge dirty', title: 'Local changes not yet in Postman' }, 'unsynced') : null;
  const extra = [
    entry.folderError ? h('span', { class: 'badge err', title: entry.folderError }, 'folder') : entry.linkedDir ? h('span', { class: 'badge local', title: `Saved to ${entry.linkedDir}` }, 'git') : null,
    mockFor(entry) ? h('span', { class: 'badge ok', title: `Mock server on http://localhost:${mockFor(entry).port}` }, `mock :${mockFor(entry).port}`) : null,
  ];
  const row = h('div', {
    class: ['tree-row col', active?.kind === 'container' && active.ref.col === entry.uid && !active.ref.item && 'selected'],
    style: { '--depth': 0 },
    onclick: async () => {
      C.toggleExpanded(entry.uid);
      if (!entry.data) S.ensureCollection(entry).catch((e) => toast(errText(e), { error: true }));
    },
    oncontextmenu: (e) => { e.preventDefault(); colMenu(e, entry, row); },
  },
    icon('chevron', `chev${isOpen ? ' open' : ''}`),
    icon('box', 'ico'),
    h('span', { class: 'name', title: entry.name }, entry.name),
    status, ...extra,
    h('span', { class: 'actions' }, h('button', { class: 'icon-btn sm', title: 'More', onclick: (e) => { e.stopPropagation(); colMenu(e, entry, row); } }, icon('more'))));
  dropTarget(row, entry, null);
  return row;
}

function colMenu(e, entry, row) {
  showMenu(e, [
    { label: 'Add request', icon: 'plus', onClick: () => C.addRequest(entry) },
    { label: 'Add folder', icon: 'folder', onClick: async () => { const n = await promptDialog({ title: 'New folder', value: 'New Folder' }); if (n) C.addFolder(entry, null, n); } },
    { label: 'Settings, auth & variables', icon: 'gear', onClick: () => C.openContainer(entry) },
    { label: 'Run collection', icon: 'play', onClick: () => C.openRunner(entry, null) },
    { label: 'Request chain', icon: 'link', onClick: () => C.openChain(entry) },
    { label: mockFor(entry) ? `Mock server (running on :${mockFor(entry).port})` : 'Mock server…', icon: 'layers', onClick: () => C.openMock(entry) },
    '-',
    entry.linkedDir
      ? { label: 'Reload from folder', icon: 'sync', onClick: () => checkFolders().then(() => toast('Folder checked')) }
      : { label: 'Save to a folder (Git)…', icon: 'folder', onClick: () => linkToFolder(entry).catch((er) => toast(errText(er), { error: true })) },
    entry.linkedDir ? { label: 'Stop saving to folder', icon: 'x', onClick: () => { unlinkFolder(entry); toast('The files stay where they are; changes are no longer written there.'); } } : null,
    '-',
    { label: 'Rename', icon: 'edit', onClick: async () => { await S.ensureCollection(entry); const n = await promptDialog({ title: 'Rename collection', value: entry.name, confirm: 'Rename' }); if (n) C.renameItem(entry, null, n); } },
    { label: 'Export…', icon: 'upload', onClick: async () => { try { const p = await S.exportCollection(entry); if (p) toast(`Exported to ${p}`); } catch (er) { toast(errText(er), { error: true }); } } },
    S.isCloud() ? '-' : null,
    S.isCloud() && entry.dirty ? { label: 'Push to Postman now', icon: 'cloudUp', onClick: () => C.pushNow(entry) } : null,
    S.isCloud() && !entry.pendingCreate ? { label: 'Reload from Postman', icon: 'sync', onClick: async () => {
      if (entry.dirty && !(await confirmDialog({ title: 'Discard local changes?', message: `"${entry.name}" has changes that aren't in Postman yet. Reloading replaces them with Postman's version.`, confirm: 'Reload', danger: true }))) return;
      try { await S.pullCollection(entry, { discard: true }); C.refreshCleanTabs(); toast('Reloaded from Postman'); } catch (er) { toast(errText(er), { error: true }); }
    } } : null,
    !S.isCloud() || entry.deletedRemotely ? '-' : null,
    !S.isCloud() || entry.deletedRemotely ? { label: 'Remove from Dispatch', icon: 'trash', danger: true, onClick: async () => {
      if (await confirmDialog({ title: `Remove "${entry.name}"?`, message: 'It will be deleted from this device. Export it first if you want a copy.', confirm: 'Remove', danger: true })) S.removeLocalCollection(entry);
    } } : null,
  ].filter((x, i, a) => x !== null && !(x === '-' && (a[i - 1] === '-' || i === a.length - 1))), row);
}

function itemsRows(entry, items, depth, open, active) {
  const rows = [];
  for (const it of items) {
    if (!matches(it)) continue;
    const id = itemId(it);
    if (isFolder(it)) {
      const isOpen = open.includes(id) || !!filter;
      const row = h('div', {
        class: ['tree-row', active?.kind === 'container' && active.ref.item === id && 'selected'],
        style: { '--depth': depth }, draggable: 'true',
        onclick: () => C.toggleExpanded(id),
        oncontextmenu: (e) => { e.preventDefault(); folderMenu(e, entry, it, row); },
      },
        icon('chevron', `chev${isOpen ? ' open' : ''}`),
        icon(isOpen ? 'folderOpen' : 'folder', 'ico'),
        h('span', { class: 'name', title: it.name }, it.name),
        h('span', { class: 'actions' }, h('button', { class: 'icon-btn sm', onclick: (e) => { e.stopPropagation(); folderMenu(e, entry, it, row); } }, icon('more'))));
      dragSource(row, entry, id);
      dropTarget(row, entry, id, true);
      rows.push(row);
      if (isOpen) rows.push(...itemsRows(entry, it.item, depth + 1, open, active));
    } else {
      const m = it.request?.method || 'GET';
      const tab = C.findTab((t) => t.kind === 'request' && t.ref?.col === entry.uid && t.ref.item === id);
      const examples = it.response || [];
      const exOpen = examples.length > 0 && open.includes(`ex:${id}`);
      const chev = examples.length ? icon('chevron', `chev${exOpen ? ' open' : ''}`) : h('span', { class: 'chev blank', style: { width: '0' } });
      if (examples.length) chev.addEventListener('click', (e) => { e.stopPropagation(); C.toggleExpanded(`ex:${id}`); });
      const row = h('div', {
        class: ['tree-row', active && active === tab && 'selected'],
        style: { '--depth': depth }, draggable: 'true',
        onclick: () => C.openItem(entry, id),
        oncontextmenu: (e) => { e.preventDefault(); reqMenu(e, entry, it, row); },
      },
        chev,
        h('span', { class: ['method', methodClass(m)] }, methodLabel(m)),
        h('span', { class: 'name', title: it.name }, it.name),
        tab?.dirty ? h('span', { class: 'sync-dot busy', title: 'Unsaved changes' }) : null,
        h('span', { class: 'actions' }, h('button', { class: 'icon-btn sm', onclick: (e) => { e.stopPropagation(); reqMenu(e, entry, it, row); } }, icon('more'))));
      dragSource(row, entry, id);
      dropTarget(row, entry, id, false);
      rows.push(row);
      if (exOpen) rows.push(...examples.map((ex) => exampleRow(entry, it, ex, depth + 1, active)));
    }
  }
  return rows;
}

function exampleRow(entry, it, ex, depth, active) {
  const exId = exampleId(ex);
  const row = h('div', {
    class: ['tree-row', active?.kind === 'example' && active.ref.col === entry.uid && active.ref.ex === exId && 'selected'],
    style: { '--depth': depth },
    onclick: () => C.openExample(entry, itemId(it), exId),
    oncontextmenu: (e) => { e.preventDefault(); exampleMenu(e, entry, it, ex, row); },
  },
    icon('file', 'ico'),
    h('span', { class: 'name', title: ex.name }, ex.name || 'Untitled example'),
    ex.code ? h('span', { class: ['status-pill', `s${String(ex.code)[0]}`], style: { fontSize: '11px' } }, ex.code) : null,
    h('span', { class: 'actions' }, h('button', { class: 'icon-btn sm', onclick: (e) => { e.stopPropagation(); exampleMenu(e, entry, it, ex, row); } }, icon('more'))));
  return row;
}

function exampleMenu(e, entry, it, ex, row) {
  const id = itemId(it);
  const exId = exampleId(ex);
  showMenu(e, [
    { label: 'Open', icon: 'file', onClick: () => C.openExample(entry, id, exId) },
    { label: 'Rename', icon: 'edit', onClick: async () => { const n = await promptDialog({ title: 'Rename example', value: ex.name, confirm: 'Rename' }); if (n) C.renameExample(entry, id, exId, n); } },
    { label: 'Duplicate', icon: 'copy', onClick: () => C.duplicateExample(entry, id, exId) },
    '-',
    { label: 'Delete', icon: 'trash', danger: true, onClick: () => C.removeExample(entry, id, exId) },
  ], row);
}

function folderMenu(e, entry, it, row) {
  showMenu(e, [
    { label: 'Add request', icon: 'plus', onClick: () => C.addRequest(entry, it.id) },
    { label: 'Add folder', icon: 'folder', onClick: async () => { const n = await promptDialog({ title: 'New folder', value: 'New Folder' }); if (n) C.addFolder(entry, it.id, n); } },
    { label: 'Folder settings & auth', icon: 'gear', onClick: () => C.openContainer(entry, it.id) },
    { label: 'Run folder', icon: 'play', onClick: () => C.openRunner(entry, it.id) },
    '-',
    { label: 'Rename', icon: 'edit', onClick: async () => { const n = await promptDialog({ title: 'Rename folder', value: it.name, confirm: 'Rename' }); if (n) C.renameItem(entry, it.id, n); } },
    { label: 'Duplicate', icon: 'copy', onClick: () => C.duplicate(entry, it.id) },
    '-',
    { label: 'Delete', icon: 'trash', danger: true, onClick: () => C.removeItem(entry, it.id) },
  ], row);
}

function reqMenu(e, entry, it, row) {
  showMenu(e, [
    { label: 'Open', icon: 'send', onClick: () => C.openItem(entry, it.id) },
    { label: 'Rename', icon: 'edit', onClick: async () => { const n = await promptDialog({ title: 'Rename request', value: it.name, confirm: 'Rename' }); if (n) C.renameItem(entry, it.id, n); } },
    { label: 'Duplicate', icon: 'copy', onClick: () => C.duplicate(entry, it.id) },
    { label: 'Add example', icon: 'file', onClick: () => C.addExample(entry, it.id, newExample(it.request)).catch((er) => toast(errText(er), { error: true })) },
    '-',
    { label: 'Delete', icon: 'trash', danger: true, onClick: () => C.removeItem(entry, it.id) },
  ], row);
}

// drag & drop within a collection
let drag = null;
function dragSource(row, entry, id) {
  row.addEventListener('dragstart', (e) => { drag = { entry, id }; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', id); row.style.opacity = '.5'; });
  row.addEventListener('dragend', () => { drag = null; row.style.opacity = ''; });
}
function dropTarget(row, entry, id, folder = false) {
  const clear = () => row.classList.remove('drop-before', 'drop-after', 'drop-inside');
  const zone = (e) => {
    if (id === null) return 'inside';
    const r = row.getBoundingClientRect();
    const y = (e.clientY - r.top) / r.height;
    if (folder) return y < 0.25 ? 'before' : y > 0.75 ? 'after' : 'inside';
    return y < 0.5 ? 'before' : 'after';
  };
  row.addEventListener('dragover', (e) => {
    if (!drag || drag.entry !== entry || drag.id === id) return;
    e.preventDefault();
    clear();
    row.classList.add(`drop-${zone(e)}`);
  });
  row.addEventListener('dragleave', clear);
  row.addEventListener('drop', (e) => {
    e.preventDefault();
    clear();
    if (!drag || drag.entry !== entry) return;
    C.moveItem(entry, drag.id, id, zone(e));
  });
}

// ---------- environments ----------

function environmentsView() {
  const envs = state.ws?.environments || [];
  const active = S.activeEnvEntry();
  const tab = C.activeTab();
  const q = filter.toLowerCase();
  const rows = [
    h('div', { class: ['tree-row', tab?.kind === 'globals' && 'selected'], onclick: () => C.openGlobals() },
      icon('globe', 'ico'), h('span', { class: 'name' }, 'Globals'),
      state.ws.globals.conflict ? h('span', { class: 'badge err' }, 'conflict') : state.ws.globals.dirty && S.isCloud() ? h('span', { class: 'badge dirty' }, 'unsynced') : null,
      state.ws.globals.dirty && S.isCloud() ? h('span', { class: 'actions' }, h('button', { class: 'icon-btn sm', title: 'Push globals to Postman', onclick: async (e) => {
        e.stopPropagation();
        try { await S.pushGlobals(); toast('Globals synced to Postman'); } catch (er) { if (er instanceof S.ConflictError) C.handleConflict(er); else toast(errText(er), { error: true }); }
      } }, icon('cloudUp'))) : null),
    h('div', { class: ['tree-row', tab?.kind === 'vault' && 'selected'], onclick: () => C.openVault() },
      icon('key', 'ico'), h('span', { class: 'name' }, 'Vault'), h('span', { class: 'faint', style: { fontSize: '11px' } }, `${(state.settings.vaultKeys || []).length || ''}`)),
    h('div', { class: 'group-label' }, 'Environments'),
  ];
  if (!envs.length) rows.push(h('div', { class: 'side-empty' }, h('p', null, 'No environments yet.'), h('button', { class: 'btn sm', onclick: newEnvironment }, 'New environment')));
  for (const env of envs) {
    if (q && !env.name.toLowerCase().includes(q)) continue;
    const isActive = active === env;
    const row = h('div', {
      class: ['tree-row', tab?.kind === 'env' && tab.ref.env === env.uid && 'selected'],
      onclick: () => C.openEnv(env),
      oncontextmenu: (e) => { e.preventDefault(); envMenu(e, env, row); },
    },
      h('button', { class: 'icon-btn sm', title: isActive ? 'Active environment' : 'Set as active', onclick: (e) => { e.stopPropagation(); S.setActiveEnv(isActive ? null : env.uid); } },
        isActive ? icon('check') : h('span', { style: { width: '12px', height: '12px', borderRadius: '50%', border: '1.5px solid var(--border-strong)', display: 'block' } })),
      h('span', { class: 'name', style: isActive ? { fontWeight: 600 } : null }, env.name),
      env.conflict ? h('span', { class: 'badge err' }, 'conflict') : env.dirty && S.isCloud() ? h('span', { class: 'badge dirty' }, 'unsynced') : null,
      h('span', { class: 'actions' }, h('button', { class: 'icon-btn sm', onclick: (e) => { e.stopPropagation(); envMenu(e, env, row); } }, icon('more'))));
    rows.push(row);
  }
  return rows;
}

function envMenu(e, env, row) {
  showMenu(e, [
    { label: 'Open', icon: 'edit', onClick: () => C.openEnv(env) },
    { label: 'Set as active', icon: 'check', onClick: () => S.setActiveEnv(env.uid) },
    { label: 'Export…', icon: 'upload', onClick: async () => { try { const p = await S.exportEnvironment(env); if (p) toast(`Exported to ${p}`); } catch (er) { toast(errText(er), { error: true }); } } },
    S.isCloud() && env.dirty ? { label: 'Push to Postman now', icon: 'cloudUp', onClick: async () => { try { await S.pushEnvironment(env); toast('Synced'); } catch (er) { if (er instanceof S.ConflictError) C.handleConflict(er); else toast(errText(er), { error: true }); } } } : null,
    { label: 'Reset current values', icon: 'sync', onClick: () => { env.overlay = {}; S.overlaysChanged(); toast('Current values reset to the shared values'); } },
  ].filter(Boolean), row);
}

// ---------- history ----------

function historyView() {
  const q = filter.toLowerCase();
  const items = state.history.filter((x) => !q || x.url?.toLowerCase().includes(q) || x.name?.toLowerCase().includes(q) || (x.method || '').toLowerCase().includes(q));
  if (!items.length) return [h('div', { class: 'side-empty' }, h('p', null, q ? 'Nothing matches.' : 'Requests you send show up here.'))];
  const out = [];
  let lastDay = '';
  const today = new Date().toDateString();
  const yest = new Date(Date.now() - 864e5).toDateString();
  for (const x of items) {
    const d = new Date(x.ts).toDateString();
    if (d !== lastDay) {
      out.push(h('div', { class: 'group-label' }, d === today ? 'Today' : d === yest ? 'Yesterday' : new Date(x.ts).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })));
      lastDay = d;
    }
    const st = x.status;
    out.push(h('div', {
      class: 'hist-row', title: `${x.name || ''}\n${x.url}\n${new Date(x.ts).toLocaleTimeString()}`,
      onclick: () => {
        const item = { id: crypto.randomUUID?.() || String(Math.random()), name: x.name || 'From history', request: clone(x.request) };
        C.openDraft(item);
      },
    },
      h('span', { class: ['method', methodClass(x.method)] }, methodLabel(x.method)),
      h('span', { class: 'url mono' }, x.url || urlObject(x.request?.url).raw),
      h('span', { class: 'st', style: { color: !st ? 'var(--err)' : st < 300 ? 'var(--ok)' : st < 400 ? 'var(--info)' : st < 500 ? 'var(--warn)' : 'var(--err)' } }, st || 'ERR')));
  }
  return out;
}
