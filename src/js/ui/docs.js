// Markdown documentation for requests, folders and collections.

import { h, toast } from './dom.js';
import { loadVendor } from '../vendor.js';
import { codeArea } from './components.js';
import { bridge } from '../bridge.js';

/** Postman stores descriptions as a string or as { content, type }. */
export const descriptionText = (d) => (typeof d === 'string' ? d : d?.content || '');

export async function renderMarkdown(text) {
  const [marked, purify] = await Promise.all([loadVendor('marked'), loadVendor('purify')]);
  return purify.sanitize(marked.parse(text || '', { gfm: true }));
}

/** Rendered Markdown; links open in the browser instead of inside the app. */
export function markdownView(text) {
  const el = h('div', { class: 'md-preview' });
  renderMarkdown(text).then((html) => { el.innerHTML = html; }, (e) => { el.textContent = text; toast(e.message, { error: true }); });
  el.addEventListener('click', (e) => {
    const a = e.target.closest('a[href]');
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute('href');
    if (/^(https?:|mailto:)/i.test(href)) bridge.openUrl(href).catch(() => { navigator.clipboard.writeText(href); toast(`Couldn't open your browser, so the link is on your clipboard: ${href}`); });
  });
  return el;
}

/**
 * Description editor with Preview and Edit modes.
 * get()/set(text) read and write the description; mode is remembered on `state`.
 */
export function docsEditor({ get, set, onChange, state, placeholder = 'Describe what this does, its parameters and responses. Markdown works, and it syncs with Postman.' }) {
  const wrap = h('div', { class: 'docs-editor' });
  const render = () => {
    const text = get();
    const mode = state.docsMode || (text.trim() ? 'preview' : 'edit');
    const seg = h('div', { class: 'seg' },
      h('button', { class: mode === 'preview' ? 'on' : '', onclick: () => { state.docsMode = 'preview'; render(); } }, 'Preview'),
      h('button', { class: mode === 'edit' ? 'on' : '', onclick: () => { state.docsMode = 'edit'; render(); } }, 'Edit'));
    const body = mode === 'edit'
      ? h('div', { class: 'code-wrap' }, codeArea({ value: text, placeholder, minHeight: 220, oninput: (v) => { set(v); onChange?.(); } }))
      : text.trim() ? markdownView(text) : h('div', { class: 'md-empty' }, 'No documentation yet. ', h('a', { onclick: () => { state.docsMode = 'edit'; render(); } }, 'Write some'));
    wrap.replaceChildren(h('div', { class: 'row', style: { marginBottom: '10px' } }, seg, h('span', { class: 'grow' }), h('span', { class: 'faint', style: { fontSize: '12px' } }, 'Markdown')), body);
    if (mode === 'edit') wrap.querySelector('textarea')?.focus();
  };
  render();
  return wrap;
}
