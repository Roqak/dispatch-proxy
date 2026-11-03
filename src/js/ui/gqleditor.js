// GraphQL body editor: schema loading, field completion, inline problems and a schema explorer.

import { h, icon, toast, errText } from './dom.js';
import { codeArea } from './components.js';
import { validateQuery, completeAt, insertionFor } from '../graphql.js';

// Schemas per endpoint for this session (introspection results can be large).
const cache = new Map();

/** Pixel position of a caret offset inside a textarea, via a mirror element. */
function caretXY(ta, pos) {
  const cs = getComputedStyle(ta);
  const m = document.createElement('div');
  for (const k of ['font', 'letterSpacing', 'padding', 'border', 'boxSizing', 'whiteSpace', 'wordWrap', 'tabSize', 'lineHeight']) m.style[k] = cs[k];
  Object.assign(m.style, { position: 'absolute', visibility: 'hidden', top: '0', left: '-9999px', width: `${ta.clientWidth}px`, whiteSpace: 'pre', overflow: 'hidden' });
  m.textContent = ta.value.slice(0, pos);
  const mark = document.createElement('span');
  mark.textContent = '​';
  m.append(mark);
  document.body.append(m);
  const r = ta.getBoundingClientRect();
  const x = r.left + mark.offsetLeft - ta.scrollLeft;
  const y = r.top + mark.offsetTop - ta.scrollTop + parseFloat(cs.lineHeight || '18');
  m.remove();
  return { x, y };
}

/**
 * opts: { body (Postman body, mode graphql), dirty, schemaKey () => string,
 *         loadSchema () => Promise<schema> }
 */
