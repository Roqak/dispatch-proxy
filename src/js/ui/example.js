// Example tab: the saved request on top, the saved response below. Both are editable.

import { h, icon, showMenu, toast, methodClass } from './dom.js';
import { varInput, kvSection, codeArea, subtabs } from './components.js';
import { bodyEditor, beautifyJson } from './request.js';
import * as C from '../ctx.js';
import { METHODS, urlObject, setRawUrl, rawWithQuery, parseUrl } from '../model.js';

const STATUS_TEXT = {
  200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content',
  301: 'Moved Permanently', 302: 'Found', 304: 'Not Modified',
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed',
  409: 'Conflict', 410: 'Gone', 415: 'Unsupported Media Type', 422: 'Unprocessable Entity', 429: 'Too Many Requests',
  500: 'Internal Server Error', 501: 'Not Implemented', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout',
};

const LANGS = [['json', 'JSON'], ['text', 'Text'], ['html', 'HTML'], ['xml', 'XML'], ['javascript', 'JavaScript']];

/** Postman stores the request as a string URL, an object, or leaves it out. */
function originalRequest(t) {
  const d = t.draft;
  if (!d.originalRequest || typeof d.originalRequest === 'string') {
    d.originalRequest = { method: 'GET', header: [], url: parseUrl(typeof d.originalRequest === 'string' ? d.originalRequest : '') };
  }
  const req = d.originalRequest;
  req.url = urlObject(req.url);
  req.header = req.header || [];
  return req;
}

export function renderExampleEditor(root, t) {
  const req = originalRequest(t);
  const resolver = () => C.resolverFor(t);
  const dirty = () => C.markDirty(t);
  const { entry, parents, item } = C.contextFor(t);

  const path = entry ? [entry.name, ...parents.map((p) => p.name), item?.name].filter(Boolean).join(' / ') : '';
  const nameInput = h('input', { class: 'name-input', value: t.draft.name || '', spellcheck: 'false', oninput: (e) => { t.draft.name = e.target.value; dirty(); C.emitTabs(); } });
  const crumbs = h('div', { class: 'crumbs' },
    h('span', { class: 'path', title: path }, `${path} /`),
    nameInput,
    h('span', { class: 'grow' }),
    h('button', { class: 'btn ghost sm', title: 'Open the request this example belongs to', onclick: () => entry && C.openItem(entry, t.ref.item) }, icon('send'), 'Open request'),
    h('button', { class: 'btn sm', title: 'Save (⌘S)', onclick: () => C.saveTab(t) }, icon('check'), 'Save'),
    h('button', { class: 'icon-btn', title: 'More', onclick: (e) => showMenu(e, [
      { label: 'Duplicate', icon: 'copy', onClick: () => entry && C.duplicateExample(entry, t.ref.item, t.ref.ex) },
      t.dirty ? { label: 'Discard changes', icon: 'sync', onClick: () => { t.dirty = false; C.refreshCleanTabs(); C.emitAll(); } } : null,
      '-',
      { label: 'Delete', icon: 'trash', danger: true, onClick: () => entry && C.removeExample(entry, t.ref.item, t.ref.ex) },
    ].filter(Boolean)) }, icon('more')));

  const methodSel = h('select', { class: ['select method-select', methodClass(req.method)], onchange: (e) => { req.method = e.target.value; methodSel.className = `select method-select ${methodClass(req.method)}`; dirty(); } },
    [...new Set([...METHODS, req.method || 'GET'])].map((m) => h('option', { value: m, selected: m === (req.method || 'GET') }, m)));
  const urlField = varInput({ value: req.url.raw || '', placeholder: 'Request URL for this example', resolver, oninput: (v) => { setRawUrl(req, v); dirty(); if (t.sub === 'params') renderPane(); } });
  urlField.classList.add('url-wrap');
  urlField.style.height = '100%';
  const reqline = h('div', { class: 'reqline' }, h('div', { class: 'reqline-box' }, methodSel, urlField));

  const count = (a) => (a || []).filter((x) => !x.disabled && x.key).length;
  const tabsDef = () => [
    { id: 'params', label: 'Params', count: count(req.url.query) || '' },
    { id: 'headers', label: 'Headers', count: count(req.header) || '' },
    { id: 'body', label: 'Body', dot: !!req.body?.mode && req.body.mode !== 'none' },
  ];
  if (!['params', 'headers', 'body'].includes(t.sub)) t.sub = 'headers';
  const tabsHolder = h('div');
  const pane = h('div', { class: 'pane' });
  const renderTabs = () => tabsHolder.replaceChildren(subtabs(tabsDef(), t.sub, (id) => { t.sub = id; renderTabs(); renderPane(); C.saveTabsLater(); }));
  function renderPane() {
    if (t.sub === 'params') {
      const query = (req.url.query = req.url.query || []);
      pane.replaceChildren(kvSection({ title: 'Query params', rows: query, resolver, kind: 'params', onChange: () => { req.url.raw = rawWithQuery(req.url.raw || '', query); urlField.setValue(req.url.raw); dirty(); } }));
    } else if (t.sub === 'headers') {
      pane.replaceChildren(kvSection({ title: 'Request headers', rows: req.header, resolver, kind: 'headers', onChange: dirty }));
    } else {
      pane.replaceChildren(bodyEditor(req, resolver, dirty, renderTabs));
    }
  }
  renderTabs();
  renderPane();

  root.replaceChildren(crumbs, h('div', { class: 'pane-title', style: { padding: '10px 16px 0', margin: 0 } }, 'Example request'), reqline, tabsHolder, pane);
  root.repaintVars = () => { urlField.repaint(); pane.querySelectorAll('.var-input').forEach((v) => v.repaint?.()); };
}

