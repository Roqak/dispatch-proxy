// Browser-only stand-in for the Rust backend, used when you open src/index.html
// directly (e.g. to work on the UI). It is never loaded inside the desktop app.

const ls = globalThis.localStorage;
const read = (k) => { try { return JSON.parse(ls.getItem(`dispatch:${k}`)); } catch { return null; } };
const write = (k, v) => ls.setItem(`dispatch:${k}`, JSON.stringify(v));

const now = '2026-10-01T09:00:00.000Z';
const demoCollection = {
  info: { _postman_id: 'demo-c1', name: 'Payments API', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json', updatedAt: now },
  auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{token}}', type: 'string' }] },
  variable: [{ key: 'baseUrl', value: 'https://httpbin.org' }],
  item: [
    {
      id: 'f-auth', name: 'Auth', item: [
        { id: 'r-login', name: 'Get token', request: { method: 'POST', auth: { type: 'noauth' }, header: [], url: { raw: '{{baseUrl}}/post', host: ['{{baseUrl}}'], path: ['post'] }, body: { mode: 'raw', raw: '{\n  "client_id": "{{clientId}}",\n  "secret": "{{clientSecret}}"\n}', options: { raw: { language: 'json' } } } }, event: [{ listen: 'test', script: { exec: ["pm.test('Status is 200', () => pm.response.to.have.status(200));", "pm.environment.set('token', pm.response.json().json.client_id);"] } }] },
      ],
    },
    {
      id: 'f-tx', name: 'Transactions', item: [
        { id: 'r-list', name: 'List transactions', request: { method: 'GET', header: [{ key: 'X-Request-Ref', value: '{{$guid}}' }], url: { raw: '{{baseUrl}}/get?page=1&limit=20', host: ['{{baseUrl}}'], path: ['get'], query: [{ key: 'page', value: '1' }, { key: 'limit', value: '20' }, { key: 'status', value: 'successful', disabled: true }] } } },
        { id: 'r-create', name: 'Create transaction', request: { method: 'POST', header: [], url: { raw: '{{baseUrl}}/anything/transactions', host: ['{{baseUrl}}'], path: ['anything', 'transactions'] }, body: { mode: 'raw', raw: '{\n  "amount": 250000,\n  "currency": "NGN",\n  "narration": "Invoice 2041"\n}', options: { raw: { language: 'json' } } } }, event: [{ listen: 'prerequest', script: { exec: ["const sig = CryptoJS.MD5(pm.environment.get('clientSecret')).toString();", "pm.request.headers.upsert({ key: 'Signature', value: sig });"] } }] },
        { id: 'r-get', name: 'Get transaction', request: { method: 'GET', header: [], url: { raw: '{{baseUrl}}/anything/transactions/:id', host: ['{{baseUrl}}'], path: ['anything', 'transactions', ':id'], variable: [{ key: 'id', value: 'TX-1001' }] } } },
        { id: 'r-del', name: 'Cancel transaction', request: { method: 'DELETE', header: [], url: { raw: '{{baseUrl}}/delete', host: ['{{baseUrl}}'], path: ['delete'] } } },
      ],
    },
    { id: 'r-health', name: 'Health check', request: { method: 'GET', auth: { type: 'noauth' }, header: [], url: { raw: '{{baseUrl}}/status/200', host: ['{{baseUrl}}'], path: ['status', '200'] } } },
  ],
};

const mockCloud = {
  '/me': { user: { id: 1, username: 'demo', fullName: 'Demo User', email: 'demo@example.com' } },
  '/workspaces': { workspaces: [{ id: 'ws1', name: 'Team Workspace', type: 'team' }, { id: 'ws2', name: 'My Workspace', type: 'personal' }] },
  '/collections?workspace=ws1': { collections: [{ uid: '1-demo-c1', id: 'demo-c1', name: 'Payments API', updatedAt: now }] },
  '/collections?workspace=ws2': { collections: [] },
  '/collections/1-demo-c1': { collection: demoCollection },
  '/environments?workspace=ws1': { environments: [{ uid: '1-env1', id: 'env1', name: 'Sandbox', updatedAt: now }, { uid: '1-env2', id: 'env2', name: 'Production', updatedAt: now }] },
  '/environments?workspace=ws2': { environments: [] },
  '/environments/1-env1': { environment: { id: 'env1', name: 'Sandbox', values: [{ key: 'clientId', value: 'sandbox-client', enabled: true }, { key: 'clientSecret', value: 's3cr3t', enabled: true, type: 'secret' }, { key: 'token', value: '', enabled: true }] } },
  '/environments/1-env2': { environment: { id: 'env2', name: 'Production', values: [{ key: 'clientId', value: 'live-client', enabled: true }] } },
  '/workspaces/ws1/global-variables': { values: [] },
  '/workspaces/ws2/global-variables': { values: [] },
};

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Active profile for cloud calls; the store syncs it in browser mode too.
export const mockCtx = { profileId: null, region: 'us', server: false, baseUrl: null };
const keyName = () => `apikey:${mockCtx.profileId ?? 'local'}`;

