import { h, icon, modal, toast, errText, logoSvg, relTime, confirmDialog, promptDialog, showMenu, lazyEl } from './dom.js';
import { varInput, subtabs } from './components.js';
import { authEditor, scriptsEditor } from './request.js';
import { docsEditor, descriptionText } from './docs.js';
import * as C from '../ctx.js';
import * as S from '../store.js';
import { state, emit } from '../store.js';
import { bridge } from '../bridge.js';
import { isFolder, itemId } from '../model.js';
import { localOnlyKeys, persistCurrent, resetCurrent } from '../vars.js';
import { callsRemaining } from '../sync.js';
import { pwSlotKey } from '../transport.js';

const openCookieManager = () => import('./cookies.js').then((m) => m.openCookieManager());

// ---------- collection / folder settings ----------

export function renderContainer(root, t) {
  const { entry, collection, parents } = C.contextFor(t);
  if (!entry || !collection || !t.draft) { root.replaceChildren(h('div', { class: 'center-screen' }, 'This item is no longer available.')); return; }
  const isCol = !t.ref.item;
  const d = t.draft;
  const dirty = () => C.markDirty(t);
  const resolver = () => C.resolverFor(t);
  const head = h('div', { class: 'crumbs' },
    icon(isCol ? 'box' : 'folder', 'ico'),
    h('input', { class: 'name-input', value: d.name, oninput: (e) => { d.name = e.target.value; dirty(); C.emitTabs(); } }),
    h('span', { class: 'grow' }),
    h('button', { class: 'btn sm', onclick: () => C.saveTab(t) }, icon('check'), 'Save'));
  // Rebuilt on every render so the dots and the variable count stay current.
  const tabs = () => [
    { id: 'overview', label: 'Overview' },
    { id: 'auth', label: 'Authorization', dot: d.auth && d.auth.type !== 'noauth' && d.auth.type !== 'inherit' },
    { id: 'scripts', label: 'Scripts', dot: (d.event || []).length > 0 },
    ...(isCol ? [{ id: 'variables', label: 'Variables', count: (d.variable || []).filter((v) => v.key).length || '' }] : []),
  ];
  const tabsHolder = h('div');
  const pane = h('div', { class: 'pane' });
  const renderTabs = () => tabsHolder.replaceChildren(subtabs(tabs(), t.sub, (id) => { t.sub = id; renderTabs(); renderPane(); }));
  function renderPane() {
    pane.replaceChildren();
    if (t.sub === 'overview') {
      const docs = docsEditor({ get: () => descriptionText(d.description), set: (v) => { d.description = v; }, onChange: dirty, state: t, placeholder: `Describe what this ${isCol ? 'collection' : 'folder'} is for. Markdown works, and it syncs with Postman.` });
      const count = (() => { let r = 0, f = 0; const src = isCol ? collection.item : C.contextFor(t).item?.item || []; (function walk(items) { for (const x of items) { if (isFolder(x)) { f++; walk(x.item); } else r++; } })(src); return `${r} request${r === 1 ? '' : 's'}${f ? `, ${f} folder${f === 1 ? '' : 's'}` : ''}`; })();
      pane.append(h('div', { class: 'pane-title' }, 'Description'), docs, h('p', { class: 'hint' }, count, isCol && entry.updatedAt ? ` · last changed in Postman ${relTime(Date.parse(entry.updatedAt))}` : ''));
    } else if (t.sub === 'auth') {
      pane.append(h('p', { class: 'hint', style: { marginTop: 0 } }, `Requests in this ${isCol ? 'collection' : 'folder'} set to "Inherit from parent" use this.`),
        authEditor({ target: d, kind: isCol ? 'collection' : 'folder', parents: isCol ? [] : parents, collection: isCol ? null : collection, resolver, onChange: dirty, onTypeChange: () => { renderTabs(); renderPane(); }, tab: t }));
    } else if (t.sub === 'scripts') {
      pane.append(scriptsEditor(d, t, dirty, renderTabs));
    } else if (t.sub === 'variables') {
      d.variable = d.variable || [];
      const overlay = (state.ws.colOverlays[entry.uid] = state.ws.colOverlays[entry.uid] || {});
      const onChange = () => { dirty(); renderTabs(); };
      pane.append(h('div', { class: 'row', style: { justifyContent: 'flex-end', marginBottom: '8px' } },
          currentValueButtons({ rows: d.variable, overlay, enabledKey: 'disabled', onChange, rerender: renderPane })),
        varsTable({ rows: d.variable, overlay, enabledKey: 'disabled', onChange, onOverlay: () => S.overlaysChanged(), resolver }),
        h('p', { class: 'hint' }, 'Shared values sync with Postman. Current values are only on this device, and scripts write to them, just like in Postman.'));
    }
  }
  renderTabs();
  renderPane();
  root.replaceChildren(head, tabsHolder, pane);
}

