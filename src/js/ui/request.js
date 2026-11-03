import { h, icon, showMenu, toast, errText, fmtBytes, fmtMs, methodClass, modal, popover, closeMenu, lazyEl } from './dom.js';
import { LANGUAGES, generate } from '../codegen.js';
import { docsEditor, descriptionText } from './docs.js';
import { loadVendor } from '../vendor.js';
import { varInput, kvSection, codeArea, highlightJson, subtabs } from './components.js';
import * as WS from '../ws.js';
import * as C from '../ctx.js';
import * as S from '../store.js';
import { state } from '../store.js';
import { bridge } from '../bridge.js';
import { METHODS, urlObject, setRawUrl, rawWithQuery, getScript, setScript, AUTH_TYPES, authParam, setAuthParam, effectiveAuth, parseUrl, clone, exampleFromResponse } from '../model.js';
import { fetchOAuthToken } from '../send.js';
import { formatJsonc, jsonProblem } from '../jsonc.js';
import { parseSse, parseNdjson, isEventStream, isLineStream } from '../sse.js';

// Less-used features load their code on first use.
const openCookieManager = (opts) => import('./cookies.js').then((m) => m.openCookieManager(opts));
const writeTests = (t) => import('./assistview.js').then((m) => m.writeTests(t));
const explainResponse = (t) => import('./assistview.js').then((m) => m.explainResponse(t));
const openCompare = (t) => import('./compare.js').then((m) => m.openCompare(t));

// ---------- request editor ----------

export function renderRequestEditor(root, t) {
  const req = (t.draft.request = t.draft.request || { method: 'GET', header: [], url: parseUrl('') });
  req.url = urlObject(req.url);
  req.header = req.header || [];
  const resolver = () => C.resolverFor(t);
  const dirty = () => C.markDirty(t);
  const { entry, collection, parents } = C.contextFor(t);

  // breadcrumb + name + save
  const path = entry ? [entry.name, ...parents.map((p) => p.name)].join(' / ') : null;
  const nameInput = h('input', { class: 'name-input', value: t.draft.name, spellcheck: 'false', oninput: (e) => { t.draft.name = e.target.value; dirty(); C.emitTabs(); } });
  const crumbs = h('div', { class: 'crumbs' },
    path ? h('span', { class: 'path', title: path }, `${path} /`) : h('span', { class: 'badge local' }, 'Not saved'),
    nameInput,
    h('span', { class: 'grow' }),
    h('button', { class: 'icon-btn', title: state.settings.layout === 'side' ? 'Show the response below (⌥⌘V)' : 'Show the response beside the request (⌥⌘V)', onclick: () => S.toggleLayout() }, icon(state.settings.layout === 'side' ? 'rows' : 'columns')),
    h('button', { class: 'icon-btn', title: 'Code snippet (⌥⌘C)', onclick: () => codeDialog(t) }, icon('code')),
    h('button', { class: 'btn sm', title: 'Save (⌘S)', onclick: () => C.saveTab(t) }, icon('check'), t.ref?.col ? 'Save' : 'Save to collection'),
    h('button', { class: 'icon-btn', title: 'More', onclick: (e) => showMenu(e, [
      { label: 'Copy as cURL', icon: 'terminal', onClick: async () => { await navigator.clipboard.writeText(C.curlFor(t)); toast('Copied cURL command'); } },
      { label: 'Generate code…', icon: 'code', key: '⌥⌘C', onClick: () => codeDialog(t) },
      { label: 'Compare across environments…', icon: 'columns', onClick: () => openCompare(t) },
      { label: 'Load test…', icon: 'play', onClick: () => C.openLoadTest(t) },
      { label: 'Save as new request…', icon: 'copy', onClick: async () => { const { saveAsDialog } = await import('./panels.js'); const r = await saveAsDialog(`${t.draft.name} Copy`); if (r) { const nt = C.openDraft(clone(t.draft)); await C.saveRequestInto(nt, r.entry, r.folderId, r.name); } } },
      t.ref?.col && t.dirty ? { label: 'Discard changes', icon: 'sync', onClick: () => { const f = C.contextFor(t).item; if (f) { t.draft = clone(f); t.dirty = false; C.emitAll(); } } } : null,
    ].filter(Boolean)) }, icon('more')));

  // method + URL + send
  const methodSel = h('select', { class: ['select method-select', methodClass(req.method)], onchange: (e) => { req.method = e.target.value; methodSel.className = `select method-select ${methodClass(req.method)}`; dirty(); C.emitTabs(); } },
    [...new Set([...METHODS, req.method || 'GET'])].map((m) => h('option', { value: m, selected: m === (req.method || 'GET') }, m)));
  const urlField = varInput({
    value: req.url.raw || '', placeholder: 'Enter a URL, or paste a cURL command', resolver,
    oninput: (v) => {
      if (/^\s*curl\s/i.test(v)) return; // handled on paste
      setRawUrl(req, v);
      dirty();
      if (t.sub === 'params') renderPane();
    },
    onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); WS.isWs(req.url.raw || '') ? C.wsToggle(t) : C.run(t); } },
  });
  urlField.classList.add('url-wrap');
  urlField.style.height = '100%';
  urlField.input.addEventListener('paste', (e) => {
    const text = e.clipboardData?.getData('text') || '';
    if (!/^\s*curl\s/i.test(text)) return;
    e.preventDefault();
    import('../curl.js').then(({ parseCurl }) => {
      const parsed = parseCurl(text);
      Object.assign(req, parsed);
      dirty();
      toast('Imported the cURL command');
      C.emitAll();
    }).catch((err) => toast(errText(err), { error: true }));
  });
  const wsMode = WS.isWs(req.url.raw || '');
  const wsBtnLabel = wsMode ? (t.wsConn?.status === 'connected' ? 'Disconnect' : t.wsConn?.status === 'connecting' ? 'Cancel' : 'Connect') : t.running ? 'Sending…' : 'Send';
  const sendBtn = h('button', { class: 'btn primary send-btn', disabled: t.running && !wsMode, onclick: () => (wsMode ? C.wsToggle(t) : C.run(t)) }, wsBtnLabel);
  const reqline = h('div', { class: 'reqline' }, h('div', { class: 'reqline-box' }, methodSel, urlField), sendBtn);

  // sub tabs
  const enabledCount = (a) => (a || []).filter((x) => !x.disabled && x.key).length;
  // Rebuilt on every renderTabs so counts and dots follow edits.
  const tabsDef = () => {
    const authType = req.auth?.type || 'inherit';
    return [
      { id: 'params', label: 'Params', count: enabledCount(req.url.query) || '' },
      { id: 'auth', label: 'Authorization', dot: authType !== 'inherit' && authType !== 'noauth' },
      { id: 'headers', label: 'Headers', count: enabledCount(req.header) || '' },
      { id: 'body', label: 'Body', dot: !!req.body?.mode && req.body.mode !== 'none' && !isEmptyBody(req.body) },
      { id: 'scripts', label: 'Scripts', dot: !!(getScript(t.draft, 'prerequest') || getScript(t.draft, 'test')) },
      { id: 'settings', label: 'Settings' },
      { id: 'docs', label: 'Docs', dot: !!descriptionText(req.description).trim() },
    ];
  };
  const tabsHolder = h('div');
  const pane = h('div', { class: 'pane' });
  const renderTabs = () => tabsHolder.replaceChildren(subtabs(tabsDef(), t.sub, (id) => { t.sub = id; renderTabs(); renderPane(); C.saveTabsLater(); }));

  function renderPane() {
    pane.replaceChildren();
    const sub = t.sub;
    if (sub === 'params') {
      const query = (req.url.query = req.url.query || []);
      pane.append(kvSection({ title: 'Query params', rows: query, resolver, kind: 'params', onChange: () => {
        req.url.raw = rawWithQuery(req.url.raw || '', query);
        urlField.setValue(req.url.raw);
        dirty();
      } }));
      if ((req.url.variable || []).length) {
        pane.append(h('div', { style: { height: '14px' } }), kvSection({ title: 'Path variables', rows: req.url.variable, resolver, kind: 'pathvars', onChange: dirty }));
      }
    } else if (sub === 'auth') {
      pane.append(authEditor({ target: req, kind: 'request', parents, collection, resolver, onChange: () => { dirty(); }, onTypeChange: () => { renderTabs(); renderPane(); }, tab: t }));
    } else if (sub === 'headers') {
      pane.append(kvSection({ title: 'Headers', rows: req.header, resolver, kind: 'headers', onChange: () => { dirty(); } }));
      const { auth, source } = effectiveAuth(req, parents, collection);
      pane.append(h('p', { class: 'hint' }, 'Dispatch adds ', h('span', { class: 'mono' }, 'Accept: */*'), ' and a Content-Type matching the body when you haven\'t set them.', auth ? ` Auth headers come from ${source === 'request' ? 'the Authorization tab' : `the ${source === 'collection' ? 'collection' : `"${source}" folder`}`}.` : ''));
    } else if (sub === 'body') {
      pane.append(bodyEditor(req, resolver, dirty, () => { renderTabs(); }, { graphql: {
        schemaKey: () => { try { return C.outgoingFor(t).url; } catch { return ''; } },
        loadSchema: async () => {
          // Introspect the same endpoint, with the request's own headers and auth.
          const o = C.outgoingFor(t);
          const headers = o.headers.filter((x) => x.key.toLowerCase() !== 'content-type').concat({ key: 'Content-Type', value: 'application/json' });
          const { INTROSPECTION_QUERY, buildSchema } = await import('../graphql.js');
          const res = await bridge.send({ ...o, method: 'POST', headers, body: { mode: 'raw', content: JSON.stringify({ query: INTROSPECTION_QUERY, operationName: 'IntrospectionQuery' }) } });
          let json;
          try { json = JSON.parse(res.bodyText || ''); } catch { throw new Error(`The server answered ${res.status} without JSON. Check the URL and auth.`); }
          return buildSchema(json);
        },
      } }));
    } else if (sub === 'scripts') {
      pane.append(scriptsEditor(t.draft, t, dirty, () => renderTabs()));
    } else if (sub === 'settings') {
      pane.append(requestSettings(t.draft, dirty));
    } else if (sub === 'docs') {
      // Postman keeps a request's documentation on request.description.
      pane.append(docsEditor({ get: () => descriptionText(req.description), set: (v) => { if (v) req.description = v; else delete req.description; }, onChange: () => { dirty(); renderTabs(); }, state: t }));
    }
  }
  renderTabs();
  renderPane();

  root.replaceChildren(crumbs, reqline, tabsHolder, pane);
  root.focusUrl = () => urlField.input.focus();
  root.repaintVars = () => { urlField.repaint(); pane.querySelectorAll('.var-input').forEach((v) => v.repaint?.()); };
}