// A plausible split of the total, so the timing popover can be exercised.
const mockTimings = (total) => ({ dnsMs: +(total * 0.08).toFixed(3), connectMs: +(total * 0.22).toFixed(3), waitingMs: +(total * 0.6).toFixed(3), downloadMs: +(total * 0.1).toFixed(3), totalMs: total, connections: 1 });
const mockServers = new Map();
const mockLoads = new Map();
const mockFolders = new Map();
globalThis.__mockFolders = mockFolders;
globalThis.__mockServe = (id, method, path) => {
  const m = mockServers.get(id);
  const r = m?.routes.find((x) => x.method === method && x.path.split('/').length === path.split('/').length && x.path.split('/').every((seg, i) => seg.startsWith(':') || seg === path.split('/')[i]));
  m?.onLog({ id, method, path, status: r ? r.code : 404, example: r?.name ?? null, ms: 0.4 });
  return r;
};
const mockCookies = [
  { domain: 'httpbin.org', hostOnly: true, path: '/', name: 'session', value: 'abc123', expires: null, secure: true, httpOnly: true, sameSite: 'Lax' },
  { domain: 'example.com', hostOnly: false, path: '/', name: 'theme', value: 'dark', expires: Math.floor(Date.now() / 1000) + 86400 * 30, secure: false, httpOnly: false, sameSite: null },
];