// ---------- environments & globals ----------

export function renderEnvTab(root, t) {
  const isGlobals = t.kind === 'globals';
  const env = isGlobals ? null : state.ws.environments.find((e) => e.uid === t.ref.env);
  if (!isGlobals && !env) { root.replaceChildren(h('div', { class: 'center-screen' }, 'This environment is no longer in the workspace.')); return; }
  const d = t.draft;
  const overlay = isGlobals ? (state.ws.globals.overlay = state.ws.globals.overlay || {}) : (env.overlay = env.overlay || {});
  const dirty = () => C.markDirty(t);
  const isActive = S.activeEnvEntry() === env;
  const head = h('div', { class: 'env-head' },
    icon('globe', 'ico'),
    isGlobals ? h('span', { style: { fontSize: '15px', fontWeight: 600 } }, 'Globals') : h('input', { class: 'name-input', value: d.name, oninput: (e) => { d.name = e.target.value; dirty(); C.emitTabs(); } }),
    !isGlobals ? h('button', { class: ['btn sm', isActive && 'primary'], onclick: () => S.setActiveEnv(isActive ? null : env.uid) }, isActive ? 'Active' : 'Set active') : null,
    h('span', { class: 'grow' }),
    currentValueButtons({ rows: d.values, overlay, enabledKey: 'enabled', onChange: dirty, rerender: () => renderEnvTab(root, t) }),
    h('button', { class: 'btn sm', onclick: () => C.saveTab(t) }, icon('check'), 'Save'));
  const pane = h('div', { class: 'pane' },
    varsTable({ rows: d.values, overlay, enabledKey: 'enabled', onChange: dirty, onOverlay: () => S.overlaysChanged() }),
    h('p', { class: 'hint' }, isGlobals ? 'Globals apply to every request in this workspace.' : 'Shared values sync with Postman for everyone in the workspace. Current values stay on this device; scripts like ',
      isGlobals ? null : h('span', { class: 'mono' }, 'pm.environment.set()'), isGlobals ? null : ' write to them, so tokens you fetch never overwrite your team\'s values.'));
  root.replaceChildren(head, pane);
}

/**
 * Variables table with shared (synced) and current (local) values. Names that
 * only have a current value, usually set by a script, show as "not shared yet"
 * rows until they're given a shared value or persisted.
 */
function varsTable({ rows, overlay, enabledKey, onChange, onOverlay }) {
  const isOn = (r) => (enabledKey === 'enabled' ? r.enabled !== false : !r.disabled);
  const setOn = (r, on) => { if (enabledKey === 'enabled') r.enabled = on; else if (on) delete r.disabled; else r.disabled = true; };
  const fresh = (key = '') => ({ key, value: '', type: 'default', ...(enabledKey === 'enabled' ? { enabled: true } : {}) });
  const tbody = h('tbody');
  const rowEl = (row, local = false) => {
      const ghost = row === null;
      const r = row || fresh();
      const tr = h('tr', { class: [ghost && 'ghost', local && 'local', !ghost && !isOn(r) && 'disabled'] });
      // Shared edits turn a blank or local-only row into a real (synced) one.
      const attach = () => {
        if (rows.includes(r)) return;
        rows.push(r);
        tr.classList.remove('ghost', 'local');
        shared.placeholder = '';
        if (ghost) tbody.append(rowEl(null));
      };
      // The first keystroke in the blank row makes it real; local rows stay local.
      const ensure = () => { if (ghost) attach(); };
      const secret = r.type === 'secret';
      const shared = h('input', { class: 'cell', type: secret ? 'password' : 'text', value: r.value ?? '', placeholder: local ? 'Not shared yet' : '', title: local ? 'Only a current value exists. Type a shared value, or use Persist, to sync it.' : null, spellcheck: 'false', oninput: (e) => { attach(); r.value = e.target.value; onChange(); } });
      const curHas = Object.prototype.hasOwnProperty.call(overlay, r.key);
      const current = h('input', { class: 'cell', type: secret ? 'password' : 'text', value: curHas ? overlay[r.key] ?? '' : '', placeholder: ghost ? '' : secret ? (r.value ? '••••••' : '') : (r.value ?? ''), spellcheck: 'false', oninput: (e) => { ensure(); if (!r.key) return; overlay[r.key] = e.target.value; onOverlay(); } });
      tr.append(
        h('td', { class: 'chk' }, h('input', { type: 'checkbox', checked: ghost || isOn(r), onchange: (e) => { attach(); setOn(r, e.target.checked); tr.classList.toggle('disabled', !e.target.checked); onChange(); } })),
        h('td', null, h('input', { class: 'cell', value: r.key, placeholder: ghost ? 'Add variable' : 'Name', spellcheck: 'false', oninput: (e) => {
          ensure();
          const old = r.key;
          r.key = e.target.value;
          if (old && Object.prototype.hasOwnProperty.call(overlay, old)) { overlay[r.key] = overlay[old]; delete overlay[old]; onOverlay(); }
          if (!local || rows.includes(r)) onChange();
        } })),
        h('td', { class: 'type' }, h('select', { class: 'cell select', onchange: (e) => { attach(); r.type = e.target.value; onChange(); render(); } },
          h('option', { value: 'default', selected: !secret }, 'default'), h('option', { value: 'secret', selected: secret }, 'secret'))),
        h('td', null, shared),
        h('td', null, current),
        h('td', { class: 'del' }, h('button', { class: 'icon-btn sm', title: 'Remove', onclick: () => {
          const i = rows.indexOf(r);
          if (i >= 0) { rows.splice(i, 1); onChange(); }
          delete overlay[r.key];
          onOverlay();
          render();
        } }, icon('x'))));
      return tr;
  };
  const render = () => tbody.replaceChildren(...rows.map((r) => rowEl(r)), ...localOnlyKeys(rows, overlay).map((k) => rowEl(fresh(k), true)), rowEl(null));
  render();
  return h('table', { class: 'kv' },
    h('thead', null, h('tr', null, h('th', { class: 'chk' }), h('th', null, 'Variable'), h('th', { class: 'type' }, 'Type'), h('th', null, 'Shared value (synced)'), h('th', null, 'Current value (this device)'), h('th', { class: 'del' }))),
    tbody);
}