/**
 * Pretty-print a JSON body that may contain {{variables}} (inside strings or
 * bare, e.g. "amount": {{amount}}) and // or /* *\/ comments, keeping both.
 * Throws when the JSON itself isn't valid.
 */
export function beautifyJson(text) {
  const problem = jsonProblem(text);
  if (problem) throw new Error(problem);
  return formatJsonc(text);
}

function isEmptyBody(b) {
  if (b.mode === 'raw') return !b.raw;
  if (b.mode === 'urlencoded') return !(b.urlencoded || []).length;
  if (b.mode === 'formdata') return !(b.formdata || []).length;
  if (b.mode === 'graphql') return !b.graphql?.query;
  if (b.mode === 'file') return !b.file?.src;
  return true;
}

// ---------- auth ----------

export function authEditor({ target, kind, parents = [], collection, resolver, onChange, onTypeChange, tab }) {
  const box = h('div');
  const types = kind === 'collection' ? AUTH_TYPES.filter(([id]) => id !== 'inherit') : AUTH_TYPES;
  const known = types.map(([id]) => id);
  const current = target.auth?.type || (kind === 'collection' ? 'noauth' : 'inherit');
  const select = h('select', { class: 'select', onchange: (e) => {
    const type = e.target.value;
    if (type === 'inherit') delete target.auth;
    else {
      const prev = target.auth;
      target.auth = { ...(prev || {}), type };
      if (type !== 'noauth' && !Array.isArray(target.auth[type])) target.auth[type] = [];
    }
    onChange();
    onTypeChange?.();
  } },
    types.map(([id, label]) => h('option', { value: id, selected: id === current }, label)),
    !known.includes(current) ? h('option', { value: current, selected: true }, `${current} (kept as is)`) : null);

  const field = (label, key, { secret = false, placeholder = '' } = {}) => {
    const input = varInput({ value: String(authParam(target.auth, key) ?? ''), placeholder, resolver, oninput: (v) => { setAuthParam(target.auth, key, v); onChange(); } });
    if (secret) input.input.type = 'password';
    return [h('label', null, label), secret ? h('div', { class: 'row' }, h('div', { class: 'grow' }, input), h('button', { class: 'icon-btn', title: 'Show', onclick: () => { input.input.type = input.input.type === 'password' ? 'text' : 'password'; } }, icon('eye'))) : input];
  };
  const choice = (label, key, options, def) => {
    const v = authParam(target.auth, key) ?? def;
    return [h('label', null, label), h('select', { class: 'select', onchange: (e) => { setAuthParam(target.auth, key, e.target.value); onChange(); onTypeChange?.(); } }, options.map(([id, l]) => h('option', { value: id, selected: id === v }, l)))];
  };

  const grid = h('div', { class: 'form-grid' }, h('label', null, 'Auth type'), select);
  box.append(grid);

  if (current === 'inherit') {
    const { auth, source } = effectiveAuth({}, parents, collection);
    const label = auth ? AUTH_TYPES.find(([id]) => id === auth.type)?.[1] || auth.type : 'No Auth';
    box.append(h('div', { class: 'inherit-box', style: { marginTop: '14px' } },
      auth ? h('span', null, 'This request uses ', h('b', null, label), ` from ${source === 'collection' ? 'the collection' : `the "${source}" folder`}.`) : 'Nothing above this request sets auth, so it is sent without any.'));
  } else if (current === 'noauth') {
    box.append(h('p', { class: 'hint', style: { marginTop: '12px' } }, 'No authorization is sent.'));
  } else if (current === 'bearer') {
    grid.append(...field('Token', 'token', { secret: true, placeholder: 'Token or {{variable}}' }));
  } else if (current === 'basic') {
    grid.append(...field('Username', 'username'), ...field('Password', 'password', { secret: true }));
  } else if (current === 'apikey') {
    grid.append(...field('Key', 'key', { placeholder: 'e.g. X-API-Key' }), ...field('Value', 'value', { secret: true }), ...choice('Add to', 'in', [['header', 'Header'], ['query', 'Query params']], 'header'));
  } else if (current === 'oauth2') {
    const grant = authParam(target.auth, 'grant_type') || 'client_credentials';
    grid.append(
      ...field('Current token', 'accessToken', { secret: true, placeholder: 'Paste a token or get a new one below' }),
      ...field('Header prefix', 'headerPrefix', { placeholder: 'Bearer' }),
      ...choice('Add token to', 'addTokenTo', [['header', 'Request headers'], ['queryParams', 'Query params']], 'header'),
      h('div', { class: 'full pane-title', style: { marginTop: '14px' } }, 'Get a new access token'),
      ...choice('Grant type', 'grant_type', [['client_credentials', 'Client Credentials'], ['password_credentials', 'Password Credentials'], ['authorization_code', 'Authorization Code (paste token above)']], 'client_credentials'),
    );
    if (grant !== 'authorization_code') {
      grid.append(
        ...field('Access token URL', 'accessTokenUrl', { placeholder: 'https://auth.example.com/oauth/token' }),
        ...field('Client ID', 'clientId'),
        ...field('Client secret', 'clientSecret', { secret: true }),
        ...field('Scope', 'scope', { placeholder: 'Optional' }),
      );
      if (grant === 'password_credentials') grid.append(...field('Username', 'username'), ...field('Password', 'password', { secret: true }));
      grid.append(...choice('Client authentication', 'client_authentication', [['header', 'Send as Basic Auth header'], ['body', 'Send client credentials in body']], 'header'));
      const btn = h('button', { class: 'btn primary', onclick: async () => {
        btn.disabled = true; btn.textContent = 'Getting token…';
        try {
          const tok = await fetchOAuthToken(target.auth, resolver(), (r) => bridge.send(r), state.settings);
          setAuthParam(target.auth, 'accessToken', tok.access_token);
          if (tok.token_type && !authParam(target.auth, 'headerPrefix')) setAuthParam(target.auth, 'headerPrefix', tok.token_type.toLowerCase() === 'bearer' ? 'Bearer' : tok.token_type);
          onChange();
          onTypeChange?.();
          toast(`Got a new access token${tok.expires_in ? ` (expires in ${Math.round(tok.expires_in / 60)} min)` : ''}`);
        } catch (e) { toast(errText(e), { error: true }); btn.disabled = false; btn.textContent = 'Get new access token'; }
      } }, 'Get new access token');
      grid.append(h('span'), h('div', null, btn));
    } else {
      grid.append(
        ...field('Authorization URL', 'authorizationUrl', { placeholder: 'https://authorize.example.com/oauth/authorize' }),
        ...field('Redirect URI', 'redirectUri', { placeholder: 'e.g. http://localhost/oauth/callback' }),
        ...field('Code verifier (PKCE)', 'codeVerifier', { secret: true, placeholder: 'Optional' }),
        h('span'), h('div', null, btn),
        h('p', { class: 'hint full', style: { margin: '4px 0 0' } }, 'Opens a sign-in window; Dispatch captures the redirect with the code automatically and exchanges the code for the token.'),
      );
    }
  } else if (current === 'digest') {
    grid.append(
      ...field('Username', 'username'),
      ...field('Password', 'password', { secret: true }),
      ...field('Realm', 'realm', { placeholder: 'Optional — filled from the server\'s challenge' }),
      ...field('Server nonce', 'nonce', { placeholder: 'Optional — obtained automatically on a 401' }),
      ...choice('Algorithm', 'algorithm', [['', 'Let the server pick (MD5)'], ['MD5', 'MD5'], ['SHA-256', 'SHA-256']], ''),
      ...field('Client nonce', 'clientNonce', { placeholder: 'Optional' }),
      h('span'), h('p', { class: 'hint full', style: { margin: '4px 0 0' } }, 'A Digest request is sent once, and the server\'s 401 challenge completes it automatically — no extra setup.'),
    );
  } else if (current === 'hawk') {
    grid.append(
      ...field('Auth ID', 'authId', { placeholder: 'id' }),
      ...field('Auth Key', 'authKey', { secret: true, placeholder: 'key' }),
      ...choice('Algorithm', 'algorithm', [['sha256', 'SHA-256'], ['sha1', 'SHA-1']], 'sha256'),
      ...field('User', 'user', { placeholder: 'Optional' }),
      ...field('Nonce', 'nonce', { placeholder: 'Optional' }),
      ...field('Ext (extra data)', 'extraData', { placeholder: 'Optional' }),
      ...field('App', 'app', { placeholder: 'Optional' }),
      ...field('Dlg', 'dlg', { placeholder: 'Optional' }),
      ...choice('Body hash', 'includePayload', [['false', 'Do not hash the payload'], ['true', 'Include the payload hash']], 'false'),
    );
  } else if (current === 'awsSigV4') {
    grid.append(
      ...field('Access key', 'accessKey'),
      ...field('Secret key', 'secretKey', { secret: true }),
      ...field('Region', 'region', { placeholder: 'us-east-1' }),
      ...field('Service', 'service', { placeholder: 'e.g. execute-api, s3, iam' }),
      ...field('Session token', 'sessionToken', { secret: true, placeholder: 'Optional (temporary credentials)' }),
    );
  } else {
    box.append(h('div', { class: 'note warn', style: { marginTop: '12px' } }, icon('alert'), h('span', null, `Dispatch can't edit or apply "${current}" auth yet. It's kept exactly as is and stays in sync with Postman, but requests here are sent without it.`)));
  }
  return box;
}

