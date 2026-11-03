// App state, persistence and workspace operations.

import { bridge, region, callCtx } from './bridge.js';
import * as cloud from './sync.js';
import { clone, newCollection, forExport, ensureIds, uuid, serverBaseUrl } from './model.js';
import { loadVendor } from './vendor.js';

export const LOCAL_WS = { id: 'local', name: 'On this device (not synced)', type: 'local' };

export const state = {
  ready: false,
  settings: {
    timeoutMs: 30000,
    followRedirects: true,
    verifySsl: true,
    theme: 'system',
    syncMode: 'auto', // 'auto' pushes on save; 'manual' waits for Push
    wsId: null,
    envByWs: {},
    sidebarWidth: 290,
    responseRatio: 0.48,
    layout: 'stacked', // or 'side': request and response side by side
    sideRatio: 0.5,
    onboarded: false,
    region: 'us',
    wsByProfile: {},
  },
  account: null, // { username, fullName, email } for the active profile
  accounts: {}, // profileId → account
  profiles: [], // [{ id, name, kind: 'local'|'postman'|'server', region?, url? }]
  hasKey: false, // the active profile syncs with Postman or a Dispatch server
  sessionExpired: false, // a Dispatch server rejected its stored token
  workspaces: [LOCAL_WS],
  ws: null,
  tabs: [],
  activeTab: null,
  history: [],
  syncing: false,
  syncError: null,
  lastSync: null,
};

// ---------- events ----------
const listeners = new Map();
export function on(evt, fn) { (listeners.get(evt) || listeners.set(evt, new Set()).get(evt)).add(fn); }
export function emit(...evts) { for (const e of evts) listeners.get(e)?.forEach((fn) => fn()); }

/** Called with a collection entry whenever its contents change (edits, pulls). */
export const collectionHooks = new Set();
const collectionTouched = (entry) => { for (const fn of collectionHooks) { try { fn(entry); } catch (e) { console.error(e); } } };

// ---------- persistence ----------
const timers = {};
function persist(name, getValue, ms = 300) {
  clearTimeout(timers[name]);
  timers[name] = setTimeout(() => bridge.write(name, getValue()).catch((e) => console.error('save failed', name, e)), ms);
}
export const saveSettings = () => { region.value = activeProfile()?.region || state.settings.region || 'us'; persist('settings', () => state.settings); };
export const saveWorkspace = (ws = state.ws) => { if (ws) persist(`ws-${ws.id}`, () => ws); };
export const saveTabs = () => persist('tabs', () => ({ tabs: state.tabs.map(serialTab), activeTab: state.activeTab }), 500);
export const saveHistory = () => persist('history', () => state.history, 800);

function serialTab(t) {
  // Responses can be large; keep them out of the saved tab list.
  const { response, running, stream, ...rest } = t;
  if (rest.wsConn) {
    // Connections die with the process; keep the frame log for review only.
    rest.wsConn = { status: 'disconnected', log: rest.wsConn.log || [] };
  }
  return rest;
}

const applyCallCtx = () => {
  const p = state.profiles.find((x) => x.id === state.settings.activeProfileId) || state.profiles[0];
  const cloudP = cloudProfile(p);
  callCtx.profileId = cloudP ? p.id : null;
  callCtx.region = p.region || 'us';
  callCtx.server = p.kind === 'server';
  callCtx.baseUrl = p.kind === 'server' ? p.url : null;
  region.value = callCtx.region;
};

const cloudProfile = (p) => p.kind === 'postman' || p.kind === 'server';

