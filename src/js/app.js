import { h, icon, $, dragResize, methodClass, methodLabel, toast, errText, closeMenu, showMenu } from './ui/dom.js';
import { renderSidebar } from './ui/sidebar.js';
import { renderRequestEditor, renderResponse, codeDialog } from './ui/request.js';
import { renderContainer, renderEnvTab, renderWelcome, renderEmpty, openSettings, applyTheme, envQuickLook } from './ui/panels.js';
import { renderExampleEditor, renderExampleResponse } from './ui/example.js';
import { checkFolders } from './folderlink.js';
import { scheduleUpdateCheck } from './updater.js';
import * as S from './store.js';
import { state, on } from './store.js';
import * as C from './ctx.js';

// Feature tabs and the palette load their code the first time they're opened.
const openPalette = () => import('./ui/palette.js').then((m) => m.openPalette());
const tabViews = {
  grpc: () => import('./ui/grpcview.js').then((m) => m.renderGrpcTab),
  load: () => import('./ui/loadview.js').then((m) => m.renderLoadTab),
  chain: () => import('./ui/chainview.js').then((m) => m.renderChainTab),
  mock: () => import('./ui/mockview.js').then((m) => m.renderMockTab),
  vault: () => import('./ui/vaultview.js').then((m) => m.renderVaultTab),
  runner: () => import('./ui/runner.js').then((m) => m.renderRunner),
};
let lazySeq = 0;
function renderLazyTab(el, t) {
  const seq = ++lazySeq;
  tabViews[t.kind]().then((render) => { if (seq === lazySeq && el.isConnected && state.activeTab === t.id) render(el, t); })
    .catch((e) => toast(errText(e), { error: true }));
}

const sidebarEl = $('#sidebar');
const tabsEl = $('#tabs');
const topRight = $('#top-right');
const workspaceEl = $('#workspace');

// ---------- rendering ----------