// ---------- code snippets ----------

/** Postman's "Code" panel: the request as it would go out, in another language. */
export function codeDialog(t) {
  let lang = LANGUAGES.some(([id]) => id === state.settings.codegenLang) ? state.settings.codegenLang : 'curl';
  let outgoing;
  try { outgoing = C.outgoingFor(t); } catch (e) { toast(errText(e), { error: true }); return; }
  const pre = h('pre', { class: 'body code-snippet' });
  const render = () => { try { pre.textContent = generate(lang, outgoing); } catch (e) { pre.textContent = errText(e); } };
  const sel = h('select', { class: 'select', onchange: (e) => { lang = e.target.value; state.settings.codegenLang = lang; S.saveSettings(); render(); } },
    LANGUAGES.map(([id, label]) => h('option', { value: id, selected: id === lang }, label)));
  render();
  modal({
    title: 'Code snippet',
    wide: true,
    body: h('div', null,
      h('div', { class: 'row', style: { marginBottom: '10px' } }, sel, h('span', { class: 'grow' }),
        h('button', { class: 'btn sm', onclick: async () => { await navigator.clipboard.writeText(pre.textContent); toast('Copied'); } }, icon('copy'), 'Copy')),
      pre,
      h('p', { class: 'hint', style: { marginBottom: 0 } }, 'Variables are filled in with their current values and auth is applied; {{vault:…}} secrets stay as placeholders. Check for other secrets before sharing.')),
  });
}

// ---------- body ----------

