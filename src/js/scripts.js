// Runs Postman pre-request and test scripts with a compatible `pm` API.
// Libraries Postman bundles (chai, crypto-js, lodash) are passed in via `libs`.

import { urlObject, setRawUrl, uuid, clone } from './model.js';

// ---------- PropertyList (headers, query params) ----------

class PropertyList {
  constructor(getArr, { caseInsensitive = false, readOnly = false } = {}) {
    this._get = getArr;
    this._ci = caseInsensitive;
    this._ro = readOnly;
  }
  _eq(a, b) { return this._ci ? String(a).toLowerCase() === String(b).toLowerCase() : a === b; }
  _arr() { return this._get(); }
  _norm(item, value) {
    if (typeof item === 'string') {
      if (value !== undefined) return { key: item, value: String(value) };
      const i = item.indexOf(':');
      return i >= 0 ? { key: item.slice(0, i).trim(), value: item.slice(i + 1).trim() } : { key: item, value: '' };
    }
    return { key: item.key, value: item.value == null ? '' : String(item.value), ...(item.disabled ? { disabled: true } : {}) };
  }
  _guard() { if (this._ro) throw new Error('This list is read-only.'); }
  all() { return this._arr().filter((x) => !x.disabled); }
  count() { return this.all().length; }
  each(fn) { this.all().forEach(fn); }
  map(fn) { return this.all().map(fn); }
  filter(fn) { return this.all().filter(fn); }
  find(fn) { return this.all().find(typeof fn === 'function' ? fn : (x) => this._eq(x.key, fn)); }
  has(key, value) { return this.all().some((x) => this._eq(x.key, key) && (value === undefined || x.value === value)); }
  get(key) { return this.all().find((x) => this._eq(x.key, key))?.value; }
  one(key) { return this.all().find((x) => this._eq(x.key, key)); }
  toObject() { const o = {}; for (const x of this.all()) o[x.key] = x.value; return o; }
  toJSON() { return this.all().map((x) => ({ key: x.key, value: x.value })); }
  add(item, value) { this._guard(); this._arr().push(this._norm(item, value)); }
  append(item, value) { this.add(item, value); }
  upsert(item, value) {
    this._guard();
    const n = this._norm(item, value);
    const ex = this._arr().find((x) => this._eq(x.key, n.key));
    if (ex) { ex.value = n.value; delete ex.disabled; } else this._arr().push(n);
  }
  remove(predicate) {
    this._guard();
    const arr = this._arr();
    const match = typeof predicate === 'function' ? predicate : (x) => this._eq(x.key, typeof predicate === 'object' ? predicate.key : predicate);
    for (let i = arr.length - 1; i >= 0; i--) if (match(arr[i])) arr.splice(i, 1);
  }
  clear() { this._guard(); this._arr().splice(0); }
  toString() { return this.all().map((x) => `${x.key}: ${x.value}`).join('\n'); }
}

// ---------- Request wrapper ----------

