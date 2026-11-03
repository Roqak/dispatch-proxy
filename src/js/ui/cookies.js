// Cookie manager: every cookie in the jar, grouped by domain, with add/edit/delete.

import { h, icon, modal, toast, errText, confirmDialog } from './dom.js';
import { bridge } from '../bridge.js';

const expiryText = (c) => (c.expires == null ? 'Session' : new Date(c.expires * 1000).toLocaleString());
const toLocalInput = (secs) => { const d = new Date(secs * 1000); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };

export function openCookieManager({ domain: focusDomain = '' } = {}) {
  let cookies = [];
  let q = focusDomain;
  let editing = null; // { original, draft }
  const list = h('div', { class: 'cookie-list' });
  const form = h('div', { class: 'cookie-form' });
  const search = h('input', { class: 'input', placeholder: 'Filter by domain, name or value', value: q, oninput: (e) => { q = e.target.value; renderList(); } });

  const load = async () => {
    try { cookies = await bridge.listCookies(); } catch (e) { toast(errText(e), { error: true }); cookies = []; }
    renderList();
  };

  const renderList = () => {
    const needle = q.trim().toLowerCase();
    const shown = cookies.filter((c) => !needle || c.domain.includes(needle) || c.name.toLowerCase().includes(needle) || c.value.toLowerCase().includes(needle));
    if (!shown.length) {
      list.replaceChildren(h('div', { class: 'md-empty' }, cookies.length ? 'No cookies match.' : 'No cookies yet. They appear here when a response sets one, or add your own.'));
      return;
    }
    const byDomain = new Map();
    for (const c of shown) { if (!byDomain.has(c.domain)) byDomain.set(c.domain, []); byDomain.get(c.domain).push(c); }
    list.replaceChildren(...[...byDomain].map(([domain, items]) => h('div', { class: 'cookie-domain' },
      h('div', { class: 'cookie-domain-head' },
        h('b', null, domain), h('span', { class: 'faint' }, `${items.length} cookie${items.length === 1 ? '' : 's'}`), h('span', { class: 'grow' }),
        h('button', { class: 'btn ghost sm', onclick: () => edit(null, domain) }, icon('plus'), 'Add'),
        h('button', { class: 'icon-btn sm', title: `Delete every cookie for ${domain}`, onclick: async () => {
          if (!(await confirmDialog({ title: `Delete cookies for ${domain}?`, message: `${items.length} cookie${items.length === 1 ? '' : 's'} will be removed.`, confirm: 'Delete', danger: true }))) return;
          for (const c of items) await bridge.deleteCookie(c.domain, c.path, c.name);
          load();
        } }, icon('trash'))),
      ...items.map((c) => h('div', { class: ['cookie-row', editing?.original === c && 'on'], onclick: () => edit(c) },
        h('span', { class: 'mono cookie-name' }, c.name),
        h('span', { class: 'mono cookie-value', title: c.value }, c.value || h('span', { class: 'faint' }, '(empty)')),
        h('span', { class: 'faint cookie-meta' }, [c.path !== '/' ? c.path : '', expiryText(c), c.secure ? 'Secure' : '', c.httpOnly ? 'HttpOnly' : '', c.hostOnly ? '' : 'Subdomains'].filter(Boolean).join(' · ')),
        h('button', { class: 'icon-btn sm', title: 'Delete', onclick: async (e) => { e.stopPropagation(); await bridge.deleteCookie(c.domain, c.path, c.name); if (editing?.original === c) { editing = null; renderForm(); } load(); } }, icon('x')))))));
  };

  const edit = (c, domain = '') => {
    editing = { original: c, draft: c ? { ...c } : { domain, path: '/', name: '', value: '', expires: null, secure: false, httpOnly: false, hostOnly: true } };
    renderForm();
    renderList();
    form.querySelector(c ? 'textarea' : 'input')?.focus();
  };

  const renderForm = () => {
    if (!editing) { form.replaceChildren(); return; }
    const d = editing.draft;
    const field = (label, el) => [h('label', null, label), el];
    const text = (key, placeholder) => h('input', { class: 'input mono', value: d[key] || '', placeholder, spellcheck: 'false', oninput: (e) => { d[key] = e.target.value; } });
    const check = (key, label) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!d[key], onchange: (e) => { d[key] = e.target.checked; } }), label);
    const value = h('textarea', { class: 'textarea mono', rows: 2, spellcheck: 'false', oninput: (e) => { d.value = e.target.value; } });
    value.value = d.value || '';
    const expires = h('input', { class: 'input', type: 'datetime-local', value: d.expires != null ? toLocalInput(d.expires) : '', oninput: (e) => { d.expires = e.target.value ? Math.floor(new Date(e.target.value).getTime() / 1000) : null; } });
    const save = async () => {
      try {
        const o = editing.original;
        if (o && (o.domain !== d.domain.trim().replace(/^\./, '').toLowerCase() || o.path !== d.path || o.name !== d.name.trim())) await bridge.deleteCookie(o.domain, o.path, o.name);
        await bridge.setCookie({ domain: d.domain, hostOnly: !!d.hostOnly, path: d.path || '/', name: d.name, value: d.value, expires: d.expires ?? null, secure: !!d.secure, httpOnly: !!d.httpOnly });
        editing = null;
        renderForm();
        await load();
        toast('Cookie saved');
      } catch (e) { toast(errText(e), { error: true }); }
    };
    form.replaceChildren(
      h('div', { class: 'pane-title' }, editing.original ? `Edit ${editing.original.name}` : 'New cookie'),
      h('div', { class: 'form-grid' },
        ...field('Domain', text('domain', 'api.example.com')),
        ...field('Path', text('path', '/')),
        ...field('Name', text('name', 'session')),
        ...field('Value', value),
        ...field('Expires', h('div', { class: 'row' }, expires, h('span', { class: 'hint', style: { margin: 0 } }, 'Empty = session cookie'))),
        h('span'), h('div', { class: 'row', style: { gap: '14px' } }, check('secure', 'Secure (HTTPS only)'), check('httpOnly', 'HttpOnly'), h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !d.hostOnly, onchange: (e) => { d.hostOnly = !e.target.checked; } }), 'Include subdomains'))),
      h('div', { class: 'row', style: { justifyContent: 'flex-end', marginTop: '10px' } },
        h('button', { class: 'btn', onclick: () => { editing = null; renderForm(); renderList(); } }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: save }, 'Save cookie')));
  };

  modal({
    title: 'Cookies',
    wide: true,
    body: h('div', { class: 'cookie-manager' },
      h('div', { class: 'row', style: { marginBottom: '10px' } }, search,
        h('button', { class: 'btn sm', onclick: () => edit(null, q.includes('.') ? q.trim() : '') }, icon('plus'), 'Add cookie'),
        h('button', { class: 'btn ghost sm danger', onclick: async () => {
          if (!cookies.length || !(await confirmDialog({ title: 'Delete all cookies?', message: 'Every stored cookie, for every domain, will be removed.', confirm: 'Delete all', danger: true }))) return;
          await bridge.clearCookies();
          load();
        } }, 'Clear all')),
      list, form,
      h('p', { class: 'hint', style: { marginBottom: 0 } }, 'Cookies are sent with matching requests automatically. Ones with an expiry date are kept after Dispatch restarts; session cookies last until you quit.')),
  });
  load();
}