export function bodyEditor(req, resolver, dirty, onModeChange, opts = {}) {
  const wrap = h('div', { class: 'split-pane' });
  const body = (req.body = req.body || { mode: 'none' });
  const modes = [['none', 'none'], ['formdata', 'form-data'], ['urlencoded', 'x-www-form-urlencoded'], ['raw', 'raw'], ['file', 'binary'], ['graphql', 'GraphQL']];
  const lang = body.options?.raw?.language || 'json';
  const render = () => {
    const mode = body.mode || 'none';
    const radios = h('div', { class: 'radio-row' }, modes.map(([id, label]) => h('label', { class: id === mode ? 'on' : '' },
      h('input', { type: 'radio', name: `bm-${Math.random()}`, checked: id === mode, onchange: () => {
        body.mode = id;
        if (id === 'raw' && body.raw === undefined) body.raw = '';
        if (id === 'raw' && !body.options?.raw?.language) body.options = { ...(body.options || {}), raw: { language: 'json' } };
        dirty(); onModeChange(); render();
      } }), label)));
    const parts = [radios];
    if (mode === 'raw') {
      const curLang = body.options?.raw?.language || lang;
      const langSel = h('select', { class: 'select', style: { height: '26px', fontSize: '12px' }, onchange: (e) => { body.options = { ...(body.options || {}), raw: { ...(body.options?.raw || {}), language: e.target.value } }; ta.setLang(e.target.value); dirty(); } },
        [['json', 'JSON'], ['text', 'Text'], ['javascript', 'JavaScript'], ['html', 'HTML'], ['xml', 'XML']].map(([id, l]) => h('option', { value: id, selected: id === curLang }, l)));
      const ta = codeArea({ value: body.raw || '', lang: curLang, placeholder: curLang === 'json' ? '{\n  "key": "value"\n}' : '', oninput: (v) => { body.raw = v; dirty(); } });
      const beautify = h('button', { class: 'btn ghost sm', onclick: () => {
        try {
          const out = beautifyJson(ta.value);
          ta.value = out; body.raw = out; dirty();
        } catch (e) { toast(`That isn't valid JSON yet: ${e.message}`, { error: true }); }
      } }, 'Beautify');
      parts.push(h('div', { class: 'row', style: { marginBottom: '8px' } }, langSel, h('span', { class: 'grow' }), beautify), h('div', { class: 'code-wrap' }, ta.el));
    } else if (mode === 'urlencoded') {
      parts.push(kvSection({ rows: (body.urlencoded = body.urlencoded || []), resolver, kind: 'urlencoded', onChange: dirty }));
    } else if (mode === 'formdata') {
      parts.push(kvSection({ rows: (body.formdata = body.formdata || []), resolver, kind: 'form', onChange: dirty, pickFile: () => bridge.pickFilePath() }));
    } else if (mode === 'file') {
      const src = body.file?.src;
      parts.push(h('div', { class: 'row' }, h('button', { class: 'btn', onclick: async () => { const p = await bridge.pickFilePath(); if (p) { body.file = { src: p }; dirty(); render(); } } }, icon('file'), src ? 'Change file' : 'Choose file'), h('span', { class: 'mono muted ellipsis' }, src || 'No file chosen')));
    } else if (mode === 'graphql') {
      const gql = opts.graphql || { schemaKey: () => '', loadSchema: async () => { throw new Error('Open this request in its own tab to load the schema.'); } };
      parts.push(lazyEl(() => import('./gqleditor.js').then((m) => m.graphqlEditor({ body, dirty, ...gql }))));
    } else {
      parts.push(h('p', { class: 'hint' }, 'This request has no body.'));
    }
    wrap.replaceChildren(...parts);
  };
  render();
  return wrap;
}

// ---------- scripts ----------

const SNIPPETS = {
  prerequest: [
    ['Set an environment variable', "pm.environment.set('name', 'value');"],
    ['Set a collection variable', "pm.collectionVariables.set('name', 'value');"],
    ['Add a header', "pm.request.headers.upsert({ key: 'X-Request-Id', value: pm.variables.replaceIn('{{$guid}}') });"],
    ['Timestamp header', "pm.request.headers.upsert({ key: 'X-Timestamp', value: String(Math.floor(Date.now() / 1000)) });"],
    ['Add bearer token from the environment', "const token = pm.environment.get('token');\nif (token) pm.request.headers.upsert({ key: 'Authorization', value: 'Bearer ' + token });"],
    ['Sign the body with HMAC-SHA256', "const sig = CryptoJS.HmacSHA256(pm.request.body.raw || '', pm.environment.get('secret')).toString(CryptoJS.enc.Hex);\npm.request.headers.upsert({ key: 'X-Signature', value: sig });"],
    ['MD5 of the body', "const md5 = CryptoJS.MD5(pm.request.body.raw || '').toString(CryptoJS.enc.Hex);\npm.request.headers.upsert({ key: 'X-MD5', value: md5 });"],
    ['Base64 encode the body', "const encoded = btoa(pm.request.body.raw || '');\npm.request.headers.upsert({ key: 'X-Encoded', value: encoded });"],
    ['Send a request first', "pm.sendRequest({\n  url: pm.variables.replaceIn('{{baseUrl}}/token'),\n  method: 'POST',\n  header: { 'Content-Type': 'application/json' },\n  body: { mode: 'raw', raw: JSON.stringify({ id: pm.environment.get('clientId') }) }\n}, (err, res) => {\n  if (!err) pm.environment.set('token', res.json().token);\n});"],
    ['Skip this request when a variable is missing', "if (!pm.environment.get('token')) {\n  console.log('no token yet, skipping');\n  pm.execution.skipRequest();\n}"],
  ],
  test: [
    ['Status code is 200', "pm.test('Status code is 200', () => {\n  pm.response.to.have.status(200);\n});"],
    ['Response time under 500 ms', "pm.test('Response time is under 500 ms', () => {\n  pm.expect(pm.response.responseTime).to.be.below(500);\n});"],
    ['Check a JSON value', "pm.test('Has the expected value', () => {\n  const json = pm.response.json();\n  pm.expect(json.status).to.eql('success');\n});"],
    ['Body is valid JSON', "pm.test('Body is valid JSON', () => {\n  pm.response.to.have.jsonBody();\n});"],
    ['Save a value for later requests', "const json = pm.response.json();\npm.environment.set('token', json.token);"],
    ['Chain into the next environment value', "const json = pm.response.json();\npm.environment.set('userId', json.id);\npm.collectionVariables.set('lastUserId', json.id);"],
    ['Header exists', "pm.test('Content-Type is present', () => {\n  pm.response.to.have.header('Content-Type');\n});"],
    ['Fail loudly with a custom message', "pm.test('Payment succeeded', () => {\n  const json = pm.response.json();\n  pm.expect(json.error, 'payment error field present: ' + JSON.stringify(json)).to.eql(null);\n});"],
  ],
};

export function scriptsEditor(target, t, dirty, onChange) {
  const wrap = h('div', { class: 'split-pane' });
  const render = () => {
    const phase = t.scriptTab || 'prerequest';
    const seg = h('div', { class: 'seg' },
      h('button', { class: phase === 'prerequest' ? 'on' : '', onclick: () => { t.scriptTab = 'prerequest'; render(); } }, 'Pre-request', getScript(target, 'prerequest') ? ' •' : ''),
      h('button', { class: phase === 'test' ? 'on' : '', onclick: () => { t.scriptTab = 'test'; render(); } }, 'Post-response', getScript(target, 'test') ? ' •' : ''));
    const ta = codeArea({ value: getScript(target, phase), lang: 'javascript', placeholder: phase === 'prerequest' ? '// Runs before the request is sent\n// e.g. pm.environment.set("timestamp", Date.now());' : '// Runs after the response arrives\n// e.g. pm.test("Status is 200", () => pm.response.to.have.status(200));', oninput: (v) => { setScript(target, phase, v); dirty(); onChange?.(); } });
    const snip = h('button', { class: 'btn ghost sm', onclick: (e) => showMenu(e, SNIPPETS[phase].map(([label, code]) => ({ label, onClick: () => {
      const cur = ta.value;
      ta.value = cur ? `${cur.replace(/\s*$/, '')}\n\n${code}\n` : `${code}\n`;
      setScript(target, phase, ta.value); dirty(); onChange?.(); ta.focus();
    } }))) }, 'Snippets');
    wrap.replaceChildren(
      h('div', { class: 'row', style: { marginBottom: '8px' } }, seg, h('span', { class: 'grow' }), snip),
      h('div', { class: 'code-wrap' }, ta.el),
      h('p', { class: 'hint', style: { marginBottom: 0 } }, 'Uses Postman\'s pm API. Built in: ', h('span', { class: 'mono' }, 'CryptoJS'), ', ', h('span', { class: 'mono' }, 'require("lodash")'), ', ', h('span', { class: 'mono' }, 'chai'), ', ', h('span', { class: 'mono' }, 'uuid'), ', ', h('span', { class: 'mono' }, 'atob/btoa'), '. Collection and folder scripts run first.'),
    );
  };
  render();
  return wrap;
}

