// Import from other tools: OpenAPI 3, Swagger 2, Insomnia (v4 JSON / v5 YAML)
// and HAR, converted to Postman v2.1 collections. Postman files go through
// normaliseImport as before.

import { SCHEMA_V21, uuid, parseUrl, normaliseImport } from './model.js';

/**
 * Turn an imported file into { kind: 'collection'|'environment', data, environments? }.
 * opts: { fileName, yaml } where yaml is js-yaml (needed only for YAML files).
 */
export function convertImport(text, { fileName = '', yaml } = {}) {
  const doc = parseDoc(text, fileName, yaml);
  if (doc?.openapi && String(doc.openapi).startsWith('3')) return { kind: 'collection', data: fromOpenApi(doc), format: 'OpenAPI' };
  if (doc?.swagger && String(doc.swagger).startsWith('2')) return { kind: 'collection', data: fromSwagger2(doc), format: 'Swagger' };
  if (doc?._type === 'export' && Array.isArray(doc.resources)) return { ...fromInsomnia4(doc), format: 'Insomnia' };
  if (typeof doc?.type === 'string' && doc.type.startsWith('collection.insomnia.rest/')) return { ...fromInsomnia5(doc), format: 'Insomnia' };
  if (doc?.log && Array.isArray(doc.log.entries)) return { kind: 'collection', data: fromHar(doc, fileName), format: 'HAR' };
  const pm = normaliseImport(doc);
  return { ...pm, format: 'Postman' };
}

