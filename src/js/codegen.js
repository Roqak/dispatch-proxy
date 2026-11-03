// Code generation: turn a resolved outgoing request (from buildOutgoing) into
// a snippet for another language or tool, like Postman's "Code" panel.

export const LANGUAGES = [
  ['curl', 'cURL'],
  ['httpie', 'HTTPie'],
  ['wget', 'wget'],
  ['fetch', 'JavaScript – fetch'],
  ['axios', 'JavaScript – axios'],
  ['python', 'Python – requests'],
  ['go', 'Go – net/http'],
  ['java', 'Java – HttpClient'],
  ['csharp', 'C# – HttpClient'],
  ['php', 'PHP – cURL'],
  ['ruby', 'Ruby – Net::HTTP'],
  ['swift', 'Swift – URLSession'],
  ['kotlin', 'Kotlin – OkHttp'],
  ['powershell', 'PowerShell'],
  ['http', 'Raw HTTP'],
];

const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`; // POSIX shell
const dq = (s) => JSON.stringify(String(s)); // C-like double-quoted string
const pyq = (s) => JSON.stringify(String(s));
const phpq = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const psq = (s) => `'${String(s).replace(/'/g, "''")}'`;
const rbq = (s) => JSON.stringify(String(s));
const indent = (s, n) => s.split('\n').map((l) => (l ? ' '.repeat(n) + l : l)).join('\n');
const fileName = (p) => String(p || '').split(/[\\/]/).pop();

/** Headers worth showing: drop the default Accept Dispatch adds. */
function headersOf(o) {
  return (o.headers || []).filter((h) => !(h.key.toLowerCase() === 'accept' && h.value === '*/*'));
}

const isJson = (o) => /json/i.test(headersOf(o).find((h) => h.key.toLowerCase() === 'content-type')?.value || '');
const urlencoded = (fields) => fields.map((f) => `${encodeURIComponent(f.key)}=${encodeURIComponent(f.value)}`).join('&');

function prettyJsonBody(content) {
  try { return JSON.stringify(JSON.parse(content), null, 2); } catch { return null; }
}