/** Persist and Reset buttons for a variables table, as in Postman. */
function currentValueButtons({ rows, overlay, enabledKey, onChange, rerender }) {
  return [
    h('button', { class: 'btn sm ghost', title: 'Copy every current value into the shared value, so your team gets it when you save', onclick: () => {
      const n = persistCurrent(rows, overlay, enabledKey);
      S.overlaysChanged();
      if (!n) { toast('The shared values already match the current values.'); rerender(); return; }
      onChange();
      rerender();
      toast(`Copied ${n} current value${n === 1 ? '' : 's'} into the shared values. Save to sync ${n === 1 ? 'it' : 'them'} with Postman.`);
    } }, 'Persist current values'),
    h('button', { class: 'btn sm ghost', title: 'Make current values match the shared values again', onclick: () => { resetCurrent(overlay); S.overlaysChanged(); rerender(); } }, 'Reset current values'),
  ];
}

// ---------- Save As ----------

export function saveAsDialog(defaultName) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const cols = state.ws.collections;
    const nameInput = h('input', { class: 'input', value: defaultName || 'New Request', style: { width: '100%', marginBottom: '12px' } });
    let chosen = null;
    const list = h('div', { class: 'picker-list' });
    const render = async () => {
      const rows = [];
      for (const entry of cols) {
        rows.push(pickRow(entry, null, entry.name, 0, 'box'));
        if (entry.data) (function walk(items, depth) { for (const it of items) if (isFolder(it)) { rows.push(pickRow(entry, itemId(it), it.name, depth, 'folder')); walk(it.item, depth + 1); } })(entry.data.item, 1);
      }
      if (!cols.length) rows.push(h('div', { class: 'side-empty' }, 'No collections in this workspace yet.'));
      list.replaceChildren(...rows);
    };
    const pickRow = (entry, folderId, label, depth, ico) => h('div', {
      class: ['tree-row', chosen && chosen.entry === entry && chosen.folderId === folderId && 'selected'],
      style: { '--depth': depth },
      onclick: async () => { chosen = { entry, folderId }; if (!entry.data) { try { await S.ensureCollection(entry); } catch (e) { toast(errText(e), { error: true }); } } render(); },
    }, icon(ico, 'ico'), h('span', { class: 'name' }, label));
    render();
    const newBtn = h('button', { class: 'btn sm', style: { marginTop: '10px' }, onclick: async () => {
      const n = await promptDialog({ title: 'New collection', value: 'New Collection' });
      if (!n) return;
      try { const e = await S.createCollection(n); chosen = { entry: e, folderId: null }; render(); } catch (e) { toast(errText(e), { error: true }); }
    } }, icon('plus'), 'New collection');
    modal({
      title: 'Save request',
      body: h('div', null, h('p', null, 'Name'), nameInput, h('p', null, 'Save to'), list, newBtn),
      onClose: () => finish(null),
      actions: [
        { label: 'Cancel', onClick: () => finish(null) },
        { label: 'Save', primary: true, onClick: () => { if (!chosen) { toast('Choose a collection or folder first', { error: true }); return false; } finish({ ...chosen, name: nameInput.value.trim() || defaultName }); } },
      ],
    });
  });
}