function parseDoc(text, fileName, yaml) {
  const trimmed = String(text || '').replace(/^﻿/, '').trim();
  if (!trimmed) throw new Error('That file is empty.');
  if (/^[{[]/.test(trimmed)) {
    try { return JSON.parse(trimmed); } catch (e) { throw new Error(`That file isn't valid JSON: ${e.message}`); }
  }
  if (!yaml) throw new Error('YAML files need the YAML reader, which failed to load.');
  try { return yaml.load(trimmed); } catch (e) { throw new Error(`Couldn't read ${fileName || 'that file'} as YAML: ${e.reason || e.message}`); }
}

// ---------- shared builders ----------

const collection = (name, description) => ({ info: { _postman_id: uuid(), name: name || 'Imported', schema: SCHEMA_V21, ...(description ? { description } : {}) }, item: [], variable: [] });
const folder = (name, description) => ({ id: uuid(), name, item: [], ...(description ? { description } : {}) });

function request({ name, method, url, headers = [], body, description, auth, examples = [] }) {
  const u = parseUrl(url);
  const req = { method: (method || 'GET').toUpperCase(), header: headers, url: u };
  if (body) req.body = body;
  if (description) req.description = description;
  if (auth) req.auth = auth;
  return { id: uuid(), name: name || `${req.method} ${url}`, request: req, response: examples };
}

const rawJson = (value) => ({ mode: 'raw', raw: typeof value === 'string' ? value : JSON.stringify(value, null, 2), options: { raw: { language: 'json' } } });

const STATUS = { 200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 409: 'Conflict', 422: 'Unprocessable Entity', 429: 'Too Many Requests', 500: 'Internal Server Error' };

// ---------- OpenAPI 3 / Swagger 2 ----------

/** Resolve local $refs ("#/components/schemas/X"), with a guard for cycles. */
function resolver(doc) {
  const get = (ref) => {
    if (typeof ref !== 'string' || !ref.startsWith('#/')) return undefined;
    return ref.slice(2).split('/').reduce((o, k) => o?.[k.replace(/~1/g, '/').replace(/~0/g, '~')], doc);
  };
  const deref = (v, seen = new Set()) => {
    let cur = v;
    while (cur && typeof cur === 'object' && cur.$ref && !seen.has(cur.$ref)) { seen.add(cur.$ref); cur = get(cur.$ref); }
    return cur;
  };
  return deref;
}

/** A plausible example value from a JSON schema. */
function sample(schema, deref, depth = 0, seen = new Set()) {
  const s0 = schema;
  if (s0?.$ref) { if (seen.has(s0.$ref) || depth > 8) return {}; seen = new Set([...seen, s0.$ref]); }
  const s = deref(schema) || {};
  if (s.example !== undefined) return s.example;
  if (s.examples && Array.isArray(s.examples) && s.examples.length) return s.examples[0];
  if (s.default !== undefined) return s.default;
  if (Array.isArray(s.enum) && s.enum.length) return s.enum[0];
  if (s.const !== undefined) return s.const;
  if (s.allOf) return Object.assign({}, ...s.allOf.map((x) => { const v = sample(x, deref, depth + 1, seen); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; }));
  if (s.oneOf || s.anyOf) return sample((s.oneOf || s.anyOf)[0], deref, depth + 1, seen);
  const type = Array.isArray(s.type) ? s.type.find((t) => t !== 'null') : s.type || (s.properties ? 'object' : s.items ? 'array' : undefined);
  if (depth > 8) return type === 'array' ? [] : type === 'object' ? {} : null;
  switch (type) {
    case 'object': {
      const out = {};
      for (const [k, v] of Object.entries(s.properties || {})) out[k] = sample(v, deref, depth + 1, seen);
      if (!s.properties && s.additionalProperties && typeof s.additionalProperties === 'object') out.key = sample(s.additionalProperties, deref, depth + 1, seen);
      return out;
    }
    case 'array': return s.items ? [sample(s.items, deref, depth + 1, seen)] : [];
    case 'integer': return s.minimum ?? 0;
    case 'number': return s.minimum ?? 0;
    case 'boolean': return true;
    case 'string': {
      const f = s.format;
      if (f === 'date-time') return '2024-01-01T00:00:00Z';
      if (f === 'date') return '2024-01-01';
      if (f === 'email') return 'user@example.com';
      if (f === 'uuid') return '00000000-0000-0000-0000-000000000000';
      if (f === 'uri' || f === 'url') return 'https://example.com';
      if (f === 'binary') return '';
      return 'string';
    }
    default: return null;
  }
}

function mediaExample(media, deref) {
  if (!media) return undefined;
  if (media.example !== undefined) return media.example;
  const ex = media.examples && Object.values(media.examples)[0];
  if (ex) { const d = deref(ex); if (d?.value !== undefined) return d.value; }
  return media.schema ? sample(media.schema, deref) : undefined;
}

const toPostmanPath = (p) => p.replace(/\{([^}]+)\}/g, ':$1');
const paramValue = (p, deref) => {
  const v = p.example ?? p.schema?.example ?? p.schema?.default ?? p.default ?? (p.schema ? sample(p.schema, deref) : '');
  return v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
};

function securityToAuth(scheme) {
  if (!scheme) return null;
  const t = String(scheme.type || '').toLowerCase();
  if ((t === 'http' && /^bearer$/i.test(scheme.scheme || '')) || t === 'jwt') return { type: 'bearer', bearer: [{ key: 'token', value: '{{bearerToken}}', type: 'string' }] };
  if ((t === 'http' && /^basic$/i.test(scheme.scheme || '')) || t === 'basic') return { type: 'basic', basic: [{ key: 'username', value: '{{username}}', type: 'string' }, { key: 'password', value: '{{password}}', type: 'string' }] };
  if (t === 'apikey') return { type: 'apikey', apikey: [{ key: 'key', value: scheme.name || 'X-API-Key', type: 'string' }, { key: 'value', value: '{{apiKey}}', type: 'string' }, { key: 'in', value: scheme.in === 'query' ? 'query' : 'header', type: 'string' }] };
  if (t === 'oauth2' || t === 'openidconnect') return { type: 'oauth2', oauth2: [{ key: 'addTokenTo', value: 'header', type: 'string' }] };
  return null;
}

function authFor(security, schemes) {
  if (!Array.isArray(security)) return undefined;
  if (!security.length || security.every((s) => !Object.keys(s || {}).length)) return { type: 'noauth' };
  const name = Object.keys(security[0] || {})[0];
  return securityToAuth(schemes?.[name]) || undefined;
}

function buildFromPaths(doc, { baseUrl, schemes, opBody, opResponses }) {
  const deref = resolver(doc);
  const col = collection(doc.info?.title || 'Imported API', [doc.info?.description, doc.info?.version ? `Version ${doc.info.version}` : ''].filter(Boolean).join('\n\n'));
  col.variable.push({ key: 'baseUrl', value: baseUrl || '', type: 'string' });
  const rootAuth = authFor(doc.security, schemes);
  if (rootAuth && rootAuth.type !== 'noauth') col.auth = rootAuth;
  const tagFolders = new Map();
  const tagInfo = Object.fromEntries((doc.tags || []).map((t) => [t.name, t.description]));
  const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
  for (const [path, pathItem0] of Object.entries(doc.paths || {})) {
    const pathItem = deref(pathItem0) || {};
    for (const m of METHODS) {
      const op = pathItem[m];
      if (!op) continue;
      const params = [...(pathItem.parameters || []), ...(op.parameters || [])].map((p) => deref(p)).filter(Boolean);
      // Operation-level params override path-level ones with the same name+in.
      const byKey = new Map();
      for (const p of params) byKey.set(`${p.in}:${p.name}`, p);
      const all = [...byKey.values()];
      const query = all.filter((p) => p.in === 'query').map((p) => ({ key: p.name, value: paramValue(p, deref), ...(p.required ? {} : { disabled: true }), ...(p.description ? { description: p.description } : {}) }));
      const headers = all.filter((p) => p.in === 'header').map((p) => ({ key: p.name, value: paramValue(p, deref), ...(p.description ? { description: p.description } : {}) }));
      const pathVars = all.filter((p) => p.in === 'path').map((p) => ({ key: p.name, value: paramValue(p, deref), ...(p.description ? { description: p.description } : {}) }));
      const { body, contentType } = opBody(op, all, deref);
      if (contentType && !headers.some((x) => x.key.toLowerCase() === 'content-type')) headers.push({ key: 'Content-Type', value: contentType });
      const qs = query.filter((q) => !q.disabled).map((q) => `${q.key}=${q.value}`).join('&');
      const item = request({
        name: op.summary || op.operationId || `${m.toUpperCase()} ${path}`,
        method: m,
        url: `{{baseUrl}}${toPostmanPath(path)}${qs ? `?${qs}` : ''}`,
        headers,
        body,
        description: [op.description, op.deprecated ? '**Deprecated.**' : ''].filter(Boolean).join('\n\n') || undefined,
        auth: op.security ? authFor(op.security, schemes) : undefined,
      });
      item.request.url.query = query;
      if (pathVars.length) item.request.url.variable = pathVars;
      item.response = opResponses(op, deref).map((r) => ({
        id: uuid(), name: r.name, originalRequest: JSON.parse(JSON.stringify(item.request)), code: r.code, status: STATUS[r.code] || '',
        _postman_previewlanguage: r.json ? 'json' : 'text', header: r.contentType ? [{ key: 'Content-Type', value: r.contentType }] : [], cookie: [], body: r.body,
      }));
      const tag = op.tags?.[0];
      if (tag) {
        if (!tagFolders.has(tag)) { const f = folder(tag, tagInfo[tag]); tagFolders.set(tag, f); col.item.push(f); }
        tagFolders.get(tag).item.push(item);
      } else {
        col.item.push(item);
      }
    }
  }
  const s = securityToAuth(Object.values(schemes || {})[0]);
  const varFor = { bearer: ['bearerToken'], basic: ['username', 'password'], apikey: ['apiKey'] }[s?.type] || [];
  for (const k of varFor) col.variable.push({ key: k, value: '', type: 'string' });
  return col;
}

function bodyFromMedia(content, deref) {
  if (!content) return {};
  const types = Object.keys(content);
  const pick = types.find((t) => /json/i.test(t)) || types.find((t) => /x-www-form-urlencoded/i.test(t)) || types.find((t) => /multipart/i.test(t)) || types[0];
  if (!pick) return {};
  const media = content[pick];
  if (/x-www-form-urlencoded/i.test(pick) || /multipart/i.test(pick)) {
    const schema = deref(media.schema) || {};
    const ex = mediaExample(media, deref) || {};
    const fields = Object.entries(schema.properties || ex).map(([key, prop]) => {
      const p = deref(prop) || {};
      const isFile = p.format === 'binary' || p.type === 'file';
      const v = ex[key] ?? (prop && typeof prop === 'object' ? sample(prop, deref) : prop);
      return isFile ? { key, type: 'file', src: [] } : { key, value: v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v), type: 'text' };
    });
    if (/multipart/i.test(pick)) return { body: { mode: 'formdata', formdata: fields } };
    return { body: { mode: 'urlencoded', urlencoded: fields.map(({ type, src, ...f }) => f) }, contentType: pick };
  }
  const ex = mediaExample(media, deref);
  if (/json/i.test(pick)) return { body: rawJson(ex ?? {}), contentType: pick };
  return { body: { mode: 'raw', raw: ex == null ? '' : String(ex), options: { raw: { language: /xml/i.test(pick) ? 'xml' : 'text' } } }, contentType: pick };
}

