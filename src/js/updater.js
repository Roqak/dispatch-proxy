// In-app updates via the updater plugin (withGlobalTauri exposes
// window.__TAURI__.updater and .process). Browser preview is a no-op.
//
// Checks on every launch and every few hours while the app is open; a found
// update shows a banner that stays until it's installed or dismissed, and
// installing restarts the app.

import { isDesktop } from './bridge.js';
import { h, toast, errText } from './ui/dom.js';

const UPD = globalThis.__TAURI__?.updater;
const RECHECK_MS = 4 * 60 * 60 * 1000;
const DISMISSED = 'updater-dismissed-version';
let pending = null; // the Update object waiting to be installed
let installing = false;
let banner = null;

export const currentVersion = async () => globalThis.__TAURI__?.app?.getVersion?.().catch(() => null) ?? null;

/** Asks the update server. Returns the update or null; throws only when `loud`. */
export async function checkOnce({ loud = false } = {}) {
  if (!isDesktop || !UPD) { if (loud) throw new Error('Updates only work in the desktop app.'); return null; }
  try {
    const update = await UPD.check();
    return update?.available === false ? null : update || null;
  } catch (e) {
    if (loud) throw e;
    return null; // offline or a broken endpoint: never bother the user
  }
}

function dismissed(version) {
  try { return localStorage.getItem(DISMISSED) === version; } catch { return false; }
}

function showBanner(update) {
  pending = update;
  banner?.remove();
  const status = h('span', { class: 'update-status' }, `Dispatch ${update.version} is available.`);
  const install = h('button', { class: 'btn primary sm', onclick: () => installUpdate(status, install, later) }, 'Update & restart');
  const later = h('button', { class: 'btn ghost sm', onclick: () => { try { localStorage.setItem(DISMISSED, update.version); } catch { /* fine */ } banner.remove(); banner = null; } }, 'Later');
  banner = h('div', { class: 'update-banner', role: 'status' }, status, install, later);
  document.body.append(banner);
}

async function installUpdate(status, install, later) {
  if (installing || !pending) return;
  installing = true;
  install.disabled = true;
  later.disabled = true;
  let total = 0;
  let got = 0;
  try {
    await pending.downloadAndInstall((ev) => {
      if (ev.event === 'Started') { total = ev.data?.contentLength || 0; status.textContent = `Downloading Dispatch ${pending.version}…`; }
      else if (ev.event === 'Progress') { got += ev.data?.chunkLength || 0; if (total) status.textContent = `Downloading Dispatch ${pending.version}… ${Math.min(100, Math.round((got / total) * 100))}%`; }
      else if (ev.event === 'Finished') status.textContent = 'Installing…';
    });
    status.textContent = 'Restarting…';
    await globalThis.__TAURI__.process.relaunch();
  } catch (e) {
    installing = false;
    install.disabled = false;
    later.disabled = false;
    install.textContent = 'Try again';
    status.textContent = `Update failed: ${errText(e)}`;
  }
}

async function backgroundCheck() {
  const update = await checkOnce();
  if (update && !dismissed(update.version) && pending?.version !== update.version) showBanner(update);
}

/** On launch, then every few hours while the app stays open. */
export function scheduleUpdateCheck() {
  if (!isDesktop || !UPD) return;
  backgroundCheck();
  setInterval(backgroundCheck, RECHECK_MS);
}

/** Settings → "Check for updates": always answers, and offers the update even if it was dismissed. */
export async function checkNow() {
  try {
    const update = await checkOnce({ loud: true });
    if (!update) { toast(`Dispatch ${(await currentVersion()) || ''} is up to date.`.replace('  ', ' ')); return; }
    try { localStorage.removeItem(DISMISSED); } catch { /* fine */ }
    showBanner(update);
  } catch (e) {
    toast(`Couldn't check for updates: ${errText(e)}`, { error: true });
  }
}
