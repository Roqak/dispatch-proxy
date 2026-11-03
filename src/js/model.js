// Helpers for the Postman Collection v2.1 format.
// Rule: never drop fields we don't understand. Edits patch the original
// objects so a round trip through Dispatch leaves the rest untouched.

export const SCHEMA_V21 = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';

export const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

export const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

export function uuid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export const isFolder = (item) => Array.isArray(item?.item);

// ---------- URL ----------

/** Parse a raw URL string into a Postman url object (keeps {{vars}} intact). */
export function parseUrl(raw) {
  raw = raw ?? '';
  const url = { raw };
  let rest = raw;
  const hashIdx = indexOutsideVars(rest, '#');
  if (hashIdx >= 0) {
    url.hash = rest.slice(hashIdx + 1);
    rest = rest.slice(0, hashIdx);
  }
  const qIdx = indexOutsideVars(rest, '?');
  let queryStr = null;
  if (qIdx >= 0) {
    queryStr = rest.slice(qIdx + 1);
    rest = rest.slice(0, qIdx);
  }
  const proto = rest.match(/^([a-zA-Z][\w+.-]*):\/\//);
  if (proto) {
    url.protocol = proto[1];
    rest = rest.slice(proto[0].length);
  }
  const slash = rest.indexOf('/');
  let hostPort = slash >= 0 ? rest.slice(0, slash) : rest;
  const pathStr = slash >= 0 ? rest.slice(slash + 1) : null;
  const portMatch = hostPort.match(/:(\d+|\{\{[^}]+\}\})$/);
  if (portMatch) {
    url.port = portMatch[1];
    hostPort = hostPort.slice(0, -portMatch[0].length);
  }
  url.host = hostPort ? (hostPort.startsWith('{{') && hostPort.endsWith('}}') ? [hostPort] : hostPort.split('.')) : [];
  if (pathStr !== null) url.path = pathStr.split('/');
  if (queryStr !== null) url.query = parseQuery(queryStr);
  const pathVars = (url.path || []).filter((p) => p.startsWith(':') && p.length > 1).map((p) => p.slice(1));
  if (pathVars.length) url.variable = pathVars.map((key) => ({ key, value: '' }));
  return url;
}

function indexOutsideVars(s, ch) {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.startsWith('{{', i)) { depth++; i++; continue; }
    if (s.startsWith('}}', i) && depth) { depth--; i++; continue; }
    if (!depth && s[i] === ch) return i;
  }
  return -1;
}

export function parseQuery(q) {
  if (!q) return [];
  return q.split('&').map((pair) => {
    const eq = pair.indexOf('=');
    return eq >= 0 ? { key: pair.slice(0, eq), value: pair.slice(eq + 1) } : { key: pair, value: null };
  });
}

/** Rebuild the raw string after the query table changes. */
export function rawWithQuery(raw, query) {
  const base = (() => {
    const h = indexOutsideVars(raw, '#');
    const noHash = h >= 0 ? raw.slice(0, h) : raw;
    const q = indexOutsideVars(noHash, '?');
    return q >= 0 ? noHash.slice(0, q) : noHash;
  })();
  const h = indexOutsideVars(raw, '#');
  const hash = h >= 0 ? raw.slice(h) : '';
  const enabled = (query || []).filter((p) => !p.disabled && (p.key || p.value));
  const qs = enabled.map((p) => (p.value === null || p.value === undefined ? p.key : `${p.key}=${p.value}`)).join('&');
  return base + (enabled.length ? `?${qs}` : '') + hash;
}

/** A Postman url may be a string or an object; always return the object form. */
export function urlObject(url) {
  if (!url) return parseUrl('');
  if (typeof url === 'string') return parseUrl(url);
  if (url.raw === undefined) url.raw = buildRawFromParts(url);
  return url;
}

function buildRawFromParts(u) {
  let s = '';
  if (u.protocol) s += `${u.protocol}://`;
  const host = Array.isArray(u.host) ? u.host.join('.') : u.host || '';
  s += host;
  if (u.port) s += `:${u.port}`;
  if (u.path) s += '/' + (Array.isArray(u.path) ? u.path.join('/') : u.path);
  if (u.query?.length) s += '?' + u.query.filter((q) => !q.disabled).map((q) => (q.value == null ? q.key : `${q.key}=${q.value}`)).join('&');
  if (u.hash) s += `#${u.hash}`;
  return s;
}

