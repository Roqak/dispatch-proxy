#!/usr/bin/env node
// Dispatch CLI: run a collection from a terminal or CI, like Postman's Newman.
//
//   node bin/dispatch.mjs run <collection.json | collection-folder> [options]
//
// It uses the same runner, script sandbox (pm API, chai, CryptoJS, lodash) and
// variable rules as the app, and exits non-zero when anything fails.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, '..', 'src');
const require = createRequire(import.meta.url);

const HELP = `Dispatch CLI

Usage:
  dispatch run <collection> [options]

<collection> is a Postman collection (v2.0/v2.1), an OpenAPI/Insomnia/HAR file,
or a folder saved by Dispatch's "Save to a folder (Git)".

Options:
  -e, --environment <file>   Postman environment JSON
  -g, --globals <file>       Postman globals JSON
  -d, --data <file>          Data file (JSON array or CSV); one iteration per row
  -n, --iterations <n>       Iterations when there's no data file (default 1)
      --folder <name>        Run only this folder (name or id); repeatable
      --env-var <k=v>        Set an environment variable; repeatable
      --global-var <k=v>     Set a global variable; repeatable
      --vault-from-env       Resolve {{vault:NAME}} from environment variable NAME
      --delay <ms>           Wait between requests
      --timeout <ms>         Per-request timeout (default 30000)
      --insecure             Don't verify TLS certificates
      --no-redirects         Don't follow redirects
      --bail                 Stop at the first failure
  -r, --reporters <list>     cli, json, junit (default cli)
      --out <dir>            Where json/junit reports go (default ./dispatch-reports)
      --silent               No console output (reports and exit code only)
  -h, --help                 Show this help

Exit code: 0 when every request succeeded and every test passed, 1 otherwise,
2 for usage errors.`;

// ---------- arguments ----------

export function parseArgs(argv) {
  const o = { cmd: null, target: null, folders: [], envVars: [], globalVars: [], reporters: ['cli'], iterations: 1, delay: 0, timeout: 30000, out: 'dispatch-reports', insecure: false, redirects: true, bail: false, silent: false, vaultFromEnv: false };
  const a = [...argv];
  const need = (flag) => { const v = a.shift(); if (v === undefined || v.startsWith('-') && v !== '-') throw new Error(`${flag} needs a value`); return v; };
  const kv = (flag, v) => { const i = v.indexOf('='); if (i < 1) throw new Error(`${flag} expects key=value`); return [v.slice(0, i), v.slice(i + 1)]; };
  while (a.length) {
    const t = a.shift();
    switch (t) {
      case '-h': case '--help': o.help = true; break;
      case '-e': case '--environment': o.environment = need(t); break;
      case '-g': case '--globals': o.globals = need(t); break;
      case '-d': case '--data': case '--iteration-data': o.data = need(t); break;
      case '-n': case '--iterations': case '--iteration-count': o.iterations = Math.max(1, parseInt(need(t), 10) || 1); break;
      case '--folder': o.folders.push(need(t)); break;
      case '--env-var': o.envVars.push(kv(t, need(t))); break;
      case '--global-var': o.globalVars.push(kv(t, need(t))); break;
      case '--vault-from-env': o.vaultFromEnv = true; break;
      case '--delay': case '--delay-request': o.delay = Math.max(0, parseInt(need(t), 10) || 0); break;
      case '--timeout': case '--timeout-request': o.timeout = Math.max(1, parseInt(need(t), 10) || 30000); break;
      case '-k': case '--insecure': o.insecure = true; break;
      case '--no-redirects': case '--ignore-redirects': o.redirects = false; break;
      case '--bail': o.bail = true; break;
      case '-r': case '--reporters': o.reporters = need(t).split(',').map((x) => x.trim()).filter(Boolean); break;
      case '--out': o.out = need(t); break;
      case '--silent': o.silent = true; break;
      default:
        if (t.startsWith('-')) throw new Error(`Unknown option ${t}`);
        if (!o.cmd) o.cmd = t;
        else if (!o.target) o.target = t;
        else throw new Error(`Unexpected argument ${t}`);
    }
  }
  for (const r of o.reporters) if (!['cli', 'json', 'junit'].includes(r)) throw new Error(`Unknown reporter "${r}" (use cli, json, junit)`);
  return o;
}

