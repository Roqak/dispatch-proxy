// Reusable editors: variable-aware input, key-value table, code area, JSON highlighter.

import { h, icon } from './dom.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const SCOPE_LABEL = { local: 'Local', data: 'Data', environment: 'Environment', collection: 'Collection', globals: 'Global', vault: 'Vault', dynamic: 'Dynamic' };

/** Hover text: the resolved string, then where each variable's value comes from. */
function varTitle(v, r) {
  const names = [...new Set([...v.matchAll(/\{\{([^{}]+?)\}\}/g)].map((m) => m[1].trim()))];
  const lines = names.map((n) => {
    const hit = r.lookup(n);
    if (!hit) return `${n}: not defined in any scope`;
    if (hit.scope === 'dynamic') return `${n}: new random value on each send (Dynamic)`;
    if (hit.scope === 'vault') return `${n}: ••••••, from your vault (filled in only when sent)`;
    return `${n}: ${hit.secret ? '••••••' : hit.value} (${SCOPE_LABEL[hit.scope]})`;
  });
  return [r.replace(v, 0, { mask: true }), '', ...lines].join('\n');
}

/**
 * Single-line input that highlights {{variables}}: green when defined in the
 * active scopes, red when not. Hover shows the resolved value and each
 * variable's scope; typing {{ suggests the variables in reach.
 */