function wrapRequest(req, resolver) {
  req.header = req.header || [];
  const urlApi = {
    toString: () => urlObject(req.url).raw,
    getHost: () => { const h = urlObject(req.url).host; return Array.isArray(h) ? h.join('.') : h || ''; },
    getPath: () => '/' + (urlObject(req.url).path || []).join('/'),
    getQueryString: () => (urlObject(req.url).query || []).filter((q) => !q.disabled).map((q) => (q.value == null ? q.key : `${q.key}=${q.value}`)).join('&'),
    update: (raw) => setRawUrl(req, String(raw)),
    query: null,
    get protocol() { return urlObject(req.url).protocol; },
    get host() { return urlObject(req.url).host; },
    get path() { return urlObject(req.url).path; },
    get port() { return urlObject(req.url).port; },
    get variables() { return new PropertyList(() => { const u = urlObject(req.url); req.url = u; u.variable = u.variable || []; return u.variable; }); },
  };
  const syncRaw = () => {
    // Rebuild raw from query params after scripts edit them.
    const u = urlObject(req.url);
    const base = u.raw.split('?')[0];
    const qs = (u.query || []).filter((q) => !q.disabled).map((q) => (q.value == null ? q.key : `${q.key}=${q.value}`)).join('&');
    u.raw = base + (qs ? `?${qs}` : '');
  };
  const queryList = new PropertyList(() => { const u = urlObject(req.url); req.url = u; u.query = u.query || []; return u.query; });
  urlApi.query = new Proxy(queryList, {
    get(t, p) {
      const v = t[p];
      if (typeof v === 'function' && ['add', 'append', 'upsert', 'remove', 'clear'].includes(p)) return (...a) => { const r = v.apply(t, a); syncRaw(); return r; };
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });

  const headers = new PropertyList(() => req.header, { caseInsensitive: true });
  const body = {
    get mode() { return req.body?.mode; },
    set mode(m) { req.body = req.body || {}; req.body.mode = m; },
    get raw() { return req.body?.raw; },
    set raw(v) { req.body = req.body || { mode: 'raw' }; req.body.raw = v; },
    get urlencoded() { req.body = req.body || {}; req.body.urlencoded = req.body.urlencoded || []; return new PropertyList(() => req.body.urlencoded); },
    get formdata() { req.body = req.body || {}; req.body.formdata = req.body.formdata || []; return new PropertyList(() => req.body.formdata); },
    get graphql() { return req.body?.graphql; },
    update(b) {
      if (typeof b === 'string') req.body = { mode: 'raw', raw: b };
      else req.body = { ...b };
    },
    isEmpty() { return !req.body || !req.body.mode || req.body.mode === 'none'; },
    toString() { return req.body?.mode === 'raw' ? req.body.raw || '' : JSON.stringify(req.body?.[req.body?.mode] ?? ''); },
    toJSON() { return clone(req.body); },
  };
  return {
    get method() { return req.method; },
    set method(m) { req.method = String(m).toUpperCase(); },
    get url() { return urlApi; },
    set url(v) { setRawUrl(req, typeof v === 'string' ? v : v?.toString?.() || ''); },
    headers,
    get body() { return body; },
    set body(v) { body.update(v); },
    get auth() { return req.auth; },
    set auth(v) { req.auth = v; },
    addHeader: (h) => headers.add(h),
    removeHeader: (k) => headers.remove(k),
    upsertHeader: (h) => headers.upsert(h),
    toJSON: () => clone(req),
    getHeaders: () => headers.toObject(),
  };
}

// ---------- Response wrapper ----------

function wrapResponse(res, libs) {
  const headerArr = res.headers || [];
  const headers = new PropertyList(() => headerArr, { caseInsensitive: true, readOnly: true });
  const text = () => res.bodyText ?? (res.bodyBase64 ? atob(res.bodyBase64) : '');
  const json = () => {
    try { return JSON.parse(text()); } catch (e) { throw new Error(`JSONError: the response body isn't valid JSON (${e.message})`); }
  };
  const assert = (cond, msg) => { if (!cond) throw new libs.chai.AssertionError(msg); };
  const range = (lo, hi) => res.status >= lo && res.status <= hi;
  const be = {};
  const defineBe = (name, fn, msg) => Object.defineProperty(be, name, { get() { assert(fn(), msg()); return true; } });
  defineBe('ok', () => res.status === 200, () => `expected response to have status code 200 but got ${res.status}`);
  defineBe('success', () => range(200, 299), () => `expected response code to be 2XX but found ${res.status}`);
  defineBe('info', () => range(100, 199), () => `expected response code to be 1XX but found ${res.status}`);
  defineBe('redirection', () => range(300, 399), () => `expected response code to be 3XX but found ${res.status}`);
  defineBe('clientError', () => range(400, 499), () => `expected response code to be 4XX but found ${res.status}`);
  defineBe('serverError', () => range(500, 599), () => `expected response code to be 5XX but found ${res.status}`);
  defineBe('error', () => range(400, 599), () => `expected response code to be 4XX or 5XX but found ${res.status}`);
  defineBe('json', () => { try { JSON.parse(text()); return true; } catch { return false; } }, () => 'expected response body to be valid JSON');
  defineBe('notFound', () => res.status === 404, () => `expected response to have status code 404 but got ${res.status}`);
  defineBe('unauthorized', () => res.status === 401, () => `expected response to have status code 401 but got ${res.status}`);
  defineBe('forbidden', () => res.status === 403, () => `expected response to have status code 403 but got ${res.status}`);
  const have = {
    status(expected) {
      if (typeof expected === 'number') assert(res.status === expected, `expected response to have status code ${expected} but got ${res.status}`);
      else assert(String(res.statusText).toLowerCase() === String(expected).toLowerCase(), `expected response to have status reason '${expected}' but got '${res.statusText}'`);
      return true;
    },
    header(key, value) {
      const v = headers.get(key);
      assert(v !== undefined, `expected response to have header with key '${key}'`);
      if (value !== undefined) assert(v === String(value), `expected response header '${key}' to have value '${value}' but got '${v}'`);
      return true;
    },
    body(expected) {
      if (expected === undefined) assert(text().length > 0, 'expected response to have a body');
      else if (expected instanceof RegExp) assert(expected.test(text()), `expected response body to match ${expected}`);
      else assert(text() === String(expected), 'expected response body to equal the given value');
      return true;
    },
    jsonBody(path, value) {
      const data = json();
      if (path === undefined) return true;
      if (typeof path === 'object') { libs.chai.expect(data).to.deep.include(path); return true; }
      const got = libs.lodash.get(data, path);
      assert(got !== undefined, `expected response body json to have path '${path}'`);
      if (value !== undefined) libs.chai.expect(got).to.deep.equal(value);
      return true;
    },
    jsonSchema() { return true; },
  };
  const to = { have, be, not: {} };
  to.not.have = {
    status: (c) => { assert(res.status !== c, `expected response to not have status code ${c}`); return true; },
    header: (k) => { assert(headers.get(k) === undefined, `expected response to not have header '${k}'`); return true; },
  };
  to.be = be;
  return {
    code: res.status,
    status: res.statusText,
    responseTime: res.timeMs,
    responseSize: res.size,
    headers,
    text,
    json,
    reason: () => res.statusText,
    to,
    get cookies() {
      const cookies = headerArr.filter((h) => h.key.toLowerCase() === 'set-cookie').map((h) => {
        const [pair] = h.value.split(';');
        const i = pair.indexOf('=');
        return { name: pair.slice(0, i).trim(), value: pair.slice(i + 1).trim() };
      });
      return { get: (n) => cookies.find((c) => c.name === n)?.value, has: (n) => cookies.some((c) => c.name === n), toObject: () => Object.fromEntries(cookies.map((c) => [c.name, c.value])), all: () => cookies };
    },
  };
}

// ---------- sendRequest ----------

function toOutgoing(input, resolver) {
  if (typeof input === 'string') return { method: 'GET', url: resolver.replace(input), headers: [], body: { mode: 'none' } };
  const headers = [];
  const h = input.header || input.headers;
  if (Array.isArray(h)) h.forEach((x) => typeof x === 'string' ? headers.push({ key: x.split(':')[0].trim(), value: x.split(':').slice(1).join(':').trim() }) : headers.push({ key: x.key, value: resolver.replace(String(x.value ?? '')) }));
  else if (h && typeof h === 'object') Object.entries(h).forEach(([key, value]) => headers.push({ key, value: resolver.replace(String(value)) }));
  let body = { mode: 'none' };
  const b = input.body;
  if (b) {
    if (typeof b === 'string') body = { mode: 'raw', content: resolver.replace(b) };
    else if (b.mode === 'raw') body = { mode: 'raw', content: resolver.replace(typeof b.raw === 'string' ? b.raw : JSON.stringify(b.raw)) };
    else if (b.mode === 'urlencoded') body = { mode: 'urlencoded', fields: (b.urlencoded || []).filter((f) => !f.disabled).map((f) => ({ key: f.key, value: resolver.replace(String(f.value ?? '')) })) };
    else if (b.mode === 'formdata') body = { mode: 'formdata', fields: (b.formdata || []).filter((f) => !f.disabled).map((f) => ({ key: f.key, kind: f.type === 'file' ? 'file' : 'text', value: resolver.replace(String(f.value ?? '')), src: f.src })) };
    else if (b.mode === 'graphql') { body = { mode: 'raw', content: JSON.stringify({ query: b.graphql?.query, variables: b.graphql?.variables }) }; }
  }
  const url = typeof input.url === 'string' ? input.url : urlObject(input.url).raw;
  return { method: (input.method || 'GET').toUpperCase(), url: resolver.replace(url), headers, body };
}

// ---------- Runner ----------

function formatArg(a) {
  if (typeof a === 'string') return a;
  if (a instanceof Error) return `${a.name}: ${a.message}`;
  try { return JSON.stringify(a, null, 2); } catch { return String(a); }
}

// Postman's sandbox libraries beyond the always-loaded ones; loaded on first use.
export const PM_LIBS = ['cheerio', 'moment', 'xml2js', 'tv4', 'ajv', 'csv-parse/lib/sync', 'buffer', 'events', 'util', 'assert', 'path', 'querystring', 'url', 'string_decoder', 'punycode', 'timers', 'stream'];

export function needsExtraLibs(code) {
  for (const m of code.matchAll(/require\(\s*['"`](?:node:)?([^'"`]+)['"`]\s*\)/g)) if (PM_LIBS.includes(m[1])) return true;
  return /\b(cheerio|tv4|xml2Json)\b/.test(code);
}

// Postman's old sandbox shipped Sugar.js, and many shared scripts still call its
// Number methods, e.g. (Math.random() * 100).round(). Added once, non-enumerable.
function installSugarShims() {
  const P = Number.prototype;
  if (Object.hasOwn(P, 'round')) return;
  const step = (fn) => function (precision = 0) { const m = 10 ** precision; return fn(this * m) / m; };
  const methods = {
    round: step(Math.round),
    ceil: step(Math.ceil),
    floor: step(Math.floor),
    abs() { return Math.abs(this); },
    pow(n = 1) { return this ** n; },
    isEven() { return this % 2 === 0; },
    isOdd() { return Math.abs(this % 2) === 1; },
    isInteger() { return Number.isInteger(+this); },
    isMultipleOf(n) { return this % n === 0; },
    times(fn) { const out = []; for (let i = 0; i < this; i++) out.push(fn?.(i)); return out; },
    pad(place = 0, sign = false, base = 10) { const s = Math.abs(this).toString(base).padStart(place, '0'); return (this < 0 ? '-' : sign ? '+' : '') + s; },
    toNumber() { return +this; },
  };
  for (const [name, value] of Object.entries(methods)) {
    if (!(name in P)) Object.defineProperty(P, name, { value, writable: true, configurable: true });
  }
}

/**
 * Run one script.
 * ctx: { phase: 'prerequest'|'test', request, response?, resolver, scopes, send, libs, info }
 * Returns { tests, logs, error, skipRequest, nextRequest, visualizer }.
 * nextRequest stays undefined unless a script calls setNextRequest (null = stop the run);
 * visualizer stays undefined unless a script calls pm.visualizer (null = cleared).
 */
export async function runScript(code, ctx) {
  const result = { tests: [], logs: [], error: null, skipRequest: false, nextRequest: undefined, visualizer: undefined };
  if (!code || !code.trim()) return result;
  installSugarShims();
  if (!globalThis.__pmLibs && needsExtraLibs(code)) {
    try { await ctx.libs?.loadExtra?.(); } catch (e) { result.logs.push({ level: 'warn', message: `Couldn't load the script libraries: ${e?.message || e}`, ts: Date.now() }); }
  }
  const { libs = {}, scopes } = ctx;
  // Scripts never see vault secrets: {{vault:…}} stays a placeholder here.
  const resolver = ctx.resolver?.withoutVault?.() ?? ctx.resolver;
  const pending = [];
  const track = (p) => { pending.push(p.catch(() => {})); return p; };
  // Errors thrown later (in callbacks and timers) are script errors too, as in Postman.
  const fail = (where, e) => {
    const msg = `${where}: ${e?.message || e}`;
    if (!result.error) result.error = msg;
    result.logs.push({ level: 'error', message: msg, ts: Date.now() });
  };

  const log = (level) => (...args) => result.logs.push({ level, message: args.map(formatArg).join(' '), ts: Date.now() });
  const consoleApi = { log: log('log'), info: log('info'), warn: log('warn'), error: log('error'), debug: log('log'), clear() {} };

  const scopeApi = (scope) => ({
    get: (k) => scope.get(k),
    set: (k, v) => scope.set(k, v),
    unset: (k) => scope.unset(k),
    has: (k) => scope.has(k),
    clear: () => scope.clear(),
    toObject: () => scope.toObject(),
    replaceIn: (s) => resolver.replace(s),
    get name() { return scope.name; },
  });

  // Data-file row for this runner iteration (empty outside the runner).
  const dataScope = scopes.data;
  const iterationData = {
    get: (k) => dataScope?.get(k),
    has: (k) => !!dataScope?.has(k),
    unset: (k) => dataScope?.unset(k),
    toObject: () => (dataScope ? dataScope.toObject() : {}),
    toJSON: () => (dataScope ? dataScope.toObject() : {}),
    replaceIn: (s) => resolver.replace(s),
  };
  // A request name or id to run next; null ends the run. Only the runner acts on it.
  const setNextRequest = (next) => { result.nextRequest = next == null ? null : String(next); };

  const reqWrapper = wrapRequest(ctx.request, resolver);
  const resWrapper = ctx.response ? wrapResponse(ctx.response, libs) : undefined;

  const test = (name, fn) => {
    const entry = { name: String(name), passed: true, error: null };
    result.tests.push(entry);
    try {
      const r = fn?.();
      if (r && typeof r.then === 'function') {
        track(r.then(() => {}, (e) => { entry.passed = false; entry.error = e?.message || String(e); }));
      }
    } catch (e) {
      entry.passed = false;
      entry.error = e?.message || String(e);
    }
  };
  test.skip = (name) => result.tests.push({ name: String(name), passed: null, skipped: true, error: null });

  const sendRequest = (input, cb) => {
    const call = (err, res) => { try { cb?.(err, res); } catch (e) { fail('Error in the pm.sendRequest callback', e); } };
    const p = ctx.send(toOutgoing(input, resolver)).then(
      (r) => { const w = wrapResponse(r, libs); call(null, w); return w; },
      (e) => { const err = new Error(String(e?.message || e)); call(err, null); throw err; },
    );
    track(p);
    // A callback-style call never awaits the promise; don't let a failed send surface as an unhandled rejection.
    if (cb) p.catch(() => {});
    return p;
  };

  const pm = {
    info: { eventName: ctx.phase, requestName: ctx.info?.requestName, requestId: ctx.info?.requestId, iteration: ctx.info?.iteration ?? 0, iterationCount: ctx.info?.iterationCount ?? 1 },
    environment: scopeApi(scopes.environment),
    collectionVariables: scopeApi(scopes.collection),
    globals: scopeApi(scopes.globals),
    variables: { ...scopeApi(scopes.local), get: (k) => resolver.lookup(k)?.value, has: (k) => !!resolver.lookup(k), toObject: () => ({ ...scopes.globals.toObject(), ...scopes.collection.toObject(), ...scopes.environment.toObject(), ...scopes.local.toObject() }) },
    iterationData,
    request: reqWrapper,
    response: resWrapper,
    test,
    expect: libs.chai.expect,
    sendRequest,
    execution: { skipRequest: () => { result.skipRequest = true; }, setNextRequest, location: [] },
    cookies: resWrapper ? resWrapper.cookies : { get: () => undefined, has: () => false, toObject: () => ({}) },
    require: (n) => requireLib(n),
    visualizer: {
      set: (template, data, options) => { result.visualizer = { template: String(template ?? ''), data: data === undefined ? {} : JSON.parse(JSON.stringify(data)), options: options || {} }; },
      clear: () => { result.visualizer = null; },
    },
  };

  const legacyTests = {};
  const postman = {
    setEnvironmentVariable: (k, v) => scopes.environment.set(k, v),
    getEnvironmentVariable: (k) => scopes.environment.get(k),
    clearEnvironmentVariable: (k) => scopes.environment.unset(k),
    clearEnvironmentVariables: () => scopes.environment.clear(),
    setGlobalVariable: (k, v) => scopes.globals.set(k, v),
    getGlobalVariable: (k) => scopes.globals.get(k),
    clearGlobalVariable: (k) => scopes.globals.unset(k),
    setNextRequest,
    getResponseHeader: (k) => resWrapper?.headers.get(k),
  };

  function requireLib(name) {
    const map = {
      'crypto-js': libs.CryptoJS,
      lodash: libs.lodash,
      chai: libs.chai,
      uuid: { v4: uuid },
      atob: (s) => atob(s),
      btoa: (s) => btoa(s),
    };
    if (name in map && map[name]) return map[name];
    const extra = globalThis.__pmLibs;
    const key = name.replace(/^node:/, '');
    if (extra && key in extra) return extra[key];
    if (PM_LIBS.includes(key)) throw new Error(`"${name}" couldn't be loaded.`);
    throw new Error(`Dispatch doesn't bundle "${name}". Available: ${['crypto-js', 'lodash', 'chai', 'uuid', 'atob', 'btoa', ...PM_LIBS].join(', ')}.`);
  }

  const timers = (fn, ms, ...a) => { let t; track(new Promise((res) => { t = setTimeout(() => { try { fn(...a); } catch (e) { fail('Error in a setTimeout callback', e); } finally { res(); } }, ms); })); return t; };

  const extra = globalThis.__pmLibs || {};
  // Postman's legacy globals for scripts written before require().
  const xml2Json = (xml) => { let out = null; extra.xml2js?.parseString(xml, { explicitArray: false, async: false }, (e, r) => { if (e) throw e; out = r; }); return out; };
  const names = ['pm', 'postman', 'console', 'require', 'CryptoJS', '_', 'chai', 'tests', 'responseBody', 'responseCode', 'responseTime', 'responseHeaders', 'environment', 'globals', 'setTimeout', 'atob', 'btoa', 'data', 'iteration', 'cheerio', 'tv4', 'xml2Json', 'Buffer'];
  const values = [
    pm, postman, consoleApi, requireLib, libs.CryptoJS, libs.lodash, libs.chai, legacyTests,
    resWrapper ? resWrapper.text() : undefined,
    resWrapper ? { code: resWrapper.code, name: resWrapper.status, detail: resWrapper.status } : undefined,
    resWrapper ? resWrapper.responseTime : undefined,
    resWrapper ? resWrapper.headers.toObject() : undefined,
    scopes.environment.toObject(), scopes.globals.toObject(),
    timers, (s) => atob(s), (s) => btoa(s),
    iterationData.toObject(), pm.info.iteration,
    extra.cheerio, extra.tv4, xml2Json, extra.buffer?.Buffer ?? globalThis.Buffer,
  ];

  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function(...names, `return (async () => {\n${code}\n})();`);
    await fn(...values);
    await Promise.all(pending);
    // Promises added while waiting (e.g. sendRequest inside a callback)
    let n = 0;
    while (pending.length && n++ < 20) {
      const batch = pending.splice(0);
      await Promise.all(batch);
    }
  } catch (e) {
    result.error = e?.message || String(e);
  }

  for (const [name, passed] of Object.entries(legacyTests)) result.tests.push({ name, passed: !!passed, error: passed ? null : 'failed' });
  return result;
}
