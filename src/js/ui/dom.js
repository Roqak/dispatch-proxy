// Small DOM toolkit: element builder, icons, menus, dialogs, toasts.

export function h(tag, attrs, ...children) {
  const el = tag === 'svg' || attrs?.svg ? document.createElementNS('http://www.w3.org/2000/svg', tag) : document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false || k === 'svg') continue;
      if (k === 'class') el.setAttribute('class', Array.isArray(v) ? v.filter(Boolean).join(' ') : v);
      else if (k === 'style' && typeof v === 'object') {
        for (const [sk, sv] of Object.entries(v)) {
          if (sv === undefined || sv === null) continue;
          if (sk.startsWith('--')) el.style.setProperty(sk, String(sv));
          else el.style[sk] = sv;
        }
      }
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'value' && 'value' in el) el.value = v;
      else if (k === 'checked' || k === 'selected' || k === 'disabled') el[k] = !!v;
      else if (k === 'html') el.innerHTML = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export const $ = (sel, root = document) => root.querySelector(sel);

// ---------- icons (24px grid, stroke) ----------
const P = {
  chevron: 'M9 6l6 6-6 6',
  folder: 'M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z',
  folderOpen: 'M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v1H7.5a2 2 0 00-1.9 1.4L3 19zM3 19l2.6-7.6A2 2 0 017.5 10H21l-2.7 7.7A2 2 0 0116.4 19z',
  box: 'M21 8l-9-5-9 5 9 5 9-5zM3 8v8l9 5 9-5V8M12 13v8',
  plus: 'M12 5v14M5 12h14',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  search: 'M11 18a7 7 0 100-14 7 7 0 000 14zM21 21l-5-5',
  filter: 'M4 5h16l-6 7.5V19l-4 1v-7.5z',
  sync: 'M20 11a8 8 0 00-14.9-3M4 5v4h4M4 13a8 8 0 0014.9 3M20 19v-4h-4',
  gear: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z',
  x: 'M6 6l12 12M18 6L6 18',
  trash: 'M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 002 2h8a2 2 0 002-2l1-12M9 7V4h6v3',
  copy: 'M9 9h10v10H9zM5 15V5h10',
  download: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  upload: 'M12 20V9M7 14l5-5 5 5M5 4h14',
  eye: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zM12 15a3 3 0 100-6 3 3 0 000 6z',
  check: 'M5 12l5 5L20 7',
  clock: 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 7v5l3 2',
  layers: 'M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5',
  columns: 'M4 5h16v14H4zM12 5v14',
  rows: 'M4 5h16v14H4zM4 12h16',
  globe: 'M12 21a9 9 0 100-18 9 9 0 000 18zM3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z',
  send: 'M4 12l16-8-6 16-2.5-6.5z',
  play: 'M7 5l12 7-12 7z',
  stop: 'M7 7h10v10H7z',
  cloud: 'M7 18a4.5 4.5 0 01-.8-8.9 6 6 0 0111.6 1.4A3.8 3.8 0 0117.5 18z',
  cloudUp: 'M7 18a4.5 4.5 0 01-.8-8.9 6 6 0 0111.6 1.4A3.8 3.8 0 0117.5 18zM12 15v-5M9.5 12.5L12 10l2.5 2.5',
  alert: 'M12 9v4M12 17h.01M10.3 3.9L2.4 17.5A2 2 0 004.1 20.5h15.8a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z',
  info: 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 11v5M12 8h.01',
  file: 'M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8zM14 3v5h5',
  edit: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
  key: 'M15 7a4 4 0 11-3.9 4.9L4 19v2h3v-2h2v-2h2l1.1-1.1A4 4 0 0115 7zM16 9.5h.01',
  wrap: 'M4 6h16M4 12h13a3 3 0 010 6h-4M15 16l-2 2 2 2M4 18h5',
  terminal: 'M5 7l5 5-5 5M12 19h7',
  code: 'M8 7l-5 5 5 5M16 7l5 5-5 5M13.5 5l-3 14',
  link: 'M10 14a5 5 0 007.1 0l3-3a5 5 0 00-7.1-7.1l-1 1M14 10a5 5 0 00-7.1 0l-3 3a5 5 0 007.1 7.1l1-1',
  logout: 'M15 4h3a2 2 0 012 2v12a2 2 0 01-2 2h-3M10 17l5-5-5-5M15 12H3',
};

export function icon(name, cls) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', name === 'more' ? '3' : '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  if (cls) svg.setAttribute('class', cls);
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', P[name] || P.info);
  svg.append(p);
  return svg;
}