export const mockBridge = {
  async send(req) {
    await delay(350);
    const started = performance.now();
    try {
      const init = { method: req.method, headers: Object.fromEntries(req.headers.map((h) => [h.key, h.value])) };
      if (req.body?.mode === 'raw') init.body = req.body.content;
      const res = await fetch(req.url, init);
      const text = await res.text();
      const timeMs = Math.round(performance.now() - started);
      return { status: res.status, statusText: res.statusText, headers: [...res.headers].map(([key, value]) => ({ key, value })), url: res.url, contentType: res.headers.get('content-type') || '', bodyText: text, bodyBase64: null, size: text.length, timeMs, timings: mockTimings(timeMs) };
    } catch {
      const body = JSON.stringify({ args: {}, headers: Object.fromEntries(req.headers.map((h) => [h.key, h.value])), method: req.method, url: req.url, json: req.body?.content ? safeJson(req.body.content) : null, note: 'Mock response (browser preview)' }, null, 2);
      return { status: 200, statusText: 'OK', headers: [{ key: 'content-type', value: 'application/json' }, { key: 'x-mock', value: 'true' }], url: req.url, contentType: 'application/json', bodyText: body, bodyBase64: null, size: body.length, timeMs: 142, timings: mockTimings(142) };
    }
  },
  // The browser preview can't stream; streaming responses arrive whole.
  async sendStream(req) { return mockBridge.send(req); },
  async stopRequest() { return false; },
  // Browser preview: a small real run through fetch, reported like the Rust engine.
  async loadtestRun(id, req, cfg, onProgress) {
    const started = performance.now();
    const lat = []; const statuses = {}; const errors = {}; const seconds = [];
    let issued = 0; let stop = false; mockLoads.set(id, () => { stop = true; });
    const limit = cfg.requests ?? Infinity; const end = cfg.durationS ? started + cfg.durationS * 1000 : Infinity;
    const snap = (finished) => { const s = [...lat].sort((a, b) => a - b); const pct = (p) => (s.length ? s[Math.min(s.length - 1, Math.round((p / 100) * (s.length - 1)))] : 0); const done = lat.length; const el = performance.now() - started;
      return { elapsedMs: Math.round(el), done, ok: done - Object.values(errors).reduce((a, b) => a + b, 0) - Object.entries(statuses).filter(([k]) => k >= 400).reduce((a, [, v]) => a + v, 0), failed: Object.values(errors).reduce((a, b) => a + b, 0) + Object.entries(statuses).filter(([k]) => k >= 400).reduce((a, [, v]) => a + v, 0), rps: done / (el / 1000 || 1), activeVus: finished ? 0 : cfg.vus, minMs: s[0] || 0, meanMs: s.reduce((a, b) => a + b, 0) / (s.length || 1), p50Ms: pct(50), p90Ms: pct(90), p95Ms: pct(95), p99Ms: pct(99), maxMs: s[s.length - 1] || 0, bytes: 0, statuses: Object.entries(statuses).map(([k, v]) => [Number(k), v]), errors: Object.entries(errors), timeline: seconds.map((x, t) => ({ t, count: x.c, errors: x.e, p95Ms: 0 })), finished, stopped: stop }; };
    const vu = async () => { while (!stop && issued < limit && performance.now() < end) { issued++; const t0 = performance.now(); let failed = false; try { const r = await mockBridge.send(req); statuses[r.status] = (statuses[r.status] || 0) + 1; failed = r.status >= 400; } catch (e) { errors[String(e)] = (errors[String(e)] || 0) + 1; failed = true; } lat.push(performance.now() - t0); const sec = Math.floor((performance.now() - started) / 1000); while (seconds.length <= sec) seconds.push({ c: 0, e: 0 }); seconds[sec].c++; if (failed) seconds[sec].e++; } };
    const timer = setInterval(() => onProgress(snap(false)), 500);
    await Promise.all(Array.from({ length: Math.min(cfg.vus, 20) }, vu));
    clearInterval(timer); mockLoads.delete(id);
    const r = snap(true); onProgress(r); return r;
  },
  async loadtestStop(id) { mockLoads.get(id)?.(); return true; },
  // Browser preview: a pretend gRPC server with one service.
  async grpcDescribe(source) {
    await delay(150);
    if (!source.target) throw 'Enter the server address, e.g. localhost:50051';
    return [{ name: 'shop.v1.Orders', methods: [
      { name: 'Get', path: 'shop.v1.Orders/Get', input: 'shop.v1.GetReq', output: 'shop.v1.Order', clientStreaming: false, serverStreaming: false, template: '{\n  "id": ""\n}' },
      { name: 'Watch', path: 'shop.v1.Orders/Watch', input: 'shop.v1.GetReq', output: 'shop.v1.Order', clientStreaming: false, serverStreaming: true, template: '{\n  "id": ""\n}' },
    ] }];
  },
  async grpcCall(source, method, message, onMessage) {
    const req = JSON.parse(message || '{}');
    const n = method.endsWith('/Watch') ? 3 : 1;
    const messages = [];
    for (let i = 0; i < n; i++) { await delay(120); const m = JSON.stringify({ id: req.id || 'o1', total: 100 + i, status: i < n - 1 ? 'PENDING' : 'PAID' }, null, 2); messages.push(m); onMessage(m); }
    return { code: 0, codeName: 'OK', message: '', headers: [['content-type', 'application/grpc']], trailers: [['grpc-status', '0']], messages, timeMs: 120 * n };
  },
  async pickProtoFiles() { return ['/Users/you/protos/shop.proto']; },
  // Browser preview: canned answers so the assistant UI can be exercised offline.
  async aiSetKey(key) { if (!String(key).startsWith('sk-ant-')) throw 'Anthropic rejected the API key. Check it under Settings → AI assistant.'; write('ai-key', '1'); },
  async aiHasKey() { return !!read('ai-key'); },
  async aiDeleteKey() { ls.removeItem('dispatch:ai-key'); },
  async aiAsk(request, id, onEvent) {
    const text = globalThis.__mockAiAnswer?.(request) ?? (request.schema ? JSON.stringify({ name: 'List users', method: 'GET', url: '{{baseUrl}}/users?page=1', headers: [{ key: 'Accept', value: 'application/json' }], bodyMode: 'none', body: '', description: 'Lists users, paginated.' }) : "```javascript\npm.test('Status is 200', () => pm.response.to.have.status(200));\n```");
    for (const part of text.match(/[\s\S]{1,12}/g) || []) { await delay(15); onEvent({ type: 'text', text: part }); }
    return { text, model: 'claude-opus-5', stopReason: 'end_turn', inputTokens: 100, outputTokens: 40 };
  },
  async clearCookies() { mockCookies.length = 0; },
  // Browser preview: no real server, but requests to it can be simulated through __mockServe.
  async mockStart(id, port, routes, onLog) { mockServers.set(id, { routes, onLog }); return port || 4010; },
  async mockUpdate(id, routes) { const m = mockServers.get(id); if (m) m.routes = routes; return !!m; },
  async mockStop(id) { return mockServers.delete(id); },
  async pickFolder() { return globalThis.__mockPickFolder ?? '/Users/you/repo/api-collection'; },
  async folderRead(dir) { return [...(mockFolders.get(dir) || new Map())].map(([path, content]) => ({ path, content })); },
  async folderWrite(dir, files, prune) {
    const m = mockFolders.get(dir) || new Map();
    if (prune) for (const p of [...m.keys()]) if ((p.endsWith('.request.json') || p.endsWith('folder.json')) && !files.some((f) => f.path === p)) m.delete(p);
    let n = 0;
    for (const f of files) if (m.get(f.path) !== f.content) { m.set(f.path, f.content); n++; }
    mockFolders.set(dir, m);
    return n;
  },
  async folderForget() {},
  async listCookies() { return mockCookies.filter((c) => c.expires == null || c.expires > Date.now() / 1000).map((c) => ({ ...c })); },
  async setCookie(c) {
    if (!c.domain?.trim()) throw 'Enter a domain such as api.example.com.';
    if (!c.name?.trim() || /[=; ]/.test(c.name)) throw "Cookie names can't be empty or contain =, ; or spaces.";
    const cookie = { domain: c.domain.trim().replace(/^\./, '').toLowerCase(), hostOnly: !!c.hostOnly, path: c.path || '/', name: c.name.trim(), value: c.value || '', expires: c.expires ?? null, secure: !!c.secure, httpOnly: !!c.httpOnly, sameSite: null };
    const i = mockCookies.findIndex((x) => x.domain === cookie.domain && x.path === cookie.path && x.name === cookie.name);
    if (cookie.expires != null && cookie.expires <= Date.now() / 1000) { if (i >= 0) mockCookies.splice(i, 1); return; }
    if (i >= 0) mockCookies[i] = cookie; else mockCookies.push(cookie);
  },
  async deleteCookie(domain, path, name) { const i = mockCookies.findIndex((x) => x.domain === domain && x.path === path && x.name === name); if (i >= 0) mockCookies.splice(i, 1); return i >= 0; },
  async postman(method, path, body) {
    await delay(200);
    if (!read(keyName())) throw mockCtx.server ? "This profile isn't signed in to your Dispatch server. Sign in again under Settings → Profiles." : 'This profile has no Postman API key. Add it under Settings → Profiles.';
    // A tiny fake Postman that remembers writes, so sync flows can be exercised.
    const cloud = read('mockcloud') || JSON.parse(JSON.stringify(mockCloud));
    const save = () => write('mockcloud', cloud);
    const stamp = () => new Date(Date.now() + Math.floor(Math.random() * 1000)).toISOString();
    const out = (v) => JSON.parse(JSON.stringify({ ...v, _rateLimitRemainingMonth: '9874' }));
    const [p, qs] = path.split('?');
    const ws = new URLSearchParams(qs || '').get('workspace');
    let m;
    if (method === 'GET') {
      const hit = cloud[path];
      if (!hit) throw `Postman returned 404: not found (${path})`;
      return out(hit);
    }
    if (method === 'PUT' && (m = p.match(/^\/collections\/(.+)$/))) {
      const uid = m[1];
      const updatedAt = stamp();
      cloud[`/collections/${uid}`] = { collection: { ...body.collection, info: { ...body.collection.info, updatedAt } } };
      for (const k of Object.keys(cloud)) if (k.startsWith('/collections?')) cloud[k].collections.forEach((c) => { if (c.uid === uid) { c.updatedAt = updatedAt; c.name = body.collection.info.name; } });
      save();
      return out({ collection: { uid, id: uid, name: body.collection.info.name } });
    }
    if (method === 'POST' && p === '/collections') {
      const id = `c-${Date.now()}`;
      const uid = `1-${id}`;
      const updatedAt = stamp();
      cloud[`/collections/${uid}`] = { collection: { ...body.collection, info: { ...body.collection.info, updatedAt } } };
      (cloud[`/collections?workspace=${ws}`] ||= { collections: [] }).collections.push({ uid, id, name: body.collection.info.name, updatedAt });
      save();
      return out({ collection: { uid, id, name: body.collection.info.name } });
    }
    if (method === 'PUT' && (m = p.match(/^\/environments\/(.+)$/))) {
      const uid = m[1];
      const updatedAt = stamp();
      cloud[`/environments/${uid}`] = { environment: { id: uid, ...body.environment } };
      for (const k of Object.keys(cloud)) if (k.startsWith('/environments?')) cloud[k].environments.forEach((e) => { if (e.uid === uid) { e.updatedAt = updatedAt; e.name = body.environment.name; } });
      save();
      return out({ environment: { uid, id: uid, name: body.environment.name } });
    }
    if (method === 'POST' && p === '/environments') {
      const uid = `1-e${Date.now()}`;
      cloud[`/environments/${uid}`] = { environment: { id: uid, ...body.environment } };
      (cloud[`/environments?workspace=${ws}`] ||= { environments: [] }).environments.push({ uid, id: uid, name: body.environment.name, updatedAt: stamp() });
      save();
      return out({ environment: { uid, id: uid, name: body.environment.name } });
    }
    if (method === 'PUT' && /global-variables$/.test(p)) { cloud[p] = { values: body.values }; save(); return out({ values: body.values }); }
    throw `Mock doesn't handle ${method} ${path}`;
  },
  /** Test hook: simulate a teammate editing a collection in Postman. */
  async _remoteEdit(uid, mutate) {
    const cloud = read('mockcloud');
    const c = cloud[`/collections/${uid}`].collection;
    mutate(c);
    const updatedAt = new Date(Date.now() + 5000).toISOString();
    c.info.updatedAt = updatedAt;
    for (const k of Object.keys(cloud)) if (k.startsWith('/collections?')) cloud[k].collections.forEach((x) => { if (x.uid === uid) x.updatedAt = updatedAt; });
    write('mockcloud', cloud);
  },
  async setApiKey(key, profileId, region) { await delay(300); if (!key.startsWith('PMAK-')) throw 'Postman rejected the API key.'; mockCtx.profileId = profileId; mockCtx.region = region || 'us'; write(`apikey:${profileId}`, key); return mockCloud['/me']; },
  async serverAuth({ profileId, baseUrl, email, password, token }) {
    await delay(300);
    const base = String(baseUrl || '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\//.test(base)) throw 'The server URL must start with http:// or https://';
    if (token?.trim()) write(`apikey:${profileId}`, token.trim());
    else {
      if (!String(email || '').trim() || !password) throw 'Enter your email and password, or paste a token';
      write(`apikey:${profileId}`, 'mock-server-token');
    }
    return mockCloud['/me'];
  },
  async hasApiKey(profileId) { return !!read(`apikey:${profileId}`); },
  async deleteApiKey(profileId) { ls.removeItem(`dispatch:apikey:${profileId}`); },
  async hasLegacyKey() { return !!read('apikey'); },
  async migrateLegacyKey(profileId) { const k = read('apikey'); if (!k) return false; write(`apikey:${profileId}`, k); return true; },
  async secretGet(key) { return read(key) ?? ''; },
  async secretPut(key, value) { if (value === '') { ls.removeItem(`dispatch:${key}`); return; } write(key, value); },
  async trimMemory() {},
  async oauthFlow() { throw 'Only in the desktop app.'; },
  async read(name) { return read(name); },
  async write(name, value) { write(name, value); },
  async openTextFile() { return null; },
  async pickFilePath() { return '/Users/demo/Desktop/receipt.pdf'; },
  async saveTextFile() { return null; },
  async saveBinaryFile() { return null; },
  async openUrl(url) { globalThis.open(url, '_blank', 'noopener'); },
};

function safeJson(s) { try { return JSON.parse(s); } catch { return s; } }