// ---------- Postman API key help ----------

const API_KEYS_URL = 'https://go.postman.co/settings/me/api-keys';
const KEY_GUIDE_URL = 'https://github.com/Roqak/dispatch/blob/main/docs/postman-api-key.md';
const openLink = (url) => bridge.openUrl(url).catch(() => { navigator.clipboard.writeText(url); toast(`Couldn't open your browser, so the link is on your clipboard: ${url}`); });

/** Steps for creating a Postman API key, with a button to Postman's API keys page. */
function apiKeyHelp({ open = false } = {}) {
  return h('details', { class: 'key-help', open },
    h('summary', null, 'How do I get an API key?'),
    h('ol', null,
      h('li', null, 'In Postman, click your avatar → ', h('b', null, 'Settings'), ' → ', h('b', null, 'API keys'), '. ',
        h('button', { class: 'link-btn', onclick: () => openLink(API_KEYS_URL) }, 'Open the API keys page')),
      h('li', null, 'Click ', h('b', null, 'Generate API key'), ', name it "Dispatch", and copy the key. It starts with ', h('span', { class: 'mono' }, 'PMAK-'), ', and Postman only shows it once.'),
      h('li', null, 'Paste it here. If your team uses Postman\'s EU region, tick the EU box first.')),
    h('p', { class: 'hint' }, 'Key rejected, or no Generate button? ',
      h('button', { class: 'link-btn', onclick: () => openLink(KEY_GUIDE_URL) }, 'Read the full guide'),
      ' for expiry, regions, errors and revoking a key.'));
}

// ---------- settings ----------

/** Shared "connect another account" dialog: a Postman key or a Dispatch server. Resolves with the new profile. */
export function addProfileDialog(then) {
  const body = h('div');
  let kind = 'postman';
  const render = () => {
    const typeRow = h('div', { class: 'row', style: { marginBottom: '10px' } },
      h('button', { class: ['btn', kind === 'postman' && 'primary'], onclick: () => { if (kind !== 'postman') { kind = 'postman'; render(); } } }, 'Postman account'),
      h('button', { class: ['btn', kind === 'server' && 'primary'], onclick: () => { if (kind !== 'server') { kind = 'server'; render(); } } }, 'Dispatch server'));
    body.replaceChildren(typeRow, kind === 'postman' ? postmanForm() : serverForm());
  };

  const postmanForm = () => {
    const keyInput = h('input', { class: 'input', type: 'password', placeholder: 'PMAK-…', style: { width: '100%' } });
    const nameInput = h('input', { class: 'input', placeholder: 'Name (optional — defaults to the Postman username)', style: { width: '100%' } });
    const errLine = h('div', { class: 'hint', style: { color: 'var(--err)', minHeight: '18px', margin: '6px 0 0' } });
    const eu = h('input', { type: 'checkbox' });
    const connectBtn = h('button', { class: 'btn primary', onclick: async () => {
      connectBtn.disabled = true; connectBtn.textContent = 'Checking…'; errLine.textContent = '';
      try {
        const profile = await S.addProfile({ key: keyInput.value, name: nameInput.value, region: eu.checked ? 'eu' : 'us' });
        toast(`Connected "${profile.name}"`);
        render();
        then?.(profile);
      } catch (e) { errLine.textContent = errText(e); connectBtn.disabled = false; connectBtn.textContent = 'Connect'; }
    } }, 'Connect');
    keyInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') connectBtn.click(); });
    setTimeout(() => keyInput.focus(), 50);
    return h('div', null,
      h('p', null, 'Paste a Postman API key to add the account as a profile. Each profile syncs its own workspaces, collections and environments — switch any time from the sidebar footer.'),
      h('div', { class: 'form-grid' },
        h('label', null, 'Profile name'), nameInput,
        h('label', null, 'API key'), h('div', { class: 'row' }, keyInput, connectBtn),
        h('label', null, 'Region'), h('div', null, h('label', { class: 'check hint', style: { margin: 0 } }, eu, ' My Postman team is hosted in the EU region'))),
      errLine,
      apiKeyHelp());
  };

  const serverForm = () => {
    const urlInput = h('input', { class: 'input', placeholder: 'https://dispatch.example.com', spellcheck: 'false', style: { width: '100%' } });
    const nameInput = h('input', { class: 'input', placeholder: 'Name (optional — defaults to your server username)', style: { width: '100%' } });
    const emailInput = h('input', { class: 'input', type: 'email', placeholder: 'you@company.com', autocomplete: 'email', style: { width: '100%' } });
    const pwInput = h('input', { class: 'input', type: 'password', autocomplete: 'current-password', style: { width: '100%' } });
    const tokenInput = h('input', { class: 'input', type: 'password', placeholder: 'Pre-issued token, instead of signing in', spellcheck: 'false', style: { width: '100%' } });
    const errLine = h('div', { class: 'hint', style: { color: 'var(--err)', minHeight: '18px', margin: '6px 0 0' } });
    const go = h('button', { class: 'btn primary', onclick: async () => {
      go.disabled = true; go.textContent = 'Checking…'; errLine.textContent = '';
      try {
        const profile = await S.addServerProfile({ url: urlInput.value, name: nameInput.value, email: emailInput.value.trim(), password: pwInput.value, token: tokenInput.value.trim() });
        toast(`Connected "${profile.name}"`);
        render();
        then?.(profile);
      } catch (e) { errLine.textContent = errText(e); go.disabled = false; go.textContent = 'Sign in'; }
    } }, 'Sign in');
    [urlInput, nameInput, emailInput, pwInput, tokenInput].forEach((el) => el.addEventListener('keydown', (e) => { if (e.key === 'Enter') go.click(); }));
    setTimeout(() => urlInput.focus(), 50);
    return h('div', null,
      h('p', null, 'Point Dispatch at a self-hosted Dispatch server. It mirrors Postman’s sync — workspaces, collections and environments keep working the same. Get the server URL and an account from whoever runs it.'),
      h('div', { class: 'form-grid' },
        h('label', null, 'Server URL'), urlInput,
        h('label', null, 'Profile name'), nameInput,
        h('label', null, 'Email'), emailInput,
        h('label', null, 'Password'), pwInput,
        h('label', null, 'Token'), h('div', null, tokenInput, h('p', { class: 'hint', style: { margin: '2px 0 0' } }, 'Optional — leave blank to sign in with your email and password.'))),
      errLine);
  };

  render();
  modal({ title: 'Add profile', body, wide: true });
}

