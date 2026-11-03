// AI assistant UI: write tests, explain a response, create a request from a
// description. Answers stream in; nothing is changed until you accept it.

import { h, icon, modal, toast, errText } from './dom.js';
import { codeArea } from './components.js';
import { markdownView } from './docs.js';
import * as C from '../ctx.js';
import * as S from '../store.js';
import { state } from '../store.js';
import { bridge } from '../bridge.js';
import { getScript, setScript, uuid } from '../model.js';
import { TESTS_SYSTEM, EXPLAIN_SYSTEM, CREATE_SYSTEM, REQUEST_SCHEMA, testsPrompt, explainPrompt, createPrompt, extractCode, requestFromAi } from '../assist.js';

/** Settings row: add / replace / remove the Anthropic API key. */
export function aiKeyControl() {
  const wrap = h('div', { class: 'row' });
  const render = async () => {
    const has = await bridge.aiHasKey().catch(() => false);
    wrap.replaceChildren(
      h('span', { class: has ? 'chip ok' : 'chip' }, has ? 'Key saved' : 'No key'),
      h('button', { class: 'btn sm', onclick: () => keyDialog(render) }, has ? 'Replace key…' : 'Add API key…'),
      has ? h('button', { class: 'btn ghost sm', onclick: async () => { await bridge.aiDeleteKey(); toast('API key removed'); render(); } }, 'Remove') : null);
  };
  render();
  return wrap;
}

function keyDialog(done) {
  const input = h('input', { class: 'input mono', type: 'password', placeholder: 'sk-ant-…', autocomplete: 'off', spellcheck: 'false' });
  const err = h('p', { class: 'hint', style: { color: 'var(--err)', minHeight: '16px' } });
  modal({
    title: 'Anthropic API key',
    body: h('div', null,
      h('p', { class: 'hint', style: { marginTop: 0 } }, 'The assistant uses Claude with your own key (create one in the Anthropic Console). It\'s stored in your system keychain and only used for requests you start.'),
      input, err),
    actions: [{ label: 'Cancel' }, { label: 'Save', primary: true, onClick: async () => {
      err.textContent = 'Checking…';
      try { await bridge.aiSetKey(input.value); toast('API key saved'); done?.(); return true; } catch (e) { err.textContent = errText(e); return false; }
    } }],
  });
}

async function ready() {
  if (!(await bridge.aiHasKey().catch(() => false))) { keyDialog(); return false; }
  if (state.settings.aiConsent) return true;
  return new Promise((resolve) => {
    modal({
      title: 'Before the assistant runs',
      body: h('div', null, h('p', null, 'Requests you ask about are sent to Anthropic\'s Claude API: method, URL and headers as written ({{variables}} are not filled in, and credential headers are redacted), the body, and for responses the status, headers and up to 30 KB of body.'),
        h('p', { class: 'hint' }, 'Avoid it for responses that contain data you\'re not allowed to share.')),
      onClose: () => resolve(false),
      actions: [{ label: 'Cancel', onClick: () => { resolve(false); } }, { label: 'Continue', primary: true, onClick: () => { state.settings.aiConsent = true; S.saveSettings(); resolve(true); } }],
    });
  });
}

/** Streams an answer into a modal; `finish(text, el)` renders the result and returns modal actions. */
function askModal({ title, request, finish }) {
  const id = `ai-${uuid()}`;
  const live = h('pre', { class: 'ai-live' });
  const out = h('div', { class: 'ai-out' }, h('div', { class: 'loading-bar' }), live);
  const foot = h('div', { class: 'row', style: { justifyContent: 'flex-end', marginTop: '12px' } }, h('button', { class: 'btn', onclick: () => bridge.stopRequest?.(id) }, icon('stop'), 'Stop'));
  const close = modal({ title, wide: true, body: h('div', null, out, foot), onClose: () => bridge.stopRequest?.(id).catch(() => {}) });
  bridge.aiAsk(request, id, (ev) => { if (ev.type === 'text') { live.textContent += ev.text; live.scrollTop = live.scrollHeight; } })
    .then((answer) => {
      const actions = finish(answer.text, out, close) || [];
      foot.replaceChildren(h('span', { class: 'faint', style: { fontSize: '11.5px', marginRight: 'auto' } }, `${answer.model} · ${answer.inputTokens + answer.outputTokens} tokens`), ...actions);
    }, (e) => {
      out.replaceChildren(h('div', { class: 'note err' }, icon('alert'), h('span', null, errText(e))));
      foot.replaceChildren(h('button', { class: 'btn', onclick: close }, 'Close'));
    });
}