/** Apply a new raw URL, preserving disabled query params and path variable values. */
export function setRawUrl(request, raw) {
  const old = urlObject(request.url);
  const next = parseUrl(raw);
  // Keep each param's extra fields (description, type) and disabled params in place.
  const oldQuery = old.query || [];
  if (oldQuery.length) {
    const pool = oldQuery.filter((q) => !q.disabled);
    const parsed = (next.query || []).map((q) => {
      const i = pool.findIndex((o) => o.key === q.key);
      if (i < 0) return q;
      const [prev] = pool.splice(i, 1);
      return { ...prev, key: q.key, value: q.value };
    });
    const merged = [];
    let pi = 0;
    for (const q of oldQuery) {
      if (q.disabled) merged.push(q);
      else if (pi < parsed.length) merged.push(parsed[pi++]);
    }
    while (pi < parsed.length) merged.push(parsed[pi++]);
    next.query = merged;
  }
  if (next.variable) {
    const oldVars = Object.fromEntries((old.variable || []).map((v) => [v.key, v]));
    next.variable = next.variable.map((v) => oldVars[v.key] ? { ...oldVars[v.key] } : v);
  }
  // keep any unknown url fields
  for (const k of Object.keys(old)) if (!(k in next) && !['raw', 'protocol', 'host', 'port', 'path', 'query', 'hash', 'variable'].includes(k)) next[k] = old[k];
  request.url = next;
}

// ---------- Tree ----------

export function walk(items, fn, parents = []) {
  for (const it of items || []) {
    if (fn(it, parents) === false) return false;
    if (isFolder(it) && walk(it.item, fn, [...parents, it]) === false) return false;
  }
  return true;
}

export function findItem(collection, id) {
  let found = null;
  walk(collection.item, (it, parents) => {
    if (itemId(it) === id) { found = { item: it, parents }; return false; }
  });
  return found;
}

export function findParentList(collection, id) {
  let result = null;
  const search = (list) => {
    for (let i = 0; i < list.length; i++) {
      if (itemId(list[i]) === id) { result = { list, index: i }; return true; }
      if (isFolder(list[i]) && search(list[i].item)) return true;
    }
    return false;
  };
  search(collection.item || []);
  return result;
}

/** Every item needs a stable id for tabs; Postman items from the API have one. */
export function itemId(item) {
  if (!item.id) item.id = uuid();
  return item.id;
}

export function ensureIds(collection) {
  walk(collection.item, (it) => { itemId(it); });
  return collection;
}

export function newRequestItem(name = 'New Request') {
  return {
    id: uuid(),
    name,
    request: { method: 'GET', header: [], url: parseUrl('') },
    response: [],
  };
}

export function newFolder(name = 'New Folder') {
  return { id: uuid(), name, item: [] };
}

export function newCollection(name = 'New Collection') {
  return { info: { _postman_id: uuid(), name, schema: SCHEMA_V21 }, item: [] };
}

/** Deep copy an item for "Duplicate", giving every node new ids. */
export function duplicateItem(item) {
  const copy = clone(item);
  copy.name = `${item.name} Copy`;
  const reId = (it) => {
    it.id = uuid();
    delete it.uid;
    delete it._postman_id;
    (it.response || []).forEach((r) => { r.id = uuid(); delete r.uid; });
    (it.item || []).forEach(reId);
  };
  reId(copy);
  return copy;
}

// ---------- Examples ----------

/** Examples need a stable id for tabs too; hand-made or older ones may lack one. */
export function exampleId(ex) {
  if (!ex.id) ex.id = uuid();
  return ex.id;
}

export function findExample(item, id) {
  const list = item?.response || [];
  const index = list.findIndex((r) => exampleId(r) === id);
  return index < 0 ? null : { list, index, example: list[index] };
}

export function previewLanguage(contentType = '') {
  const ct = contentType.toLowerCase();
  if (ct.includes('json')) return 'json';
  if (ct.includes('html')) return 'html';
  if (ct.includes('xml')) return 'xml';
  if (ct.includes('javascript')) return 'javascript';
  return 'text';
}

/** A Postman example built from a response Dispatch received. */
export function exampleFromResponse(request, res, name) {
  return {
    id: uuid(),
    name: name || `${res.status} ${res.statusText || ''}`.trim(),
    originalRequest: clone(request),
    status: res.statusText || '',
    code: res.status,
    _postman_previewlanguage: previewLanguage(res.contentType),
    header: (res.headers || []).map((x) => ({ key: x.key, value: x.value })),
    cookie: [],
    body: res.bodyText ?? '',
  };
}

/** An empty example to fill in by hand ("Add example"). */
export function newExample(request, name = 'New Example') {
  return {
    id: uuid(),
    name,
    originalRequest: clone(request) || { method: 'GET', header: [], url: parseUrl('') },
    status: 'OK',
    code: 200,
    _postman_previewlanguage: 'json',
    header: [{ key: 'Content-Type', value: 'application/json' }],
    cookie: [],
    body: '',
  };
}

export function duplicateExample(ex) {
  const copy = clone(ex);
  copy.id = uuid();
  delete copy.uid;
  copy.name = `${ex.name} Copy`;
  return copy;
}

// ---------- Scripts ----------

export function getScript(target, listen) {
  const ev = (target.event || []).find((e) => e.listen === listen);
  if (!ev?.script) return '';
  const exec = ev.script.exec;
  return Array.isArray(exec) ? exec.join('\n') : exec || '';
}