export function fromOpenApi(doc) {
  const deref = resolver(doc);
  const server = doc.servers?.[0];
  let baseUrl = server?.url || '';
  for (const [k, v] of Object.entries(server?.variables || {})) baseUrl = baseUrl.replaceAll(`{${k}}`, v.default ?? '');
  return buildFromPaths(doc, {
    baseUrl: baseUrl.replace(/\/$/, ''),
    schemes: doc.components?.securitySchemes,
    opBody: (op) => bodyFromMedia(deref(op.requestBody)?.content, deref),
    opResponses: (op) => Object.entries(op.responses || {}).filter(([code]) => /^\d{3}$/.test(code)).map(([code, r0]) => {
      const r = deref(r0) || {};
      const types = Object.keys(r.content || {});
      const ct = types.find((t) => /json/i.test(t)) || types[0];
      const ex = ct ? mediaExample(r.content[ct], deref) : undefined;
      return { code: +code, name: r.description || `${code} ${STATUS[code] || ''}`.trim(), contentType: ct, json: /json/i.test(ct || ''), body: ex === undefined ? '' : typeof ex === 'string' ? ex : JSON.stringify(ex, null, 2) };
    }),
  });
}

export function fromSwagger2(doc) {
  const scheme = doc.schemes?.includes('https') ? 'https' : doc.schemes?.[0] || 'https';
  const baseUrl = doc.host ? `${scheme}://${doc.host}${doc.basePath && doc.basePath !== '/' ? doc.basePath : ''}` : (doc.basePath || '');
  return buildFromPaths(doc, {
    baseUrl: baseUrl.replace(/\/$/, ''),
    schemes: Object.fromEntries(Object.entries(doc.securityDefinitions || {}).map(([k, v]) => [k, v.type === 'basic' ? { type: 'basic' } : v])),
    opBody: (op, params, deref) => {
      const consumes = op.consumes || doc.consumes || [];
      const bodyParam = params.find((p) => p.in === 'body');
      if (bodyParam) {
        const ct = consumes.find((t) => /json/i.test(t)) || consumes[0] || 'application/json';
        return bodyFromMedia({ [ct]: { schema: bodyParam.schema, example: bodyParam['x-example'] } }, deref);
      }
      const form = params.filter((p) => p.in === 'formData');
      if (!form.length) return {};
      const multi = form.some((p) => p.type === 'file') || consumes.some((t) => /multipart/i.test(t));
      const schema = { type: 'object', properties: Object.fromEntries(form.map((p) => [p.name, { type: p.type, format: p.type === 'file' ? 'binary' : p.format, example: p['x-example'] ?? p.default }])) };
      return bodyFromMedia({ [multi ? 'multipart/form-data' : 'application/x-www-form-urlencoded']: { schema } }, deref);
    },
    opResponses: (op, deref) => Object.entries(op.responses || {}).filter(([code]) => /^\d{3}$/.test(code)).map(([code, r0]) => {
      const r = deref(r0) || {};
      const ex = r.examples?.['application/json'] ?? (r.schema ? sample(r.schema, deref) : undefined);
      return { code: +code, name: r.description || `${code} ${STATUS[code] || ''}`.trim(), contentType: ex !== undefined ? 'application/json' : undefined, json: ex !== undefined, body: ex === undefined ? '' : JSON.stringify(ex, null, 2) };
    }),
  });
}

