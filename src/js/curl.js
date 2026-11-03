// Turn a pasted cURL command into a Postman request object.

import { parseUrl } from './model.js';

function tokenize(cmd) {
  const s = cmd.replace(/\\\r?\n/g, ' ').trim();
  const out = [];
  let cur = '';
  let quote = null;
  let has = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) { quote = null; continue; }
      if (c === '\\' && quote === '"' && i + 1 < s.length && '"\\$`'.includes(s[i + 1])) { cur += s[++i]; continue; }
      cur += c;
    } else if (c === "'" || c === '"') { quote = c; has = true; }
    else if (c === '$' && s[i + 1] === "'") { quote = "'"; has = true; i++; }
    else if (/\s/.test(c)) { if (cur || has) { out.push(cur); cur = ''; has = false; } }
    else if (c === '\\' && i + 1 < s.length) cur += s[++i];
    else cur += c;
  }
  if (quote) throw new Error('The cURL command has an unclosed quote.');
  if (cur || has) out.push(cur);
  return out;
}

export function parseCurl(cmd) {
  const t = tokenize(cmd);
  if (t[0]?.toLowerCase() !== 'curl') throw new Error("That doesn't look like a cURL command.");
  let method = null;
  let url = '';
  const header = [];
  const data = [];
  const form = [];
  let urlencoded = false;
  let user = null;
  for (let i = 1; i < t.length; i++) {
    const a = t[i];
    const next = () => t[++i] ?? '';
    if (a === '-X' || a === '--request') method = next().toUpperCase();
    else if (a.startsWith('-X') && a.length > 2) method = a.slice(2).toUpperCase();
    else if (a === '-H' || a === '--header') {
      const v = next();
      const idx = v.indexOf(':');
      if (idx > 0) header.push({ key: v.slice(0, idx).trim(), value: v.slice(idx + 1).trim() });
    } else if (['-d', '--data', '--data-raw', '--data-binary', '--data-ascii', '--json'].includes(a)) {
      data.push(next());
      if (a === '--json') { header.push({ key: 'Content-Type', value: 'application/json' }); }
    } else if (a === '--data-urlencode') { data.push(next()); urlencoded = true; }
    else if (a === '-F' || a === '--form') form.push(next());
    else if (a === '-u' || a === '--user') user = next();
    else if (a === '--url') url = next();
    else if (a === '-I' || a === '--head') method = 'HEAD';
    else if (a === '-G' || a === '--get') method = 'GET';
    else if (['-A', '--user-agent'].includes(a)) header.push({ key: 'User-Agent', value: next() });
    else if (['-b', '--cookie'].includes(a)) header.push({ key: 'Cookie', value: next() });
    else if (['-e', '--referer'].includes(a)) header.push({ key: 'Referer', value: next() });
    else if (['-o', '--output', '-m', '--max-time', '--connect-timeout', '-w', '--write-out', '--retry'].includes(a)) next();
    else if (a.startsWith('-')) { /* flags without values: -L, -s, -k, --compressed, ... */ }
    else if (!url) url = a;
  }
  if (!url) throw new Error('No URL found in the cURL command.');
  const req = { method: method || (data.length || form.length ? 'POST' : 'GET'), header, url: parseUrl(url) };
  if (user) {
    const i = user.indexOf(':');
    req.auth = { type: 'basic', basic: [{ key: 'username', value: i >= 0 ? user.slice(0, i) : user, type: 'string' }, { key: 'password', value: i >= 0 ? user.slice(i + 1) : '', type: 'string' }] };
  }
  if (form.length) {
    req.body = { mode: 'formdata', formdata: form.map((f) => {
      const i = f.indexOf('=');
      const key = f.slice(0, i);
      const v = f.slice(i + 1);
      return v.startsWith('@') ? { key, type: 'file', src: v.slice(1).replace(/^"|"$/g, '') } : { key, value: v, type: 'text' };
    }) };
  } else if (data.length) {
    const ct = header.find((x) => x.key.toLowerCase() === 'content-type')?.value || '';
    const joined = data.join('&');
    if (urlencoded || (ct.includes('x-www-form-urlencoded') && !ct.includes('json'))) {
      req.body = { mode: 'urlencoded', urlencoded: joined.split('&').filter(Boolean).map((p) => { const i = p.indexOf('='); return { key: decodeURIComponent(i >= 0 ? p.slice(0, i) : p), value: i >= 0 ? safeDecode(p.slice(i + 1)) : '' }; }) };
      const h = header.findIndex((x) => x.key.toLowerCase() === 'content-type');
      if (h >= 0) header.splice(h, 1);
    } else {
      const looksJson = /^\s*[{[]/.test(joined);
      req.body = { mode: 'raw', raw: data.join(''), options: { raw: { language: looksJson || ct.includes('json') ? 'json' : 'text' } } };
      if (looksJson) {
        try { req.body.raw = JSON.stringify(JSON.parse(req.body.raw), null, 2); } catch { /* keep as typed */ }
      }
    }
  }
  return req;
}

function safeDecode(s) { try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch { return s; } }
