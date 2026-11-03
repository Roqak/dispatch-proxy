// Request chains: which requests set which variables (in scripts) and which
// requests use them ({{var}} or pm.*.get), in run order — so a collection's
// token-passing is visible, and variables used before anything sets them stand out.

import { getScript, urlObject } from './model.js';

const isFolder = (it) => Array.isArray(it?.item);
const SET_RE = /\bpm\.(environment|collectionVariables|globals|variables)\.set\(\s*(['"`])([^'"`]+)\2/g;
const LEGACY_SET_RE = /\bpostman\.(setEnvironmentVariable|setGlobalVariable)\(\s*(['"`])([^'"`]+)\2/g;
const GET_RE = /\bpm\.(environment|collectionVariables|globals|variables|iterationData)\.get\(\s*(['"`])([^'"`]+)\2/g;
const TEMPLATE_RE = /\{\{\s*([^{}\s][^{}]*?)\s*\}\}/g;
const SCOPE = { environment: 'environment', collectionVariables: 'collection', globals: 'globals', variables: 'local', iterationData: 'data', setEnvironmentVariable: 'environment', setGlobalVariable: 'globals' };

function scriptsOf(target) {
  return ['prerequest', 'test'].map((phase) => ({ phase, code: getScript(target, phase) || '' })).filter((s) => s.code);
}

/** Every {{name}} in the request's URL, headers, body and auth. */
function templateUses(req) {
  const out = new Set();
  const scan = (v) => { if (typeof v === 'string') for (const m of v.matchAll(TEMPLATE_RE)) if (!m[1].startsWith('$')) out.add(m[1].trim()); };
  const u = urlObject(req?.url);
  scan(u.raw);
  for (const v of u.variable || []) scan(v.value);
  for (const h of req?.header || []) if (!h.disabled) { scan(h.key); scan(h.value); }
  const b = req?.body;
  if (b && !b.disabled) {
    scan(b.raw);
    for (const f of [...(b.urlencoded || []), ...(b.formdata || [])]) if (!f.disabled) { scan(f.key); scan(f.value); }
    scan(b.graphql?.query); scan(b.graphql?.variables);
  }
  const auth = req?.auth;
  if (auth?.type && Array.isArray(auth[auth.type])) for (const p of auth[auth.type]) scan(p.value);
  return out;
}

function scriptSets(code) {
  const out = [];
  for (const re of [SET_RE, LEGACY_SET_RE]) for (const m of code.matchAll(re)) out.push({ name: m[3], scope: SCOPE[m[1]] });
  return out;
}

function scriptGets(code) {
  const out = [];
  for (const m of code.matchAll(GET_RE)) out.push({ name: m[3], scope: SCOPE[m[1]] });
  for (const m of code.matchAll(TEMPLATE_RE)) if (!m[1].startsWith('$')) out.push({ name: m[1].trim(), scope: null });
  return out;
}

/**
 * Analyse a collection. `defined` is a Set of names that have a value before
 * the run starts (environment, collection variables, globals, vault, data).
 * Returns { steps: [{ id, name, method, path, sets: [{name, scope, phase}], uses: [{name, from: stepIndex|null, defined}] }],
 *           variables: Map(name → { setBy: [stepIndex], usedBy: [stepIndex] }), problems: [{ step, name, message }] }
 */
export function analyzeChain(collection, { defined = new Set() } = {}) {
  const steps = [];
  const inherited = (parents) => parents.flatMap((p) => scriptsOf(p));
  const walk = (items, parents, path) => {
    for (const it of items || []) {
      if (isFolder(it)) { walk(it.item, [...parents, it], [...path, it.name]); continue; }
      if (!it.request) continue;
      const own = scriptsOf(it);
      const all = [...inherited(parents), ...own];
      const sets = [];
      for (const s of all) for (const x of scriptSets(s.code)) if (!sets.some((y) => y.name === x.name)) sets.push({ ...x, phase: s.phase, inherited: !own.includes(s) });
      const used = new Set(templateUses(it.request));
      for (const s of all) for (const g of scriptGets(s.code)) if (g.scope !== 'data') used.add(g.name);
      steps.push({ id: it.id, name: it.name, method: it.request.method || 'GET', path: path.join(' / '), sets, usedNames: [...used] });
    }
  };
  walk(collection?.item, [collection].filter(Boolean), []);

  const variables = new Map();
  const v = (name) => { if (!variables.has(name)) variables.set(name, { setBy: [], usedBy: [] }); return variables.get(name); };
  const problems = [];
  steps.forEach((st, i) => {
    // A request sees what earlier requests set, and its own pre-request sets.
    st.uses = st.usedNames.map((name) => {
      const ownPre = st.sets.some((x) => x.name === name && x.phase === 'prerequest');
      let from = null;
      for (let k = i - 1; k >= 0; k--) if (steps[k].sets.some((x) => x.name === name)) { from = k; break; }
      const isDefined = defined.has(name) || name.startsWith('vault:');
      const use = { name, from: ownPre ? i : from, defined: isDefined };
      v(name).usedBy.push(i);
      if (use.from == null && !isDefined) {
        const later = steps.findIndex((s, k) => k > i && s.sets.some((x) => x.name === name));
        problems.push({ step: i, name, message: later > i ? `"${name}" is used before "${steps[later].name}" sets it` : `"${name}" isn't set by any request or defined in the environment` });
      }
      return use;
    });
    for (const s of st.sets) v(s.name).setBy.push(i);
    delete st.usedNames;
  });
  return { steps, variables, problems };
}