// ---------- loading ----------

async function loadCollection(target) {
  const { convertImport } = await import(path.join(src, 'js/importers.js'));
  const stat = fs.statSync(target, { throwIfNoEntry: false });
  if (!stat) throw new Error(`Can't find ${target}`);
  if (stat.isDirectory()) {
    const { fromFiles, ownFiles } = await import(path.join(src, 'js/gitfs.js'));
    const files = [];
    const walk = (dir, rel) => {
      for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
        if (d.name.startsWith('.') || d.name === 'node_modules') continue;
        const p = path.join(dir, d.name);
        const r = rel ? `${rel}/${d.name}` : d.name;
        if (d.isDirectory()) walk(p, r);
        else if (d.name.endsWith('.json')) files.push({ path: r, content: fs.readFileSync(p, 'utf8') });
      }
    };
    walk(target, '');
    return fromFiles(ownFiles(files));
  }
  const text = fs.readFileSync(target, 'utf8');
  const yaml = /^\s*[{[]/.test(text) ? undefined : require(path.join(src, 'vendor/js-yaml.min.js'));
  const parsed = convertImport(text, { fileName: target, yaml });
  if (parsed.kind !== 'collection') throw new Error(`${target} is an environment, not a collection`);
  return parsed.data;
}

function loadValues(file, label) {
  if (!file) return [];
  let json;
  try { json = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new Error(`Couldn't read the ${label} file ${file}: ${e.message}`); }
  const values = json.values || json.environment?.values || json.globals?.values || [];
  return values.filter((v) => v && v.key && v.enabled !== false).map((v) => ({ key: v.key, value: v.value ?? '', type: v.type || 'default', enabled: true }));
}

const upsert = (values, pairs) => { for (const [key, value] of pairs) { const row = values.find((v) => v.key === key); if (row) row.value = value; else values.push({ key, value, type: 'default', enabled: true }); } return values; };

// ---------- sending (Node's fetch) ----------

const BINARY = /^(image|audio|video)\/|application\/(pdf|zip|octet-stream)/i;

export function makeSend({ timeout, redirects }) {
  return async (o) => {
    const started = performance.now();
    const headers = new Headers();
    for (const h of o.headers || []) if (h.key?.trim()) headers.append(h.key.trim(), h.value ?? '');
    if (!headers.has('user-agent')) headers.set('user-agent', 'Dispatch-CLI');
    let body;
    const b = o.body || { mode: 'none' };
    if (b.mode === 'raw') body = b.content;
    else if (b.mode === 'urlencoded') body = new URLSearchParams(b.fields.map((f) => [f.key, f.value]));
    else if (b.mode === 'formdata') {
      body = new FormData();
      for (const f of b.fields) {
        if (f.kind === 'file') { if (f.src) body.append(f.key, new Blob([fs.readFileSync(f.src)]), path.basename(f.src)); }
        else body.append(f.key, f.value ?? '');
      }
      headers.delete('content-type'); // fetch sets the multipart boundary
    } else if (b.mode === 'file') body = fs.readFileSync(b.path);
    const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(o.url) ? o.url : `http://${o.url}`;
    if (url.includes('{{')) throw new Error(`The URL still has an undefined variable: ${url}`);
    const res = await fetch(url, { method: o.method, headers, body, redirect: redirects ? 'follow' : 'manual', signal: AbortSignal.timeout(timeout) })
      .catch((e) => { throw new Error(e.name === 'TimeoutError' ? `Timed out after ${timeout} ms` : `Couldn't connect: ${e.cause?.message || e.message}`); });
    const buf = Buffer.from(await res.arrayBuffer());
    const contentType = res.headers.get('content-type') || '';
    const text = BINARY.test(contentType) ? null : buf.toString('utf8');
    return {
      status: res.status, statusText: res.statusText, url: res.url || url, contentType,
      headers: [...res.headers].map(([key, value]) => ({ key, value })),
      bodyText: text, bodyBase64: text == null ? buf.toString('base64') : null,
      size: buf.length, timeMs: Math.round(performance.now() - started),
    };
  };
}

// ---------- reporting ----------

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const green = c(32); const red = c(31); const dim = c(2); const bold = c(1); const yellow = c(33);

const ok = (r) => !r.error && r.status != null && r.status < 400 && r.testsPassed === r.testsTotal;

export function junit(run) {
  const esc = (s) => String(s ?? '').replace(/[<>&"']/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[ch]));
  const suites = run.results.map((r) => {
    const cases = [];
    if (r.error || r.status == null || r.status >= 400) cases.push(`    <testcase name="${esc(`${r.method} ${r.name} responds`)}" classname="${esc(r.name)}" time="${(r.timeMs || 0) / 1000}"><failure message="${esc(r.error || `HTTP ${r.status}`)}"/></testcase>`);
    for (const t of r.tests || []) {
      const inner = t.skipped ? '<skipped/>' : t.passed === false ? `<failure message="${esc(t.error || 'failed')}"/>` : '';
      cases.push(`    <testcase name="${esc(t.name)}" classname="${esc(r.name)}" time="0">${inner}</testcase>`);
    }
    if (!cases.length) cases.push(`    <testcase name="${esc(`${r.method} ${r.name}`)}" classname="${esc(r.name)}" time="${(r.timeMs || 0) / 1000}"/>`);
    const failures = cases.filter((x) => x.includes('<failure')).length;
    return `  <testsuite name="${esc(`${r.name} (iteration ${r.iteration})`)}" tests="${cases.length}" failures="${failures}" skipped="${cases.filter((x) => x.includes('<skipped')).length}" time="${(r.timeMs || 0) / 1000}">\n${cases.join('\n')}\n  </testsuite>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="${esc(run.collectionName)}" time="${run.durationMs / 1000}">\n${suites.join('\n')}\n</testsuites>\n`;
}

// ---------- main ----------

export async function main(argv, { stdout = (s) => process.stdout.write(s) } = {}) {
  let o;
  try { o = parseArgs(argv); } catch (e) { stdout(`${red('error')} ${e.message}\n\n${HELP}\n`); return 2; }
  if (o.help || !o.cmd) { stdout(`${HELP}\n`); return o.help ? 0 : 2; }
  if (o.cmd !== 'run' || !o.target) { stdout(`${red('error')} expected: dispatch run <collection>\n`); return 2; }
  if (o.insecure) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  const log = o.silent ? () => {} : stdout;

  globalThis.chai = require(path.join(src, 'vendor/chai.min.js'));
  globalThis.CryptoJS = require(path.join(src, 'vendor/crypto-js.min.js'));
  globalThis._ = require(path.join(src, 'vendor/lodash.min.js'));
  // cheerio, moment, xml2js, tv4, ajv, csv-parse and Node built-ins for require() in scripts.
  require(path.join(src, 'vendor/postman-libs.min.js'));
  const { runBatch, parseDataFile } = await import(path.join(src, 'js/runner.js'));
  const { findItem } = await import(path.join(src, 'js/model.js'));
  const { setVault } = await import(path.join(src, 'js/vars.js'));

  let collection;
  let rows = [];
  let envValues;
  let globalValues;
  try {
    collection = await loadCollection(o.target);
    envValues = upsert(loadValues(o.environment, 'environment'), o.envVars);
    globalValues = upsert(loadValues(o.globals, 'globals'), o.globalVars);
    if (o.data) {
      rows = parseDataFile(fs.readFileSync(o.data, 'utf8'));
      if (rows == null) throw new Error(`${o.data} isn't a JSON array of objects or a CSV with a header row`);
    }
  } catch (e) { stdout(`${red('error')} ${e.message}\n`); return 2; }
  if (o.vaultFromEnv) setVault(process.env);

  const folderIds = [];
  for (const f of o.folders) {
    let found = findItem(collection, f)?.item;
    if (!found) {
      const walk = (items) => { for (const it of items || []) { if (Array.isArray(it.item)) { if (it.name === f) { found = it; return; } walk(it.item); if (found) return; } } };
      walk(collection.item);
    }
    if (!found || !Array.isArray(found.item)) { stdout(`${red('error')} no folder named "${f}"\n`); return 2; }
    folderIds.push(found.id);
  }

  const entry = { uid: 'cli', name: collection.info?.name || 'Collection', data: collection };
  const env = o.environment || envValues.length ? { name: o.environment ? path.basename(o.environment) : 'CLI', data: { values: envValues }, overlay: {} } : null;
  const ws = { globals: { values: globalValues, overlay: {} }, colOverlays: {} };
  const send = makeSend({ timeout: o.timeout, redirects: o.redirects });
  let stop = false;

  log(`\n${bold(entry.name)}${env ? dim(` · ${env.name}`) : ''}${rows.length ? dim(` · ${rows.length} data rows`) : o.iterations > 1 ? dim(` · ${o.iterations} iterations`) : ''}\n\n`);
  let lastIteration = 0;
  const onProgress = (r) => {
    if (r.iteration !== lastIteration && (rows.length > 1 || o.iterations > 1)) { log(dim(`Iteration ${r.iteration}\n`)); lastIteration = r.iteration; }
    const mark = ok(r) ? green('✓') : red('✗');
    const status = r.error ? red('ERR') : r.status >= 400 ? red(r.status) : r.status >= 300 ? yellow(r.status) : green(r.status);
    log(`${mark} ${r.method.padEnd(6)} ${r.name} ${status} ${dim(`${r.timeMs ?? '-'} ms`)}\n`);
    if (r.error) log(`    ${red(r.error)}\n`);
    for (const t of r.tests || []) log(`    ${t.skipped ? dim('-') : t.passed === false ? red('✗') : green('✓')} ${t.name}${t.passed === false && t.error ? dim(` — ${t.error}`) : ''}\n`);
    for (const n of r.notes || []) log(`    ${dim(n)}\n`);
    if (o.bail && !ok(r)) stop = true;
  };

  const runs = [];
  try {
    for (const folderId of folderIds.length ? folderIds : [null]) {
      runs.push(await runBatch({ entry, folderId, iterations: o.iterations, rows, delayMs: o.delay, env, ws, send, onProgress, isStopped: () => stop, recordHistory: false }));
      if (stop) break;
    }
  } catch (e) { stdout(`${red('error')} ${e.message}\n`); return 2; }

  const results = runs.flatMap((r) => r.results);
  const run = { ...runs[0], results, passed: results.filter(ok).length, failed: results.filter((r) => !ok(r)).length, durationMs: runs.reduce((n, r) => n + r.durationMs, 0) };
  const tests = results.flatMap((r) => r.tests || []);
  const testsFailed = tests.filter((t) => t.passed === false).length;
  log(`\n${bold('Requests')} ${run.results.length}  ${green(`${run.passed} passed`)}  ${run.failed ? red(`${run.failed} failed`) : dim('0 failed')}\n`);
  log(`${bold('Tests')}    ${tests.length}  ${green(`${tests.length - testsFailed} passed`)}  ${testsFailed ? red(`${testsFailed} failed`) : dim('0 failed')}\n`);
  log(`${dim(`Finished in ${(run.durationMs / 1000).toFixed(2)} s${stop && o.bail ? ' (stopped early by --bail)' : ''}`)}\n\n`);

  if (o.reporters.some((r) => r !== 'cli')) {
    fs.mkdirSync(o.out, { recursive: true });
    const base = path.join(o.out, (entry.name || 'run').replace(/[^\w.-]+/g, '_'));
    if (o.reporters.includes('json')) { fs.writeFileSync(`${base}.json`, JSON.stringify(run, null, 2)); log(dim(`JSON report: ${base}.json\n`)); }
    if (o.reporters.includes('junit')) { fs.writeFileSync(`${base}.xml`, junit(run)); log(dim(`JUnit report: ${base}.xml\n`)); }
  }
  return run.failed ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => { console.error(e); process.exit(2); });
}