const GEN = {
  curl(o) {
    const parts = [`curl --location --request ${o.method} ${sq(o.url)}`];
    for (const h of headersOf(o)) parts.push(`--header ${sq(`${h.key}: ${h.value}`)}`);
    const b = o.body;
    if (b.mode === 'raw') parts.push(`--data-raw ${sq(b.content)}`);
    if (b.mode === 'urlencoded') for (const f of b.fields) parts.push(`--data-urlencode ${sq(`${f.key}=${f.value}`)}`);
    if (b.mode === 'formdata') for (const f of b.fields) parts.push(`--form ${sq(f.kind === 'file' ? `${f.key}=@"${f.src}"` : `${f.key}=${f.value}`)}`);
    if (b.mode === 'file') parts.push(`--data-binary ${sq(`@${b.path}`)}`);
    return parts.join(' \\\n  ');
  },

  httpie(o) {
    const b = o.body;
    const parts = [];
    if (b.mode === 'raw') parts.push(`printf '%s' ${sq(b.content)} |`);
    if (b.mode === 'file') parts.push(`cat ${sq(b.path)} |`);
    parts.push(`http ${b.mode === 'urlencoded' ? '--form ' : b.mode === 'formdata' ? '--multipart ' : ''}${o.method} ${sq(o.url)}`);
    for (const h of headersOf(o)) parts.push(sq(`${h.key}:${h.value}`));
    if (b.mode === 'urlencoded') for (const f of b.fields) parts.push(sq(`${f.key}=${f.value}`));
    if (b.mode === 'formdata') for (const f of b.fields) parts.push(sq(f.kind === 'file' ? `${f.key}@${f.src}` : `${f.key}=${f.value}`));
    return parts.join(' \\\n  ');
  },

  wget(o) {
    const parts = [`wget --quiet --method ${o.method}`];
    for (const h of headersOf(o)) parts.push(`--header ${sq(`${h.key}: ${h.value}`)}`);
    const b = o.body;
    if (b.mode === 'raw') parts.push(`--body-data ${sq(b.content)}`);
    if (b.mode === 'urlencoded') parts.push(`--body-data ${sq(urlencoded(b.fields))}`);
    if (b.mode === 'file') parts.push(`--body-file ${sq(b.path)}`);
    parts.push('--output-document -', sq(o.url));
    const out = parts.join(' \\\n  ');
    return b.mode === 'formdata' ? `# wget can't send multipart form-data; use cURL or HTTPie instead.\n${out}` : out;
  },

  fetch(o) {
    const lines = [];
    const hs = headersOf(o);
    const b = o.body;
    const opts = [`  method: ${dq(o.method)},`];
    if (hs.length && b.mode !== 'formdata') opts.push(`  headers: {\n${hs.map((h) => `    ${dq(h.key)}: ${dq(h.value)},`).join('\n')}\n  },`);
    else if (hs.length) opts.push(`  headers: {\n${hs.filter((h) => h.key.toLowerCase() !== 'content-type').map((h) => `    ${dq(h.key)}: ${dq(h.value)},`).join('\n')}\n  },`);
    if (b.mode === 'raw') {
      const pretty = isJson(o) && prettyJsonBody(b.content);
      opts.push(pretty ? `  body: JSON.stringify(${indent(pretty, 2).trimStart()}),` : `  body: ${dq(b.content)},`);
    } else if (b.mode === 'urlencoded') {
      lines.push('const body = new URLSearchParams();', ...b.fields.map((f) => `body.append(${dq(f.key)}, ${dq(f.value)});`), '');
      opts.push('  body,');
    } else if (b.mode === 'formdata') {
      lines.push('const body = new FormData();', ...b.fields.map((f) => (f.kind === 'file'
        ? `body.append(${dq(f.key)}, fileInput.files[0], ${dq(fileName(f.src))}); // ${f.src}`
        : `body.append(${dq(f.key)}, ${dq(f.value)});`)), '');
      opts.push('  body,');
    } else if (b.mode === 'file') {
      opts.push(`  body: file, // contents of ${b.path}`);
    }
    lines.push(`const response = await fetch(${dq(o.url)}, {`, ...opts, '});', '', 'console.log(response.status, await response.text());');
    return lines.join('\n');
  },

  axios(o) {
    const lines = ["const axios = require('axios');"];
    const hs = headersOf(o);
    const b = o.body;
    let data = null;
    if (b.mode === 'raw') data = (isJson(o) && prettyJsonBody(b.content)) || dq(b.content);
    if (b.mode === 'urlencoded') {
      lines.push('const data = new URLSearchParams();', ...b.fields.map((f) => `data.append(${dq(f.key)}, ${dq(f.value)});`));
      data = 'data';
    }
    if (b.mode === 'formdata') {
      lines.splice(1, 0, "const FormData = require('form-data');", "const fs = require('fs');");
      lines.push('const data = new FormData();', ...b.fields.map((f) => (f.kind === 'file' ? `data.append(${dq(f.key)}, fs.createReadStream(${dq(f.src)}));` : `data.append(${dq(f.key)}, ${dq(f.value)});`)));
      data = 'data';
    }
    if (b.mode === 'file') { lines.splice(1, 0, "const fs = require('fs');"); data = `fs.readFileSync(${dq(b.path)})`; }
    const cfg = [`  method: ${dq(o.method.toLowerCase())},`, `  url: ${dq(o.url)},`];
    const headerLines = hs.filter((h) => !(b.mode === 'formdata' && h.key.toLowerCase() === 'content-type')).map((h) => `    ${dq(h.key)}: ${dq(h.value)},`);
    if (b.mode === 'formdata') headerLines.push('    ...data.getHeaders(),');
    if (headerLines.length) cfg.push(`  headers: {\n${headerLines.join('\n')}\n  },`);
    if (data) cfg.push(`  data: ${data.includes('\n') ? indent(data, 2).trimStart() : data},`);
    lines.push('', 'axios.request({', ...cfg, '})', '  .then((response) => console.log(response.status, response.data))', '  .catch((error) => console.error(error));');
    return lines.join('\n');
  },

  python(o) {
    const hs = headersOf(o);
    const b = o.body;
    const lines = ['import requests', '', `url = ${pyq(o.url)}`];
    const args = ['url'];
    if (hs.length) {
      const keep = hs.filter((h) => !(b.mode === 'formdata' && h.key.toLowerCase() === 'content-type'));
      if (keep.length) { lines.push(`headers = {\n${keep.map((h) => `    ${pyq(h.key)}: ${pyq(h.value)},`).join('\n')}\n}`); args.push('headers=headers'); }
    }
    if (b.mode === 'raw') { lines.push(`payload = ${pyq(b.content)}`); args.push('data=payload'); }
    if (b.mode === 'urlencoded') { lines.push(`payload = {\n${b.fields.map((f) => `    ${pyq(f.key)}: ${pyq(f.value)},`).join('\n')}\n}`); args.push('data=payload'); }
    if (b.mode === 'formdata') {
      const text = b.fields.filter((f) => f.kind !== 'file');
      const files = b.fields.filter((f) => f.kind === 'file');
      if (text.length) { lines.push(`payload = {\n${text.map((f) => `    ${pyq(f.key)}: ${pyq(f.value)},`).join('\n')}\n}`); args.push('data=payload'); }
      if (files.length) { lines.push(`files = [\n${files.map((f) => `    (${pyq(f.key)}, open(${pyq(f.src)}, "rb")),`).join('\n')}\n]`); args.push('files=files'); }
    }
    if (b.mode === 'file') { lines.push(`payload = open(${pyq(b.path)}, "rb")`); args.push('data=payload'); }
    lines.push('', `response = requests.request(${pyq(o.method)}, ${args.join(', ')})`, '', 'print(response.status_code)', 'print(response.text)');
    return lines.join('\n');
  },

  go(o) {
    const hs = headersOf(o);
    const b = o.body;
    const imports = ['"fmt"', '"io"', '"net/http"'];
    const pre = [];
    let bodyExpr = 'nil';
    if (b.mode === 'raw') { imports.push('"strings"'); pre.push(`\tpayload := strings.NewReader(${goRaw(b.content)})`); bodyExpr = 'payload'; }
    if (b.mode === 'urlencoded') { imports.push('"strings"'); pre.push(`\tpayload := strings.NewReader(${dq(urlencoded(b.fields))})`); bodyExpr = 'payload'; }
    if (b.mode === 'file') { imports.push('"os"'); pre.push(`\tpayload, err := os.Open(${dq(b.path)})`, '\tif err != nil {', '\t\tpanic(err)', '\t}', '\tdefer payload.Close()'); bodyExpr = 'payload'; }
    if (b.mode === 'formdata') {
      imports.push('"bytes"', '"mime/multipart"', '"os"', '"path/filepath"');
      pre.push('\tpayload := &bytes.Buffer{}', '\twriter := multipart.NewWriter(payload)');
      for (const f of b.fields) {
        if (f.kind === 'file') pre.push(`\tif file, err := os.Open(${dq(f.src)}); err == nil {`, `\t\tpart, _ := writer.CreateFormFile(${dq(f.key)}, filepath.Base(${dq(f.src)}))`, '\t\tio.Copy(part, file)', '\t\tfile.Close()', '\t}');
        else pre.push(`\twriter.WriteField(${dq(f.key)}, ${dq(f.value)})`);
      }
      pre.push('\twriter.Close()');
      bodyExpr = 'payload';
    }
    const hdr = hs.filter((h) => !(b.mode === 'formdata' && h.key.toLowerCase() === 'content-type')).map((h) => `\treq.Header.Add(${dq(h.key)}, ${dq(h.value)})`);
    if (b.mode === 'formdata') hdr.push('\treq.Header.Set("Content-Type", writer.FormDataContentType())');
    return [
      'package main', '', 'import (', ...imports.sort().map((i) => `\t${i}`), ')', '',
      'func main() {',
      ...pre,
      `\treq, err := http.NewRequest(${dq(o.method)}, ${dq(o.url)}, ${bodyExpr})`,
      '\tif err != nil {', '\t\tpanic(err)', '\t}',
      ...hdr,
      '',
      '\tres, err := http.DefaultClient.Do(req)',
      '\tif err != nil {', '\t\tpanic(err)', '\t}',
      '\tdefer res.Body.Close()',
      '\tbody, _ := io.ReadAll(res.Body)',
      '\tfmt.Println(res.StatusCode, string(body))',
      '}',
    ].join('\n');
  },

  java(o) {
    const hs = headersOf(o);
    const b = o.body;
    let publisher = 'HttpRequest.BodyPublishers.noBody()';
    if (b.mode === 'raw') publisher = `HttpRequest.BodyPublishers.ofString(${dq(b.content)})`;
    if (b.mode === 'urlencoded') publisher = `HttpRequest.BodyPublishers.ofString(${dq(urlencoded(b.fields))})`;
    if (b.mode === 'file') publisher = `HttpRequest.BodyPublishers.ofFile(java.nio.file.Path.of(${dq(b.path)}))`;
    const lines = [
      'import java.net.URI;', 'import java.net.http.HttpClient;', 'import java.net.http.HttpRequest;', 'import java.net.http.HttpResponse;', '',
      'public class Main {',
      '    public static void main(String[] args) throws Exception {',
      '        HttpRequest request = HttpRequest.newBuilder()',
      `            .uri(URI.create(${dq(o.url)}))`,
      ...hs.map((h) => `            .header(${dq(h.key)}, ${dq(h.value)})`),
      `            .method(${dq(o.method)}, ${publisher})`,
      '            .build();',
      '        HttpResponse<String> response = HttpClient.newHttpClient().send(request, HttpResponse.BodyHandlers.ofString());',
      '        System.out.println(response.statusCode());',
      '        System.out.println(response.body());',
      '    }',
      '}',
    ];
    if (b.mode === 'formdata') lines.unshift('// java.net.http has no multipart builder; build the body with a library such as OkHttp or Apache HttpClient.');
    return lines.join('\n');
  },

  csharp(o) {
    const hs = headersOf(o);
    const b = o.body;
    const ct = hs.find((h) => h.key.toLowerCase() === 'content-type')?.value;
    const lines = ['using var client = new HttpClient();', `var request = new HttpRequestMessage(new HttpMethod(${dq(o.method)}), ${dq(o.url)});`];
    for (const h of hs) if (h.key.toLowerCase() !== 'content-type') lines.push(`request.Headers.TryAddWithoutValidation(${dq(h.key)}, ${dq(h.value)});`);
    if (b.mode === 'raw') lines.push(`request.Content = new StringContent(${dq(b.content)}, System.Text.Encoding.UTF8${ct ? `, ${dq(ct.split(';')[0].trim())}` : ''});`);
    if (b.mode === 'urlencoded') lines.push('request.Content = new FormUrlEncodedContent(new[]', '{', ...b.fields.map((f) => `    new KeyValuePair<string, string>(${dq(f.key)}, ${dq(f.value)}),`), '});');
    if (b.mode === 'formdata') {
      lines.push('var content = new MultipartFormDataContent();');
      for (const f of b.fields) lines.push(f.kind === 'file' ? `content.Add(new StreamContent(File.OpenRead(${dq(f.src)})), ${dq(f.key)}, ${dq(fileName(f.src))});` : `content.Add(new StringContent(${dq(f.value)}), ${dq(f.key)});`);
      lines.push('request.Content = content;');
    }
    if (b.mode === 'file') lines.push(`request.Content = new StreamContent(File.OpenRead(${dq(b.path)}));`);
    lines.push('var response = await client.SendAsync(request);', 'Console.WriteLine((int)response.StatusCode);', 'Console.WriteLine(await response.Content.ReadAsStringAsync());');
    return lines.join('\n');
  },

  php(o) {
    const hs = headersOf(o);
    const b = o.body;
    const opts = [
      `  CURLOPT_URL => ${phpq(o.url)},`,
      '  CURLOPT_RETURNTRANSFER => true,',
      '  CURLOPT_FOLLOWLOCATION => true,',
      `  CURLOPT_CUSTOMREQUEST => ${phpq(o.method)},`,
    ];
    if (b.mode === 'raw') opts.push(`  CURLOPT_POSTFIELDS => ${phpq(b.content)},`);
    if (b.mode === 'urlencoded') opts.push(`  CURLOPT_POSTFIELDS => ${phpq(urlencoded(b.fields))},`);
    if (b.mode === 'formdata') opts.push(`  CURLOPT_POSTFIELDS => [\n${b.fields.map((f) => `    ${phpq(f.key)} => ${f.kind === 'file' ? `new CURLFile(${phpq(f.src)})` : phpq(f.value)},`).join('\n')}\n  ],`);
    if (b.mode === 'file') opts.push(`  CURLOPT_POSTFIELDS => file_get_contents(${phpq(b.path)}),`);
    const keep = hs.filter((h) => !(b.mode === 'formdata' && h.key.toLowerCase() === 'content-type'));
    if (keep.length) opts.push(`  CURLOPT_HTTPHEADER => [\n${keep.map((h) => `    ${phpq(`${h.key}: ${h.value}`)},`).join('\n')}\n  ],`);
    return ['<?php', '', '$curl = curl_init();', 'curl_setopt_array($curl, [', ...opts, ']);', '', '$response = curl_exec($curl);', 'curl_close($curl);', 'echo $response;'].join('\n');
  },

  ruby(o) {
    const hs = headersOf(o);
    const b = o.body;
    const cls = { GET: 'Get', POST: 'Post', PUT: 'Put', PATCH: 'Patch', DELETE: 'Delete', HEAD: 'Head', OPTIONS: 'Options' }[o.method];
    const lines = ['require "uri"', 'require "net/http"', '', `url = URI(${rbq(o.url)})`, 'http = Net::HTTP.new(url.host, url.port)', 'http.use_ssl = url.scheme == "https"', '',
      cls ? `request = Net::HTTP::${cls}.new(url)` : `request = Net::HTTPGenericRequest.new(${rbq(o.method)}, true, true, url)`];
    for (const h of hs) if (!(b.mode === 'formdata' && h.key.toLowerCase() === 'content-type')) lines.push(`request[${rbq(h.key)}] = ${rbq(h.value)}`);
    if (b.mode === 'raw') lines.push(`request.body = ${rbq(b.content)}`);
    if (b.mode === 'urlencoded') lines.push(`request.set_form_data(${b.fields.length ? `{ ${b.fields.map((f) => `${rbq(f.key)} => ${rbq(f.value)}`).join(', ')} }` : '{}'})`);
    if (b.mode === 'formdata') lines.push(`request.set_form([${b.fields.map((f) => `[${rbq(f.key)}, ${f.kind === 'file' ? `File.open(${rbq(f.src)})` : rbq(f.value)}]`).join(', ')}], "multipart/form-data")`);
    if (b.mode === 'file') lines.push(`request.body = File.binread(${rbq(b.path)})`);
    lines.push('', 'response = http.request(request)', 'puts response.code', 'puts response.body');
    return lines.join('\n');
  },

  swift(o) {
    const hs = headersOf(o);
    const b = o.body;
    const lines = ['import Foundation', '', `var request = URLRequest(url: URL(string: ${dq(o.url)})!)`, `request.httpMethod = ${dq(o.method)}`];
    for (const h of hs) lines.push(`request.addValue(${dq(h.value)}, forHTTPHeaderField: ${dq(h.key)})`);
    if (b.mode === 'raw') lines.push(`request.httpBody = ${dq(b.content)}.data(using: .utf8)`);
    if (b.mode === 'urlencoded') lines.push(`request.httpBody = ${dq(urlencoded(b.fields))}.data(using: .utf8)`);
    if (b.mode === 'file') lines.push(`request.httpBody = try Data(contentsOf: URL(fileURLWithPath: ${dq(b.path)}))`);
    if (b.mode === 'formdata') lines.push('// Build a multipart/form-data body here; URLSession has no built-in helper.');
    lines.push('', 'let (data, response) = try await URLSession.shared.data(for: request)', 'print((response as? HTTPURLResponse)?.statusCode ?? 0)', 'print(String(decoding: data, as: UTF8.self))');
    return lines.join('\n');
  },

  kotlin(o) {
    const hs = headersOf(o);
    const b = o.body;
    const ct = hs.find((h) => h.key.toLowerCase() === 'content-type')?.value || 'text/plain';
    const lines = ['import okhttp3.*', 'import okhttp3.MediaType.Companion.toMediaType', 'import okhttp3.RequestBody.Companion.asRequestBody', 'import okhttp3.RequestBody.Companion.toRequestBody', 'import java.io.File', '', 'val client = OkHttpClient()'];
    let bodyExpr = 'null';
    if (b.mode === 'raw') bodyExpr = `${dq(b.content)}.toRequestBody(${dq(ct)}.toMediaType())`;
    if (b.mode === 'urlencoded') bodyExpr = `FormBody.Builder()${b.fields.map((f) => `\n    .add(${dq(f.key)}, ${dq(f.value)})`).join('')}\n    .build()`;
    if (b.mode === 'formdata') bodyExpr = `MultipartBody.Builder().setType(MultipartBody.FORM)${b.fields.map((f) => (f.kind === 'file'
      ? `\n    .addFormDataPart(${dq(f.key)}, ${dq(fileName(f.src))}, File(${dq(f.src)}).asRequestBody())`
      : `\n    .addFormDataPart(${dq(f.key)}, ${dq(f.value)})`)).join('')}\n    .build()`;
    if (b.mode === 'file') bodyExpr = `File(${dq(b.path)}).asRequestBody(${dq(ct)}.toMediaType())`;
    if (bodyExpr !== 'null') lines.push(`val body = ${bodyExpr}`);
    lines.push('val request = Request.Builder()', `    .url(${dq(o.url)})`, `    .method(${dq(o.method)}, ${bodyExpr === 'null' ? 'null' : 'body'})`);
    for (const h of hs) if (!(b.mode === 'formdata' && h.key.toLowerCase() === 'content-type')) lines.push(`    .addHeader(${dq(h.key)}, ${dq(h.value)})`);
    lines.push('    .build()', '', 'client.newCall(request).execute().use { response ->', '    println(response.code)', '    println(response.body?.string())', '}');
    return lines.join('\n');
  },

  powershell(o) {
    const hs = headersOf(o);
    const b = o.body;
    const lines = [];
    const ct = hs.find((h) => h.key.toLowerCase() === 'content-type')?.value;
    const others = hs.filter((h) => h.key.toLowerCase() !== 'content-type');
    if (others.length) lines.push('$headers = @{', ...others.map((h) => `    ${psq(h.key)} = ${psq(h.value)}`), '}');
    const args = [`-Uri ${psq(o.url)}`, `-Method ${psq(o.method)}`];
    if (others.length) args.push('-Headers $headers');
    if (ct && b.mode !== 'formdata') args.push(`-ContentType ${psq(ct)}`);
    if (b.mode === 'raw') { lines.push(`$body = ${psq(b.content)}`); args.push('-Body $body'); }
    if (b.mode === 'urlencoded') { lines.push('$body = @{', ...b.fields.map((f) => `    ${psq(f.key)} = ${psq(f.value)}`), '}'); args.push('-Body $body'); }
    if (b.mode === 'formdata') { lines.push('$form = @{', ...b.fields.map((f) => `    ${psq(f.key)} = ${f.kind === 'file' ? `Get-Item -Path ${psq(f.src)}` : psq(f.value)}`), '}'); args.push('-Form $form'); }
    if (b.mode === 'file') args.push(`-InFile ${psq(b.path)}`);
    lines.push(`$response = Invoke-RestMethod ${args.join(' ')}`, '$response | ConvertTo-Json -Depth 10');
    return lines.join('\n');
  },

  http(o) {
    let u;
    try { u = new URL(o.url); } catch { u = null; }
    const b = o.body;
    const target = u ? `${u.pathname || '/'}${u.search}` : o.url;
    const lines = [`${o.method} ${target} HTTP/1.1`];
    if (u) lines.push(`Host: ${u.host}`);
    for (const h of headersOf(o)) lines.push(`${h.key}: ${h.value}`);
    let body = '';
    if (b.mode === 'raw') body = b.content;
    if (b.mode === 'urlencoded') body = urlencoded(b.fields);
    if (b.mode === 'formdata') {
      const boundary = '----DispatchBoundary7MA4YWxkTrZu0gW';
      body = `${b.fields.map((f) => `--${boundary}\r\nContent-Disposition: form-data; name="${f.key}"${f.kind === 'file' ? `; filename="${fileName(f.src)}"\r\nContent-Type: application/octet-stream\r\n\r\n<contents of ${f.src}>` : `\r\n\r\n${f.value}`}`).join('\r\n')}\r\n--${boundary}--`;
      lines.push(`Content-Type: multipart/form-data; boundary=${boundary}`);
    }
    if (b.mode === 'file') body = `<contents of ${b.path}>`;
    if (b.mode === 'urlencoded' && !headersOf(o).some((h) => h.key.toLowerCase() === 'content-type')) lines.push('Content-Type: application/x-www-form-urlencoded');
    if (body) lines.push(`Content-Length: ${new TextEncoder().encode(body).length}`);
    return `${lines.join('\n')}\n${body ? `\n${body.replace(/\r\n/g, '\n')}` : ''}`.trimEnd();
  },
};

/** Go: raw string literal when the content allows it, else a quoted string. */
function goRaw(s) {
  return s.includes('`') ? dq(s) : `\`${s}\``;
}

export function generate(lang, outgoing) {
  const fn = GEN[lang];
  if (!fn) throw new Error(`Unknown language: ${lang}`);
  return fn({ ...outgoing, method: (outgoing.method || 'GET').toUpperCase(), body: outgoing.body || { mode: 'none' } });
}
