// The request pipeline: pre-request scripts → variables → auth → send → tests.

import { clone, urlObject, getScript, effectiveAuth, authParam } from './model.js';
import { Resolver } from './vars.js';
import { runScript } from './scripts.js';
import { stripJsonComments } from './jsonc.js';
import { awsSigV4Sign, hawkHeader, digestHeader, parseDigestChallenge } from './authsign.js';
import { transportFor } from './transport.js';
import { bridge } from './bridge.js';

const RAW_TYPES = {
  json: 'application/json',
  xml: 'application/xml',
  html: 'text/html',
  javascript: 'application/javascript',
  text: 'text/plain',
};

const b64 = (s) => btoa(unescape(encodeURIComponent(s)));

/** Turn a (script-modified, unresolved) Postman request into what the backend sends. */
export function buildOutgoing(req, auth, resolver, settings) {
  const R = (s) => resolver.replace(s == null ? '' : String(s));
  const u = urlObject(req.url);

  // Path variables (:id) take values from the url.variable table.
  let url = u.raw || '';
  for (const v of u.variable || []) {
    if (!v.key || v.disabled) continue;
    url = url.replace(new RegExp(`/:${escapeRe(v.key)}(?=/|\\?|#|$)`, 'g'), `/${encodeURIComponent(R(v.value ?? ''))}`);
  }
  url = R(url);

  const headers = (req.header || []).filter((h) => !h.disabled && h.key).map((h) => ({ key: R(h.key), value: R(h.value) }));
  const hasHeader = (k) => headers.some((h) => h.key.toLowerCase() === k.toLowerCase());
  const queryAdd = [];

  // Body (built before auth so signers can hash the resolved content)
  let body = { mode: 'none' };
  const b = req.body;
  const method = (req.method || 'GET').toUpperCase();
  const bodyDisabled = b?.disabled;
  if (b && !bodyDisabled) {
    if (b.mode === 'raw' && b.raw != null && b.raw !== '') {
      const lang = b.options?.raw?.language || 'text';
      // Postman lets JSON bodies carry comments and strips them before sending.
      body = { mode: 'raw', content: R(lang === 'json' ? stripJsonComments(b.raw) : b.raw) };
      if (!hasHeader('content-type')) headers.push({ key: 'Content-Type', value: RAW_TYPES[lang] || 'text/plain' });
    } else if (b.mode === 'urlencoded') {
      body = { mode: 'urlencoded', fields: (b.urlencoded || []).filter((f) => !f.disabled && f.key).map((f) => ({ key: R(f.key), value: R(f.value) })) };
    } else if (b.mode === 'formdata') {
      body = {
        mode: 'formdata',
        fields: (b.formdata || []).filter((f) => !f.disabled && f.key).map((f) => ({
          key: R(f.key),
          kind: f.type === 'file' ? 'file' : 'text',
          value: R(f.value),
          src: Array.isArray(f.src) ? f.src[0] : f.src || null,
        })),
      };
    } else if (b.mode === 'graphql') {
      let variables;
      try { variables = b.graphql?.variables ? JSON.parse(R(b.graphql.variables)) : undefined; } catch { variables = undefined; }
      body = { mode: 'raw', content: JSON.stringify({ query: R(b.graphql?.query || ''), ...(variables ? { variables } : {}) }) };
      if (!hasHeader('content-type')) headers.push({ key: 'Content-Type', value: 'application/json' });
    } else if (b.mode === 'file' && b.file?.src) {
      body = { mode: 'file', path: b.file.src };
    }
  }

  // Auth (signers get the resolved URL, method and exact body content)
  const bodyContent = body.mode === 'raw' ? body.content : body.mode === 'urlencoded'
    ? body.fields.map((f) => `${encodeURIComponent(f.key)}=${encodeURIComponent(f.value)}`).join('&')
    : body.mode === 'file' ? '\u0000file' : '';
  const applied = applyAuth(auth, R, { url, method, bodyContent, contentType: headers.find((h) => h.key.toLowerCase() === 'content-type')?.value || '' });
  for (const h of applied.headers) if (!hasHeader(h.key)) headers.push(h);
  queryAdd.push(...applied.query);
  if (queryAdd.length) {
    const qs = queryAdd.map((q) => `${encodeURIComponent(q.key)}=${encodeURIComponent(q.value)}`).join('&');
    url += (url.includes('?') ? '&' : '?') + qs;
  }
  if (!hasHeader('accept')) headers.push({ key: 'Accept', value: '*/*' });

  const ppb = req._protocolProfileBehavior || {};
  return {
    method,
    url,
    headers,
    body,
    settings: {
      timeoutMs: settings.timeoutMs ?? 30000,
      followRedirects: ppb.followRedirects ?? settings.followRedirects ?? true,
      verifySsl: ppb.strictSSL ?? settings.verifySsl ?? true,
    },
  };
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

export function applyAuth(auth, R, ctx = {}) {
  const out = { headers: [], query: [], note: null };
  if (!auth || auth.type === 'noauth' || auth.type === 'inherit') return out;
  const p = (k) => R(authParam(auth, k) ?? '');
  const params = auth[auth.type];
  // Raw (array or object) params, without variable resolution.
  const pv = (k) => {
    if (Array.isArray(params)) return (params.find((x) => x.key === k) || {}).value;
    return params?.[k];
  };
  switch (auth.type) {
    case 'bearer': {
      const t = p('token');
      if (t) out.headers.push({ key: 'Authorization', value: `Bearer ${t}` });
      break;
    }
    case 'basic':
      out.headers.push({ key: 'Authorization', value: `Basic ${b64(`${p('username')}:${p('password')}`)}` });
      break;
    case 'apikey': {
      const key = p('key') || '';
      if (!key) break;
      if ((authParam(auth, 'in') || 'header') === 'query') out.query.push({ key, value: p('value') });
      else out.headers.push({ key, value: p('value') });
      break;
    }
    case 'oauth2': {
      const token = p('accessToken');
      if (!token) { out.note = 'OAuth 2.0 has no access token yet. Use "Get new access token".'; break; }
      if ((authParam(auth, 'addTokenTo') || 'header') === 'queryParams') out.query.push({ key: 'access_token', value: token });
      else out.headers.push({ key: 'Authorization', value: `${p('headerPrefix') || 'Bearer'} ${token}`.trim() });
      break;
    }
    case 'awsSigV4': {
      const cryptoLib = globalThis.CryptoJS || ctx.CryptoJS;
      if (!cryptoLib) { out.note = 'CryptoJS library is not loaded for AWS signing.'; break; }
      const signed = awsSigV4Sign({ method: ctx.method ?? 'GET', url: ctx.url ?? '', bodyContent: ctx.bodyContent ?? '',
        params: { accessKey: p('accessKey'), secretKey: p('secretKey'), region: p('region'), service: p('service'), sessionToken: p('sessionToken'),
          unsignedPayload: ctx.bodyContent === '\u0000file' || pv('unsignedPayload') === 'true' }, CryptoJS: cryptoLib });
      if (signed.note) { out.note = signed.note; break; }
      out.headers.push(...signed.headers);
      break;
    }
    case 'hawk': {
      const cryptoLib = globalThis.CryptoJS || ctx.CryptoJS;
      if (!cryptoLib) { out.note = 'CryptoJS library is not loaded for Hawk signing.'; break; }
      const signed = hawkHeader({ method: ctx.method ?? 'GET', url: ctx.url ?? '', bodyContent: ctx.bodyContent ?? '',
        params: { authId: pv('authId') ?? pv('id'), authKey: pv('authKey') ?? pv('key'), algorithm: pv('algorithm'), user: pv('user'),
          nonce: pv('nonce'), extraData: pv('extraData'), app: pv('app'), dlg: pv('dlg'),
          includePayload: pv('includePayload') ?? pv('includePayloadTimestamp') }, CryptoJS: cryptoLib });
      if (signed.note) { out.note = signed.note; break; }
      out.headers.push(...signed.headers);
      break;
    }
    case 'digest': {
      // Needs the server's nonce, which arrives as a 401 challenge; the send
      // pipeline retries once with the computed header (see execute()).
      if (!authParam(auth, 'username') || !authParam(auth, 'password')) {
        out.note = 'Digest auth has no username or password yet.';
        break;
      }
      if (authParam(auth, 'nonce')) { // pre-provided nonce: sign without a challenge
        const header = digestHeader({
          challenge: { realm: authParam(auth, 'realm'), nonce: authParam(auth, 'nonce'), qop: authParam(auth, 'qop'), algorithm: authParam(auth, 'algorithm'), opaque: authParam(auth, 'opaque') },
          method: ctx.method ?? 'GET', url: ctx.url ?? '',
          params: { username: authParam(auth, 'username'), password: authParam(auth, 'password'), nonceCount: authParam(auth, 'nonceCount'), clientNonce: authParam(auth, 'clientNonce') },
          CryptoJS: globalThis.CryptoJS || ctx.CryptoJS,
        });
        if (header) out.headers.push({ key: 'Authorization', value: header });
        else out.note = 'Digest auth is configured but has no usable nonce.';
      }
      break;
    }
    default:
      out.note = `"${auth.type}" auth isn't supported in Dispatch yet, so this request was sent without it.`;
  }
  return out;
}

/** Compute the Digest Authorization header to retry a 401-digest challenge with. */
export function digestRetry(auth, outgoing, wwwAuth, CryptoJS) {
  const p = (k) => authParam(auth, k) ?? '';
  const challenge = parseDigestChallenge(wwwAuth);
  return digestHeader({
    challenge,
    method: outgoing.method, url: outgoing.url,
    params: { username: p('username'), password: p('password'), nonceCount: p('nonceCount'), clientNonce: p('clientNonce'), algorithm: p('algorithm') },
    CryptoJS,
  });
}

/**
 * Extract the ?code= (or #code=) parameter from an OAuth redirect URL.
 */
export function codeFromRedirect(redirectUrl) {
  const u = new URL(redirectUrl, 'http://redirect.invalid');
  const code = u.searchParams.get('code') || u.hash?.replace(/^#/, '').split('&').map((p) => p.split('=').map(decodeURIComponent)).find(([k]) => k === 'code')?.[1];
  return code || null;
}

/**
 * Fetch an OAuth 2.0 token (client credentials, password or authorization code grant).
 * Returns the parsed token response.
 */
export async function fetchOAuthToken(auth, resolver, send, settings) {
  const R = (s) => resolver.replace(s == null ? '' : String(s));
  const p = (k) => R(authParam(auth, k) ?? '');
  const grant = authParam(auth, 'grant_type') || 'client_credentials';
  const tokenUrl = p('accessTokenUrl');
  if (!tokenUrl) throw new Error('Add the Access Token URL first.');
  const headers = [{ key: 'Accept', value: 'application/json' }];
  let fields = [{ key: 'grant_type', value: grant === 'password_credentials' ? 'password' : grant }];

  if (grant === 'authorization_code') {
    // Browser sign-in: open the auth page, capture the redirect with ?code=.
    const authUrlBase = p('authorizationUrl');
    if (!authUrlBase) throw new Error('Add the Authorization URL first.');
    const redirectUri = p('redirectUri');
    if (!redirectUri) throw new Error('Add a Redirect URI first (e.g. http://localhost/oauth/callback).');
    const stateStr = Math.random().toString(36).slice(2);
    const authUrl = new URL(authUrlBase);
    for (const [k, v] of [['response_type', 'code'], ['client_id', p('clientId')], ['redirect_uri', redirectUri], ['scope', p('scope')], ['state', stateStr]]) if (v) authUrl.searchParams.set(k, v);
    const redirectUrl = await bridge.oauthFlow(authUrl.toString(), redirectUri);
    const code = codeFromRedirect(redirectUrl);
    if (!code) throw new Error(`The sign-in redirect had no code: ${redirectUrl}`);
    fields = [{ key: 'grant_type', value: 'authorization_code' }, { key: 'code', value: code }, { key: 'redirect_uri', value: redirectUri }];
    const verifier = p('codeVerifier');
    if (verifier) fields.push({ key: 'code_verifier', value: verifier });
  } else {
    if (grant === 'password_credentials') {
      fields.push({ key: 'username', value: p('username') }, { key: 'password', value: p('password') });
    }
    if (p('scope')) fields.push({ key: 'scope', value: p('scope') });
    const clientAuth = authParam(auth, 'client_authentication') || 'header';
    if (clientAuth === 'body') {
      fields.push({ key: 'client_id', value: p('clientId') }, { key: 'client_secret', value: p('clientSecret') });
    } else {
      headers.push({ key: 'Authorization', value: `Basic ${b64(`${p('clientId')}:${p('clientSecret')}`)}` });
    }
  }

  const res = await send({ method: 'POST', url: tokenUrl, headers, body: { mode: 'urlencoded', fields }, settings });
  let json;
  try { json = JSON.parse(res.bodyText || ''); } catch { json = null; }
  if (res.status >= 400 || !json?.access_token) {
    const why = json?.error_description || json?.error || (res.bodyText || '').slice(0, 200);
    throw new Error(`The token endpoint returned ${res.status}${why ? `: ${why}` : ''}`);
  }
  return json;
}

/**
 * Run a request end to end.
 * opts: { item, parents, collection, scopes, settings, send, libs, run, sendMain }
 * sendMain (optional) sends the request itself, e.g. streaming; scripts' pm.sendRequest always uses send.
 * run (runner only): { iteration (0-based), iterationCount }.
 * The result's nextRequest/visualizer are set when a script asked for them.
 */
export async function execute({ item, parents, collection, scopes, settings, send, libs, run, sendMain = send }) {
  const req = clone(item.request);
  if (item.protocolProfileBehavior) req._protocolProfileBehavior = item.protocolProfileBehavior;
  const resolver = new Resolver(scopes);
  const info = { requestName: item.name, requestId: item.id, iteration: run?.iteration ?? 0, iterationCount: run?.iterationCount ?? 1 };
  const out = { logs: [], tests: [], response: null, error: null, outgoing: null, notes: [], scriptErrors: [], nextRequest: undefined, visualizer: undefined };
  const take = (r) => {
    if (r.nextRequest !== undefined) out.nextRequest = r.nextRequest;
    if (r.visualizer !== undefined) out.visualizer = r.visualizer;
  };
  const chain = [collection, ...parents, item].filter(Boolean);

  const ctxBase = { resolver, scopes, libs, info, send };

  for (const target of chain) {
    const code = getScript(target, 'prerequest');
    if (!code) continue;
    const r = await runScript(code, { ...ctxBase, phase: 'prerequest', request: req });
    out.logs.push(...r.logs);
    take(r);
    if (r.error) {
      out.scriptErrors.push({ phase: 'Pre-request script', where: target === collection ? 'collection' : target.name, message: r.error });
      out.error = `Pre-request script error in ${target === collection ? 'the collection' : `"${target.name}"`}: ${r.error}`;
      return out;
    }
    if (r.skipRequest) { out.notes.push('A pre-request script skipped this request.'); return out; }
  }

  const { auth } = effectiveAuth(req, parents, collection);
  const outgoing = buildOutgoing(req, auth, resolver, settings);
  const authNote = applyAuth(auth, (s) => resolver.replace(s), { url: outgoing.url, method: outgoing.method, bodyContent: outgoing.body.mode === 'raw' ? outgoing.body.content : outgoing.body.mode === 'urlencoded' ? outgoing.body.fields.map((f) => `${f.key}=${f.value}`).join('&') : outgoing.body.mode === 'file' ? '\u0000file' : '' }).note;
  if (authNote) out.notes.push(authNote);
  const missing = new Set([...resolver.unresolved(urlObject(req.url).raw), ...(req.header || []).filter((h) => !h.disabled).flatMap((h) => resolver.unresolved(h.value))]);
  if (missing.size) out.notes.push(`Unresolved variables: ${[...missing].map((m) => `{{${m}}}`).join(', ')}`);
  try {
    const transport = await transportFor(outgoing.url).catch(() => ({}));
    if (transport.proxyUrl) outgoing.settings.proxyUrl = transport.proxyUrl;
    if (transport.clientCert) outgoing.settings.clientCert = transport.clientCert;
  } catch { /* transport config is optional */ }
  out.outgoing = outgoing;

  try {
    out.response = await sendMain(outgoing);
  } catch (e) {
    out.error = String(e?.message || e);
    return out;
  }

  // Digest challenge-response: one automatic retry on the server's 401 challenge.
  const www = out.response?.headers?.find((h) => (h.key || '').toLowerCase() === 'www-authenticate')?.value || '';
  if (auth?.type === 'digest' && authParam(auth, 'username') && authParam(auth, 'password') && out.response?.status === 401 && /^digest/i.test(www)) {
    const CryptoJS = globalThis.CryptoJS || libs?.CryptoJS;
    const header = digestRetry(auth, outgoing, www, CryptoJS);
    if (header) {
      const retry = { ...outgoing, headers: [...outgoing.headers.filter((h) => (h.key || '').toLowerCase() !== 'authorization'), { key: 'Authorization', value: header }] };
      try {
        out.response = await sendMain(retry);
        out.notes.push('Sent again with the Digest challenge response from the server.');
      } catch (e) {
        out.error = String(e?.message || e);
        return out;
      }
    }
  }

  for (const target of chain) {
    const code = getScript(target, 'test');
    if (!code) continue;
    const r = await runScript(code, { ...ctxBase, phase: 'test', request: req, response: out.response });
    out.logs.push(...r.logs);
    take(r);
    out.tests.push(...r.tests);
    if (r.error) out.scriptErrors.push({ phase: 'Test script', where: target === collection ? 'collection' : target.name, message: r.error });
  }
  return out;
}