export async function init() {
  const [settings, tabs, history, accounts] = await Promise.all([
    bridge.read('settings'), bridge.read('tabs'), bridge.read('history'), bridge.read('accounts'),
  ]);
  Object.assign(state.settings, settings || {});
  region.value = state.settings.region || 'us';
  state.history = history || [];
  state.accounts = accounts || {};
  state.profiles = (state.settings.profiles || []).filter((p) => p && p.id && (p.kind === 'postman' || p.kind === 'server'));

  // First boot after profiles existed: migrate the legacy single key.
  if (!state.profiles.length && !(await bridge.hasApiKey('postman').catch(() => false)) && (await bridge.hasLegacyKey().catch(() => false))) {
    if (await bridge.migrateLegacyKey('postman').catch(() => false)) {
      state.profiles.push({ id: 'postman', name: state.accounts.postman?.username || 'Postman', kind: 'postman', region: state.settings.region || 'us' });
      state.accounts.postman = state.accounts.postman || ((await bridge.read('account')) ?? settings?.account) || null;
      await bridge.write('accounts', state.accounts);
    }
  }

  if (!state.settings.onboarded && state.profiles.length) state.settings.onboarded = true;
  // The local profile is built in and always first.
  state.profiles = [{ id: 'local', name: 'On this device (not synced)', kind: 'local', region: 'us' }].concat(state.profiles.filter((p) => p.kind !== 'local'));
  state.settings.profiles = state.profiles; // keep the persisted copy in one place
  // Upgraded users land on their existing Postman sync, as before.
  const firstPostman = state.profiles.find((p) => p.kind === 'postman');
  if (!(settings?.profiles?.length) && firstPostman) state.settings.activeProfileId = firstPostman.id;
  else state.settings.activeProfileId = state.profiles.some((p) => p.id === state.settings.activeProfileId) ? state.settings.activeProfileId : 'local';
  applyCallCtx();

  if (tabs?.tabs) { state.tabs = tabs.tabs; state.activeTab = tabs.activeTab; }
  const meta = activeProfile();
  state.account = state.accounts[meta.id] || null;
  state.hasKey = meta.kind !== 'local';
  state.sessionExpired = false;

  const wsList = state.hasKey ? ((await bridge.read(`workspaces-${meta.id}`)) || (await bridge.read('workspaces')) || []) : [];
  state.workspaces = wsList.length ? [...wsList, LOCAL_WS] : [LOCAL_WS];
  const wsId = state.settings.wsId && state.workspaces.some((w) => w.id === state.settings.wsId) ? state.settings.wsId : state.workspaces[0].id;
  await openWorkspace(wsId, { refresh: false });
  state.ready = true;
  emit('all');
  if (state.hasKey) refreshAll().catch(() => {});
}

// ---------- account ----------

export function activeProfile() {
  return state.profiles.find((p) => p.id === state.settings.activeProfileId) || state.profiles[0];
}

/** Add a Postman account: verify the key, store it under the profile, switch to it. */
export async function addProfile({ key, name, region: profRegion }) {
  const id = uuid().replace(/-/g, '');
  const me = await bridge.setApiKey(key, id, profRegion || 'us');
  const profile = { id, name: (name || '').trim() || me.user?.username || me.user?.fullName || 'Postman', kind: 'postman', region: profRegion || 'us' };
  state.profiles.push(profile);
  state.settings.profiles = state.profiles;
  state.accounts[id] = { username: me.user?.username, fullName: me.user?.fullName, email: me.user?.email };
  await bridge.write('accounts', state.accounts);
  state.settings.onboarded = true;
  await switchProfile(id);
  return profile;
}

/** Sign a Dispatch server profile in with email+password, or verify a pre-issued token. */
export async function serverAuth({ profileId, url: rawUrl, email, password, token }) {
  const base = serverBaseUrl(rawUrl);
  return bridge.serverAuth({ profileId, baseUrl: base, email: email || null, password: password || null, token: token || null });
}

/** Add a Dispatch server profile: sign in (or verify a token), store it, switch to it. */
export async function addServerProfile({ url, name, email, password, token }) {
  const id = uuid().replace(/-/g, '');
  const me = await serverAuth({ profileId: id, url, email, password, token });
  const profile = { id, name: (name || '').trim() || me.user?.username || me.user?.fullName || (email || '').split('@')[0] || 'Dispatch server', kind: 'server', url: serverBaseUrl(url) };
  state.profiles.push(profile);
  state.settings.profiles = state.profiles;
  state.accounts[id] = { username: me.user?.username, fullName: me.user?.fullName, email: me.user?.email || email || null };
  await bridge.write('accounts', state.accounts);
  state.settings.onboarded = true;
  await switchProfile(id);
  return profile;
}