function requestSettings(item, dirty) {
  const ppb = item.protocolProfileBehavior || {};
  const tri = (label, key, help) => h('div', { class: 'settings-row' },
    h('div', { class: 'form-grid', style: { marginBottom: '12px' } },
      h('label', null, label),
      h('select', { class: 'select', style: { maxWidth: '260px' }, onchange: (e) => {
        item.protocolProfileBehavior = item.protocolProfileBehavior || {};
        if (e.target.value === 'default') delete item.protocolProfileBehavior[key];
        else item.protocolProfileBehavior[key] = e.target.value === 'on';
        if (!Object.keys(item.protocolProfileBehavior).length) delete item.protocolProfileBehavior;
        dirty();
      } },
        h('option', { value: 'default', selected: ppb[key] === undefined }, `Use app setting (${state.settings[key === 'strictSSL' ? 'verifySsl' : key] ? 'on' : 'off'})`),
        h('option', { value: 'on', selected: ppb[key] === true }, 'On'),
        h('option', { value: 'off', selected: ppb[key] === false }, 'Off')),
      h('span'), h('span', { class: 'hint', style: { margin: 0 } }, help)));
  return h('div', null,
    tri('Follow redirects', 'followRedirects', 'Follow 3xx responses automatically.'),
    tri('Verify SSL certificates', 'strictSSL', 'Turn off for local servers with self-signed certificates.'));
}

// ---------- response ----------

export function renderResponse(root, t) {
  if (WS.isWs(t.draft?.request?.url?.raw || '') || t.wsConn) return renderWsResponse(root, t);
  const r = t.response;
  if (t.running && t.stream?.head) return renderLiveStream(root, t);
  if (t.running) {
    root.replaceChildren(h('div', { class: 'loading-bar' }), h('div', { class: 'resp-empty' }, h('div', null, 'Sending request…')));
    return;
  }
  if (!r) {
    root.replaceChildren(h('div', { class: 'resp-empty' }, h('div', null, icon('send'), h('div', null, 'Send the request to see the response'),
      h('div', { class: 'keys' }, h('span', null, h('kbd', null, '⌘'), ' ', h('kbd', null, '↵'), ' Send'), h('span', null, h('kbd', null, '⌘'), ' ', h('kbd', null, 'S'), ' Save')))));
    return;
  }
  const res = r.response;
  const tests = r.tests || [];
  const passed = tests.filter((x) => x.passed === true).length;
  const failedTests = tests.filter((x) => x.passed === false).length;
  const tabsDef = [
    { id: 'body', label: 'Body' },
    { id: 'headers', label: 'Headers', count: res?.headers?.length || '' },
    { id: 'tests', label: tests.length ? `Tests ${passed}/${tests.length}` : 'Tests' },
    { id: 'console', label: 'Console', count: r.logs?.length || '' },
    ...(res && (res.streamed || isEventStream(res.contentType) || isLineStream(res.contentType)) ? [{ id: 'events', label: 'Events', count: streamEvents(t, res).length || '' }] : []),
    ...(r.visualizer ? [{ id: 'visualize', label: 'Visualize' }] : []),
    ...(res ? [{ id: 'diff', label: 'Diff' }] : []),
  ];
  if (t.respTab === 'visualize' && !r.visualizer) t.respTab = 'body';
  const statusCls = res ? `s${String(res.status)[0]}` : '';
  const meta = res ? h('div', { class: 'resp-meta' },
    h('span', { class: ['status-pill', statusCls] }, `${res.status} ${res.statusText || ''}`.trim()),
    res.timings ? timingButton(res) : h('span', null, h('b', null, fmtMs(res.timeMs))),
    h('span', null, h('b', null, fmtBytes(res.size))),
    failedTests ? h('span', { style: { color: 'var(--err)' } }, `${failedTests} failed`) : null,
    h('button', { class: 'icon-btn', title: 'More', onclick: (e) => showMenu(e, [
      { label: 'Copy body', icon: 'copy', onClick: async () => { await navigator.clipboard.writeText(res.bodyText ?? ''); toast('Copied'); } },
      { label: 'Save body to file…', icon: 'download', onClick: async () => {
        const ext = res.contentType.includes('json') ? 'json' : res.contentType.includes('html') ? 'html' : res.contentType.includes('xml') ? 'xml' : res.bodyBase64 ? 'bin' : 'txt';
        const p = res.bodyBase64 ? await bridge.saveBinaryFile(`response.${ext}`, res.bodyBase64) : await bridge.saveTextFile(`response.${ext}`, res.bodyText || '');
        if (p) toast(`Saved to ${p}`);
      } },
      t.ref?.col ? { label: 'Save as example', icon: 'check', onClick: () => saveExample(t) } : null,
      { label: 'Write tests with AI…', icon: 'check', onClick: () => writeTests(t) },
      { label: 'Explain this response', icon: 'info', onClick: () => explainResponse(t) },
      { label: 'Cookies for this site…', icon: 'globe', onClick: () => { let host = ''; try { host = new URL(res.url).hostname; } catch { /* keep empty */ } openCookieManager({ domain: host }); } },
    ].filter(Boolean)) }, icon('more'))) : null;

  const head = h('div', { class: 'resp-head' }, subtabs(tabsDef, t.respTab, (id) => { t.respTab = id; renderResponse(root, t); }), meta);
  const body = h('div', { class: 'resp-body' });

  const notes = [
    ...(r.notes || []).map((n) => h('div', { class: 'note warn', style: { margin: '10px 14px 0' } }, icon('info'), h('span', null, n))),
    ...(r.scriptErrors || []).filter((s) => r.response).map((s) => h('div', { class: 'note err', style: { margin: '10px 14px 0' } }, icon('alert'), h('span', null, `${s.phase} error in ${s.where === 'collection' ? 'the collection' : `"${s.where}"`}: ${s.message}`))),
  ];

  if (!res) {
    body.append(...notes, h('div', { class: 'resp-error' },
      h('h3', null, r.error ? 'Could not send request' : 'Nothing was sent'),
      h('p', null, r.error || (r.notes || []).join(' ')),
      r.error ? h('button', { class: 'btn sm', onclick: () => explainResponse(t) }, icon('info'), 'Explain with AI') : null,
      r.outgoing ? h('p', { class: 'mono' }, `${r.outgoing.method} ${r.outgoing.url}`) : null));
    if (t.respTab === 'console') body.replaceChildren(consoleView(r));
  } else if (t.respTab === 'body') {
    body.append(...notes, bodyView(res, t));
  } else if (t.respTab === 'headers') {
    body.append(h('table', { class: 'hdr-table' }, res.headers.map((x) => h('tr', null, h('td', null, x.key), h('td', null, x.value)))));
  } else if (t.respTab === 'tests') {
    if (!tests.length) body.append(h('div', { class: 'resp-empty' }, h('div', null, 'No tests ran. Add some in the Scripts tab → Post-response, or ', h('a', { style: { color: 'var(--accent)', cursor: 'pointer' }, onclick: () => writeTests(t) }, 'write them with AI'), '.')));
    else body.append(...tests.map((x) => h('div', { class: 'test-row' },
      h('span', { class: ['tag', x.skipped ? 'skip' : x.passed ? 'pass' : 'fail'] }, x.skipped ? 'SKIP' : x.passed ? 'PASS' : 'FAIL'),
      h('div', null, h('div', null, x.name), x.error ? h('div', { class: 'err' }, x.error) : null))));
  } else if (t.respTab === 'console') {
    body.append(consoleView(r));
  } else if (t.respTab === 'diff' && res) {
    body.append(diffView(root, t, res));
  } else if (t.respTab === 'events' && res) {
    body.append(eventsView(streamEvents(t, res), { live: false }));
  } else if (t.respTab === 'visualize' && r.visualizer) {
    body.append(visualizerView(r.visualizer));
  }
  root.replaceChildren(head, body);
}

