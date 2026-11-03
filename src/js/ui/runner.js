// The runner tab: configuration (iterations, delay, data file), a live results
// matrix, and this workspace's recent runs.

import { h, icon, toast, errText, relTime, methodClass, methodLabel, modal } from './dom.js';
import * as S from '../store.js';
import { state, emit } from '../store.js';
import { bridge } from '../bridge.js';
import * as C from '../ctx.js';
import * as R from '../runner.js';
import { loadVault } from '../vault.js';

export function renderRunner(root, t) {
  const entry = S.collectionEntry(t.ref?.col);
  if (!entry?.data) {
    root.replaceChildren(h('div', { class: 'center-screen' }, h('p', { class: 'muted' }, 'This collection is gone.')));
    return;
  }
  const s0 = (t.runState = t.runState || {
    iterations: 1, delayMs: 0, dataText: '',
    running: false, stopped: false, run: null,
  });

  const historySlot = h('div', { class: 'runner-history-slot' });
  root.replaceChildren(h('div', { class: 'runner' }, buildConfig(), buildProgress(), buildResults(), historySlot));
  buildHistory().then((el) => { historySlot.replaceChildren(el); }).catch(() => {});

  // ---------- config ----------

  function dataHint() {
    if (!s0.dataText) return 'No data file — one iteration.';
    const rows = R.parseDataFile(s0.dataText);
    return rows?.length ? `${rows.length} rows → ${rows.length} iterations` : 'Data file looks empty or unsupported.';
  }

  function buildConfig() {
    const meta = R.flattenRequests(entry.data, t.ref?.item);
    const folder = t.ref?.item ? C.contextFor(t)?.collection && (entry.data && findFolderName(entry.data, t.ref.item)) : null;
    const label = `${entry.name}${folder ? ` / ${folder}` : ''}`;
    const iterInput = h('input', { class: 'input', type: 'number', min: 1, max: 10000, value: s0.iterations, onchange: () => { s0.iterations = Math.max(1, Math.min(10000, Number(iterInput.value) || 1)); } });
    const delayInput = h('input', { class: 'input', type: 'number', min: 0, max: 60000, value: s0.delayMs, onchange: () => { s0.delayMs = Math.max(0, Math.min(60000, Number(delayInput.value) || 0)); } });
    const activeEnvUid = S.activeEnvEntry()?.uid || '';
    if (!s0.envInit) { s0.envInit = true; s0.env = s0.env ?? activeEnvUid; }
    const envSel = h('select', { class: 'select', title: 'Environment for this run', onchange: () => { s0.env = envSel.value || null; } },
      h('option', { value: '', selected: !s0.env }, 'None'),
      (S.state.ws?.environments || []).map((e) => h('option', { value: e.uid, selected: e.uid === s0.env }, e.name)));
    const parallelChk = h('input', { type: 'checkbox', checked: !!s0.parallel, onchange: () => { s0.parallel = parallelChk.checked; } });
    const examplesSel = h('select', { class: 'select', title: 'Keep responses as examples', onchange: () => { s0.saveExamples = examplesSel.value; } },
      h('option', { value: 'none', selected: (s0.saveExamples || 'none') === 'none' }, "Don't save"),
      h('option', { value: 'failed', selected: s0.saveExamples === 'failed' }, 'Save responses of failed requests'));
    const dataLabel = h('span', { class: 'muted', style: { fontSize: '12px' } }, dataHint());
    const dataBtn = h('button', {
      class: 'btn sm', title: 'CSV (first row = headers) or a JSON array of objects: every {{variable}} resolves from the row; rows.length iterations run.',
      onclick: async () => {
        const f = await bridge.openTextFile();
        if (!f?.content) return;
        const rows = R.parseDataFile(f.content);
        if (!rows) { toast('Data file: empty or not a JSON array / CSV with two rows.', { error: true }); return; }
        s0.dataText = f.content;
        dataLabel.textContent = dataHint();
        toast(`Data file loaded: ${rows.length} iteration${rows.length === 1 ? '' : 's'}`);
      },
    }, icon('upload'), 'Data file…');
    const clearData = h('button', { class: 'icon-btn sm', title: 'Remove the data file', onclick: () => { s0.dataText = ''; dataLabel.textContent = dataHint(); } }, icon('x'));
    const editData = h('button', {
      class: 'icon-btn sm', title: 'Edit the data rows inline', disabled: !s0.dataText,
      onclick: () => {
        const box = h('textarea', { class: 'input', style: { width: '100%', minHeight: '220px', fontFamily: 'var(--mono, monospace)', fontSize: '12px' } }, s0.dataText);
        modal({
          title: 'Data variables (JSON array or CSV, first row = headers)',
          body: box,
          actions: [
            { label: 'Cancel', onClick: () => {} },
            { label: 'Save', primary: true, onClick: () => {
              const rows = R.parseDataFile(box.value);
              if (box.value.trim() && !rows) { toast('Not a JSON array or CSV with headers + rows', { error: true }); return false; }
              s0.dataText = box.value;
              dataLabel.textContent = dataHint();
            } },
          ],
        });
      },
    }, icon('edit'));
    return h('div', { class: 'runner-config' },
      h('div', { class: 'row', style: { alignItems: 'center' } },
        icon('play', 'ico'), h('div', { class: 'grow' }, h('b', null, label), h('div', { class: 'muted', style: { fontSize: '12px' } }, `${meta.length} request${meta.length === 1 ? '' : 's'}`)),
        h('button', { class: 'btn primary', disabled: s0.running, onclick: () => start() }, icon('play'), 'Run'),
        h('button', { class: 'btn danger', disabled: !s0.running, onclick: () => { s0.stopped = true; } }, icon('stop'), 'Stop')),
      h('div', { class: 'form-grid', style: { marginTop: '10px' } },
        h('label', null, 'Iterations'), iterInput,
        h('label', null, 'Delay between iterations (ms)'), delayInput,
        h('label', null, 'Environment'), envSel,
        h('label', null, 'Run iterations'), h('div', { class: 'row' }, h('span', null, parallelChk), h('span', { class: 'hint', style: { margin: 0 } }, 'All at once (isolated copies)')),
        h('label', null, 'Failed responses'), examplesSel,
        h('label', null, 'Data variables'), h('div', { class: 'row' }, dataBtn, editData, clearData, dataLabel)),
      h('p', { class: 'hint', style: { marginTop: '8px' } }, 'Collection and folder scripts run before each request. Iterations share variables unless parallel; data variables win over environment ones.'),
    );
  }

  // ---------- progress ----------

  function buildProgress() {
    return h('div', { class: 'runner-progress' },
      h('progress', { max: 100, value: s0.running && s0.run?.total ? Math.round((s0.run.done / s0.run.total) * 100) : 100, style: { flex: '1' } }),
      h('span', { class: 'muted', style: { fontSize: '12px' } },
        s0.running ? `running ${s0.run.done} / ${s0.run.total}`
          : s0.run?.summary ? `${s0.run.summary.passed} passed, ${s0.run.summary.failed} failed in ${(s0.run.summary.durationMs / 1000).toFixed(1)}s`
            : 'Ready.'));
  }

  // ---------- results ----------

  function buildResults() {
    const results = s0.run?.summary?.results || [];
    if (!results.length) return h('div', { class: 'runner-results' }, h('p', { class: 'muted', style: { padding: '20px 0' } }, 'No runs yet. Configure above and press Run.'));
    const grouped = new Map();
    for (const r of results) {
      if (!grouped.has(r.iteration)) grouped.set(r.iteration, []);
      grouped.get(r.iteration).push(r);
    }
    const summary = h('div', { class: 'runner-summary' },
      h('span', { class: ['chip', s0.run.summary.failed ? 'bad' : 'ok'] }, `${s0.run.summary.passed} passed`),
      s0.run.summary.failed ? h('span', { class: 'chip bad' }, `${s0.run.summary.failed} failed`) : null,
      h('span', { class: 'chip' }, `${(s0.run.summary.durationMs / 1000).toFixed(1)}s`),
      s0.run.summary.cancelled ? h('span', { class: 'chip warn' }, 'stopped early') : null);
    return h('div', { class: 'runner-results' }, summary, [...grouped.entries()].map(([iteration, rows]) => h('div', {},
      (rows.length > 1 || s0.run.summary.iterations > 1) ? h('h4', { class: 'muted', style: { margin: '12px 0 4px' } }, `Iteration ${iteration}`) : null,
      rows.map(rowView))));
  }

  function rowView(r) {
    const ok = !r.error && r.status != null && r.status < 400 && r.testsPassed === r.testsTotal;
    const extra = [];
    if (r.status != null) extra.push(`${r.status} · ${r.timeMs ?? 0}ms`);
    if (r.testsTotal) extra.push(`${r.testsPassed}/${r.testsTotal} tests`);
    const details = [];
    if (r.error) details.push(h('div', { class: 'test-fail' }, h('b', null, 'Error'), r.error));
    for (const f of r.failures || []) details.push(h('div', { class: 'test-fail' }, h('b', null, 'Test failed'), f));
    if (r.notes?.length) for (const n of r.notes) details.push(h('div', { class: 'muted', style: { fontSize: '11px' } }, n));
    return h('details', { class: 'runner-row' },
      h('summary', null,
        h('span', { class: ['method', methodClass(r.method)] }, methodLabel(r.method)),
        h('span', { class: 'grow', style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, r.name),
        ...extra.map((x) => h('span', { class: 'muted', style: { fontSize: '11px' } }, x)),
        ok ? h('span', { class: 'chip ok' }, '✓') : h('span', { class: 'chip bad' }, '✗')),
      h('div', { class: 'runner-row-detail' }, ...details,
        r.id ? h('button', { class: 'btn sm', style: { margin: '6px 0' }, onclick: () => C.openItem(entry, r.id) }, icon('send'), 'Open request') : null));
  }

  // ---------- history ----------

  async function buildHistory() {
    const history = await R.loadRunHistory();
    if (!history.length) return h('span');
    return h('div', { class: 'runner-history' },
      h('h4', { class: 'muted', style: { margin: '14px 0 6px' } }, 'Recent runs'),
      history.slice(0, 8).map((run) => h('div', { class: 'row', style: { padding: '2px 0' } },
        h('span', { class: 'muted', style: { fontSize: '12px' } }, relTime(run.at)),
        h('span', { class: 'grow', style: { fontSize: '12px' } }, run.name),
        h('span', { class: ['chip', run.failed ? 'bad' : 'ok'] }, `${run.passed}✓ ${run.failed}✗`),
        h('span', { class: 'muted', style: { fontSize: '11px' } }, `${(run.durationMs / 1000).toFixed(1)}s`))));
  }

  // ---------- running ----------

  async function start() {
    if (s0.running) return;
    let rows = [];
    if (s0.dataText) {
      rows = R.parseDataFile(s0.dataText);
      if (!rows) { toast('Data file: empty or not a JSON array / CSV with two rows.', { error: true }); return; }
    }
    const total = (rows.length || s0.iterations) * R.flattenRequests(entry.data, t.ref?.item).length;
    s0.running = true; s0.stopped = false;
    s0.run = { done: 0, total, summary: null };
    emit('tabs', 'main');
    try {
      await loadVault().catch(() => {});
      const summary = await R.runBatch({
        entry, folderId: t.ref?.item ?? null,
        iterations: s0.iterations, rows, delayMs: s0.delayMs,
        env: s0.env === undefined ? undefined : (S.state.ws?.environments || []).find((e) => e.uid === s0.env) || null,
        parallel: !!s0.parallel, saveExamples: s0.saveExamples || 'none',
        isStopped: () => s0.stopped,
        onProgress: () => { s0.run.done++; emit('main'); },
      });
      s0.run.summary = summary;
      await R.saveRunSummary(summary);
      toast(summary.cancelled ? `Stopped early — ${summary.passed} passed, ${summary.failed} failed so far` : `${summary.passed} passed, ${summary.failed} failed in ${(summary.durationMs / 1000).toFixed(1)}s`);
    } catch (e) {
      toast(errText(e), { error: true });
    } finally {
      s0.running = false;
      emit('main');
    }
  }
}

function findFolderName(coll, id) {
  const stack = [...(coll?.item || [])];
  while (stack.length) {
    const it = stack.shift();
    if (it?.id === id) return it.name;
    if (Array.isArray(it?.item)) stack.push(...it.item);
  }
  return undefined;
}