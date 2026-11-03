// GraphQL helpers: introspection, a light schema model, field completion at the
// cursor, and validation of selections against the schema.

export const INTROSPECTION_QUERY = `query IntrospectionQuery {
  __schema {
    queryType { name }
    mutationType { name }
    subscriptionType { name }
    types {
      kind name description
      fields(includeDeprecated: true) {
        name description isDeprecated deprecationReason
        args { name description defaultValue type { ...TypeRef } }
        type { ...TypeRef }
      }
      inputFields { name description defaultValue type { ...TypeRef } }
      enumValues(includeDeprecated: true) { name description isDeprecated }
      possibleTypes { name }
    }
  }
}
fragment TypeRef on __Type {
  kind name
  ofType { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } } } }
}`;

const typeString = (t) => (!t ? '?' : t.kind === 'NON_NULL' ? `${typeString(t.ofType)}!` : t.kind === 'LIST' ? `[${typeString(t.ofType)}]` : t.name);
const namedType = (t) => { while (t && !t.name) t = t.ofType; return t?.name || null; };

/** Introspection result (with or without the { data } wrapper) → schema model. */
export function buildSchema(result) {
  const s = result?.data?.__schema || result?.__schema;
  if (!s?.types) {
    const msg = result?.errors?.[0]?.message;
    throw new Error(msg ? `The server rejected the schema query: ${msg}` : "That response isn't a GraphQL introspection result. Is introspection turned on?");
  }
  const types = new Map();
  for (const t of s.types) {
    types.set(t.name, {
      name: t.name, kind: t.kind, description: t.description || '',
      fields: new Map((t.fields || []).map((f) => [f.name, {
        name: f.name, description: f.description || '', deprecated: !!f.isDeprecated, type: namedType(f.type), typeStr: typeString(f.type),
        args: (f.args || []).map((a) => ({ name: a.name, typeStr: typeString(a.type), required: a.type?.kind === 'NON_NULL' && a.defaultValue == null, description: a.description || '' })),
      }])),
      inputFields: (t.inputFields || []).map((f) => ({ name: f.name, typeStr: typeString(f.type) })),
      enumValues: (t.enumValues || []).map((e) => e.name),
      possibleTypes: (t.possibleTypes || []).map((p) => p.name),
    });
  }
  return { types, query: s.queryType?.name || null, mutation: s.mutationType?.name || null, subscription: s.subscriptionType?.name || null };
}

const isComposite = (schema, name) => ['OBJECT', 'INTERFACE', 'UNION'].includes(schema.types.get(name)?.kind);
const fieldsOf = (schema, name) => {
  const t = schema.types.get(name);
  const own = [...(t?.fields?.values() || [])];
  return [...own, { name: '__typename', typeStr: 'String!', type: 'String', args: [], description: 'The name of the object type' }];
};

// ---------- tokenizer ----------