/** Sign an existing Dispatch server profile in again, keeping the profile. */
export async function serverSignIn({ profileId, url, email, password, token }) {
  const profile = state.profiles.find((p) => p.id === profileId && p.kind === 'server');
  if (!profile) throw new Error('That profile is no longer available.');
  const me = await serverAuth({ profileId, url, email, password, token });
  profile.url = serverBaseUrl(url);
  state.settings.profiles = state.profiles;
  state.accounts[profileId] = { username: me.user?.username, fullName: me.user?.fullName, email: me.user?.email || state.accounts[profileId]?.email || email || null };
  state.sessionExpired = false;
  if (profile.id === state.settings.activeProfileId) {
    state.account = state.accounts[profileId];
    applyCallCtx();
  }
  saveSettings();
  emit('all');
  refreshAll().catch(() => {});
  return me;
}

/** A Dispatch server rejected its stored token: remember it so the UI offers "Sign in again". */
cloud.onAuthLost(() => {
  if (activeProfile()?.kind !== 'server' || state.sessionExpired) return;
  state.sessionExpired = true;
  emit('all');
});

export async function switchProfile(id) {
  if (id === state.settings.activeProfileId || !state.profiles.some((p) => p.id === id)) return;
  saveWorkspace(); // leave the current workspace persisted on its own profile
  const profile = state.profiles.find((p) => p.id === id);
  state.settings.activeProfileId = id;
  applyCallCtx();
  state.account = state.accounts[id] || null;
  state.hasKey = profile.kind !== 'local';
  state.sessionExpired = false;
  saveSettings();
  const wsList = state.hasKey ? ((await bridge.read(`workspaces-${id}`)) || (id === 'postman' && (await bridge.read('workspaces'))) || []) : [];
  state.workspaces = wsList.length ? [...wsList, LOCAL_WS] : [LOCAL_WS];
  state.settings.wsId = state.settings.wsByProfile?.[id] || null;
  emit('all');
  const wsId = state.settings.wsId && state.workspaces.some((w) => w.id === state.settings.wsId) ? state.settings.wsId : state.workspaces[0].id;
  await openWorkspace(wsId, { refresh: false });
  if (state.hasKey) refreshAll().catch(() => {});
}

export async function renameProfile(id, name) {
  const p = state.profiles.find((x) => x.id === id);
  if (!p || !name?.trim()) return;
  p.name = name.trim();
  state.settings.profiles = state.profiles;
  saveSettings();
  emit('all');
}

export async function setProfileRegion(id, value) {
  const p = state.profiles.find((x) => x.id === id);
  if (!p) return;
  p.region = value === 'eu' ? 'eu' : 'us';
  state.settings.profiles = state.profiles;
  if (p.id === state.settings.activeProfileId) applyCallCtx();
  saveSettings();
  emit('all');
}

/** Remove a cloud profile (Postman or Dispatch server): deletes its stored secret. The local profile stays. */
export async function removeProfile(id) {
  const profile = state.profiles.find((p) => p.id === id);
  if (!profile || !cloudProfile(profile)) return;
  await bridge.deleteApiKey(id);
  state.profiles = state.profiles.filter((p) => p.id !== id);
  state.settings.profiles = state.profiles;
  delete state.accounts[id];
  await bridge.write('accounts', state.accounts);
  if (state.settings.activeProfileId === id) await switchProfile(state.profiles[0].id);
  else { saveSettings(); emit('all'); }
}

// ---------- workspaces ----------

function emptyWs(meta) {
  return { id: meta.id, name: meta.name, type: meta.type, collections: [], environments: [], globals: { values: [], overlay: {}, dirty: false }, colOverlays: {} };
}

