// Postman cloud operations, using only the public Postman API.

import { bridge } from './bridge.js';
import { forUpload, ensureIds, SCHEMA_V21 } from './model.js';

// The desktop client reports an expired Dispatch-server session with this exact wording.
const EXPIRED = 'Your Dispatch server session has expired';
let authLost = null;
/** Lets the store watch (from activeProfile) for expired server sessions and offer "Sign in again". */
export const onAuthLost = (fn) => { authLost = fn; };

const api = async (m, p, b) => {
  try {
    return await bridge.postman(m, p, b);
  } catch (e) {
    if (String(e?.message ?? e).startsWith(EXPIRED)) authLost?.();
    throw e;
  }
};
const q = encodeURIComponent;

export let callsRemaining = null;
const note = (r) => {
  if (r && r._rateLimitRemainingMonth != null) callsRemaining = Number(r._rateLimitRemainingMonth);
  return r;
};

export async function listWorkspaces() {
  const r = note(await api('GET', '/workspaces'));
  return (r.workspaces || []).map((w) => ({ id: w.id, name: w.name, type: w.type }));
}

export async function listCollections(wsId) {
  const r = note(await api('GET', `/collections?workspace=${q(wsId)}`));
  return (r.collections || []).map((c) => ({ uid: c.uid, id: c.id, name: c.name, updatedAt: c.updatedAt }));
}

export async function getCollection(uid) {
  const r = note(await api('GET', `/collections/${q(uid)}`));
  return ensureIds(r.collection);
}

export async function putCollection(uid, collection) {
  const r = note(await api('PUT', `/collections/${q(uid)}`, { collection: forUpload(collection) }));
  return r.collection;
}

export async function createCollection(wsId, collection) {
  const body = forUpload(collection);
  body.info.schema = SCHEMA_V21;
  const r = note(await api('POST', `/collections?workspace=${q(wsId)}`, { collection: body }));
  return r.collection; // { id, name, uid }
}

export async function listEnvironments(wsId) {
  const r = note(await api('GET', `/environments?workspace=${q(wsId)}`));
  return (r.environments || []).map((e) => ({ uid: e.uid, id: e.id, name: e.name, updatedAt: e.updatedAt }));
}

export async function getEnvironment(uid) {
  const r = note(await api('GET', `/environments/${q(uid)}`));
  return r.environment;
}

const cleanValues = (values) => (values || []).filter((v) => v.key).map((v) => ({ key: v.key, value: v.value ?? '', enabled: v.enabled !== false, type: v.type || 'default' }));

export async function putEnvironment(uid, env) {
  return note(await api('PUT', `/environments/${q(uid)}`, { environment: { name: env.name, values: cleanValues(env.values) } })).environment;
}

export async function createEnvironment(wsId, env) {
  return note(await api('POST', `/environments?workspace=${q(wsId)}`, { environment: { name: env.name, values: cleanValues(env.values) } })).environment;
}

/** Returns the values, or null when this workspace doesn't offer globals. Other errors are thrown. */
export async function getGlobals(wsId) {
  try {
    const r = note(await api('GET', `/workspaces/${q(wsId)}/global-variables`));
    return r.values || [];
  } catch (e) {
    const msg = String(e?.message || e);
    if (/couldn't find|doesn't have permission/i.test(msg)) return null;
    throw e;
  }
}

export async function putGlobals(wsId, values) {
  return note(await api('PUT', `/workspaces/${q(wsId)}/global-variables`, { values: cleanValues(values) }));
}