function tokenize(src) {
  const out = [];
  let i = 0;
  let line = 1;
  let lineStart = 0;
  const push = (type, value, start) => out.push({ type, value, start, end: i, line, col: start - lineStart + 1 });
  while (i < src.length) {
    const c = src[i];
    if (c === '\n') { i++; line++; lineStart = i; continue; }
    if (/[\s,﻿]/.test(c)) { i++; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
    const start = i;
    if (src.startsWith('"""', i)) {
      i += 3;
      while (i < src.length && !src.startsWith('"""', i)) { if (src[i] === '\n') { line++; lineStart = i + 1; } i++; }
      i = Math.min(src.length, i + 3);
      push('string', src.slice(start, i), start);
      continue;
    }
    if (c === '"') {
      i++;
      while (i < src.length && src[i] !== '"' && src[i] !== '\n') { if (src[i] === '\\') i++; i++; }
      i++;
      push('string', src.slice(start, i), start);
      continue;
    }
    if (src.startsWith('...', i)) { i += 3; push('punct', '...', start); continue; }
    if (/[{}()[\]:=!@$|&]/.test(c)) { i++; push('punct', c, start); continue; }
    if (/[_A-Za-z]/.test(c)) { while (i < src.length && /[_0-9A-Za-z]/.test(src[i])) i++; push('name', src.slice(start, i), start); continue; }
    if (/[-0-9]/.test(c)) { i++; while (i < src.length && /[0-9.eE+-]/.test(src[i])) i++; push('number', src.slice(start, i), start); continue; }
    i++; // anything else is skipped; the server reports real syntax errors
  }
  return out;
}

// ---------- walking selections ----------

/**
 * Walk the document, calling visit(kind, info) for each selection with the
 * parent type it was resolved against. Returns the selection-set stack
 * (innermost last) at `cursor`, used for completion.
 */
function walk(src, schema, visit, cursor = -1) {
  const toks = tokenize(src);
  let p = 0;
  let atCursor = null;
  const peek = (o = 0) => toks[p + o];
  const skipBalanced = (open, close) => {
    if (peek()?.value !== open) return;
    let depth = 0;
    do { const t = toks[p++]; if (t?.value === open) depth++; else if (t?.value === close) depth--; } while (p < toks.length && depth > 0);
  };
  const skipDirectives = () => { while (peek()?.value === '@') { p += 2; skipBalanced('(', ')'); } };

  const selectionSet = (typeName, stack) => {
    const open = toks[p++]; // {
    const here = [...stack, typeName];
    while (p < toks.length && peek().value !== '}') {
      const t = peek();
      if (cursor >= 0 && t.start >= cursor && !atCursor) atCursor = here;
      if (t.value === '...') {
        p++;
        if (peek()?.value === 'on') {
          p++;
          const cond = toks[p++];
          if (cond && !schema.types.has(cond.value)) visit('error', { message: `Unknown type "${cond.value}"`, tok: cond });
          skipDirectives();
          if (peek()?.value === '{') selectionSet(schema.types.has(cond?.value) ? cond.value : null, here);
        } else if (peek()?.value === '{' || peek()?.value === '@') {
          skipDirectives();
          if (peek()?.value === '{') selectionSet(typeName, here);
        } else {
          p++; // ...FragmentName
          skipDirectives();
        }
        continue;
      }
      if (t.type !== 'name') { p++; continue; }
      // alias: name
      let nameTok = t;
      p++;
      if (peek()?.value === ':') { p++; nameTok = toks[p++] || nameTok; }
      const field = typeName && schema.types.has(typeName) ? fieldsOf(schema, typeName).find((f) => f.name === nameTok.value) : null;
      if (typeName && schema.types.has(typeName) && !field) visit('error', { message: `Unknown field "${nameTok.value}" on type "${typeName}"`, tok: nameTok });
      if (peek()?.value === '(') {
        const argStart = p;
        skipBalanced('(', ')');
        if (field) {
          // Argument names are the names directly followed by ":" at depth 1.
          let depth = 0;
          for (let k = argStart; k < p; k++) {
            const v = toks[k].value;
            if (v === '(' || v === '[' || v === '{') depth++;
            else if (v === ')' || v === ']' || v === '}') depth--;
            else if (depth === 1 && toks[k].type === 'name' && toks[k + 1]?.value === ':' && toks[k - 1]?.value !== '$' && !field.args.some((a) => a.name === v)) {
              visit('error', { message: `Unknown argument "${v}" on field "${field.name}"`, tok: toks[k] });
            }
          }
        }
      }
      skipDirectives();
      if (field) {
        const missing = field.args.filter((a) => a.required);
        if (missing.length) {
          const given = new Set();
          // recompute given args cheaply by scanning back over the args we skipped
          for (let k = toks.indexOf(nameTok) + 1; k < p && toks[k].value !== '{'; k++) if (toks[k].type === 'name' && toks[k + 1]?.value === ':') given.add(toks[k].value);
          for (const a of missing) if (!given.has(a.name)) visit('error', { message: `Field "${field.name}" needs argument "${a.name}: ${a.typeStr}"`, tok: nameTok, warn: true });
        }
      }
      if (peek()?.value === '{') {
        if (field && !isComposite(schema, field.type)) visit('error', { message: `"${field.name}" is a ${field.typeStr} and can't have a selection`, tok: nameTok });
        selectionSet(field && isComposite(schema, field.type) ? field.type : field ? null : null, here);
      } else if (field && isComposite(schema, field.type)) {
        visit('error', { message: `"${field.name}" returns ${field.typeStr}; pick some of its fields in { }`, tok: nameTok });
      }
    }
    const close = toks[p++];
    if (cursor >= 0 && !atCursor && open.start < cursor && (!close || cursor <= close.start)) atCursor = here;
  };

  while (p < toks.length) {
    const t = peek();
    if (t.value === '{') { selectionSet(schema.query, []); continue; }
    if (t.type === 'name' && ['query', 'mutation', 'subscription'].includes(t.value)) {
      p++;
      const root = schema[t.value];
      if (!root) visit('error', { message: `This API has no ${t.value} type`, tok: t });
      while (p < toks.length && peek().value !== '{') { if (peek().value === '(') skipBalanced('(', ')'); else p++; }
      if (peek()?.value === '{') selectionSet(root, []);
      continue;
    }
    if (t.type === 'name' && t.value === 'fragment') {
      p += 2; // fragment Name
      if (peek()?.value === 'on') p++;
      const cond = toks[p++];
      if (cond && !schema.types.has(cond.value)) visit('error', { message: `Unknown type "${cond.value}"`, tok: cond });
      skipDirectives();
      if (peek()?.value === '{') selectionSet(schema.types.has(cond?.value) ? cond.value : null, []);
      continue;
    }
    p++;
  }
  return atCursor;
}

/** Problems in `query` against `schema`: [{ message, line, col, warn }]. */
export function validateQuery(query, schema) {
  if (!schema) return [];
  const errors = [];
  walk(query, schema, (kind, info) => { if (kind === 'error') errors.push({ message: info.message, line: info.tok.line, col: info.tok.col, warn: !!info.warn }); });
  return errors;
}

/** Field suggestions at `cursor`: { type, prefix, from, items: [{ name, typeStr, description, args }] }. */
export function completeAt(query, cursor, schema) {
  if (!schema) return null;
  const before = query.slice(0, cursor);
  const word = /[_A-Za-z][_0-9A-Za-z]*$/.exec(before)?.[0] || '';
  // Inside an argument list or a string, field names don't belong.
  const opens = (before.match(/\(/g) || []).length - (before.match(/\)/g) || []).length;
  if (opens > 0 || ((before.match(/"/g) || []).length % 2 === 1)) return null;
  const stack = walk(query, schema, () => {}, cursor - word.length);
  let typeName = stack?.[stack.length - 1];
  if (!stack) {
    if (/^\s*$/.test(before) || /(^|\})\s*$/.test(before)) return { type: null, prefix: word, from: cursor - word.length, items: ['query', 'mutation', 'subscription', 'fragment'].filter((k) => k.startsWith(word) && (k === 'fragment' || schema[k])).map((k) => ({ name: k, typeStr: 'keyword', description: '' })) };
    return null;
  }
  if (!typeName || !schema.types.has(typeName)) return null;
  const items = fieldsOf(schema, typeName).filter((f) => f.name.toLowerCase().startsWith(word.toLowerCase()) && f.name !== word)
    .sort((a, b) => (a.deprecated - b.deprecated) || (a.name.startsWith('__') - b.name.startsWith('__')) || a.name.localeCompare(b.name));
  return { type: typeName, prefix: word, from: cursor - word.length, items };
}

/** The text to insert for a completion: arguments for required args, braces for objects. */
export function insertionFor(item, schema) {
  if (item.typeStr === 'keyword') return `${item.name} `;
  const req = (item.args || []).filter((a) => a.required);
  const args = req.length ? `(${req.map((a) => `${a.name}: `).join(', ')})` : '';
  return `${item.name}${args}${item.type && isComposite(schema, item.type) ? ' {\n  \n}' : ''}`;
}
