// Request-chain tab: requests in run order, the variables each sets and uses,
// arrows from setter to user, and warnings for variables nothing provides.

import { h, icon, methodClass, methodLabel } from './dom.js';
import * as C from '../ctx.js';
import * as S from '../store.js';
import { analyzeChain } from '../chain.js';

const ROW = 46;
const SVGNS = 'http://www.w3.org/2000/svg';
const hue = (name) => { let x = 0; for (const ch of name) x = (x * 31 + ch.charCodeAt(0)) >>> 0; return x % 360; };

export async function renderChainTab(root, t) {
  const entry = S.collectionEntry(t.ref.col);
  if (!entry) { root.replaceChildren(h('div', { class: 'pane' }, 'This collection is no longer in the workspace.')); return; }
  await S.ensureCollection(entry);
  const defined = new Set(C.resolverFor({ kind: 'chain', ref: { col: entry.uid, item: null } }).names().filter((n) => n.scope !== 'dynamic').map((n) => n.name));
  const { steps, variables, problems } = analyzeChain(entry.data, { defined });

  // Arrows: one per (setter → user) pair, packed into lanes so they don't overlap.
  const arcs = [];
  steps.forEach((st, i) => { for (const u of st.uses) if (u.from != null && u.from !== i) arcs.push({ from: u.from, to: i, name: u.name }); });
  arcs.sort((a, b) => (a.to - a.from) - (b.to - b.from));
  const lanes = [];
  for (const a of arcs) {
    let lane = 0;
    while ((lanes[lane] || []).some((b) => !(a.to <= b.from || a.from >= b.to))) lane++;
    (lanes[lane] = lanes[lane] || []).push(a);
    a.lane = lane;
  }
  const gutter = 24 + lanes.length * 14;
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('class', 'chain-arcs');
  svg.setAttribute('width', gutter);
  svg.setAttribute('height', Math.max(ROW, steps.length * ROW));
  for (const a of arcs) {
    const y1 = a.from * ROW + ROW / 2 + 4;
    const y2 = a.to * ROW + ROW / 2 - 4;
    const x = gutter - 14 - a.lane * 14;
    const p = document.createElementNS(SVGNS, 'path');
    p.setAttribute('d', `M ${gutter - 4} ${y1} C ${x} ${y1}, ${x} ${y1}, ${x} ${Math.min(y1 + 10, y2)} L ${x} ${Math.max(y2 - 10, y1)} C ${x} ${y2}, ${x} ${y2}, ${gutter - 6} ${y2}`);
    p.setAttribute('stroke', `hsl(${hue(a.name)} 65% 55%)`);
    p.setAttribute('fill', 'none');
    p.setAttribute('stroke-width', '1.6');
    p.setAttribute('marker-end', 'url(#chain-arrow)');
    const title = document.createElementNS(SVGNS, 'title');
    title.textContent = `${a.name}: ${steps[a.from].name} → ${steps[a.to].name}`;
    p.append(title);
    svg.append(p);
  }
  const defs = document.createElementNS(SVGNS, 'defs');
  defs.innerHTML = '<marker id="chain-arrow" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0 L6 3 L0 6 z" fill="currentColor"/></marker>';
  svg.prepend(defs);

  const chip = (name, cls, title) => h('span', { class: ['chain-chip', cls], title, style: { '--h': hue(name) } }, name);
  const rows = steps.map((st, i) => {
    const issues = problems.filter((p) => p.step === i);
    return h('div', { class: 'chain-row', style: { height: `${ROW}px` }, onclick: () => st.id && C.openItem(entry, st.id) },
      h('span', { class: 'faint mono chain-n' }, i + 1),
      h('span', { class: ['method', methodClass(st.method)] }, methodLabel(st.method)),
      h('div', { class: 'chain-name' }, h('span', null, st.name), st.path ? h('span', { class: 'faint' }, st.path) : null),
      h('div', { class: 'chain-vars' },
        ...st.sets.filter((s) => !s.inherited).map((s) => chip(`→ ${s.name}`, 'sets', `Sets ${s.name} (${s.scope}, ${s.phase === 'test' ? 'post-response' : 'pre-request'} script)`)),
        ...st.uses.filter((u) => u.from != null && u.from !== i).map((u) => chip(`${u.name} ←`, 'uses', `Uses ${u.name}, set by ${steps[u.from].name}`)),
        ...issues.map((p) => chip(`⚠ ${p.name}`, 'bad', p.message))));
  });

  const unusedSets = [...variables].filter(([, v]) => v.setBy.length && !v.usedBy.length).map(([k]) => k);
  root.replaceChildren(
    h('div', { class: 'crumbs' }, icon('link'), h('b', null, `Request chain · ${entry.name}`)),
    h('div', { class: 'pane' },
      h('p', { class: 'hint', style: { marginTop: 0 } }, 'In run order. Arrows run from the request whose script sets a variable to the requests that use it. Click a request to open it.'),
      problems.length ? h('div', { class: 'note warn', style: { marginBottom: '10px' } }, icon('alert'), h('span', null, `${problems.length} variable${problems.length === 1 ? '' : 's'} used without a value: `, problems.map((p) => p.message).join('; '), '.')) : null,
      steps.length
        ? h('div', { class: 'chain' }, svg, h('div', { class: 'chain-rows' }, rows))
        : h('div', { class: 'md-empty' }, 'This collection has no requests yet.'),
      unusedSets.length ? h('p', { class: 'hint' }, 'Set but never used here: ', unusedSets.map((n) => h('span', { class: 'mono' }, `${n} `))) : null,
      h('p', { class: 'hint' }, 'Found by reading scripts (pm.*.set / get) and {{variables}} in URLs, headers, bodies and auth. Names built at run time can\'t be seen.')));
}