export async function openWorkspace(id, { refresh = true } = {}) {
  const meta = state.workspaces.find((w) => w.id === id) || LOCAL_WS;
  const saved = await bridge.read(`ws-${id}`);
  state.ws = saved || emptyWs(meta);
  for (const c of state.ws.collections) delete c.pushing; // never resume mid-push state
  state.ws.name = meta.name;
  state.ws.globals = state.ws.globals || { values: [], overlay: {}, dirty: false };
  state.ws.colOverlays = state.ws.colOverlays || {};
  state.settings.wsId = id;
  state.settings.wsByProfile = state.settings.wsByProfile || {};
  state.settings.wsByProfile[state.settings.activeProfileId] = id;
  // No workspace-level env choice yet? Start on this profile's default.
  if (state.settings.envByWs?.[id] === undefined) {
    state.settings.envByWs = state.settings.envByWs || {};
    const profileDefault = state.settings.envByProfile?.[state.settings.activeProfileId];
    if (profileDefault !== undefined) {
      const known = state.ws.environments.some((e) => e.uid === profileDefault);
      if (known || profileDefault === null) state.settings.envByWs[id] = profileDefault || null;
    }
  }
  saveSettings();
  emit('sidebar', 'env', 'workspace');
  if (refresh && id !== 'local' && state.hasKey) await refreshWorkspace().catch(() => {});
}

export const isCloud = () => state.ws && state.ws.id !== 'local';

export async function refreshAll() {
  if (!state.hasKey) return;
  state.syncing = true;
  state.syncError = null;
  emit('sync');
  try {
    const list = await cloud.listWorkspaces();
    state.workspaces = [...list, LOCAL_WS];
    bridge.write(`workspaces-${state.settings.activeProfileId}`, list);
    const preferred = list.find((w) => w.type === 'personal') || list[0];
    const currentGone = !state.workspaces.some((w) => w.id === state.ws?.id);
    const neverChose = state.ws?.id === 'local' && !state.settings.wsChosen && !state.ws.collections.length;
    if (preferred && (currentGone || neverChose)) await openWorkspace(preferred.id, { refresh: false });
    emit('workspace');
    if (isCloud()) await refreshWorkspace(true);
  } catch (e) {
    state.syncError = String(e);
    throw e;
  } finally {
    state.syncing = false;
    emit('sync');
  }
}

// ---------- push queue ----------
// Pushes for the same collection or environment run one at a time, so two
// quick saves can never reach Postman out of order or create an item twice.
const chains = new WeakMap();
function queued(target, fn) {
  const prev = chains.get(target) || Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  chains.set(target, run);
  return run;
}
const settle = (target) => (chains.get(target) || Promise.resolve()).catch(() => {});

/** Pull the collection and environment lists, then any changed items we already use. */
export async function refreshWorkspace(inner = false) {
  if (!isCloud() || !state.hasKey) return;
  const ws = state.ws;
  if (!inner) { state.syncing = true; state.syncError = null; emit('sync'); }
  try {
    // Let in-flight pushes finish so a half-created collection isn't listed twice.
    await Promise.all([...ws.collections, ...ws.environments].map(settle));
    const [cols, envs, globals] = await Promise.all([
      cloud.listCollections(ws.id),
      cloud.listEnvironments(ws.id),
      cloud.getGlobals(ws.id).catch(() => undefined), // undefined = couldn't check this time
    ]);
    if (state.ws !== ws) return; // switched away meanwhile

    // Collections
    const byUid = Object.fromEntries(ws.collections.map((c) => [c.uid, c]));
    const next = [];
    const toPull = [];
    for (const r of cols) {
      const local = byUid[r.uid];
      if (!local) {
        next.push({ uid: r.uid, name: r.name, updatedAt: r.updatedAt, data: null, dirty: false });
        continue;
      }
      if (!local.dirty) local.name = r.name;
      if (r.updatedAt !== local.updatedAt) {
        if (local.dirty) local.conflict = r.updatedAt;
        else if (local.data) toPull.push(local);
        else local.updatedAt = r.updatedAt;
      }
      next.push(local);
      delete byUid[r.uid];
    }
    // Deleted in Postman: drop unless there are unsaved local changes.
    for (const gone of Object.values(byUid)) if (gone.dirty || gone.pendingCreate) { gone.deletedRemotely = !gone.pendingCreate; next.push(gone); }
    ws.collections = next;

    // Environments
    const envByUid = Object.fromEntries(ws.environments.map((e) => [e.uid, e]));
    const envNext = envs.map((r) => {
      const local = envByUid[r.uid];
      delete envByUid[r.uid];
      if (!local) return { uid: r.uid, name: r.name, updatedAt: r.updatedAt, data: null, overlay: {}, dirty: false };
      if (r.updatedAt !== local.updatedAt) {
        if (local.dirty) local.conflict = r.updatedAt;
        else { local.stale = true; local.updatedAt = r.updatedAt; }
      }
      if (!local.dirty) local.name = r.name;
      return local;
    });
    for (const gone of Object.values(envByUid)) if (gone.dirty || gone.pendingCreate) envNext.push(gone);
    ws.environments = envNext;

    // Globals: null means this workspace doesn't offer them.
    if (globals === null) ws.globals.unsupported = true;
    else if (globals !== undefined) {
      const snap = JSON.stringify(globals);
      if (ws.globals.dirty) { if (ws.globals.loaded && snap !== ws.globals.remoteSnap) ws.globals.conflict = true; }
      else { ws.globals.values = globals; ws.globals.remoteSnap = snap; }
      ws.globals.loaded = true;
      delete ws.globals.unsupported;
    }

    await Promise.all(toPull.map((c) => pullCollection(c, { ws })));
    const active = activeEnvEntry();
    if (active && (!active.data || active.stale) && !active.dirty) await pullEnvironment(active, { ws });

    state.lastSync = Date.now();
    saveWorkspace(ws);
    emit('sidebar', 'env', 'tabs-refresh');
  } catch (e) {
    state.syncError = String(e);
    throw e;
  } finally {
    if (!inner) { state.syncing = false; emit('sync'); }
  }
}

