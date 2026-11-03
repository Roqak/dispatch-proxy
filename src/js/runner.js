// The collection runner: batch requests through the normal send pipeline,
// against optional data rows, with a results matrix and run history.

import { findItem, isFolder, itemId, exampleFromResponse } from './model.js';
import { Scope } from './vars.js';
import { execute } from './send.js';
import { bridge } from './bridge.js';
import * as S from './store.js';
import { state } from './store.js';

export const HISTORY_STORE = 'runner-history';

/** Requests under a collection root or folder, depth-first in display order. */
export function flattenRequests(root, folderId = null) {
  const found = folderId ? findItem(root, folderId) : null;
  // findItem returns the matched node; a folder's children are one level down.
  // The folder stays in `parents` so its scripts run for everything inside.
  const start = found ? (found.item?.item || []) : (root?.item || []);
  const seedParents = found ? [found.item] : [];
  const out = [];
  const walk = (items, parents) => {
    for (const it of items || []) {
      if (isFolder(it)) walk(it.item, [...parents, it]);
      else if (it.request) out.push({ item: it, parents });
    }
  };
  walk(start, seedParents);
  return out;
}

/** Accept a JSON array of objects, or CSV (first row = headers). Returns rows or null. */
export function parseDataFile(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) return [];
  try {
    const json = JSON.parse(trimmed);
    if (Array.isArray(json) && json.every((x) => x && typeof x === 'object')) return json.map((x) => Object.fromEntries(Object.entries(x).map(([k, v]) => [k, v == null ? '' : String(v)])));
  } catch { /* fall through to CSV */ }
  const lines = trimmed.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return null;
  const split = (line) => {
    const fields = []; let cur = ''; let q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
      else if (c === '"') q = true;
      else if (c === ',') { fields.push(cur); cur = ''; }
      else cur += c;
    }
    fields.push(cur);
    return fields;
  };
  const headers = split(lines[0]);
  const rows = [];
  for (const line of lines.slice(1)) {
    const cells = split(line);
    rows.push(Object.fromEntries(headers.map((hd, i) => [hd, cells[i] ?? ''])));
  }
  return rows;
}

const runnerScopes = ({ ws, env, collection, colOverlay, row, iteration }) => ({
  local: new Scope([], {}),
  data: row ? new Scope(Object.entries(row).map(([k, v]) => ({ key: k, value: String(v), enabled: true })), {}, null, `Data · iteration ${iteration}`) : undefined,
  environment: new Scope(env?.data?.values || [], env?.overlay || {}, null, env?.name),
  collection: new Scope(collection?.variable || [], colOverlay, null, collection?.info?.name),
  globals: new Scope(ws.globals.values || [], ws.globals.overlay || {}, null, 'Globals'),
});

/**
 * Run every request of a collection or folder. `iterations` applies when
 * there are no data rows; with rows, one iteration runs per row.
 * opts: { entry, folderId, iterations, rows, delayMs, onProgress, isStopped,
 *         env, send, parallel, saveExamples ('none' | 'failed'),
 *         ws (globals/overlays; defaults to the open workspace), recordHistory }
 * Cancellation: throws nothing — returns a cancelled summary.
 */