export function varInput({ value = '', placeholder = '', oninput, onkeydown, resolver, small = false, cls, readonly = false }) {
  const mirror = h('div', { class: 'mirror', 'aria-hidden': 'true' });
  const input = h('input', { spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off', placeholder, value, readonly });
  const wrap = h('div', { class: ['var-input', small && 'small', cls] }, mirror, input);
  const paint = () => {
    const v = input.value;
    const r = resolver?.();
    let html = '';
    let last = 0;
    v.replace(/\{\{([^{}]*?)\}\}/g, (m, name, i) => {
      html += esc(v.slice(last, i));
      const ok = r ? !!r.lookup(name.trim()) : true;
      html += `<span class="v${ok ? '' : ' bad'}">${esc(m)}</span>`;
      last = i + m.length;
      return m;
    });
    html += esc(v.slice(last));
    mirror.innerHTML = html;
    mirror.scrollLeft = input.scrollLeft;
    if (r && v.includes('{{')) input.title = varTitle(v, r);
    else input.removeAttribute('title');
  };

  // ---- {{ autocomplete ----
  let menu = null;
  let items = [];
  let active = 0;
  let start = 0; // index just after the {{ being completed
  const closeMenu = () => { menu?.remove(); menu = null; };
  const choose = (item) => {
    const v = input.value;
    const caret = input.selectionStart;
    // Swallow the rest of a name already being edited, and its closing braces.
    const rest = /^[^{}\s]*\}\}/.exec(v.slice(caret))?.[0] || '';
    const next = `${v.slice(0, start)}${item.name}}}`;
    input.value = next + v.slice(caret + rest.length);
    input.setSelectionRange(next.length, next.length);
    closeMenu();
    paint();
    oninput?.(input.value);
  };
  const showMenu = () => {
    const m = resolver && !readonly ? /\{\{([^{}\s]*)$/.exec(input.value.slice(0, input.selectionStart)) : null;
    if (!m) return closeMenu();
    start = input.selectionStart - m[1].length;
    const q = m[1].toLowerCase();
    // Dynamic variables only join in once you type {{$ (or nothing yet), as in Postman.
    const withDynamic = !q || q.startsWith('$');
    const all = resolver().names().filter((n) => (withDynamic || n.scope !== 'dynamic') && n.name.toLowerCase().includes(q));
    // Prefix matches first, then your own variables before dynamic ones.
    const rank = (n) => (n.name.toLowerCase().startsWith(q) ? 0 : 2) + (n.scope === 'dynamic' ? 1 : 0);
    items = all.sort((a, b) => rank(a) - rank(b)).slice(0, 12);
    if (!items.length) return closeMenu();
    active = 0;
    if (!menu) { menu = h('div', { class: 'menu var-suggest' }); document.body.append(menu); }
    const box = input.getBoundingClientRect();
    Object.assign(menu.style, { left: `${box.left}px`, top: `${box.bottom + 4}px`, maxWidth: `${Math.max(320, box.width)}px` });
    renderMenu();
  };
  const renderMenu = () => menu.replaceChildren(...items.map((n, i) => h('button', {
    class: i === active && 'on',
    onmousedown: (e) => { e.preventDefault(); choose(n); },
  }, h('span', { class: 'vs-name' }, n.name), h('span', { class: 'vs-val' }, n.scope === 'dynamic' ? '' : n.secret ? '••••••' : String(n.value ?? '')), h('span', { class: 'k' }, SCOPE_LABEL[n.scope] || n.scope))));
  // Registered before the caller's handler so Enter picks a suggestion instead of sending.
  input.addEventListener('keydown', (e) => {
    if (!menu) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') active = (active + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
    else if (e.key === 'Enter' || e.key === 'Tab') { choose(items[active]); }
    else if (e.key === 'Escape') closeMenu();
    else return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (menu) renderMenu();
  });
  input.addEventListener('blur', closeMenu);
  input.addEventListener('click', showMenu);

  input.addEventListener('input', () => { paint(); oninput?.(input.value); showMenu(); });
  input.addEventListener('scroll', () => { mirror.scrollLeft = input.scrollLeft; });
  input.addEventListener('keyup', () => { mirror.scrollLeft = input.scrollLeft; });
  if (onkeydown) input.addEventListener('keydown', onkeydown);
  wrap.repaint = paint;
  wrap.input = input;
  wrap.setValue = (v) => { input.value = v; paint(); };
  queueMicrotask(paint);
  return wrap;
}

/**
 * Editable key/value table bound to a Postman list (mutated in place).
 * opts: { rows, onChange, resolver, kind: 'params'|'headers'|'form'|'urlencoded'|'pathvars',
 *         title, pickFile }
 */
export function kvSection(opts) {
  const { rows, onChange, kind = 'params', title, pickFile } = opts;
  const fixed = kind === 'pathvars';
  let bulk = false;
  const holder = h('div');
  const bulkBtn = fixed ? null : h('button', { class: 'btn ghost sm', onclick: () => { bulk = !bulk; bulkBtn.textContent = bulk ? 'Table view' : 'Bulk edit'; render(); } }, 'Bulk edit');
  const head = title ? h('div', { class: 'pane-title' }, title, h('span', { class: 'spacer' }), bulkBtn) : null;

  const changed = () => onChange?.();

  function render() {
    holder.replaceChildren(bulk ? bulkEditor() : table());
  }

  function bulkEditor() {
    const text = rows.filter((r) => r.key || r.value).map((r) => `${r.disabled ? '//' : ''}${r.key}:${r.value ?? ''}`).join('\n');
    const ta = h('textarea', { class: 'textarea', rows: Math.max(6, rows.length + 2), spellcheck: 'false', placeholder: 'key:value — one per line. Start a line with // to disable it.' });
    ta.value = text;
    ta.addEventListener('input', () => {
      const next = ta.value.split('\n').filter((l) => l.trim()).map((l) => {
        const disabled = l.trimStart().startsWith('//');
        const line = disabled ? l.trimStart().slice(2) : l;
        const i = line.indexOf(':');
        const key = (i >= 0 ? line.slice(0, i) : line).trim();
        const value = i >= 0 ? line.slice(i + 1).trim() : '';
        const prev = rows.find((r) => r.key === key);
        return { ...(prev || {}), key, value, ...(disabled ? { disabled: true } : {}), ...(!disabled && prev?.disabled ? { disabled: undefined } : {}) };
      }).map((r) => { if (r.disabled === undefined) delete r.disabled; return r; });
      rows.splice(0, rows.length, ...next);
      changed();
    });
    return ta;
  }

  function table() {
    const isForm = kind === 'form';
    const thead = h('tr', null,
      fixed ? null : h('th', { class: 'chk' }),
      h('th', null, 'Key'),
      isForm ? h('th', { class: 'type' }, 'Type') : null,
      h('th', null, 'Value'),
      opts.descriptions !== false ? h('th', null, 'Description') : null,
      fixed ? null : h('th', { class: 'del' }));
    const tbody = h('tbody');
    const all = fixed ? rows : [...rows, null]; // null = ghost row for adding
    all.forEach((row, idx) => tbody.append(rowEl(row, idx)));
    return h('table', { class: 'kv' }, h('thead', null, thead), tbody);
  }

  function rowEl(row, idx) {
    const ghost = row === null;
    const r = row || { key: '', value: '' };
    const tr = h('tr', { class: [ghost && 'ghost', r.disabled && 'disabled'] });
    const materialise = () => {
      if (!ghost || rows.includes(r)) return;
      if (kind === 'form') r.type = r.type || 'text';
      rows.push(r);
      // add a fresh ghost row without rebuilding (keeps focus)
      tr.classList.remove('ghost');
      tr.parentElement.append(rowEl(null, rows.length));
      chk && (chk.checked = true);
    };
    const chk = fixed ? null : h('input', { type: 'checkbox', checked: !ghost && !r.disabled, onchange: () => {
      materialise();
      if (chk.checked) delete r.disabled; else r.disabled = true;
      tr.classList.toggle('disabled', !!r.disabled);
      changed();
    } });
    const keyCell = fixed
      ? h('input', { class: 'cell', value: r.key, readonly: true, tabindex: -1 })
      : h('input', { class: 'cell', value: r.key, placeholder: ghost ? (kind === 'headers' ? 'Add header' : 'Add key') : 'Key', spellcheck: 'false', oninput: (e) => { materialise(); r.key = e.target.value; changed(); } });
    let valueCell;
    if (kind === 'form' && r.type === 'file') {
      const src = Array.isArray(r.src) ? r.src[0] : r.src;
      valueCell = h('div', { class: 'file-cell' },
        h('span', { class: 'path', title: src || '' }, src ? src.split(/[\\/]/).pop() : 'No file chosen'),
        h('button', { class: 'btn sm', onclick: async () => { const p = await pickFile?.(); if (p) { r.src = p; changed(); render(); } } }, src ? 'Change' : 'Choose file'));
    } else {
      valueCell = varInput({ value: r.value ?? '', placeholder: ghost ? '' : 'Value', small: true, resolver: opts.resolver, oninput: (v) => { materialise(); r.value = v; changed(); } });
    }
    const typeCell = kind === 'form' ? h('select', { class: 'cell select', onchange: (e) => { materialise(); r.type = e.target.value; if (r.type === 'file') delete r.value; else delete r.src; changed(); render(); } },
      h('option', { value: 'text', selected: r.type !== 'file' }, 'Text'), h('option', { value: 'file', selected: r.type === 'file' }, 'File')) : null;
    const descCell = opts.descriptions !== false ? h('input', { class: 'cell', value: typeof r.description === 'string' ? r.description : r.description?.content || '', placeholder: '', oninput: (e) => { materialise(); r.description = e.target.value; if (!r.description) delete r.description; changed(); } }) : null;
    tr.append(...[
      fixed ? null : h('td', { class: 'chk' }, chk),
      h('td', null, keyCell),
      typeCell ? h('td', { class: 'type' }, typeCell) : null,
      h('td', null, valueCell),
      descCell ? h('td', null, descCell) : null,
      fixed ? null : h('td', { class: 'del' }, h('button', { class: 'icon-btn sm', title: 'Remove', onclick: () => {
        const i = rows.indexOf(r);
        if (i >= 0) { rows.splice(i, 1); changed(); render(); }
      } }, icon('x'))),
    ].filter(Boolean));
    return tr;
  }

  render();
  const el = h('div', null, head, holder);
  el.rerender = render;
  return el;
}

/** Monospace editor: Tab indents, Enter keeps indentation. */
/**
 * Plain textarea for code. With `lang` ('json' | 'javascript'), a highlighted copy
 * is painted behind it; put `ta.el` in the page instead of `ta` itself.
 */
export function codeArea({ value = '', oninput, placeholder = '', minHeight, onkeydown, lang }) {
  const ta = h('textarea', { class: 'code', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off', placeholder });
  ta.el = ta;
  let paint = () => {};
  if (lang !== undefined) {
    const pre = h('pre', { class: 'code code-hl-pre', 'aria-hidden': 'true' });
    ta.classList.add('code-hl-input');
    ta.el = h('div', { class: 'code-hl' }, pre, ta);
    paint = () => { pre.innerHTML = `${highlightCode(ta.value, lang)}\n`; pre.scrollTop = ta.scrollTop; pre.scrollLeft = ta.scrollLeft; };
    ta.addEventListener('scroll', () => { pre.scrollTop = ta.scrollTop; pre.scrollLeft = ta.scrollLeft; });
    // Callers set ta.value directly (Beautify, snippets); repaint when they do.
    const native = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
    Object.defineProperty(ta, 'value', { get() { return native.get.call(this); }, set(v) { native.set.call(this, v); paint(); } });
    ta.setLang = (l) => { lang = l; paint(); };
  }
  ta.value = value;
  if (minHeight) ta.style.minHeight = `${minHeight}px`;
  ta.addEventListener('input', () => { paint(); oninput?.(ta.value); });
  ta.addEventListener('keydown', (e) => {
    onkeydown?.(e);
    if (e.defaultPrevented) return;
    if (e.key === 'Tab' && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      const { selectionStart: s, selectionEnd: en, value: v } = ta;
      if (s === en && !e.shiftKey) {
        ta.setRangeText('  ', s, en, 'end');
      } else {
        const ls = v.lastIndexOf('\n', s - 1) + 1;
        const block = v.slice(ls, en);
        const next = e.shiftKey ? block.replace(/^ {1,2}/gm, '') : block.replace(/^/gm, '  ');
        ta.setRangeText(next, ls, en, 'select');
      }
      paint();
      oninput?.(ta.value);
    } else if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
      const { selectionStart: s, value: v } = ta;
      const ls = v.lastIndexOf('\n', s - 1) + 1;
      const indent = v.slice(ls).match(/^\s*/)[0].slice(0, Math.max(0, s - ls));
      const prevChar = v.slice(0, s).trimEnd().slice(-1);
      const extra = '{[('.includes(prevChar) && prevChar ? '  ' : '';
      e.preventDefault();
      ta.setRangeText(`\n${indent}${extra}`, s, ta.selectionEnd, 'end');
      paint();
      oninput?.(ta.value);
    }
  });
  ta.setValue = (v) => { ta.value = v; };
  return ta;
}

const JS_KEYWORDS = new Set('async await break case catch class const continue default delete do else export extends finally for function if import in instanceof let new of return static super switch this throw try typeof var void while yield'.split(' '));
// Comments, strings, {{variables}}, numbers, words. Unterminated strings run to the line end.
const CODE_TOKEN = /(\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|("(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?|`(?:\\[\s\S]|[^`\\])*`?)|(\{\{[^{}\n]*\}\})|\b(\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b|([A-Za-z_$][\w$]*)/g;

/** Editable JSON (comments allowed) or JavaScript with syntax colours, returned as HTML. */
export function highlightCode(text, lang) {
  if ((lang !== 'json' && lang !== 'javascript') || text.length > 200000) return esc(text);
  let out = '';
  let last = 0;
  for (const m of text.matchAll(CODE_TOKEN)) {
    const [tok, comment, str, variable, num, word] = m;
    out += esc(text.slice(last, m.index));
    last = m.index + tok.length;
    if (comment) out += `<span class="c-com">${esc(tok)}</span>`;
    else if (str) {
      const cls = /^\s*:/.test(text.slice(last, last + 50)) ? 'j-key' : 'j-str';
      out += `<span class="${cls}">${esc(tok).replace(/\{\{[^{}\n]*\}\}/g, (v) => `<span class="c-var">${v}</span>`)}</span>`;
    } else if (variable) out += `<span class="c-var">${esc(tok)}</span>`;
    else if (num) out += `<span class="j-num">${tok}</span>`;
    else if (word === 'true' || word === 'false') out += `<span class="j-bool">${tok}</span>`;
    else if (word === 'null' || word === 'undefined') out += `<span class="j-null">${tok}</span>`;
    else if (lang === 'javascript' && JS_KEYWORDS.has(word)) out += `<span class="c-kw">${tok}</span>`;
    else out += esc(tok);
  }
  return out + esc(text.slice(last));
}

/** Pretty JSON with syntax colours, returned as HTML. */
export function highlightJson(text) {
  return esc(text).replace(/(&quot;(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\&]|&(?!quot;))*?&quot;)(\s*:)?|\b(true|false)\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, (m, str, colon, bool) => {
    if (str) return colon ? `<span class="j-key">${str}</span>${colon}` : `<span class="j-str">${str}</span>`;
    if (bool) return `<span class="j-bool">${m}</span>`;
    if (m === 'null') return `<span class="j-null">${m}</span>`;
    return `<span class="j-num">${m}</span>`;
  });
}

export function subtabs(items, active, onSelect) {
  return h('div', { class: 'subtabs' }, items.map((it) => h('button', {
    class: ['subtab', it.id === active && 'active'],
    onclick: () => onSelect(it.id),
  }, it.label, it.count ? h('span', { class: 'count' }, ` ${it.count}`) : null, it.dot ? h('span', { class: 'dot' }) : null)));
}
