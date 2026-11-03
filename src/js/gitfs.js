// A collection as a folder of small JSON files, for Git:
//   collection.json            info, auth, scripts, variables, child order
//   <folder>/folder.json       a folder's settings and child order
//   <name>.request.json        one request, with its examples
// Files are pretty-printed with stable names, so diffs and reviews stay readable.
// Requests or folders added by hand (not listed in an order) are picked up too.

import { forUpload, SCHEMA_V21, uuid } from './model.js';

const isFolder = (it) => Array.isArray(it?.item);
const json = (v) => `${JSON.stringify(v, null, 2)}\n`;

export function slug(name, fallback) {
  const s = String(name || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return s || fallback;
}

/**
 * Collection → [{ path, content }].
 * `paths` (item id → path from an earlier read/write) keeps existing file and
 * folder names, so renaming a request in the app doesn't rename its file.
 */
export function toFiles(collection, { paths = {} } = {}) {
  const c = forUpload(collection);
  const files = [];
  const writeChildren = (items, prefix) => {
    const used = new Set(['folder.json', 'collection.json']);
    const order = [];
    for (const it of items || []) {
      const known = it.id && paths[it.id];
      const knownName = known && known.startsWith(prefix) ? known.slice(prefix.length) : null;
      const fits = knownName && !knownName.includes('/') && !used.has(knownName) && (isFolder(it) ? !knownName.endsWith('.json') : knownName.endsWith('.request.json'));
      const base = slug(it.name, isFolder(it) ? 'folder' : 'request');
      let name = fits ? knownName : isFolder(it) ? base : `${base}.request.json`;
      for (let n = 2; used.has(name); n++) name = isFolder(it) ? `${base}-${n}` : `${base}-${n}.request.json`;
      used.add(name);
      order.push(name);
      if (isFolder(it)) {
        const { item, ...rest } = it;
        const childOrder = writeChildren(item, `${prefix}${name}/`);
        files.push({ path: `${prefix}${name}/folder.json`, content: json({ ...rest, order: childOrder }) });
      } else {
        files.push({ path: `${prefix}${name}`, content: json(it) });
      }
    }
    return order;
  };
  const order = writeChildren(c.item, '');
  const { item, ...top } = c;
  files.push({ path: 'collection.json', content: json({ ...top, order }) });
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

// Where each item was read from; not enumerable, so it never ends up in saved data.
const SOURCE = Symbol('file');
const from = (obj, path) => { Object.defineProperty(obj, SOURCE, { value: path, enumerable: false }); return obj; };

/** Item id → path for a collection just read with fromFiles. */
export function pathsFromTree(collection) {
  const out = {};
  const walk = (items) => { for (const it of items || []) { if (it[SOURCE] && it.id) out[it.id] = it[SOURCE]; if (Array.isArray(it.item)) walk(it.item); } };
  walk(collection.item);
  return out;
}

/** Item id → path for every request and folder in a file set (see toFiles `paths`). */
export function pathsOf(files) {
  const out = {};
  for (const f of files) {
    if (!f.path.endsWith('.request.json') && !f.path.endsWith('/folder.json')) continue;
    try {
      const id = JSON.parse(f.content)?.id;
      if (id) out[id] = f.path.endsWith('/folder.json') ? f.path.slice(0, -'/folder.json'.length) : f.path;
    } catch { /* broken files are reported by fromFiles */ }
  }
  return out;
}

/** [{ path, content }] → collection. Throws a readable error for broken files. */
export function fromFiles(files) {
  const byPath = new Map(files.map((f) => [f.path, f.content]));
  const parse = (path) => {
    try { return JSON.parse(byPath.get(path)); } catch (e) { throw new Error(`${path} isn't valid JSON: ${e.message}`); }
  };
  if (!byPath.has('collection.json')) throw new Error('This folder has no collection.json, so it isn\'t a Dispatch collection folder.');
  const top = parse('collection.json');
  const readDir = (prefix, order) => {
    // Direct children of this directory: request files and sub-folders with folder.json.
    const here = new Set();
    for (const p of byPath.keys()) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      const parts = rest.split('/');
      if (parts.length === 1 && rest.endsWith('.request.json')) here.add(rest);
      if (parts.length === 2 && parts[1] === 'folder.json') here.add(parts[0]);
    }
    const listed = (Array.isArray(order) ? order : []).filter((n) => here.has(n));
    const unlisted = [...here].filter((n) => !listed.includes(n)).sort();
    return [...listed, ...unlisted].map((name) => {
      if (name.endsWith('.request.json')) {
        const it = parse(`${prefix}${name}`);
        if (!it || typeof it !== 'object' || !it.request) throw new Error(`${prefix}${name} doesn't look like a request.`);
        it.id = it.id || uuid();
        return from(it, `${prefix}${name}`);
      }
      const meta = parse(`${prefix}${name}/folder.json`);
      const { order: childOrder, ...rest } = meta || {};
      return from({ id: uuid(), ...rest, name: rest.name || name, item: readDir(`${prefix}${name}/`, childOrder) }, `${prefix}${name}`);
    });
  };
  const { order, ...rest } = top;
  const collection = { ...rest, info: { ...(rest.info || {}), name: rest.info?.name || 'Untitled', schema: rest.info?.schema || SCHEMA_V21 }, item: readDir('', order) };
  return collection;
}

/** Only the files this format owns (others in the folder are left alone). */
export const ownFiles = (files) => files.filter((f) => f.path === 'collection.json' || f.path.endsWith('/folder.json') || f.path.endsWith('.request.json'));

/** Cheap fingerprint of a file set (FNV-1a), to notice edits made outside Dispatch. */
export function signature(files) {
  let h = 0x811c9dc5;
  for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const s = `${f.path}\u0000${f.content}\u0000`;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  }
  return h.toString(16);
}
