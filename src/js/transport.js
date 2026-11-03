// Transport configuration (client certificates, proxy) resolved per request.

import { bridge } from './bridge.js';

export const CONFIG_STORE = 'certificates';

export const pwSlotKey = (host) => `cert-pw-${String(host).replace(/[^a-zA-Z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 78)}`;

const hostOf = (url) => {
  try { return new URL(url)?.hostname?.toLowerCase() || ''; } catch { return ''; }
};

/** Match an exact host first, then wildcard `*.example.com` entries. */
export function certForHost(hosts, host) {
  if (!host) return null;
  if (hosts[host]) return { host, cert: hosts[host] };
  for (const pattern of Object.keys(hosts)) {
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(1); // .example.com
      if (host.endsWith(suffix)) return { host, cert: hosts[pattern] };
    }
  }
  return null;
}

/**
 * Returns extra transport settings for a request URL:
 * { proxyUrl?, clientCert? } — undefined fields mean "nothing to add".
 */
export async function transportFor(url) {
  const cfg = (await bridge.read(CONFIG_STORE).catch(() => null)) || {};
  const out = {};
  const proxyUrl = (cfg.proxyUrl || '').trim();
  if (proxyUrl) out.proxyUrl = proxyUrl;
  const host = hostOf(url);
  const found = certForHost(cfg.hosts || {}, host);
  if (found?.cert?.path && found.cert.disabled !== true) {
    const password = (await bridge.secretGet(pwSlotKey(found.cert.slot || found.host)).catch(() => '')) || '';
    out.clientCert = { path: found.cert.path, password };
  }
  return out;
}