/** The response time, with a hover/click breakdown of where it went. */
function timingButton(res) {
  const tm = res.timings;
  const btn = h('button', { class: 'meta-btn', title: 'Where the time went',
    onmousedown: (e) => e.stopPropagation(),
    onclick: () => (btn.classList.contains('menu-open') ? closeMenu() : popover(btn, timingView(tm, res), { width: 340 })) },
  h('b', null, fmtMs(res.timeMs)));
  return btn;
}

function timingView(tm, res) {
  const phases = [
    ['DNS lookup', tm.dnsMs, 'dns'],
    [/^https:/i.test(res.url || '') ? 'TCP + TLS handshake' : 'TCP connect', tm.connectMs, 'connect'],
    ['Waiting (time to first byte)', tm.waitingMs, 'wait'],
    ['Download', tm.downloadMs, 'download'],
  ];
  const total = Math.max(tm.totalMs, 0.001);
  const fmt = (v) => (v < 1 ? `${v.toFixed(2)} ms` : v < 1000 ? `${v.toFixed(v < 10 ? 1 : 0)} ms` : `${(v / 1000).toFixed(2)} s`);
  let at = 0;
  const rows = phases.map(([label, v, cls]) => {
    const left = (at / total) * 100;
    at += v;
    return h('div', { class: 'timing-row' },
      h('span', { class: 'timing-label' }, label),
      h('span', { class: 'timing-track' }, h('span', { class: ['timing-bar', cls], style: { left: `${left}%`, width: `${Math.max(0.6, (v / total) * 100)}%` } })),
      h('span', { class: 'timing-val mono' }, fmt(v)));
  });
  return h('div', { class: 'timing' },
    h('div', { class: 'timing-head' }, h('span', null, 'Response time'), h('b', { class: 'mono' }, fmt(tm.totalMs))),
    ...rows,
    tm.connections > 1 ? h('p', { class: 'hint', style: { margin: '8px 0 0' } }, `${tm.connections} connections opened (redirects); phases are summed across them.`) : null,
    h('p', { class: 'hint', style: { margin: '8px 0 0' } }, `${fmtBytes(res.size)} received. Each send opens a fresh connection, so DNS and the handshake are always included.`));
}

/** Events of a finished stream: the live capture (with arrival times) or parsed from the body. */
function streamEvents(t, res) {
  if (t.stream?.events?.length) return t.stream.events;
  return isEventStream(res.contentType) ? parseSse(res.bodyText || '') : parseNdjson(res.bodyText || '');
}

function eventsView(events, { live }) {
  if (!events.length) return h('div', { class: 'resp-empty' }, h('div', null, live ? 'Connected. Waiting for the first event…' : 'No events in this response.'));
  const list = h('div', { class: 'sse-list' }, events.map((e, i) => {
    let pretty = null;
    if (/^\s*[{[]/.test(e.data)) { const p = safeParse(e.data); if (p !== undefined) pretty = JSON.stringify(p); }
    return h('div', { class: 'sse-row' },
      h('span', { class: 'faint mono sse-n' }, i + 1),
      h('span', { class: ['sse-type', e.event !== 'message' && e.event !== 'line' && 'named'] }, e.event),
      h('span', { class: 'mono sse-data', title: e.data }, pretty ?? e.data),
      h('span', { class: 'faint mono sse-at' }, e.at != null ? fmtMs(e.at) : e.id ? `id ${e.id}` : ''));
  }));
  if (live) queueMicrotask(() => { const sc = list.closest('.resp-body'); if (sc && sc.scrollHeight - sc.scrollTop - sc.clientHeight < 120) sc.scrollTop = sc.scrollHeight; });
  return list;
}

/** While a stream is open: status, event count, live events, and Stop. */
function renderLiveStream(root, t) {
  const s = t.stream;
  const statusCls = `s${String(s.head.status)[0]}`;
  const head = h('div', { class: 'resp-head' },
    h('div', { class: 'subtabs' }, h('button', { class: 'subtab active' }, 'Events', h('span', { class: 'count' }, ` ${s.events.length}`))),
    h('div', { class: 'resp-meta' },
      h('span', { class: ['status-pill', statusCls] }, `${s.head.status} ${s.head.statusText || ''}`.trim()),
      h('span', { class: 'chip ok live-chip' }, 'streaming'),
      h('span', null, h('b', null, fmtBytes(new TextEncoder().encode(s.text).length))),
      h('button', { class: 'btn sm', onclick: () => C.stopStream(t) }, icon('stop'), 'Stop')));
  const body = h('div', { class: 'resp-body' }, eventsView(s.events, { live: true }));
  const prev = root.querySelector('.resp-body');
  const keep = prev ? prev.scrollTop : null;
  root.replaceChildren(h('div', { class: 'loading-bar' }), head, body);
  if (keep != null) body.scrollTop = keep;
}

function renderWsResponse(root, t) {
  const c = t.wsConn || (t.wsConn = { status: 'disconnected', log: [] });
  const statusLabel = c.status === 'connected' ? ['chip ok', 'ws connected'] : c.status === 'connecting' ? ['chip warn', 'connecting…'] : c.status === 'closed' ? ['chip', `closed${c.closeCode != null ? ' ' + c.closeCode : ''}`] : c.status === 'error' ? ['chip bad', 'error'] : ['chip', 'not connected'];

  const head = h('div', { class: 'resp-head' },
    h('div', { class: 'resp-tools' },
      h('span', { class: statusLabel[0] }, statusLabel[1]),
      h('button', { class: 'icon-btn', title: 'Clear frames', onclick: () => { c.log = []; emit2('ws'); } }, icon('trash'))));
  const body = h('div', { class: 'resp-body' });
  const log = h('div', { class: 'ws-log' });
  const rows = (c.log || []).map((f) => h('div', { class: ['ws-frame', f.dir] },
    h('span', { class: 'dir' }, f.dir === 'in' ? '← in' : '→ out'),
    h('pre', null, f.text),
    h('span', { class: 'size muted' }, fmtBytes(f.size))));
  log.append(...rows.length ? rows : [h('div', { class: 'resp-empty' }, 'Frames show up here once connected.')]);
  body.append(log);

  const composer = h('textarea', { class: 'input ws-compose', placeholder: 'Message text to send…', rows: 2, onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } } });
  const send = async () => {
    const text = composer.value;
    if (!text.trim()) return;
    try { await WS.sendFrame(t, text); composer.value = ''; } catch (err) { toast(errText(err), { error: true }); }
  };
  const closeBtn = h('button', { class: 'btn sm', disabled: !c.id, onclick: async () => { try { await WS.closeConn(t); } catch (err) { toast(errText(err), { error: true }); } } }, 'Close');
  body.append(h('div', { class: 'ws-composer' }, composer,
    h('button', { class: 'btn primary', disabled: c.status !== 'connected', onclick: send }, icon('send'), 'Send frame'), closeBtn));
  root.replaceChildren(head, body);
}

const emit2 = (evt) => {
  import('../store.js').then((S) => S.emit(evt));
};

/**
 * Response diff: compare this response against an example, a history entry,
 * or another open tab. Value diff for JSON bodies, line diff otherwise.
 */