export const logoSvg = () => h('div', { class: 'logo', html: `<svg viewBox="0 0 64 64" width="46" height="46"><rect x="4" y="4" width="56" height="56" rx="13" fill="#181c26"/><path d="M17 33 L46 20 L35 47 L31 37 Z" fill="#7fd6a4"/><path d="M31 37 L46 20 L29 35 Z" fill="#2f8a5e"/><rect x="11" y="38" width="9" height="2" rx="1" fill="#7fd6a4" opacity=".7"/><rect x="14" y="42" width="6" height="2" rx="1" fill="#7fd6a4" opacity=".7"/></svg>` });

// ---------- menus ----------
let openMenu = null;
export function closeMenu() { openMenu?.remove(); openMenu = null; document.querySelectorAll('.menu-open').forEach((e) => e.classList.remove('menu-open')); }

/** items: [{ label, icon, onClick, danger, key }, '-', ...] */
export function showMenu(anchorOrEvent, items, owner) {
  closeMenu();
  const menu = h('div', { class: 'menu', role: 'menu' },
    items.filter(Boolean).map((it) => it === '-' ? h('hr') : h('button', {
      class: it.danger ? 'danger' : '',
      disabled: it.disabled,
      onclick: (e) => { e.stopPropagation(); closeMenu(); it.onClick?.(); },
    }, it.icon ? icon(it.icon) : null, it.label, it.key ? h('span', { class: 'k' }, it.key) : null)));
  document.body.append(menu);
  let x, y;
  if (anchorOrEvent instanceof MouseEvent && anchorOrEvent.type === 'contextmenu') { x = anchorOrEvent.clientX; y = anchorOrEvent.clientY; }
  else { const r = (anchorOrEvent.currentTarget || anchorOrEvent.target || anchorOrEvent).getBoundingClientRect(); x = r.left; y = r.bottom + 4; }
  const mr = menu.getBoundingClientRect();
  if (x + mr.width > innerWidth - 8) x = innerWidth - mr.width - 8;
  if (y + mr.height > innerHeight - 8) y = Math.max(8, y - mr.height - 30);
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  owner?.classList.add('menu-open');
  openMenu = menu;
}
/**
 * A menu with a search box: type to filter, ↑/↓ to move, Enter to pick.
 * items: [{ id, label, hint }]
 */
export function pickerMenu(anchor, { items, current, onPick, placeholder = 'Search' }) {
  closeMenu();
  const input = h('input', { class: 'input', placeholder, spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off' });
  const list = h('div', { class: 'picker-list', role: 'listbox' });
  const menu = h('div', { class: 'menu picker', role: 'menu' }, input, list);
  let shown = [];
  let active = Math.max(0, items.findIndex((it) => it.id === current));
  const pick = (it) => { closeMenu(); if (it.id !== current) onPick(it); };
  const highlight = () => {
    [...list.children].forEach((el, i) => el.classList.toggle('on', i === active));
    list.children[active]?.scrollIntoView({ block: 'nearest' });
  };
  const render = () => {
    const q = input.value.trim().toLowerCase();
    shown = items.filter((it) => !q || it.label.toLowerCase().includes(q) || it.hint?.toLowerCase().includes(q));
    active = Math.min(active, Math.max(0, shown.length - 1));
    list.replaceChildren(...(shown.length ? shown.map((it, i) => h('button', {
      role: 'option',
      onmousemove: () => { if (active !== i) { active = i; highlight(); } },
      onclick: (e) => { e.stopPropagation(); pick(it); },
    }, it.id === current ? icon('check') : h('span', { class: 'picker-gap' }), h('span', { class: 'ellipsis' }, it.label), it.hint ? h('span', { class: 'k' }, it.hint) : null))
      : [h('div', { class: 'picker-empty' }, 'No matches')]));
    highlight();
  };
  input.addEventListener('input', () => { active = 0; render(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (shown.length) { active = (active + (e.key === 'ArrowDown' ? 1 : shown.length - 1)) % shown.length; highlight(); }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (shown[active]) pick(shown[active]);
    }
  });
  render();
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.left = `${Math.min(r.left, innerWidth - menu.offsetWidth - 8)}px`;
  menu.style.top = `${r.bottom + 4}px`;
  menu.style.width = `${Math.max(r.width, 260)}px`;
  anchor.classList.add('menu-open');
  openMenu = menu;
  input.focus();
}

/** Free-form content in a menu-style popover below `anchor` (closes like a menu). */
export function popover(anchor, content, { width } = {}) {
  closeMenu();
  const menu = h('div', { class: 'menu popover', role: 'dialog' }, content);
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  if (width) menu.style.width = `${width}px`;
  const left = Math.max(8, Math.min(r.right - menu.offsetWidth, innerWidth - menu.offsetWidth - 8));
  const top = r.bottom + 6 + menu.offsetHeight > innerHeight - 8 ? Math.max(8, r.top - menu.offsetHeight - 6) : r.bottom + 6;
  Object.assign(menu.style, { left: `${left}px`, top: `${top}px` });
  anchor.classList.add('menu-open');
  openMenu = menu;
  return menu;
}

document.addEventListener('mousedown', (e) => { if (openMenu && !openMenu.contains(e.target)) closeMenu(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

// ---------- modals ----------
export function modal({ title, body, actions = [], wide = false, onClose }) {
  const close = () => { overlay.remove(); document.removeEventListener('keydown', esc); onClose?.(); };
  const esc = (e) => { if (e.key === 'Escape') close(); };
  const overlay = h('div', { class: 'overlay', onmousedown: (e) => { if (e.target === overlay) close(); } },
    h('div', { class: ['modal', wide && 'wide'], role: 'dialog' },
      h('div', { class: 'modal-head' }, h('h2', null, title), h('button', { class: 'icon-btn', onclick: close, title: 'Close' }, icon('x'))),
      h('div', { class: 'modal-body' }, body),
      actions.length ? h('div', { class: 'modal-foot' }, actions.map((a) => h('button', {
        class: ['btn', a.primary && 'primary', a.danger && 'danger'],
        onclick: async (e) => { const r = await a.onClick?.(e); if (r !== false) close(); },
      }, a.label))) : null));
  document.addEventListener('keydown', esc);
  document.body.append(overlay);
  setTimeout(() => overlay.querySelector('input, textarea, select, .btn.primary')?.focus(), 30);
  return close;
}

export function confirmDialog({ title, message, confirm = 'OK', danger = false, cancel = 'Cancel', extra }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    modal({
      title,
      body: h('p', null, message),
      onClose: () => finish(false),
      actions: [
        ...(extra ? [{ label: extra.label, onClick: () => finish(extra.value) }] : []),
        { label: cancel, onClick: () => finish(false) },
        { label: confirm, primary: !danger, danger, onClick: () => finish(true) },
      ],
    });
  });
}

export function promptDialog({ title, label, value = '', confirm = 'Create', placeholder = '' }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const input = h('input', { class: 'input', value, placeholder, style: { width: '100%' } });
    let closeFn;
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && input.value.trim()) { finish(input.value.trim()); closeFn(); } });
    closeFn = modal({
      title,
      body: h('div', null, label ? h('p', null, label) : null, input),
      onClose: () => finish(null),
      actions: [
        { label: 'Cancel', onClick: () => finish(null) },
        { label: confirm, primary: true, onClick: () => { if (!input.value.trim()) return false; finish(input.value.trim()); } },
      ],
    });
    setTimeout(() => { input.focus(); input.select(); }, 40);
  });
}