// ---------- collections ----------

export function collectionEntry(uid) { return state.ws?.collections.find((c) => c.uid === uid); }

/** Download a collection. Unless `discard`, local edits made meanwhile are never overwritten. */
export async function pullCollection(entry, { ws = state.ws, discard = false } = {}) {
  const before = entry.localUpdatedAt;
  const data = await cloud.getCollection(entry.uid);
  if (!discard && (entry.dirty || entry.localUpdatedAt !== before)) {
    // Edited while downloading: keep the local edits; flag only if Postman moved on too.
    if (data.info?.updatedAt && data.info.updatedAt !== entry.updatedAt) entry.conflict = data.info.updatedAt;
    saveWorkspace(ws);
    emit('sidebar');
    return entry;
  }
  entry.data = data;
  entry.name = data.info?.name || entry.name;
  entry.updatedAt = data.info?.updatedAt || entry.updatedAt;
  entry.dirty = false;
  delete entry.conflict;
  delete entry.deletedRemotely;
  saveWorkspace(ws);
  emit('sidebar', 'tabs-refresh');
  collectionTouched(entry);
  return entry;
}

export async function ensureCollection(entry) {
  if (!entry.data && isCloud() && !entry.pendingCreate) await pullCollection(entry);
  return entry.data;
}

export class ConflictError extends Error {
  constructor(entry, kind = 'collection') { super(`"${entry.name}" was changed in Postman since you last synced.`); this.entry = entry; this.kind = kind; }
}

/** Mark a collection changed, persist it, and push if automatic sync is on. */
export async function collectionChanged(entry, { push = state.settings.syncMode === 'auto' } = {}) {
  entry.dirty = true;
  entry.localUpdatedAt = Date.now() + Math.random(); // unique even within the same millisecond
  if (entry.data?.info) entry.name = entry.data.info.name;
  saveWorkspace();
  emit('sidebar');
  collectionTouched(entry);
  if (push && isCloud() && state.hasKey) return pushCollection(entry);
}

/**
 * Upload a collection. `ws` is captured when the edit happened, so a delayed
 * push still goes to the right workspace after you switch.
 */
export function pushCollection(entry, { force = false, ws = state.ws } = {}) {
  return queued(entry, () => doPushCollection(entry, { force, ws }));
}

