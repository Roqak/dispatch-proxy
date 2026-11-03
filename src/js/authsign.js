// Cryptographic auth helpers: AWS Signature v4, Digest, Hawk. Pure functions
// so they're unit-testable; CryptoJS (already bundled) does the math.
// Convention: all functions take resolved (variable-free) inputs and return
// header objects to be merged by the request pipeline.

export function sha256Hex(value, CryptoJS) {
  return CryptoJS.SHA256(value).toString(CryptoJS.enc.Hex);
}

function hmacHex(key, value, CryptoJS) {
  return CryptoJS.HmacSHA256(value, key).toString(CryptoJS.enc.Hex);
}

export function amzDate(CryptoJS, now = new Date()) {
  // YYYYMMDD'T'HHmmss'Z'
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}T${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}Z`;
  return { amzDate: stamp, dateStamp: stamp.slice(0, 8) };
}

/** RFC3986 encode: encodeURIComponent but keep -_.~ */
const uriEncode = (s) => encodeURIComponent(String(s)).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * AWS Signature v4. Adds Host (if missing), x-amz-date, x-amz-security-token and
 * the Authorization header. `bodyContent` must be the exact bytes that will be
 * sent; for bodies whose exact bytes aren't known to JS, callers pass
 * `unsignedPayload: true` and the request is marked UNSIGNED-PAYLOAD (S3 style).
 * Returns { headers, note }。
 */
export function awsSigV4Sign({ method, url, bodyContent = '', params, CryptoJS, now = new Date() }) {
  const p = (k) => String(params?.[k] ?? '');
  const accessKey = p('accessKey'), secretKey = p('secretKey');
  if (!accessKey || !secretKey) return { note: 'AWS SigV4 needs an access key and a secret key.', headers: [] };
  const region = p('region'), service = p('service');
  if (!region || !service) return { note: 'AWS SigV4 needs a region and a service name.', headers: [] };

  const { amzDate: stamp, dateStamp } = amzDate(CryptoJS, now);
  const u = new URL(url);
  const host = u.host;
  const payloadHash = params?.unsignedPayload ? 'UNSIGNED-PAYLOAD' : sha256Hex(bodyContent, CryptoJS);

  const canonicalUri = u.pathname.split('/').map((c) => uriEncode(c)).join('/');
  const qs = [...u.searchParams.entries()].map(([k, v]) => [uriEncode(k), uriEncode(v)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`).join('&');

  const headers = [];
  for (const q of [['host', host], ['x-amz-content-sha256', payloadHash], ['x-amz-date', stamp]]) headers.push({ key: q[0], value: q[1] });
  const token = p('sessionToken');
  if (token) headers.push({ key: 'x-amz-security-token', value: token });

  const canonicalHeaders = headers.map((h) => `${h.key.toLowerCase()}:${h.value.trim()}\n`).join('');
  const signedHeaders = headers.map((h) => h.key.toLowerCase()).sort().join(';');
  const canonicalRequest = [method.toUpperCase(), canonicalUri || '/', qs, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256Hex(canonicalRequest, CryptoJS)].join('\n');
  const kDate = CryptoJS.HmacSHA256(dateStamp, `AWS4${secretKey}`);
  const kRegion = CryptoJS.HmacSHA256(region, kDate);
  const kService = CryptoJS.HmacSHA256(service, kRegion);
  const kSigning = CryptoJS.HmacSHA256('aws4_request', kService);
  const signature = CryptoJS.HmacSHA256(stringToSign, kSigning).toString(CryptoJS.enc.Hex);

  headers.push({ key: 'Authorization', value: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` });
  return { headers, note: null };
}

/** Parse a WWW-Authenticate: Digest challenge into a { param: value } map. */
export function parseDigestChallenge(wwwAuth) {
  const body = String(wwwAuth).replace(/^Digest\s+/i, '');
  const out = {};
  const re = /([a-zA-Z-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(body))) out[m[1].trim().toLowerCase()] = m[2].startsWith('"') ? m[2].slice(1, -1) : m[2].trim();
  return out;
}

const digestAlgo = (CryptoJS, algorithm) => (/sha-?256/i.test(algorithm || '') ? CryptoJS.SHA256 : CryptoJS.MD5);

/**
 * Compute a Digest Authorization header from a WWW-Authenticate challenge.
 * Supports qop=auth (and the no-qop RFC2069 shape). auth-int is not supported.
 */
export function digestHeader({ challenge, method, url, params = {}, CryptoJS, clientNonce }) {
  const H = digestAlgo(CryptoJS, params.algorithm ?? challenge.algorithm);
  const hex = (v) => H(v).toString(CryptoJS.enc.Hex);
  const username = params.username ?? '', password = params.password ?? '';
  const realm = challenge.realm ?? params.realm ?? '';
  const nonce = challenge.nonce ?? params.nonce ?? '';
  if (!nonce) return null;
  const uri = new URL(url).pathname + new URL(url).search;
  const opaque = challenge.opaque ? `, opaque="${challenge.opaque}"` : '';
  const nc = String(params.nonceCount ?? '00000001').padStart(8, '0').slice(-8);
  const qop = /auth-int/.test(challenge.qop || '') ? 'auth' : challenge.qop?.split(',').find((q) => q.trim() === 'auth') ? 'auth' : '';
  const cnonce = clientNonce ?? params.clientNonce ?? Math.random().toString(16).slice(2, 10);
  const ha1 = hex(`${username}:${realm}:${password}`);
  const ha2 = hex(`${method.toUpperCase()}:${uri}`);
  const response = qop ? hex(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : hex(`${ha1}:${nonce}:${ha2}`);
  const algo = (/sha-?256/i.test((params.algorithm ?? challenge.algorithm) || '') ? 'SHA-256' : 'MD5');
  return `Digest username="${username}", realm="${realm}", nonce="${nonce}", uri="${uri}", algorithm=${algo}` +
    (qop ? `, qop=${qop}, nc=${nc}, cnonce="${cnonce}", response="${response}"` : `, response="${response}"`) + opaque;
}

/**
 * Hawk ( hawk.1.header ). Postman stores params: authId, authKey, algorithm,
 * user, nonce, extraData, app, dlg, includePayloadTimestamp. Returns { headers, note }.
 */
export function hawkHeader({ method, url, bodyContent = '', params, CryptoJS, now = new Date() }) {
  const p = (k) => params?.[k];
  const id = p('authId') ?? p('id'), key = p('authKey') ?? p('key');
  if (!id || !key) return { headers: [], note: 'Hawk needs an auth id and an auth key.' };
  const alg = (p('algorithm') || 'sha256').toLowerCase() === 'sha1' ? 'sha1' : 'sha256';
  const H = alg === 'sha1' ? CryptoJS.HmacSHA1 : CryptoJS.HmacSHA256;
  const hashOf = (v) => H(v).toString(CryptoJS.enc.Base64);

  const u = new URL(url);
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  const ts = Math.floor(now.getTime() / 1000);
  const nonce = p('nonce') || Math.random().toString(36).slice(2, 8);
  const pathQ = u.pathname + u.search;

  let hash = '';
  if (p('includePayload').toString() === 'true' && bodyContent) {
    hash = hashOf(`hawk.1.payload\n${bodyContent}\n`);
  }
  let base = `hawk.1.header\n${ts}\n${nonce}\n${method.toUpperCase()}\n${pathQ}\n${u.hostname.toLowerCase()}\n${port}\n${hash}\n`;
  const ext = p('extraData');
  if (ext) base += `${ext}\n`;
  const app = p('app');
  if (app) base += `${app}\n${p('dlg') ?? ''}\n`;
  const mac = H(base, key).toString(CryptoJS.enc.Base64);

  const parts = [
    `id="${id}"`, `ts="${ts}"`, `nonce="${nonce}"`, `mac="${mac}"`,
    hash ? `hash="${hash}"` : null,
    ext ? `ext="${ext.replace(/"/g, '\\"')}"` : null,
    app ? `app="${app}"` : null,
    (app && p('dlg')) ? `dlg="${p('dlg')}"` : null,
  ].filter(Boolean);
  return { headers: [{ key: 'Authorization', value: `Hawk ${parts.join(', ')}` }], note: null };
}