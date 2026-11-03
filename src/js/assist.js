// The AI assistant's prompts and parsing. What goes to Anthropic is the request
// as written ({{variables}} unresolved, so environment secrets stay out), with
// credential-looking header values redacted and bodies capped.

import { urlObject, parseUrl, uuid, getScript } from './model.js';

const SENSITIVE = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token)$|token|secret|password|key|session/i;
const MAX_BODY = 30_000;

export const redactHeaders = (headers = []) => headers.filter((x) => x.key && !x.disabled).map((x) => `${x.key}: ${SENSITIVE.test(x.key) ? '[redacted]' : x.value}`);

const cap = (s, n = MAX_BODY) => (s && s.length > n ? `${s.slice(0, n)}\n…(${s.length - n} more characters cut)` : s || '');

/** A plain-text description of the request (and response, if any) for the prompt. */
export function describeExchange(item, res) {
  const req = item.request || {};
  const lines = [`Request "${item.name || 'Untitled'}": ${req.method || 'GET'} ${urlObject(req.url).raw || ''}`];
  const hs = redactHeaders(req.header);
  if (hs.length) lines.push('Request headers:', ...hs.map((x) => `  ${x}`));
  const b = req.body;
  if (b?.mode === 'raw' && b.raw) lines.push(`Request body (${b.options?.raw?.language || 'text'}):`, cap(b.raw, 8000));
  else if (b?.mode === 'graphql') lines.push('GraphQL query:', cap(b.graphql?.query || '', 8000));
  else if (b?.mode === 'urlencoded' || b?.mode === 'formdata') lines.push(`Request body (${b.mode}) fields: ${(b[b.mode] || []).map((f) => f.key).join(', ')}`);
  const pre = getScript(item, 'test');
  if (pre) lines.push('Existing post-response script:', cap(pre, 4000));
  if (res) {
    lines.push('', `Response: ${res.status} ${res.statusText || ''} in ${res.timeMs ?? '?'} ms`);
    const rh = redactHeaders(res.headers);
    if (rh.length) lines.push('Response headers:', ...rh.map((x) => `  ${x}`));
    lines.push('Response body:', res.bodyBase64 ? `(binary, ${res.size} bytes)` : cap(res.bodyText));
  }
  return lines.join('\n');
}

export const TESTS_SYSTEM = `You write post-response test scripts for an API client that runs Postman's pm API (pm.test, pm.expect with chai, pm.response.json(), pm.response.to.have.status(), pm.response.headers.get(), pm.response.responseTime).
Reply with a single \`\`\`javascript code block and nothing else.
Check the status, the content type, the response's shape and the types of its important fields, and any clear business rules visible in the data. Don't assert exact values that will change between calls (timestamps, generated ids, tokens) beyond their type or format. Group related checks into a few clearly named pm.test blocks. If a value is useful to later requests (a token or id), save it with pm.environment.set and say so in a comment.`;

export const EXPLAIN_SYSTEM = `You help a developer understand an HTTP response in their API client. Explain what happened, the most likely cause if something is wrong, and what to try next — concretely, referring to the actual request and response. Use Markdown. Be brief for simple cases; only go long when the problem genuinely needs it.`;

export const CREATE_SYSTEM = `You turn a description into one HTTP request for an API client. Use {{variable}} placeholders for hosts and credentials the user hasn't given (prefer variables they already have). Put the full URL, including query parameters, in url. For JSON bodies set bodyMode to "json" and body to pretty-printed JSON; use "none" with an empty body when there is no body.`;

export const REQUEST_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] },
    url: { type: 'string' },
    headers: { type: 'array', items: { type: 'object', properties: { key: { type: 'string' }, value: { type: 'string' } }, required: ['key', 'value'], additionalProperties: false } },
    bodyMode: { type: 'string', enum: ['none', 'json', 'text', 'urlencoded'] },
    body: { type: 'string' },
    description: { type: 'string' },
  },
  required: ['name', 'method', 'url', 'headers', 'bodyMode', 'body', 'description'],
  additionalProperties: false,
};

export function testsPrompt(item, res) {
  return `Write tests for this exchange.\n\n${describeExchange(item, res)}`;
}

export function explainPrompt(item, res, error) {
  return `${error ? `Sending failed: ${error}\n\n` : ''}Explain this exchange.\n\n${describeExchange(item, res)}`;
}

export function createPrompt(description, variableNames = []) {
  return `${description.trim()}\n\n${variableNames.length ? `Variables already defined: ${variableNames.slice(0, 80).join(', ')}` : 'No variables are defined yet.'}`;
}

/** The first fenced code block (or the whole text when there's none). */
export function extractCode(text) {
  const m = /```(?:javascript|js)?\s*\n([\s\S]*?)```/.exec(text || '');
  return (m ? m[1] : text || '').trim();
}

/** Structured answer → a Postman request item. */
export function requestFromAi(json) {
  const o = typeof json === 'string' ? JSON.parse(json) : json;
  const request = { method: o.method || 'GET', header: (o.headers || []).filter((x) => x.key).map((x) => ({ key: x.key, value: x.value ?? '' })), url: parseUrl(o.url || '') };
  if (o.bodyMode === 'json' || o.bodyMode === 'text') request.body = { mode: 'raw', raw: o.body || '', options: { raw: { language: o.bodyMode === 'json' ? 'json' : 'text' } } };
  else if (o.bodyMode === 'urlencoded') request.body = { mode: 'urlencoded', urlencoded: [...new URLSearchParams(o.body || '')].map(([key, value]) => ({ key, value })) };
  if (o.description) request.description = o.description;
  return { id: uuid(), name: o.name || 'New request', request, response: [] };
}