export function graphqlEditor({ body, dirty, schemaKey, loadSchema }) {
  body.graphql = body.graphql || { query: '', variables: '' };
  const g = body.graphql;
  const wrap = h('div', { class: 'gql' });
  let schema = cache.get(schemaKey?.()) || null;
  let menu = null;
  let items = [];
  let active = 0;
  let from = 0;

  const status = h('span', { class: 'faint gql-status' });
  const loadBtn = h('button', { class: 'btn ghost sm', onclick: () => load() }, icon('sync'), 'Load schema');
  const exploreBtn = h('button', { class: 'btn ghost sm', onclick: () => { explorer.hidden = !explorer.hidden; if (!explorer.hidden) renderExplorer([]); } }, icon('layers'), 'Explore');
  const problems = h('div', { class: 'gql-problems' });
  const explorer = h('div', { class: 'gql-explorer', hidden: true });

  const ta = codeArea({ value: g.query || '', minHeight: 160, placeholder: 'query {\n  viewer { id }\n}', oninput: (v) => { g.query = v; dirty(); check(); suggest(); } });
  ta.addEventListener('keydown', (e) => {
    if (menu) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); active = (active + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length; paintMenu(); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); e.stopImmediatePropagation(); accept(items[active]); return; }
      if (e.key === 'Escape') { e.preventDefault(); closeMenu(); return; }
    }
    if (e.key === ' ' && e.ctrlKey) { e.preventDefault(); suggest(true); }
  }, true);
  ta.addEventListener('blur', () => setTimeout(closeMenu, 120));
  ta.addEventListener('click', () => closeMenu());

  const vars = codeArea({ value: g.variables || '', lang: 'json', minHeight: 70, placeholder: '{\n  "id": "1"\n}', oninput: (v) => { g.variables = v; dirty(); } });

  function setStatus() {
    status.textContent = schema ? `Schema: ${[...schema.types.values()].filter((t) => !t.name.startsWith('__')).length} types` : 'No schema loaded — Load schema for autocomplete and checks';
    loadBtn.lastChild.textContent = schema ? 'Reload schema' : 'Load schema';
    exploreBtn.disabled = !schema;
  }

  async function load() {
    loadBtn.disabled = true;
    status.textContent = 'Loading schema…';
    try {
      schema = await loadSchema();
      cache.set(schemaKey?.(), schema);
      toast('GraphQL schema loaded');
    } catch (e) { toast(errText(e), { error: true }); }
    loadBtn.disabled = false;
    setStatus();
    check();
    if (!explorer.hidden) renderExplorer([]);
  }

  function check() {
    const errs = schema ? validateQuery(ta.value, schema) : [];
    problems.replaceChildren(...errs.slice(0, 20).map((e) => h('div', { class: ['gql-problem', e.warn && 'warn'] }, icon(e.warn ? 'info' : 'alert'), h('span', { class: 'mono faint' }, `${e.line}:${e.col}`), h('span', null, e.message))));
  }

  function closeMenu() { menu?.remove(); menu = null; }
  function paintMenu() {
    menu.replaceChildren(...items.map((it, i) => h('button', { class: i === active && 'on', onmousedown: (e) => { e.preventDefault(); accept(it); } },
      h('span', { class: 'vs-name' }, it.name), h('span', { class: 'vs-val' }, it.typeStr), it.deprecated ? h('span', { class: 'k' }, 'deprecated') : null)));
    menu.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
  }
  function suggest(force = false) {
    const pos = ta.selectionStart;
    const c = completeAt(ta.value, pos, schema);
    // Pops up while typing a name, or anywhere with ⌃Space.
    if (!c || !c.items.length || (!force && !c.prefix)) return closeMenu();
    items = c.items.slice(0, 40);
    from = c.from;
    active = 0;
    if (!menu) { menu = h('div', { class: 'menu var-suggest gql-suggest' }); document.body.append(menu); }
    const { x, y } = caretXY(ta, from);
    Object.assign(menu.style, { left: `${Math.min(x, innerWidth - 340)}px`, top: `${Math.min(y + 2, innerHeight - 220)}px` });
    paintMenu();
  }
  function accept(it) {
    const text = insertionFor(it, schema);
    const pos = ta.selectionStart;
    // Keep the indentation of the current line for multi-line inserts.
    const lineStart = ta.value.lastIndexOf('\n', from - 1) + 1;
    const indent = /^\s*/.exec(ta.value.slice(lineStart))[0];
    const out = text.replace(/\n/g, `\n${indent}`);
    ta.setRangeText(out, from, pos, 'end');
    // Put the caret inside "(" or the empty selection when there is one.
    const argAt = out.indexOf(': )');
    const inner = out.indexOf('{\n');
    if (argAt >= 0) ta.selectionStart = ta.selectionEnd = from + argAt + 2;
    else if (inner >= 0) ta.selectionStart = ta.selectionEnd = from + inner + 2 + indent.length + 2;
    g.query = ta.value;
    dirty();
    closeMenu();
    check();
  }

  function renderExplorer(path) {
    if (!schema) { explorer.replaceChildren(); return; }
    const typeName = path.length ? path[path.length - 1] : null;
    const crumbs = h('div', { class: 'gql-crumbs' },
      h('a', { onclick: () => renderExplorer([]) }, 'Schema'),
      ...path.map((p, i) => [h('span', { class: 'faint' }, ' / '), h('a', { onclick: () => renderExplorer(path.slice(0, i + 1)) }, p)]).flat());
    let rows;
    if (!typeName) {
      rows = ['query', 'mutation', 'subscription'].filter((k) => schema[k]).map((k) => h('div', { class: 'gql-row', onclick: () => renderExplorer([schema[k]]) }, h('b', null, k), h('span', { class: 'faint mono' }, schema[k])));
    } else {
      const t = schema.types.get(typeName);
      const fields = [...(t?.fields?.values() || [])];
      rows = [
        t?.description ? h('p', { class: 'hint', style: { margin: '0 0 6px' } }, t.description) : null,
        ...fields.map((f) => h('div', { class: ['gql-row', f.deprecated && 'deprecated'] },
          h('span', { class: 'mono' }, f.name, f.args.length ? h('span', { class: 'faint' }, `(${f.args.map((a) => `${a.name}: ${a.typeStr}`).join(', ')})`) : null),
          h('a', { class: 'mono', onclick: () => schema.types.get(f.type)?.fields?.size && renderExplorer([...path, f.type]) }, f.typeStr),
          f.description ? h('span', { class: 'faint gql-desc' }, f.description) : null)),
        t?.enumValues?.length ? h('div', { class: 'mono faint' }, t.enumValues.join(' · ')) : null,
        t?.inputFields?.length ? t.inputFields.map((f) => h('div', { class: 'gql-row' }, h('span', { class: 'mono' }, f.name), h('span', { class: 'mono faint' }, f.typeStr))) : null,
      ].flat();
    }
    explorer.replaceChildren(crumbs, ...rows.filter(Boolean));
  }

  wrap.append(
    h('div', { class: 'pane-title' }, 'Query', h('span', { class: 'spacer' }), status, exploreBtn, loadBtn),
    h('div', { class: 'code-wrap' }, ta),
    problems,
    explorer,
    h('div', { class: 'pane-title', style: { marginTop: '12px' } }, 'Variables (JSON)'),
    vars.el);
  setStatus();
  check();
  return wrap;
}