// ---------- Insomnia ----------

/** Insomnia template tags: {{ _.baseUrl }} → {{baseUrl}}; other tags are kept as text. */
const insVars = (s) => String(s ?? '').replace(/\{\{\s*_\.([\w.-]+)\s*\}\}/g, '{{$1}}').replace(/\{\{\s*([\w-]+)\s*\}\}/g, '{{$1}}');

function insomniaBody(body) {
  if (!body || (!body.mimeType && !body.text && !body.params)) return undefined;
  const mt = body.mimeType || '';
  if (/x-www-form-urlencoded/.test(mt)) return { mode: 'urlencoded', urlencoded: (body.params || []).map((p) => ({ key: insVars(p.name), value: insVars(p.value), ...(p.disabled ? { disabled: true } : {}) })) };
  if (/multipart/.test(mt)) return { mode: 'formdata', formdata: (body.params || []).map((p) => (p.type === 'file' ? { key: insVars(p.name), type: 'file', src: p.fileName || [] } : { key: insVars(p.name), value: insVars(p.value), type: 'text', ...(p.disabled ? { disabled: true } : {}) })) };
  if (/graphql/.test(mt)) {
    let g = {};
    try { g = JSON.parse(body.text || '{}'); } catch { /* keep empty */ }
    return { mode: 'graphql', graphql: { query: insVars(g.query || ''), variables: g.variables ? JSON.stringify(g.variables, null, 2) : '' } };
  }
  if (body.fileName && !body.text) return { mode: 'file', file: { src: body.fileName } };
  const lang = /json/.test(mt) ? 'json' : /xml/.test(mt) ? 'xml' : /html/.test(mt) ? 'html' : 'text';
  return { mode: 'raw', raw: insVars(body.text || ''), options: { raw: { language: lang } } };
}