export async function writeTests(t) {
  const res = t.response?.response;
  if (!res) return toast('Send the request first, so the tests can be based on a real response.', { error: true });
  if (!(await ready())) return;
  askModal({
    title: `Tests for "${t.draft.name}"`,
    request: { system: TESTS_SYSTEM, prompt: testsPrompt(t.draft, res) },
    finish: (text, out, close) => {
      const code = extractCode(text);
      const ta = codeArea({ value: code, lang: 'javascript', minHeight: 240 });
      out.replaceChildren(h('p', { class: 'hint', style: { marginTop: 0 } }, 'Review and edit, then add it to the post-response script. Send again to run the tests.'), h('div', { class: 'code-wrap' }, ta.el));
      return [
        h('button', { class: 'btn', onclick: close }, 'Discard'),
        h('button', { class: 'btn primary', onclick: () => {
          const cur = getScript(t.draft, 'test');
          setScript(t.draft, 'test', cur ? `${cur.replace(/\s*$/, '')}\n\n${ta.value.trim()}\n` : `${ta.value.trim()}\n`);
          C.markDirty(t);
          t.sub = 'scripts';
          t.scriptTab = 'test';
          close();
          C.emitAll();
          toast('Added to the post-response script');
        } }, icon('check'), 'Add to script'),
      ];
    },
  });
}

export async function explainResponse(t) {
  const r = t.response;
  if (!r) return toast('Send the request first.', { error: true });
  if (!(await ready())) return;
  askModal({
    title: `Explain "${t.draft.name}"`,
    request: { system: EXPLAIN_SYSTEM, prompt: explainPrompt(t.draft, r.response, r.error) },
    finish: (text, out, close) => { out.replaceChildren(markdownView(text)); return [h('button', { class: 'btn', onclick: close }, 'Close')]; },
  });
}

export async function createRequestDialog() {
  if (!(await ready())) return;
  const ta = h('textarea', { class: 'textarea', rows: 4, placeholder: 'e.g. Create a Stripe customer with an email and name, using my secret key' });
  modal({
    title: 'New request from a description',
    body: h('div', null, ta, h('p', { class: 'hint' }, 'Claude drafts the method, URL, headers and body; you review it in a new tab before sending.')),
    actions: [{ label: 'Cancel' }, { label: 'Draft request', primary: true, onClick: () => {
      if (!ta.value.trim()) return false;
      const t = C.activeTab();
      const names = (t ? C.resolverFor(t) : C.resolverFor({ ref: null })).names().filter((n) => n.scope !== 'dynamic').map((n) => n.name);
      askModal({
        title: 'Drafting request…',
        request: { system: CREATE_SYSTEM, prompt: createPrompt(ta.value, names), schema: REQUEST_SCHEMA },
        finish: (text, out, close) => {
          let item;
          try { item = requestFromAi(text); } catch (e) { out.replaceChildren(h('div', { class: 'note err' }, icon('alert'), h('span', null, `Couldn't read the answer: ${errText(e)}`))); return [h('button', { class: 'btn', onclick: close }, 'Close')]; }
          close();
          C.openDraft(item);
          toast('Drafted — review it, then Send or Save');
          return [];
        },
      });
      return true;
    } }],
  });
}
