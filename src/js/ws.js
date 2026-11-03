// WebSocket support on request tabs: protocol toggle, live frame log.

import { isDesktop } from './bridge.js';
import { emit } from './store.js';

export const MAX_FRAMES = 200;

export function isWs(url) {
  return /^(ws|wss):/i.test(url);
}

export function toWsUrl(url) {
  return /^http:/i.test(url) ? url.replace(/^http:/i, 'ws:') : /^https:/i.test(url) ? url.replace(/^https:/i, 'wss:') : url;
}

const channels = new Map(); // tabId → { status }

export function statusOf(t) {
  return t.wsConn?.status || 'disconnected';
}

/** Connect the tab's request as a WebSocket; frames append into t.wsConn.log. */
export async function connect(t, { outgoing, resolverReplaced }) {
  if (!isDesktop) throw 'WebSocket is desktop-only.';
  if (t.wsConn?.id) throw 'Already connected.';
  const headers = outgoing.headers
    .filter((x) => !['host'].includes(x.key.toLowerCase()))
    .map((x) => ({ key: x.key, value: x.value }));
  const settings = outgoing.settings || {};
  t.wsConn = { status: 'connecting', log: t.wsConn?.log || [] };
  emit('ws', 'tabs');

  const { Channel } = globalThis.__TAURI__?.core ?? {};
  if (!Channel) throw 'Core channel API missing.';
  const channel = new Channel();
  channel.onmessage = (ev) => {
    const c = t.wsConn;
    if (!c) return;
    if (ev.type === 'Open') {
      c.status = 'connected';
      c.id = ev.id;
    } else if (ev.type === 'Message') {
      c.log.push({ dir: 'in', text: ev.text, size: ev.size, at: ev.at, binary: ev.binary && true });
      if (c.log.length > MAX_FRAMES) c.log.splice(0, c.log.length - MAX_FRAMES);
    } else if (ev.type === 'Closed') {
      c.status = 'closed';
      c.closeCode = ev.code;
      c.closeReason = ev.reason;
      c.id = null;
    } else if (ev.type === 'Error') {
      c.status = 'error';
      c.error = ev.message;
      c.id = null;
    }
    emit('ws');
  };
  try {
    const id = await invokeConnect({ url: resolverReplaced, headers, verifySsl: settings.verifySsl ?? true, clientCert: settings.clientCert }, channel);
    return id;
  } catch (e) {
    t.wsConn.status = 'error';
    t.wsConn.error = String(e?.message || e);
    emit('ws');
    throw e;
  }
}

async function invokeConnect(opts, channel) {
  const args = { options: { url: opts.url, headers: opts.headers, verifySsl: opts.verifySsl, clientCert: opts.clientCert }, onEvent: channel };
  return globalThis.__TAURI__.core.invoke('ws_connect', args);
}

export async function sendFrame(t, text) {
  const c = t.wsConn;
  if (!c?.id) throw 'Not connected.';
  await globalThis.__TAURI__.core.invoke('ws_send', { id: c.id, text });
  c.log.push({ dir: 'out', text, size: new TextEncoder().encode(text).length, at: Date.now() });
  if (c.log.length > MAX_FRAMES) c.log.splice(0, c.log.length - MAX_FRAMES);
  emit('ws');
}

export async function closeConn(t, code) {
  const c = t.wsConn;
  if (!c?.id) throw 'Not connected.';
  await globalThis.__TAURI__.core.invoke('ws_close', { id: c.id, code: code ?? null }).catch(() => {});
  emit('ws');
}