function insomniaAuth(a) {
  if (!a || !a.type || a.disabled) return undefined;
  const kv = (o) => Object.entries(o).map(([key, value]) => ({ key, value: insVars(value), type: 'string' }));
  if (a.type === 'bearer') return { type: 'bearer', bearer: kv({ token: a.token || '' }) };
  if (a.type === 'basic') return { type: 'basic', basic: kv({ username: a.username || '', password: a.password || '' }) };
  if (a.type === 'apikey') return { type: 'apikey', apikey: kv({ key: a.key || '', value: a.value || '', in: a.addTo === 'queryParams' ? 'query' : 'header' }) };
  if (a.type === 'none') return { type: 'noauth' };
  return undefined; // OAuth, AWS, NTLM...: left for the user to set up
}

function insomniaRequest(r) {
  const headers = (r.headers || []).filter((x) => x.name).map((x) => ({ key: insVars(x.name), value: insVars(x.value), ...(x.disabled ? { disabled: true } : {}) }));
  const ct = r.body?.mimeType && !/multipart/.test(r.body.mimeType) && !headers.some((x) => x.key.toLowerCase() === 'content-type') ? [{ key: 'Content-Type', value: r.body.mimeType }] : [];
  const params = (r.parameters || []).filter((p) => p.name);
  let url = insVars(r.url || '');
  const enabled = params.filter((p) => !p.disabled);
  if (enabled.length) url += (url.includes('?') ? '&' : '?') + enabled.map((p) => `${insVars(p.name)}=${insVars(p.value)}`).join('&');
  const item = request({ name: r.name, method: r.method, url, headers: [...headers, ...ct], body: insomniaBody(r.body), description: r.description || undefined, auth: insomniaAuth(r.authentication) });
  // Keep disabled params visible but off, like Postman does.
  for (const p of params.filter((x) => x.disabled)) item.request.url.query.push({ key: insVars(p.name), value: insVars(p.value), disabled: true });
  return item;
}

const envValues = (data) => Object.entries(data || {}).filter(([, v]) => v === null || typeof v !== 'object').map(([key, value]) => ({ key, value: value == null ? '' : String(value), type: 'default', enabled: true }));

export function fromInsomnia4(doc) {
  const res = doc.resources;
  const ws = res.find((r) => r._type === 'workspace');
  const col = collection(ws?.name || 'Insomnia import', ws?.description);
  const nodes = new Map();
  const children = (parentId) => res.filter((r) => r.parentId === parentId && (r._type === 'request_group' || r._type === 'request')).sort((a, b) => (a.metaSortKey ?? 0) - (b.metaSortKey ?? 0));
  const build = (r) => {
    if (r._type === 'request') return insomniaRequest(r);
    const f = folder(r.name || 'Folder', r.description);
    nodes.set(r._id, f);
    f.item = children(r._id).map(build);
    return f;
  };
  const roots = ws ? children(ws._id) : res.filter((r) => (r._type === 'request' || r._type === 'request_group') && !res.some((p) => p._id === r.parentId));
  col.item = roots.map(build);
  const envs = res.filter((r) => r._type === 'environment');
  const base = envs.find((e) => e.parentId === ws?._id) || envs.find((e) => !envs.some((p) => p._id === e.parentId));
  if (base) col.variable = envValues(base.data).map(({ key, value }) => ({ key, value, type: 'string' }));
  const environments = envs.filter((e) => e !== base && Object.keys(e.data || {}).length).map((e) => ({ name: e.name || 'Environment', values: envValues(e.data) }));
  return { kind: 'collection', data: col, environments };
}