/** Re-authenticate an existing Dispatch server profile (e.g. after its session expired). */
export function serverSignInDialog(p = S.activeProfile(), then) {
  if (!p || p.kind !== 'server') return;
  const urlInput = h('input', { class: 'input', value: p.url, spellcheck: 'false', style: { width: '100%' } });
  const emailInput = h('input', { class: 'input', type: 'email', placeholder: state.accounts[p.id]?.email || 'you@company.com', autocomplete: 'email', style: { width: '100%' } });
  const pwInput = h('input', { class: 'input', type: 'password', autocomplete: 'current-password', style: { width: '100%' } });
  const errLine = h('div', { class: 'hint', style: { color: 'var(--err)', minHeight: '18px', margin: '6px 0 0' } });
  let closeDlg;
  const go = h('button', { class: 'btn primary', onclick: async () => {
    go.disabled = true; go.textContent = 'Signing in…'; errLine.textContent = '';
    try {
      await S.serverSignIn({ profileId: p.id, url: urlInput.value, email: emailInput.value.trim(), password: pwInput.value });
      toast(`Signed in to "${p.name}"`);
      closeDlg();
      then?.();
    } catch (e) { errLine.textContent = errText(e); go.disabled = false; go.textContent = 'Sign in'; }
  } }, 'Sign in');
  [urlInput, emailInput, pwInput].forEach((el) => el.addEventListener('keydown', (e) => { if (e.key === 'Enter') go.click(); }));
  closeDlg = modal({
    title: `Sign in to ${p.name}`,
    body: h('div', null,
      h('p', null, 'Your Dispatch server session has expired — sign in again to keep this profile syncing.'),
      h('div', { class: 'form-grid' },
        h('label', null, 'Server URL'), urlInput,
        h('label', null, 'Email'), emailInput,
        h('label', null, 'Password'), pwInput,
        h('label', null, ''), go),
      errLine),
    wide: true,
  });
  setTimeout(() => emailInput.focus(), 50);
}

/** Current version and a "Check for updates" button. */
function updatesRow() {
  const ver = h('span', { class: 'mono' }, '…');
  import('../updater.js').then(async (u) => { ver.textContent = (await u.currentVersion()) || 'browser preview'; });
  return h('div', { class: 'row' }, ver, h('button', { class: 'btn sm', onclick: async () => (await import('../updater.js')).checkNow() }, 'Check for updates'));
}