async function doPushCollection(entry, { force, ws }) {
  if (ws.id === 'local' || !entry.data) return;
  if (!entry.dirty && !entry.pendingCreate && !force) return; // an earlier queued push already sent it
  entry.pushing = true;
  emit('sidebar');
  try {
    if (entry.pendingCreate) {
      const version = entry.localUpdatedAt;
      const created = await cloud.createCollection(ws.id, entry.data);
      const oldUid = entry.uid;
      entry.uid = created.uid;
      delete entry.pendingCreate;
      remapCollectionUid(ws, oldUid, created.uid);
      // Fetch what Postman stored so item ids and the version stamp match exactly.
      const remote = await cloud.getCollection(created.uid);
      const idMap = mapIds(entry.data.item || [], remote.item || []);
      if (entry.localUpdatedAt === version) {
        entry.data = remote;
        entry.dirty = false;
      } else {
        // Edited while creating: keep the edits, adopt Postman's ids, push again later.
        applyIdMap(entry.data.item || [], idMap);
      }
      entry.updatedAt = remote.info?.updatedAt || (await cloud.listCollections(ws.id)).find((c) => c.uid === entry.uid)?.updatedAt || null;
      remapItemIds(ws, entry.uid, idMap);
    } else {
      if (!force) {
        const remote = (await cloud.listCollections(ws.id)).find((c) => c.uid === entry.uid);
        if (!remote) { entry.deletedRemotely = true; throw new Error(`"${entry.name}" no longer exists in Postman. Export it from the ⋯ menu to keep a copy.`); }
        if (remote.updatedAt !== entry.updatedAt) { entry.conflict = remote.updatedAt; throw new ConflictError(entry); }
      }
      const version = entry.localUpdatedAt;
      await cloud.putCollection(entry.uid, entry.data);
      const after = (await cloud.listCollections(ws.id)).find((c) => c.uid === entry.uid);
      entry.updatedAt = after?.updatedAt || entry.updatedAt;
      if (entry.localUpdatedAt === version) entry.dirty = false; // otherwise newer edits still need pushing
    }
    delete entry.conflict;
  } finally {
    entry.pushing = false;
    saveWorkspace(ws);
    emit('sidebar', 'sync');
  }
}

/** Pair items of two trees with the same shape (what we sent vs what Postman stored). */
function mapIds(localItems, remoteItems, map = {}) {
  localItems.forEach((l, i) => {
    const r = remoteItems[i];
    if (!r) return;
    if (l.id && r.id && l.id !== r.id) map[l.id] = r.id;
    if (l.item && r.item) mapIds(l.item, r.item, map);
  });
  return map;
}
function applyIdMap(items, map) {
  for (const it of items) { if (map[it.id]) it.id = map[it.id]; if (it.item) applyIdMap(it.item, map); }
}

/** Tabs, overlays and expanded folders refer to collections by uid. */
function remapCollectionUid(ws, oldUid, newUid) {
  if (ws.colOverlays[oldUid]) { ws.colOverlays[newUid] = ws.colOverlays[oldUid]; delete ws.colOverlays[oldUid]; }
  const exp = state.settings.expanded?.[ws.id];
  if (exp) { const i = exp.indexOf(oldUid); if (i >= 0) exp[i] = newUid; }
  for (const t of state.tabs) if (t.ws === ws.id && t.ref?.col === oldUid) t.ref.col = newUid;
  saveSettings();
  saveTabs();
}

function remapItemIds(ws, uid, map) {
  if (!Object.keys(map).length) return;
  for (const t of state.tabs) {
    if (t.ws !== ws.id || t.ref?.col !== uid || !map[t.ref.item]) continue;
    t.ref.item = map[t.ref.item];
    if (t.draft?.id) t.draft.id = t.ref.item;
  }
  const exp = state.settings.expanded?.[ws.id];
  if (exp) exp.forEach((k, i) => { if (map[k]) exp[i] = map[k]; });
  saveSettings();
  saveTabs();
  emit('tabs');
}

export async function createCollection(name) {
  const data = newCollection(name);
  const entry = { uid: `local-${uuid()}`, name, data, dirty: !!isCloud(), updatedAt: null, pendingCreate: isCloud(), localUpdatedAt: Date.now() };
  state.ws.collections.push(entry);
  saveWorkspace();
  emit('sidebar');
  if (isCloud() && state.hasKey) await pushCollection(entry);
  return entry;
}