function diffView(root, t, res) {
  const state = (t.diffState = t.diffState || { sourceId: null, ignoreArrayOrder: false });

  const sources = [];
  for (const ex of C.contextFor(t).item?.response || t.draft?.response || []) {
    const text = typeof ex.body === 'string' ? ex.body : ex.body?.raw ?? '';
    sources.push({ id: `ex:${ex.id || ex.name}`, label: `Example: ${ex.name}`, text });
  }
  for (const hx of (S.state.history || []).filter((x) => x.bodyText).slice(0, 30)) {
    sources.push({ id: `hist:${hx.id}`, label: `History: ${hx.method} ${hx.name || hx.url?.slice(0, 36)} · ${new Date(hx.ts).toLocaleTimeString()}`, text: hx.bodyText });
  }
  for (const other of S.state.tabs.filter((x) => x.id !== t.id && x.response?.response?.bodyText)) {
    sources.push({ id: `tab:${other.id}`, label: `Tab: ${C.tabTitle(other)}`, text: other.response.response.bodyText });
  }
  sources.push({ id: 'blank', label: 'Paste text…', text: null });

  const wrap = h('div', { class: 'diff-view' });
  const sourceSel = h('select', { class: 'select', onchange: () => { state.sourceId = sourceSel.value; render(); } });
  const orderSel = h('select', { class: 'select', title: 'Array comparison', onchange: () => { state.ignoreArrayOrder = orderSel.value === 'unordered'; render(); } },
    h('option', { value: 'ordered', selected: !state.ignoreArrayOrder }, 'Arrays in order'),
    h('option', { value: 'unordered', selected: state.ignoreArrayOrder }, 'Arrays unordered'));

  const content = h('div', { class: 'diff-content' });
  const pasteZone = h('div');
  const pasteBox = codeArea({ value: (t.diffState.paste ?? ''), oninput: (v) => { t.diffState.paste = v; render(); } });
  wrap.append(h('div', { class: 'resp-tools' }, sourceSel, h('span', { class: 'grow' }), orderSel), pasteZone, content);

  function sideTextOf() {
    const src = sources.find((x) => x.id === state.sourceId);
    if (src?.id === 'blank') return t.diffState.paste ?? '';
    return src?.text ?? '';
  }

  function render() {
    if (state.sourceId != null && !sources.some((x) => x.id === state.sourceId)) state.sourceId = null;
    if (state.sourceId == null) state.sourceId = sources.find((x) => x.text)?.id ?? 'blank';
    sourceSel.replaceChildren(...sources.map((src) => h('option', { value: src.id, selected: src.id === state.sourceId }, src.label)));
    if (state.sourceId === 'blank') pasteZone.replaceChildren(h('p', { class: 'hint', style: { margin: '8px 0' } }, 'Paste the response to compare against:'), pasteBox);
    else pasteZone.replaceChildren();
    content.replaceChildren();
    diffRows(t, content, 'current', sideTextOf(), state.ignoreArrayOrder);
  }

  render();
  return wrap;
}

/** Renders the actual diff rows (current on the left, `against` on the right). */
function diffRows(t, content, side, againstText, ignoreArrayOrder) {
  content.append(lazyEl(() => import('./compare.js').then((m) => m.diffTable(t.response?.response?.bodyText ?? '', againstText, { ignoreArrayOrder }))));
}

function consoleView(r) {
  const o = r.outgoing;
  const rows = [];
  if (o) {
    rows.push(h('div', { class: 'log-row' }, h('span', { class: 'lv' }, 'req'), h('pre', null, `${o.method} ${o.url}\n${o.headers.map((x) => `${x.key}: ${x.value}`).join('\n')}${o.body.mode === 'raw' ? `\n\n${o.body.content}` : o.body.mode !== 'none' ? `\n\n[${o.body.mode} body]` : ''}`)));
  }
  for (const l of r.logs || []) rows.push(h('div', { class: ['log-row', l.level] }, h('span', { class: 'lv' }, l.level), h('pre', null, l.message)));
  for (const s of r.scriptErrors || []) rows.push(h('div', { class: 'log-row error' }, h('span', { class: 'lv' }, 'error'), h('pre', null, `${s.phase} (${s.where}): ${s.message}`)));
  if (!rows.length) return h('div', { class: 'resp-empty' }, h('div', null, 'console.log output from scripts shows up here.'));
  return h('div', null, rows);
}