// ---------- toasts ----------
export function toast(message, { error = false, action, timeout } = {}) {
  let root = $('.toasts');
  if (!root) { root = h('div', { class: 'toasts' }); document.body.append(root); }
  const el = h('div', { class: ['toast', error && 'err'] }, h('span', null, message), action ? h('button', { onclick: () => { el.remove(); action.onClick(); } }, action.label) : null);
  root.append(el);
  setTimeout(() => el.remove(), timeout ?? (error ? 7000 : 2600));
}

export function errText(e) {
  const s = typeof e === 'string' ? e : e?.message || String(e);
  return s.replace(/^Error:\s*/, '');
}

/**
 * Stand-in for UI whose code loads on first use: `load` resolves to the real
 * node(s), which replace the placeholder. Keeps rarely used features out of startup.
 */
export function lazyEl(load) {
  const el = h('div', { class: 'lazy' });
  load().then((n) => el.replaceWith(...[].concat(n))).catch((e) => { el.textContent = errText(e); });
  return el;
}

// ---------- misc ----------
export function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function fmtMs(ms) { return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`; }

export function relTime(ts) {
  const d = (Date.now() - ts) / 1000;
  if (d < 45) return 'just now';
  if (d < 3600) return `${Math.round(d / 60)} min ago`;
  if (d < 86400) return `${Math.round(d / 3600)} h ago`;
  return new Date(ts).toLocaleDateString();
}

export function methodClass(m) {
  const up = String(m || 'GET').toUpperCase();
  return ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(up) ? `m-${up}` : 'm-OTHER';
}

export function methodLabel(m) {
  const up = String(m || 'GET').toUpperCase();
  return up === 'DELETE' ? 'DEL' : up === 'OPTIONS' ? 'OPT' : up;
}

/** Drag a divider to resize; calls onMove(dx, dy) relative to drag start. */
export function dragResize(handle, onStart, onMove, onEnd) {
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY;
    const ctx = onStart?.();
    handle.classList.add('dragging');
    document.body.style.cursor = getComputedStyle(handle).cursor;
    const move = (ev) => onMove(ev.clientX - sx, ev.clientY - sy, ctx);
    const up = () => {
      handle.classList.remove('dragging');
      document.body.style.cursor = '';
      removeEventListener('mousemove', move);
      removeEventListener('mouseup', up);
      onEnd?.();
    };
    addEventListener('mousemove', move);
    addEventListener('mouseup', up);
  });
}