export function removeLocalCollection(entry) {
  state.ws.collections = state.ws.collections.filter((c) => c !== entry);
  saveWorkspace();
  emit('sidebar');
}

export async function importFromFile() {
  const file = await bridge.openTextFile();
  if (!file) return null;
  return importText(file.content, file.path || '');
}

/** Import Postman, OpenAPI/Swagger, Insomnia or HAR content into this workspace. */
export async function importText(text, fileName = '') {
  const isJson = /^\s*[{[]/.test(String(text).replace(/^﻿/, ''));
  const yaml = isJson ? undefined : await loadVendor('yaml').catch(() => undefined);
  const { convertImport } = await import('./importers.js');
  const parsed = convertImport(text, { fileName, yaml });
  if (parsed.kind === 'environment') {
    const env = await addImportedEnvironment(parsed.data.name, parsed.data.values || []);
    return { kind: 'environment', name: env.name, format: parsed.format };
  }
  const data = freshIds(parsed.data); // importing the same file twice must not share ids
  delete data.info.updatedAt;
  const entry = { uid: `local-${uuid()}`, name: data.info.name, data, dirty: !!isCloud(), updatedAt: null, pendingCreate: isCloud(), localUpdatedAt: Date.now() };
  state.ws.collections.push(entry);
  saveWorkspace();
  emit('sidebar');
  for (const e of parsed.environments || []) await addImportedEnvironment(e.name, e.values);
  if (isCloud() && state.hasKey) await pushCollection(entry);
  return { kind: 'collection', name: entry.name, format: parsed.format, environments: (parsed.environments || []).length };
}

async function addImportedEnvironment(name, values) {
  const env = { uid: `local-${uuid()}`, name, data: { name, values }, overlay: {}, dirty: true, pendingCreate: isCloud() };
  state.ws.environments.push(env);
  await environmentChanged(env);
  return env;
}

export async function exportCollection(entry) {
  await ensureCollection(entry);
  const name = `${(entry.name || 'collection').replace(/[^\w.-]+/g, '_')}.postman_collection.json`;
  return bridge.saveTextFile(name, JSON.stringify(forExport(entry.data), null, 2));
}

export async function exportEnvironment(env) {
  await ensureEnvironment(env);
  const out = { id: env.data.id || uuid(), name: env.name, values: env.data.values, _postman_variable_scope: 'environment' };
  return bridge.saveTextFile(`${env.name.replace(/[^\w.-]+/g, '_')}.postman_environment.json`, JSON.stringify(out, null, 2));
}

// ---------- environments ----------

export function activeEnvEntry() {
  const uid = state.settings.envByWs[state.ws?.id];
  return state.ws?.environments.find((e) => e.uid === uid) || null;
}

export async function setActiveEnv(uid) {
  state.settings.envByWs[state.ws.id] = uid || null;
  // Per-profile default: remember this env for the workspace's profile,
  // so a fresh workspace on this profile starts on the right environment.
  state.settings.envByProfile = state.settings.envByProfile || {};
  state.settings.envByProfile[state.settings.activeProfileId] = uid || null;
  saveSettings();
  const env = activeEnvEntry();
  if (env) await ensureEnvironment(env).catch(() => {});
  emit('env');
}

export async function pullEnvironment(env, { ws = state.ws, discard = false } = {}) {
  const wasDirty = env.dirty;
  const data = await cloud.getEnvironment(env.uid);
  if (!discard && (wasDirty || env.dirty)) { env.conflict = true; saveWorkspace(ws); emit('sidebar'); return; }
  env.data = { id: data.id, name: data.name, values: data.values || [] };
  env.name = data.name;
  env.dirty = false;
  delete env.stale;
  delete env.conflict;
  saveWorkspace(ws);
  emit('env', 'sidebar', 'tabs-refresh');
}

export async function ensureEnvironment(env) {
  if ((!env.data || env.stale) && isCloud() && !env.pendingCreate && !env.dirty) await pullEnvironment(env);
  env.overlay = env.overlay || {};
  return env.data;
}

export async function environmentChanged(env, { push = state.settings.syncMode === 'auto' } = {}) {
  env.dirty = true;
  env.localUpdatedAt = Date.now() + Math.random();
  saveWorkspace();
  emit('env', 'sidebar');
  if (push && isCloud() && state.hasKey) return pushEnvironment(env);
}

export function pushEnvironment(env, { force = false, ws = state.ws } = {}) {
  return queued(env, async () => {
    if (ws.id === 'local' || !env.data) return;
    if (!env.dirty && !env.pendingCreate && !force) return;
    const version = env.localUpdatedAt;
    if (env.pendingCreate) {
      const created = await cloud.createEnvironment(ws.id, env.data);
      const old = env.uid;
      env.uid = created.uid;
      delete env.pendingCreate;
      if (state.settings.envByWs[ws.id] === old) { state.settings.envByWs[ws.id] = env.uid; saveSettings(); }
      for (const t of state.tabs) if (t.ws === ws.id && t.ref?.env === old) t.ref.env = env.uid;
      saveTabs();
    } else {
      if (!force) {
        const remote = (await cloud.listEnvironments(ws.id)).find((e) => e.uid === env.uid);
        if (!remote) throw new Error(`"${env.name}" no longer exists in Postman. Export it from the ⋯ menu to keep a copy.`);
        if (env.updatedAt && remote.updatedAt !== env.updatedAt) { env.conflict = remote.updatedAt; saveWorkspace(ws); emit('sidebar'); throw new ConflictError(env, 'environment'); }
      }
      await cloud.putEnvironment(env.uid, { name: env.name, values: env.data.values });
    }
    const after = (await cloud.listEnvironments(ws.id)).find((e) => e.uid === env.uid);
    env.updatedAt = after?.updatedAt || env.updatedAt;
    if (env.localUpdatedAt === version) env.dirty = false;
    delete env.conflict;
    saveWorkspace(ws);
    emit('env', 'sidebar');
  });
}

export async function createEnvironment(name) {
  const env = { uid: `local-${uuid()}`, name, data: { name, values: [] }, overlay: {}, dirty: true, pendingCreate: isCloud() };
  state.ws.environments.push(env);
  await environmentChanged(env);
  return env;
}

export function pushGlobals({ force = false, ws = state.ws } = {}) {
  const g = ws.globals;
  return queued(g, async () => {
    if (ws.id !== 'local') {
      if (g.unsupported) throw new Error("This workspace doesn't support globals through the Postman API.");
      if (!g.loaded) throw new Error("Dispatch hasn't been able to load this workspace's globals from Postman yet, so it won't overwrite them. Sync and try again.");
      if (!force) {
        const remote = await cloud.getGlobals(ws.id);
        if (remote && JSON.stringify(remote) !== g.remoteSnap) { g.conflict = true; emit('sidebar'); throw new ConflictError({ name: 'Globals' }, 'globals'); }
      }
      const res = await cloud.putGlobals(ws.id, g.values);
      g.remoteSnap = JSON.stringify(res?.values || g.values);
    }
    g.dirty = false;
    delete g.conflict;
    saveWorkspace(ws);
    emit('env', 'sidebar');
  });
}

/** Give every item and example a new id (for imports). */
function freshIds(collection) {
  const walkItems = (items) => (items || []).forEach((it) => {
    it.id = uuid();
    delete it.uid;
    (it.response || []).forEach((r) => { r.id = uuid(); delete r.uid; });
    walkItems(it.item);
  });
  walkItems(collection.item);
  if (collection.info) collection.info._postman_id = uuid();
  return collection;
}

/** Called when scripts change current values; these stay local, like Postman. */
/** Switches between the response under the request and beside it (⌥⌘V, as in Postman). */
export function toggleLayout() {
  state.settings.layout = state.settings.layout === 'side' ? 'stacked' : 'side';
  saveSettings();
  emit('main');
}

export function overlaysChanged() {
  saveWorkspace();
  emit('env-values');
}

// ---------- history ----------

export function addHistory(entry) {
  state.history.unshift({ id: uuid(), ts: Date.now(), ...entry });
  if (state.history.length > 300) state.history.length = 300;
  saveHistory();
  emit('history');
}

export function clearHistory() {
  state.history = [];
  saveHistory();
  emit('history');
}

export { clone, ensureIds };