export function setScript(target, listen, code) {
  target.event = target.event || [];
  let ev = target.event.find((e) => e.listen === listen);
  if (!code.trim()) {
    if (ev) target.event = target.event.filter((e) => e !== ev);
    if (!target.event.length) delete target.event;
    return;
  }
  if (!ev) {
    ev = { listen, script: { type: 'text/javascript', exec: [] } };
    target.event.push(ev);
  }
  ev.script = ev.script || { type: 'text/javascript' };
  ev.script.exec = code.split('\n');
  ev.script.type = ev.script.type || 'text/javascript';
}

// ---------- Auth ----------

export const AUTH_TYPES = [
  ['inherit', 'Inherit from parent'],
  ['noauth', 'No Auth'],
  ['bearer', 'Bearer Token'],
  ['basic', 'Basic Auth'],
  ['apikey', 'API Key'],
  ['oauth2', 'OAuth 2.0'],
  ['digest', 'Digest Auth'],
  ['hawk', 'Hawk Authentication'],
  ['awsSigV4', 'AWS Signature v4'],
];

export function authParam(auth, key) {
  if (!auth) return undefined;
  const list = auth[auth.type];
  if (Array.isArray(list)) return list.find((p) => p.key === key)?.value;
  if (list && typeof list === 'object') return list[key]; // v2.0 style
  return undefined;
}

export function setAuthParam(auth, key, value) {
  let list = auth[auth.type];
  if (!Array.isArray(list)) {
    list = list && typeof list === 'object' ? Object.entries(list).map(([k, v]) => ({ key: k, value: v, type: 'string' })) : [];
    auth[auth.type] = list;
  }
  const p = list.find((x) => x.key === key);
  if (p) p.value = value;
  else list.push({ key, value, type: typeof value === 'boolean' ? 'boolean' : 'string' });
}

/**
 * Work out which auth applies to a request: its own, or the nearest
 * ancestor's when it inherits. Returns { auth, source }.
 */
export function effectiveAuth(request, parents, collection) {
  if (request.auth && request.auth.type !== 'inherit') return { auth: request.auth, source: 'request' };
  for (let i = parents.length - 1; i >= 0; i--) {
    const a = parents[i].auth;
    if (a && a.type !== 'inherit') return { auth: a, source: parents[i].name };
  }
  if (collection?.auth && collection.auth.type !== 'inherit') return { auth: collection.auth, source: 'collection' };
  return { auth: null, source: null };
}

// ---------- Import ----------

/** Accept a Postman collection export (v2.0/v2.1), with or without the {collection} wrapper. */
export function normaliseImport(json) {
  let c = json?.collection && json.collection.info ? json.collection : json;
  if (!c?.info || !Array.isArray(c.item)) {
    if (json?.values && json?.name) return { kind: 'environment', data: json };
    throw new Error("This file isn't a Postman collection (v2.0 or v2.1) or environment export.");
  }
  c = clone(c);
  c.info.schema = SCHEMA_V21;
  walk(c.item, (it) => {
    if (it.request) {
      if (typeof it.request === 'string') it.request = { method: 'GET', url: it.request, header: [] };
      it.request.url = urlObject(it.request.url);
      if (it.request.auth) upgradeAuth(it.request.auth);
    }
    if (it.auth) upgradeAuth(it.auth);
  });
  if (c.auth) upgradeAuth(c.auth);
  ensureIds(c);
  return { kind: 'collection', data: c };
}

function upgradeAuth(auth) {
  const v = auth[auth.type];
  if (v && !Array.isArray(v) && typeof v === 'object') {
    auth[auth.type] = Object.entries(v).map(([key, value]) => ({ key, value, type: 'string' }));
  }
}

/** Strip server-managed fields before sending a collection back to Postman. */
export function forUpload(collection) {
  const c = clone(collection);
  if (c.info) {
    for (const k of ['updatedAt', 'createdAt', 'lastUpdatedBy', 'uid', 'fork', 'owner']) delete c.info[k];
    c.info.schema = c.info.schema || SCHEMA_V21;
  }
  // Postman rejects these fields on collection variables.
  if (Array.isArray(c.variable)) {
    c.variable = c.variable.filter((v) => v.key).map((v) => {
      const { id, description, enabled, ...rest } = v;
      if (enabled === false) rest.disabled = true;
      return rest;
    });
  }
  const strip = (it) => {
    delete it.uid;
    (it.response || []).forEach((r) => delete r.uid);
    (it.item || []).forEach(strip);
  };
  (c.item || []).forEach(strip);
  return c;
}

/** Export: a standard v2.1 file Postman can import. */
export function forExport(collection) {
  const c = forUpload(collection);
  c.info._postman_id = c.info._postman_id || uuid();
  return c;
}

// ---------- dispatch server ----------

/** Normalise a Dispatch server base URL: trim, drop any trailing slashes, require a host. */
export function serverBaseUrl(raw) {
  const url = String(raw ?? '').trim();
  if (!/^https?:\/\//i.test(url)) throw new Error('The server URL must start with http:// or https://');
  let host = '';
  try { host = new URL(url).hostname; } catch { /* reported below */ }
  if (!host) throw new Error('That server URL has no host, e.g. https://dispatch.example.com');
  return url.replace(/\/+$/, '');
}