export function openSettings() {
  const s = state.settings;
  const body = h('div');
  const render = async () => {
    const profileRows = state.profiles.map((p) => {
      const acc = state.accounts[p.id];
      const who = acc?.fullName || acc?.username;
      const active = p.id === s.activeProfileId;
      const menu = (e) => showMenu(e, [
        { label: 'Rename…', icon: 'edit', onClick: async () => { const n = await promptDialog({ title: 'Rename profile', value: p.name }); if (n) { await S.renameProfile(p.id, n); render(); } } },
        p.kind === 'postman' && { label: `Region: switch to ${p.region === 'eu' ? 'US' : 'EU'}`, icon: 'globe', onClick: async () => { await S.setProfileRegion(p.id, p.region === 'eu' ? 'us' : 'eu'); render(); } },
        p.kind === 'server' && { label: 'Sign in again…', icon: 'key', onClick: async () => { await serverSignInDialog(p, render); } },
        p.kind !== 'local' && {
          label: p.kind === 'postman' ? 'Disconnect and remove key' : 'Disconnect and sign out',
          icon: 'logout',
          onClick: async () => {
            const confirmMsg = p.kind === 'postman'
              ? 'Your API key is removed from this device. Collections already downloaded stay here, but stop syncing until you reconnect.'
              : 'Your server token is removed from this device. Collections already downloaded stay here, but stop syncing until you sign in again.';
            if (await confirmDialog({ title: `Disconnect "${p.name}"?`, message: confirmMsg, confirm: 'Disconnect', danger: true })) { await S.removeProfile(p.id); render(); }
          },
        },
      ].filter(Boolean));
      return h('div', { class: 'row', style: { padding: '6px 0' } },
        h('div', { class: 'avatar', title: acc?.email || '' }, (acc?.fullName || acc?.username || p.name).slice(0, 1).toUpperCase()),
        h('div', { class: 'grow' },
          h('div', { style: { fontWeight: active ? 600 : 400 } }, p.name, active ? h('span', { class: 'muted', style: { fontWeight: 400 } }, ' · active') : null),
          h('div', { class: 'muted', style: { fontSize: '12px' } },
            p.kind === 'local' ? 'This device — requests and collections stay here'
              : p.kind === 'server' ? (who ? `${who} · ${p.url}` : p.url)
              : `${who || 'Postman'}${p.region === 'eu' ? ' · EU region' : ''}`)),
        !active && h('button', { class: 'btn sm', onclick: () => S.switchProfile(p.id).catch((e) => toast(errText(e), { error: true })) }, 'Switch'),
        p.kind !== 'local' && h('button', { class: 'icon-btn sm', title: 'Profile actions', onclick: menu }, icon('more')));
    });

    const num = (key, min, max) => h('input', { class: 'input', type: 'number', min, max, value: s[key], style: { width: '120px' }, oninput: (e) => { s[key] = Math.max(min, Math.min(max, Number(e.target.value) || min)); S.saveSettings(); } });
    const toggle = (key) => h('input', { type: 'checkbox', checked: s[key], onchange: (e) => { s[key] = e.target.checked; S.saveSettings(); } });

    // ---- Certificates & proxy ----
    const transportBox = h('div');
    {
      const cfg = (await bridge.read('certificates').catch(() => null)) || { hosts: {}, proxyUrl: '' };
      cfg.hosts = cfg.hosts || {};
      const save = () => bridge.write('certificates', cfg).catch((e) => console.error('save failed certificates', e));

      const renderTransport = () => {
        const proxyInput = h('input', { class: 'input', value: cfg.proxyUrl || '', placeholder: 'http://user:pass@proxy:8080 — applies to every request', style: { width: '100%' } });
        proxyInput.addEventListener('change', () => { cfg.proxyUrl = proxyInput.value.trim(); save(); });
        const rows = Object.entries(cfg.hosts).map(([hostk, entry]) => {
          const slot = pwSlotKey(entry.slot || hostk);
          const pw = h('input', { class: 'input', type: 'password', placeholder: 'password', style: { width: '140px' } });
          bridge.secretGet(slot).then((v) => { pw.value = v || ''; }).catch(() => {});
          pw.addEventListener('change', () => { entry.slot = pwSlotKey(entry.slot || hostk); bridge.secretPut(slot, pw.value).catch(() => {}); });
          return h('div', { class: 'row', style: { padding: '4px 0' } },
            h('span', { class: 'grow', style: { fontFamily: 'var(--mono, monospace)', fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis' } }, hostk),
            h('span', { class: 'muted', style: { fontSize: '11px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '34%' } }, entry.path),
            pw,
            h('button', { class: 'icon-btn sm', title: 'Remove', onclick: () => { bridge.secretPut(slot, '').catch(() => {}); delete cfg.hosts[hostk]; save(); renderTransport(); } }, icon('x')));
        });
        const hostInput = h('input', { class: 'input', placeholder: 'api.example.com', style: { width: '190px' } });
        const addPw = h('input', { class: 'input', type: 'password', placeholder: 'password', style: { width: '140px' } });
        let path = '';
        const pickBtn = h('button', { class: 'btn sm', title: 'Where the certificate file lives (.pfx/.p12 or PEM)', onclick: async () => {
          const r = await bridge.pickFilePath();
          if (r) { path = r; pickBtn.textContent = r.split(/[\\/]/).pop(); }
        } }, 'Choose certificate…');
        const addBtn = h('button', { class: 'btn sm primary', onclick: async () => {
          const hostk = hostInput.value.trim().toLowerCase();
          if (!hostk || !path) { toast('Enter the host and choose a certificate file', { error: true }); return; }
          cfg.hosts[hostk] = { path, slot: pwSlotKey(hostk) };
          await bridge.secretPut(pwSlotKey(hostk), addPw.value).catch(() => {});
          save();
          toast(`Client certificate set for ${hostk}`);
          renderTransport();
        } }, 'Add');
        transportBox.replaceChildren(
          h('div', { class: 'form-grid', style: { marginTop: '10px' } }, h('label', null, 'Proxy'), h('div', null, proxyInput)),
          rows.length ? h('div', { style: { marginTop: '10px' } }, rows) : h('p', { class: 'hint', style: { margin: '8px 0 0' } }, 'No client certificates set.'),
          h('div', { class: 'row', style: { marginTop: '10px' } }, hostInput, pickBtn, addPw, addBtn));
      };
      renderTransport();
    }

    body.replaceChildren(
      h('div', { class: 'settings-section' },
        h('h3', null, 'Profiles'),
        profileRows,
        h('div', { class: 'row', style: { marginTop: '10px' } },
          h('button', { class: 'btn', onclick: () => addProfileDialog(() => render()) }, icon('plus'), 'Add profile'),
          h('span', { class: 'hint', style: { margin: 0 } }, 'The active profile decides which account syncs and where cloud calls go.'))),
      h('div', { class: 'settings-section' }, h('h3', null, 'Syncing'),
        h('div', { class: 'form-grid' },
          h('label', null, 'When you save'),
          h('select', { class: 'select', onchange: (e) => { s.syncMode = e.target.value; S.saveSettings(); emit('sidebar'); } },
            h('option', { value: 'auto', selected: s.syncMode === 'auto' }, 'Sync to Postman right away'),
            h('option', { value: 'manual', selected: s.syncMode === 'manual' }, 'Keep local until I push')),
          h('span'), h('span', { class: 'hint', style: { margin: 0 } }, 'Each sync uses 2–3 Postman API calls. If your plan\'s monthly limit is tight, choose "Keep local until I push" and push from a collection\'s ⋯ menu.'))),
      h('div', { class: 'settings-section' }, h('h3', null, 'Updates'),
        h('div', { class: 'form-grid' }, h('label', null, 'Version'), updatesRow())),
      h('div', { class: 'settings-section' }, h('h3', null, 'Requests'),
        h('div', { class: 'form-grid' },
          h('label', null, 'Timeout (ms)'), num('timeoutMs', 1000, 600000),
          h('label', null, 'Follow redirects'), h('div', null, toggle('followRedirects')),
          h('label', null, 'Verify SSL certificates'), h('div', null, toggle('verifySsl')),
          h('label', null, 'Cookies'), h('div', { class: 'row' }, h('button', { class: 'btn sm', onclick: () => openCookieManager() }, 'Manage cookies…'), h('button', { class: 'btn ghost sm', onclick: async () => { await bridge.clearCookies(); toast('Cookies cleared'); } }, 'Clear all cookies')))),
      h('div', { class: 'settings-section' }, h('h3', null, 'AI assistant'),
        h('div', { class: 'form-grid' }, h('label', null, 'Anthropic API key'), lazyEl(() => import('./assistview.js').then((m) => m.aiKeyControl()))),
        h('p', { class: 'hint', style: { marginTop: '8px' } }, 'Writes tests from a response, explains responses and errors, and drafts requests from a description, using Claude (claude-opus-5) with your own key. Nothing is sent until you ask.')),
      h('div', { class: 'settings-section' }, h('h3', null, 'Certificates & proxy'),
        transportBox,
        h('p', { class: 'hint', style: { marginTop: '8px' } }, 'Client certificates match by host (exact or *.wildcard). Passwords are stored like API keys, never in plain files. The proxy applies to every request.')),
      h('div', { class: 'settings-section' }, h('h3', null, 'Appearance'),
        h('div', { class: 'form-grid' },
          h('label', null, 'Theme'),
          h('select', { class: 'select', onchange: (e) => { s.theme = e.target.value; S.saveSettings(); applyTheme(); } },
            [['system', 'Match system'], ['light', 'Light'], ['dark', 'Dark']].map(([v, l]) => h('option', { value: v, selected: s.theme === v }, l))))),
    );
    if (callsRemaining != null) body.prepend(h('p', { class: 'hint' }, `Postman API calls left this month: ${callsRemaining.toLocaleString()}.`));
  };
  render();
  modal({ title: 'Settings', body, wide: true });
}

export function applyTheme() {
  const t = state.settings.theme;
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}

// ---------- welcome & empty ----------

export function renderWelcome(root) {
  const keyInput = h('input', { class: 'input grow', type: 'password', placeholder: 'Paste your Postman API key (PMAK-…)' });
  const nameInput = h('input', { class: 'input grow', placeholder: 'Profile name (optional — defaults to the Postman username)' });
  const err = h('div', { class: 'err-text' });
  const eu = h('input', { type: 'checkbox', checked: state.settings.region === 'eu' });
  const btn = h('button', { class: 'btn primary', onclick: async () => {
    btn.disabled = true; btn.textContent = 'Connecting…'; err.textContent = '';
    try {
      const profile = await S.addProfile({ key: keyInput.value, name: nameInput.value, region: eu.checked ? 'eu' : 'us' });
      toast(`Connected. "${profile.name}" profiles are syncing.`);
      emit('all');
    }
    catch (e) { err.textContent = errText(e); btn.disabled = false; btn.textContent = 'Connect'; }
  } }, 'Connect');
  keyInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') btn.click(); });
  root.replaceChildren(h('div', { class: 'center-screen' }, h('div', { class: 'welcome' },
    logoSvg(),
    h('h1', null, 'Connect your Postman account'),
    h('p', { class: 'lead' }, 'Dispatch syncs your workspaces, collections and environments through Postman\'s official API, so your team keeps working in Postman while you use something lighter. You can also work entirely on this device — add accounts later, and switch between them any time.'),
    apiKeyHelp({ open: true }),
    h('div', { class: 'row', style: { marginBottom: '6px' } }, nameInput),
    h('div', { class: 'row' }, keyInput, btn),
    h('label', { class: 'check hint', style: { marginTop: '8px' } }, eu, ' My Postman team is hosted in the EU region'),
    err,
    h('div', { class: 'row', style: { marginTop: '18px' } },
      h('button', { class: 'btn ghost', onclick: () => { state.settings.onboarded = true; S.saveSettings(); emit('all'); } }, 'Start on this device, without Postman'),
      h('button', { class: 'btn ghost', onclick: () => addProfileDialog(() => { state.settings.onboarded = true; S.saveSettings(); emit('all'); }) }, 'Add another account')))));
  setTimeout(() => keyInput.focus(), 50);
}

export function renderEmpty(root) {
  root.replaceChildren(h('div', { class: 'center-screen' }, h('div', { class: 'empty-main' },
    logoSvg(),
    h('h2', null, state.ws?.collections.length ? 'Open a request from the sidebar' : 'Nothing open'),
    h('div', null, S.isCloud() ? `Workspace: ${state.ws.name}` : 'Local workspace on this device'),
    h('div', { class: 'row' },
      h('button', { class: 'btn primary', onclick: () => C.openDraft() }, icon('plus'), 'New request'),
      h('button', { class: 'btn', onclick: async () => { try { const r = await S.importFromFile(); if (r) toast(`Imported "${r.name}"`); } catch (e) { toast(errText(e), { error: true }); } } }, icon('download'), 'Import')),
    h('div', { class: 'shortcuts' },
      h('span', null, '⌘ T'), h('span', null, 'New request'),
      h('span', null, '⌘ ↵'), h('span', null, 'Send'),
      h('span', null, '⌘ S'), h('span', null, 'Save'),
      h('span', null, '⌘ W'), h('span', null, 'Close tab'),
      h('span', null, '⌘ L'), h('span', null, 'Focus URL'),
      h('span', null, '⌘ ,'), h('span', null, 'Settings')))));
}

/** Small popover listing the active environment's resolved values. */
export function envQuickLook(anchor) {
  const env = S.activeEnvEntry();
  const t = C.activeTab();
  const scopes = C.scopesFor(t);
  const section = (title, scope) => {
    const obj = scope.toObject();
    const keys = Object.keys(obj);
    return h('div', { style: { marginBottom: '12px' } },
      h('div', { class: 'pane-title' }, title),
      keys.length ? h('table', { class: 'hdr-table' }, keys.map((k) => h('tr', null, h('td', null, k), h('td', null, (scope.values.find((v) => v.key === k)?.type === 'secret') ? '••••••' : String(obj[k]))))) : h('div', { class: 'faint', style: { fontSize: '12px', padding: '0 0 4px' } }, 'None'));
  };
  modal({
    title: env ? `Variables: ${env.name}` : 'Variables',
    body: h('div', null,
      section(env ? `Environment · ${env.name}` : 'Environment (none selected)', scopes.environment),
      C.contextFor(t).collection ? section(`Collection · ${C.contextFor(t).collection.info?.name}`, scopes.collection) : null,
      section('Globals', scopes.globals)),
    actions: env ? [{ label: 'Edit environment', primary: true, onClick: () => C.openEnv(env) }] : [],
  });
}