export function renderExampleResponse(root, t) {
  const d = t.draft;
  d.header = d.header || [];
  if (typeof d.body !== 'string') d.body = d.body == null ? '' : JSON.stringify(d.body, null, 2);
  const dirty = () => C.markDirty(t);

  const statusCls = () => `s${String(d.code || '')[0] || 0}`;
  const textInput = h('input', { class: 'input', value: d.status || '', placeholder: 'Status text', style: { width: '170px', height: '26px' }, oninput: (e) => { d.status = e.target.value; dirty(); } });
  const codeInput = h('input', { class: ['input mono status-pill', statusCls()], type: 'number', min: 100, max: 599, value: d.code ?? '', title: 'Status code', style: { width: '74px', height: '26px' }, oninput: (e) => {
    const code = Number(e.target.value) || undefined;
    // Keep the status text in step unless someone typed their own.
    if (!d.status || d.status === STATUS_TEXT[d.code]) { d.status = STATUS_TEXT[code] || d.status; textInput.value = d.status || ''; }
    d.code = code;
    codeInput.className = `input mono status-pill ${statusCls()}`;
    dirty();
  } });

  const tabsDef = [{ id: 'body', label: 'Body' }, { id: 'headers', label: 'Headers', count: d.header.filter((x) => x.key).length || '' }];
  if (!['body', 'headers'].includes(t.respTab)) t.respTab = 'body';
  const head = h('div', { class: 'resp-head' },
    subtabs(tabsDef, t.respTab, (id) => { t.respTab = id; renderExampleResponse(root, t); C.saveTabsLater(); }),
    h('div', { class: 'resp-meta' }, h('span', { class: 'faint' }, 'Status'), codeInput, textInput));

  const body = h('div', { class: 'resp-body', style: { display: 'flex', flexDirection: 'column' } });
  if (t.respTab === 'headers') {
    body.append(h('div', { class: 'pane' }, kvSection({ title: 'Response headers', rows: d.header, kind: 'headers', descriptions: false, onChange: dirty })));
  } else {
    const lang = d._postman_previewlanguage || 'text';
    const ta = codeArea({ value: d.body, lang, placeholder: 'Response body', oninput: (v) => { d.body = v; dirty(); } });
    const langSel = h('select', { class: 'select', style: { height: '26px', fontSize: '12px' }, onchange: (e) => { d._postman_previewlanguage = e.target.value; ta.setLang(e.target.value); dirty(); } },
      LANGS.map(([id, label]) => h('option', { value: id, selected: id === lang }, label)));
    const beautify = h('button', { class: 'btn ghost sm', onclick: () => {
      try { const out = beautifyJson(ta.value); ta.value = out; d.body = out; dirty(); } catch (e) { toast(`That isn't valid JSON yet: ${e.message}`, { error: true }); }
    } }, 'Beautify');
    body.append(h('div', { class: 'resp-tools' }, langSel, h('span', { class: 'grow' }), beautify),
      h('div', { class: 'pane', style: { display: 'flex', flexDirection: 'column' } }, h('div', { class: 'code-wrap' }, ta.el)));
  }
  root.replaceChildren(head, body);
}