function bodyView(res, t) {
  const ct = (res.contentType || '').toLowerCase();
  const isJson = ct.includes('json') || (/^\s*[{[]/.test(res.bodyText || '') && safeParse(res.bodyText) !== undefined);
  const isHtml = ct.includes('html');
  const isImage = ct.startsWith('image/');
  t.bodyView = t.bodyView || 'pretty';
  const view = t.bodyView;
  const wrapOn = !!t.wrap;
  const textual = !res.bodyBase64 && view !== 'preview';
  const rerender = () => container.replaceWith(bodyView(res, t));
  const container = h('div');
  const tools = h('div', { class: 'resp-tools' },
    h('div', { class: 'seg' },
      ['pretty', 'raw', ...(isHtml || isImage ? ['preview'] : [])].map((v) => h('button', { class: view === v ? 'on' : '', onclick: () => { t.bodyView = v; rerender(); } }, v[0].toUpperCase() + v.slice(1)))),
    h('span', { class: 'grow' }),
    isJson ? h('span', { class: 'faint', style: { fontSize: '12px' } }, 'JSON') : h('span', { class: 'faint', style: { fontSize: '12px' } }, ct.split(';')[0] || ''),
    isJson && textual ? h('button', { class: ['icon-btn', t.jsonFilter != null && 'on'], title: 'Filter with JSONPath', style: t.jsonFilter != null ? { color: 'var(--accent)' } : null, onclick: () => { t.jsonFilter = t.jsonFilter == null ? '' : null; rerender(); } }, icon('filter')) : null,
    textual ? h('button', { class: ['icon-btn', t.find?.open && 'on'], title: 'Find (⌘F)', style: t.find?.open ? { color: 'var(--accent)' } : null, onclick: () => { t.find = { ...(t.find || { q: '' }), open: !t.find?.open }; rerender(); } }, icon('search')) : null,
    h('button', { class: ['icon-btn', wrapOn && 'on'], title: wrapOn ? 'Turn off line wrap' : 'Wrap lines', style: wrapOn ? { color: 'var(--accent)' } : null, onclick: () => { t.wrap = !wrapOn; rerender(); } }, icon('wrap')),
    h('button', { class: 'icon-btn', title: 'Copy', onclick: async () => { await navigator.clipboard.writeText(res.bodyText ?? ''); toast('Copied'); } }, icon('copy')));
  // Toolbar plus the optional filter and find bars stay pinned together.
  const head = h('div', { class: 'resp-sticky' }, tools);
  container.append(head);

  if (view === 'preview' && isImage && res.bodyBase64) {
    container.append(h('img', { class: 'preview-img', src: `data:${ct.split(';')[0]};base64,${res.bodyBase64}` }));
  } else if (view === 'preview' && isHtml) {
    const frame = h('iframe', { class: 'preview-frame', sandbox: '', style: { height: '60vh' } });
    frame.srcdoc = res.bodyText || '';
    container.append(frame);
  } else if (res.bodyBase64) {
    container.append(h('div', { class: 'resp-empty', style: { height: 'auto', padding: '40px' } }, h('div', null, `Binary response (${fmtBytes(res.size)}). Use ⋯ → Save body to file.`)));
  } else {
    const text = res.bodyText || '';
    const pre = h('pre', { class: ['body', wrapOn && 'wrap'] });
    const showJson = (pretty) => {
      pre.innerHTML = pretty.length < 1_500_000 ? highlightJson(pretty) : '';
      if (pretty.length >= 1_500_000) pre.textContent = pretty;
    };
    const paintBody = () => {
      if (view === 'pretty' && isJson && text.length < 3_000_000) {
        const parsed = safeParse(text);
        showJson(parsed !== undefined ? JSON.stringify(parsed, null, 2) : text);
      } else if (view === 'pretty' && (ct.includes('xml') || isHtml) && text.length < 1_000_000) {
        pre.textContent = prettyXml(text);
      } else {
        pre.textContent = text || '(empty body)';
      }
    };
    let findBar = null;
    if (isJson && t.jsonFilter != null) {
      const msg = h('span', { class: 'faint filter-msg' });
      const apply = () => {
        const q = t.jsonFilter.trim();
        msg.classList.remove('err');
        if (!q) { msg.textContent = ''; paintBody(); findBar?.refresh(); return; }
        const parsed = safeParse(text);
        if (parsed === undefined) { msg.textContent = 'Body isn\'t valid JSON'; msg.classList.add('err'); return; }
        import('../jsonpath.js').then(({ jsonPath }) => {
          const hits = jsonPath(parsed, q);
          msg.textContent = `${hits.length} match${hits.length === 1 ? '' : 'es'}`;
          showJson(JSON.stringify(hits.length === 1 ? hits[0] : hits, null, 2) ?? 'undefined');
        }).catch((e) => { msg.textContent = e.message; msg.classList.add('err'); }).finally(() => findBar?.refresh());
      };
      let timer;
      const input = h('input', { class: 'input mono', value: t.jsonFilter, placeholder: '$.data[*].id   ·   $..name   ·   $.items[?(@.price > 10)]', spellcheck: 'false', oninput: (e) => { t.jsonFilter = e.target.value; clearTimeout(timer); timer = setTimeout(apply, 150); }, onkeydown: (e) => { if (e.key === 'Escape') { t.jsonFilter = null; rerender(); } } });
      head.append(h('div', { class: 'resp-tools filter-bar' }, h('span', { class: 'faint' }, 'Filter'), input, msg));
      queueMicrotask(() => { if (!t.find?.open) input.focus(); });
      paintBody();
      if (t.jsonFilter.trim()) apply();
    } else {
      paintBody();
    }
    if (t.find?.open) {
      findBar = findInBody(pre, t, () => { t.find.open = false; rerender(); });
      head.append(findBar);
    }
    container.append(pre);
  }
  return container;
}

/**
 * ⌘F inside a response body: highlights every match (CSS Custom Highlights where
 * supported), steps through them, and scrolls the current one into view.
 */
function findInBody(pre, t, onClose) {
  const f = t.find;
  f.q = f.q || '';
  f.i = f.i || 0;
  let ranges = [];
  const count = h('span', { class: 'faint find-count' });
  const supported = typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight === 'function';

  const search = () => {
    ranges = [];
    const q = f.q;
    if (q) {
      const nodes = [];
      let all = '';
      const walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) { nodes.push([n, all.length]); all += n.data; }
      const hay = f.matchCase ? all : all.toLowerCase();
      const needle = f.matchCase ? q : q.toLowerCase();
      let k = 0;
      const locate = (pos) => {
        while (k < nodes.length - 1 && nodes[k + 1][1] <= pos) k++;
        return [nodes[k][0], pos - nodes[k][1]];
      };
      for (let at = hay.indexOf(needle); at >= 0 && ranges.length < 5000; at = hay.indexOf(needle, at + needle.length)) {
        const r = document.createRange();
        const [sn, so] = locate(at);
        const [en, eo] = locate(at + needle.length - 1);
        r.setStart(sn, so);
        r.setEnd(en, eo + 1);
        ranges.push(r);
      }
    }
    f.i = ranges.length ? Math.min(f.i, ranges.length - 1) : 0;
    paint();
  };
  const paint = () => {
    count.textContent = !f.q ? '' : ranges.length ? `${f.i + 1} of ${ranges.length}${ranges.length >= 5000 ? '+' : ''}` : 'No results';
    if (supported) {
      CSS.highlights.set('find', new Highlight(...ranges));
      CSS.highlights.set('find-current', ranges[f.i] ? new Highlight(ranges[f.i]) : new Highlight());
    }
    const cur = ranges[f.i];
    if (!cur) return;
    if (!supported) { const sel = getSelection(); sel.removeAllRanges(); sel.addRange(cur); }
    const scroller = pre.closest('.resp-body');
    if (scroller) {
      const rr = cur.getBoundingClientRect();
      const cr = scroller.getBoundingClientRect();
      if (rr.top < cr.top + 80 || rr.bottom > cr.bottom - 20) scroller.scrollTop += rr.top - cr.top - cr.height / 2;
      if (rr.left < cr.left || rr.right > cr.right) scroller.scrollLeft += rr.left - cr.left - cr.width / 2;
    }
  };
  const step = (d) => { if (ranges.length) { f.i = (f.i + d + ranges.length) % ranges.length; paint(); } };
  let timer;
  const input = h('input', { class: 'input', value: f.q, placeholder: 'Find in response', spellcheck: 'false',
    oninput: (e) => { f.q = e.target.value; f.i = 0; clearTimeout(timer); timer = setTimeout(search, 120); },
    onkeydown: (e) => {
      if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
      else if (e.key === 'Escape') { e.preventDefault(); clear(); onClose(); }
    } });
  const caseBtn = h('button', { class: ['icon-btn', 'text-btn', f.matchCase && 'on'], title: 'Match case', onclick: () => { f.matchCase = !f.matchCase; caseBtn.classList.toggle('on', !!f.matchCase); search(); } }, 'Aa');
  const clear = () => { if (supported) { CSS.highlights.delete('find'); CSS.highlights.delete('find-current'); } };
  const bar = h('div', { class: 'resp-tools find-bar' }, icon('search'), input, count, caseBtn,
    h('button', { class: 'icon-btn', title: 'Previous (⇧↵)', onclick: () => step(-1) }, icon('chevron', 'rot-up')),
    h('button', { class: 'icon-btn', title: 'Next (↵)', onclick: () => step(1) }, icon('chevron', 'rot-down')),
    h('button', { class: 'icon-btn', title: 'Close (Esc)', onclick: () => { clear(); onClose(); } }, icon('x')));
  bar.refresh = search;
  bar.focus = () => { input.focus(); input.select(); };
  queueMicrotask(() => { search(); input.focus(); });
  return bar;
}

/**
 * pm.visualizer output: the Handlebars template rendered with the script's data,
 * in a sandboxed frame (scripts allowed, no access to Dispatch). pm.getData works inside.
 */
function visualizerView(vis) {
  const frame = h('iframe', { class: 'preview-frame visualizer-frame', sandbox: 'allow-scripts' });
  const wrap = h('div', { class: 'visualizer-wrap' }, frame);
  const fail = (msg) => wrap.replaceChildren(h('div', { class: 'note err', style: { margin: '14px' } }, icon('alert'), h('span', null, msg)));
  loadVendor('handlebars').then((Handlebars) => {
    let html;
    try { html = Handlebars.compile(vis.template, vis.options || {})(vis.data); } catch (e) { return fail(`Visualizer template error: ${e.message}`); }
    const data = JSON.stringify(vis.data ?? {}).replace(/</g, '\\u003c');
    frame.srcdoc = `<!doctype html><meta charset="utf-8"><script>window.pm={getData:function(cb){cb(null,${data});}};</script>${html}`;
  }, (e) => fail(errText(e)));
  return wrap;
}

function safeParse(s) { try { return JSON.parse(s); } catch { return undefined; } }

function prettyXml(xml) {
  if (xml.includes('\n') && /\n\s+</.test(xml)) return xml;
  let pad = 0;
  return xml.replace(/>\s*</g, '>\n<').split('\n').map((line) => {
    if (/^<\/\w/.test(line)) pad = Math.max(0, pad - 1);
    const out = '  '.repeat(pad) + line;
    if (/^<\w[^>]*[^/]>.*$/.test(line) && !/<\/\w/.test(line) && !/^<(br|hr|img|input|meta|link)\b/i.test(line)) pad++;
    return out;
  }).join('\n');
}

async function saveExample(t) {
  const res = t.response?.response;
  const entry = t.ref?.col && S.collectionEntry(t.ref.col);
  if (!res || !entry) return;
  try {
    await C.addExample(entry, t.ref.item, exampleFromResponse(t.draft.request, res));
  } catch (e) { toast(errText(e), { error: true }); }
}