function renderTabs() {
  const list = C.wsTabs();
  tabsEl.replaceChildren(...list.map((t) => {
    const m = t.draft?.request?.method;
    const el = h('div', {
      class: ['tab', t.id === state.activeTab && 'active', t.dirty && 'dirty'],
      title: C.tabTitle(t),
      onmousedown: (e) => { if (e.button === 1) { e.preventDefault(); C.closeTab(t.id); } },
      onclick: () => { if (state.activeTab !== t.id) C.focusTab(t.id); },
      oncontextmenu: (e) => { e.preventDefault(); showMenu(e, [
        { label: 'Close', key: '⌘W', onClick: () => C.closeTab(t.id) },
        { label: 'Close other tabs', onClick: async () => { for (const x of C.wsTabs()) if (x.id !== t.id) await C.closeTab(x.id); } },
        t.kind === 'request' ? { label: 'Duplicate tab', onClick: () => C.openDraft(S.clone({ ...t.draft, id: crypto.randomUUID(), name: `${t.draft.name} Copy` })) } : null,
      ].filter(Boolean)); },
    },
      t.kind === 'request' ? h('span', { class: ['method', methodClass(m)] }, methodLabel(m))
      : icon(t.kind === 'runner' ? 'play' : t.kind === 'vault' ? 'key' : t.kind === 'mock' ? 'layers' : t.kind === 'chain' ? 'link' : t.kind === 'load' ? 'play' : t.kind === 'grpc' ? 'layers' : t.kind === 'example' ? 'file' : t.kind === 'container' ? (t.ref.item ? 'folder' : 'box') : 'globe', 'ico'),
      h('span', { class: 'title' }, C.tabTitle(t)),
      h('button', { class: 'close', title: 'Close', onclick: (e) => { e.stopPropagation(); C.closeTab(t.id); } }, icon('x')));
    return el;
  }), h('button', { class: 'icon-btn tab-new', title: 'New request (⌘T)', onclick: () => C.openDraft() }, icon('plus')));
  const act = tabsEl.querySelector('.tab.active');
  act?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function renderTopRight() {
  const envs = state.ws?.environments || [];
  const active = S.activeEnvEntry();
  const sel = h('select', { class: 'select env-select', title: 'Active environment', onchange: (e) => S.setActiveEnv(e.target.value || null).catch((er) => toast(errText(er), { error: true })) },
    h('option', { value: '' }, 'No environment'),
    envs.map((e) => h('option', { value: e.uid, selected: e === active }, e.name)));
  topRight.replaceChildren(
    h('button', { class: 'icon-btn', title: 'Search everything (⌘K)', onclick: () => openPalette() }, icon('search')),
    sel,
    h('button', { class: 'icon-btn', title: 'Quick look at variables', onclick: (e) => envQuickLook(e) }, icon('eye')));
}

let editorEl = null;
let responseEl = null;

function renderMain() {
  closeMenu();
  const t = C.activeTab();
  editorEl = null;
  responseEl = null;
  workspaceEl.classList.remove('side');
  if (!state.settings.onboarded) return renderWelcome(workspaceEl);
  if (!t) return renderEmpty(workspaceEl);
  if (t.kind === 'request' || t.kind === 'example') {
    editorEl = h('section', { id: 'editor' });
    responseEl = h('section', { id: 'response' });
    const side = state.settings.layout === 'side';
    workspaceEl.classList.toggle('side', side);
    renderMainSizes();
    const handle = h('div', { class: side ? 'resizer-x' : 'resizer-y' });
    const dim = side ? 'width' : 'height';
    dragResize(handle, () => ({ total: workspaceEl.getBoundingClientRect()[dim], start: editorEl.getBoundingClientRect()[dim] }), (dx, dy, ctx) => {
      const size = Math.max(side ? 320 : 150, Math.min(ctx.total - (side ? 280 : 90), ctx.start + (side ? dx : dy)));
      if (side) state.settings.sideRatio = 1 - size / ctx.total;
      else state.settings.responseRatio = 1 - size / ctx.total;
      editorEl.style.flex = `0 0 ${size}px`;
    }, () => { S.saveSettings(); renderMainSizes(); });
    workspaceEl.replaceChildren(editorEl, handle, responseEl);
    if (t.kind === 'example') {
      renderExampleEditor(editorEl, t);
      renderExampleResponse(responseEl, t);
    } else {
      renderRequestEditor(editorEl, t);
      renderResponse(responseEl, t);
    }
  } else if (t.kind === 'container') {
    const el = h('section', { id: 'editor', style: { flex: '1' } });
    workspaceEl.replaceChildren(el);
    renderContainer(el, t);
  } else if (t.kind === 'env' || t.kind === 'globals') {
    const el = h('section', { id: 'editor', style: { flex: '1' } });
    workspaceEl.replaceChildren(el);
    renderEnvTab(el, t);
  } else if (t.kind === 'grpc') {
    workspaceEl.replaceChildren();
    renderLazyTab(workspaceEl, t);
  } else if (tabViews[t.kind]) {
    const el = h('section', { id: 'editor', style: { flex: '1' } });
    workspaceEl.replaceChildren(el);
    renderLazyTab(el, t);
  }
}

function renderMainSizes() {
  const ratio = state.settings.layout === 'side' ? state.settings.sideRatio ?? 0.5 : state.settings.responseRatio;
  if (editorEl) editorEl.style.flex = `0 0 ${Math.round((1 - ratio) * 1000) / 10}%`;
}

function updateRunState() {
  const t = C.activeTab();
  if (!t || t.kind !== 'request' || !responseEl) return;
  renderResponse(responseEl, t);
  const btn = editorEl?.querySelector('.send-btn');
  if (btn) { btn.disabled = !!t.running; btn.textContent = t.running ? 'Sending…' : 'Send'; }
}

function renderAll() {
  applyTheme();
  sidebarEl.style.width = `${state.settings.sidebarWidth}px`;
  renderSidebar(sidebarEl);
  renderTabs();
  renderTopRight();
  renderMain();
}

const sidebarRefresh = (() => { let q = false; return () => { if (q) return; q = true; requestAnimationFrame(() => { q = false; renderSidebar(sidebarEl); }); }; })();

on('all', renderAll);
on('sidebar', sidebarRefresh);
on('history', sidebarRefresh);
on('sync', sidebarRefresh);
on('workspace', () => { sidebarRefresh(); renderTabs(); renderTopRight(); renderMain(); });
on('tabs', () => { renderTabs(); sidebarRefresh(); });
on('main', renderMain);
on('response', updateRunState);
on('mock', () => { sidebarRefresh(); if (C.activeTab()?.kind === 'mock' && !workspaceEl.contains(document.activeElement)) renderMain(); });
on('env', () => { renderTopRight(); sidebarRefresh(); repaintVars(); const t = C.activeTab(); if (t && (t.kind === 'env' || t.kind === 'globals') && !t.dirty) renderMain(); });
on('env-values', () => { repaintVars(); const t = C.activeTab(); if (t && (t.kind === 'env' || t.kind === 'globals' || (t.kind === 'container' && t.sub === 'variables')) && !workspaceEl.contains(document.activeElement)) renderMain(); });
on('tabs-refresh', () => {
  C.refreshCleanTabs();
  const t = C.activeTab();
  if (t && !t.dirty && !workspaceEl.contains(document.activeElement)) renderMain();
  renderTabs();
  renderTopRight();
});

function repaintVars() { editorEl?.repaintVars?.(); }

// ---------- sidebar resize ----------
const sideHandle = $('#side-resizer');
dragResize(sideHandle, () => sidebarEl.getBoundingClientRect().width, (dx, dy, start) => {
  state.settings.sidebarWidth = Math.max(220, Math.min(520, start + dx));
  sidebarEl.style.width = `${state.settings.sidebarWidth}px`;
}, () => S.saveSettings());

// ---------- keyboard ----------
document.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (!mod) return;
  const t = C.activeTab();
  const k = e.key.toLowerCase();
  if (k === 'enter' && t?.kind === 'request') { e.preventDefault(); C.run(t); }
  else if (k === 's') { e.preventDefault(); if (t) C.saveTab(t); }
  else if (k === 'k' || (k === 'p' && !e.shiftKey)) { e.preventDefault(); openPalette(); }
  else if (k === 't' || (k === 'n' && !e.shiftKey)) { e.preventDefault(); C.openDraft(); }
  else if (k === 'w') { e.preventDefault(); if (t) C.closeTab(t.id); }
  else if (k === ',') { e.preventDefault(); openSettings(); }
  else if (k === 'l' && t?.kind === 'request') { e.preventDefault(); editorEl?.focusUrl?.(); }
  else if (e.code === 'KeyC' && e.altKey && t?.kind === 'request') { e.preventDefault(); codeDialog(t); }
  else if (k === 'f' && !e.shiftKey && t?.kind === 'request' && t.response?.response && !t.response.response.bodyBase64) {
    // Find in the response body (the request editor's own fields keep native find).
    e.preventDefault();
    t.find = { ...(t.find || { q: '' }), open: true };
    t.respTab = 'body';
    if (t.bodyView === 'preview') t.bodyView = 'pretty';
    updateRunState();
  }
  else if (e.code === 'KeyV' && e.altKey) { e.preventDefault(); S.toggleLayout(); }
  else if ((e.key === ']' || e.key === '}') && e.shiftKey || (e.key === 'Tab' && e.ctrlKey && !e.shiftKey)) { e.preventDefault(); cycleTab(1); }
  else if ((e.key === '[' || e.key === '{') && e.shiftKey || (e.key === 'Tab' && e.ctrlKey && e.shiftKey)) { e.preventDefault(); cycleTab(-1); }
});

function cycleTab(dir) {
  const list = C.wsTabs();
  if (list.length < 2) return;
  const i = list.findIndex((x) => x.id === state.activeTab);
  C.focusTab(list[(i + dir + list.length) % list.length].id);
}

// Re-sync when the window comes back into focus (at most every 2 minutes).
let lastFocusSync = Date.now();
let lastFolderCheck = 0;
window.addEventListener('focus', () => {
  // Collections linked to a folder pick up git pulls and outside edits.
  if (Date.now() - lastFolderCheck > 1500) { lastFolderCheck = Date.now(); checkFolders().catch(() => {}); }
  if (state.hasKey && S.isCloud() && Date.now() - lastFocusSync > 120000) {
    lastFocusSync = Date.now();
    S.refreshWorkspace().catch(() => {});
  }
});

// ---------- start ----------
window.addEventListener('unhandledrejection', (e) => { console.error(e.reason); toast(errText(e.reason), { error: true }); });

S.init().catch((e) => {
  console.error(e);
  toast(`Dispatch couldn't load its data: ${errText(e)}`, { error: true, timeout: 15000 });
  renderAll();
}).finally(() => { scheduleUpdateCheck(); checkFolders().catch(() => {}); });