export function fromInsomnia5(doc) {
  const col = collection(doc.name || 'Insomnia import', doc.meta?.description);
  const build = (n) => {
    if (Array.isArray(n.children)) { const f = folder(n.name || 'Folder', n.meta?.description); f.item = n.children.map(build); return f; }
    return insomniaRequest({ ...n, description: n.meta?.description, parameters: n.parameters, authentication: n.authentication });
  };
  col.item = (doc.collection || []).map(build);
  const env = doc.environments;
  if (env?.data) col.variable = envValues(env.data).map(({ key, value }) => ({ key, value, type: 'string' }));
  const environments = (env?.subEnvironments || []).map((e) => ({ name: e.name || 'Environment', values: envValues(e.data) }));
  return { kind: 'collection', data: col, environments };
}

// ---------- HAR ----------

const SKIP_HAR_HEADERS = /^(:|content-length$|host$|connection$|accept-encoding$)/i;

export function fromHar(doc, fileName = '') {
  const name = fileName.replace(/^.*[\\/]/, '').replace(/\.har$/i, '') || 'HAR import';
  const col = collection(name, `Imported from a HAR file${doc.log.creator?.name ? ` (${doc.log.creator.name})` : ''}.`);
  const hosts = new Map();
  for (const e of doc.log.entries) {
    const rq = e.request || {};
    if (!rq.url || /^(data|blob|chrome-extension):/.test(rq.url)) continue;
    let u;
    try { u = new URL(rq.url); } catch { continue; }
    const headers = (rq.headers || []).filter((x) => x.name && !SKIP_HAR_HEADERS.test(x.name)).map((x) => ({ key: x.name, value: x.value ?? '' }));
    let body;
    const pd = rq.postData;
    if (pd) {
      if (pd.params?.length && /x-www-form-urlencoded/.test(pd.mimeType || '')) body = { mode: 'urlencoded', urlencoded: pd.params.map((p) => ({ key: p.name, value: p.value ?? '' })) };
      else if (pd.params?.length) body = { mode: 'formdata', formdata: pd.params.map((p) => (p.fileName ? { key: p.name, type: 'file', src: [] } : { key: p.name, value: p.value ?? '', type: 'text' })) };
      else if (pd.text) body = { mode: 'raw', raw: pd.text, options: { raw: { language: /json/.test(pd.mimeType || '') ? 'json' : /xml/.test(pd.mimeType || '') ? 'xml' : 'text' } } };
    }
    const item = request({ name: `${rq.method || 'GET'} ${u.pathname}`, method: rq.method, url: rq.url, headers, body });
    const rs = e.response;
    if (rs && rs.status) {
      const ct = rs.content?.mimeType || '';
      const text = rs.content?.encoding === 'base64' ? '' : rs.content?.text || '';
      item.response.push({
        id: uuid(), name: `${rs.status} ${rs.statusText || STATUS[rs.status] || ''}`.trim(), originalRequest: JSON.parse(JSON.stringify(item.request)),
        code: rs.status, status: rs.statusText || STATUS[rs.status] || '', _postman_previewlanguage: /json/.test(ct) ? 'json' : /html/.test(ct) ? 'html' : 'text',
        header: (rs.headers || []).filter((x) => x.name && !x.name.startsWith(':')).map((x) => ({ key: x.name, value: x.value ?? '' })), cookie: [], body: text,
      });
    }
    if (!hosts.has(u.host)) hosts.set(u.host, []);
    hosts.get(u.host).push(item);
  }
  if (!hosts.size) throw new Error("That HAR file doesn't contain any requests.");
  if (hosts.size === 1) col.item = [...hosts.values()][0];
  else col.item = [...hosts].map(([host, items]) => ({ ...folder(host), item: items }));
  return col;
}