export async function runBatch({ entry, folderId = null, iterations = 1, rows = [], delayMs = 0, onProgress, isStopped, env, send, parallel = false, saveExamples = 'none', ws: wsIn, recordHistory = true }) {
  await S.ensureCollection(entry);
  const collection = entry.data;
  const ws = wsIn || state.ws || { globals: { values: [], overlay: {}, dirty: false }, colOverlays: {} };
  env = env === null ? null : (env ?? S.activeEnvEntry());
  if (env && !env.data) { try { await S.pullEnvironment(env); } catch { /* fall back to values */ } if (env && !env.data) env = null; }
  const reqs = flattenRequests(collection, folderId);
  if (!reqs.length) throw new Error('Nothing to run: this collection or folder has no requests.');

  const total = Math.max(1, rows.length || iterations);
  const allResults = [];
  const examplePlan = [];
  const started = Date.now();
  let stopped = false;
  let completedIterations = 0;

  const runOne = async (i, j, item, parents) => {
    const row = rows.length ? rows[i] : null;
    // Parallel iterations share nothing: overlays are cloned so scripts that
    // write current values never race.
    const cloneOverlays = parallel && i > 0;
    // Collection current values carry from request to request, as in Postman.
    const colOverlays = (ws.colOverlays = ws.colOverlays || {});
    const colOverlay = (colOverlays[entry.uid] = colOverlays[entry.uid] || {});
    const scopeSet = runnerScopes({
      ws: cloneOverlays ? ({ ...ws, globals: { ...ws.globals, overlay: { ...(ws.globals.overlay || {}) } } }) : ws,
      env: cloneOverlays && env ? { ...env, overlay: { ...(env.overlay || {}) } } : env,
      colOverlay: cloneOverlays ? { ...colOverlay } : colOverlay,
      collection, row, iteration: i + 1,
    });
    let result;
    try {
      result = await execute({
        item, parents, collection,
        scopes: scopeSet,
        settings: state.settings,
        send: send ?? ((r) => bridge.send(r)),
        libs: globalThis.chai ? { chai: globalThis.chai, CryptoJS: globalThis.CryptoJS, lodash: globalThis._, loadExtra: () => (typeof document === 'undefined' ? Promise.resolve() : import('./vendor.js').then((v) => v.loadVendor('pmlibs'))) } : undefined,
        run: { iteration: i, iterationCount: total },
      });
    } catch (e) {
      result = { error: String(e?.message || e), tests: [], logs: [], notes: [], scriptErrors: [] };
    }
    if (recordHistory) S.addHistory({
      name: item.name, method: item.request?.method || 'GET',
      url: result.outgoing?.url || '', status: result.response?.status ?? null,
      timeMs: result.response?.timeMs ?? null, error: result.error || null,
    });
    const res = {
      id: itemId(item), iteration: i + 1,
      name: item.name, method: item.request?.method || 'GET',
      status: result.response?.status ?? null,
      timeMs: result.response?.timeMs ?? null,
      testsTotal: result.tests?.length ?? 0,
      testsPassed: (result.tests || []).filter((x) => x.passed).length,
      failures: (result.tests || []).filter((x) => x.passed === false).map((x) => x.name),
      tests: (result.tests || []).map((x) => ({ name: x.name, passed: x.passed, skipped: !!x.skipped, error: x.error || null })),
      url: result.outgoing?.url || '',
      error: result.error ?? null,
      notes: result.notes ?? [],
      nextRequest: result.nextRequest,
    };
    if (parallel && result.nextRequest !== undefined) res.notes.push('setNextRequest is ignored when iterations run in parallel.');
    if (saveExamples === 'failed' && result.response && (res.status == null || res.status >= 400 || (result.tests || []).some((x) => x.passed === false))) {
      examplePlan.push({ item, response: result.response, result: res });
      res.exampleSaved = false; // set true once applied
    }
    onProgress?.(res);
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    return res;
  };

  if (parallel) {
    const tasks = [];
    for (let i = 0; i < total; i++) {
      for (let j = 0; j < reqs.length; j++) {
        if (isStopped?.()) { stopped = true; break; }
        tasks.push(runOne(i, j, reqs[j].item, reqs[j].parents).then((res) => { delete res.nextRequest; allResults.push(res); }));
      }
      if (stopped) break;
    }
    await Promise.all(tasks);
    completedIterations = stopped ? allResults.filter((r, idx, a2) => a2.findIndex((x) => x.iteration === r.iteration) === idx).length : total;
    allResults.sort((a2, b2) => a2.iteration - b2.iteration);
  } else {
    // setNextRequest can jump anywhere in the run; cap the steps so a loop can't run forever.
    const maxSteps = Math.max(1000, reqs.length * 100);
    for (let i = 0; i < total; i++) {
      const iterationResults = [];
      let j = 0;
      let steps = 0;
      while (j < reqs.length) {
        if (isStopped?.()) { stopped = true; break; }
        const res = await runOne(i, j, reqs[j].item, reqs[j].parents);
        iterationResults.push(res);
        const next = res.nextRequest;
        delete res.nextRequest;
        if (++steps >= maxSteps) { res.notes.push(`Stopped this iteration after ${steps} requests: setNextRequest looks like an endless loop.`); break; }
        if (next === undefined) { j++; continue; }
        if (next === null) break;
        const k = reqs.findIndex((r) => r.item.name === next || itemId(r.item) === next);
        if (k < 0) { res.notes.push(`setNextRequest("${next}"): no request with that name or id in this run, so the iteration stopped.`); break; }
        j = k;
      }
      // A stopped iteration still reports the requests that did run.
      allResults.push(...iterationResults);
      if (stopped) break;
      completedIterations = i + 1;
    }
  }

  // Apply saved examples into the collection, then push.
  if (saveExamples === 'failed' && examplePlan.length) {
    for (const { item, response, result } of examplePlan) {
      item.response = item.response || [];
      item.response.push(exampleFromResponse(item.request, { ...response, bodyText: (response.bodyText || '').slice(0, 100_000) },
        `Runner ${result.iteration}: ${response.status} ${response.statusText || ''}`.trim()));
      result.exampleSaved = true;
    }
    await S.collectionChanged(entry, { push: true }).catch(() => { entry.dirty = true; S.saveWorkspace(); });
  }

  const passed = allResults.filter((r) => !r.error && r.status && r.status < 400 && r.testsPassed === r.testsTotal).length;
  const failed = allResults.length - passed;
  return {
    at: started, collectionUid: entry.uid, collectionName: folderId ? findItem(collection, folderId)?.name || collection?.info?.name : collection?.info?.name,
    folderId: folderId || null, durationMs: Date.now() - started, iterations: completedIterations,
    requestsPerIteration: reqs.length, results: allResults, passed, failed, cancelled: stopped,
  };
}

export async function saveRunSummary(run) {
  const history = (await bridge.read(HISTORY_STORE)) || [];
  const summary = {
    at: run.at, name: run.collectionName, durationMs: run.durationMs,
    iterations: run.iterations, requests: run.requestsPerIteration,
    passed: run.passed, failed: run.failed, cancelled: run.cancelled || false,
  };
  await bridge.write(HISTORY_STORE, [summary, ...history].slice(0, 20));
}

export const loadRunHistory = async () => (await bridge.read(HISTORY_STORE)) || [];