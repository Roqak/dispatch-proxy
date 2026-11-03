// The vault: secrets referenced as {{vault:name}}. All values sit in one OS
// keychain item (one access prompt at most); settings only list the names, so
// nothing is read from the keychain until there is something to read.

import { bridge } from './bridge.js';
import { state, saveSettings, emit } from './store.js';
import { setVault, vaultNames } from './vars.js';

const SLOT = 'vault';
let values = {};
let loaded = false;

export const VAULT_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

export async function loadVault() {
  if (loaded) return;
  if (!(state.settings.vaultKeys || []).length) { loaded = true; return; }
  const raw = await bridge.secretGet(SLOT);
  try { values = raw ? JSON.parse(raw) : {}; } catch { values = {}; }
  loaded = true;
  setVault(values);
}

async function persist() {
  const names = Object.keys(values).sort();
  await bridge.secretPut(SLOT, names.length ? JSON.stringify(values) : '');
  state.settings.vaultKeys = names;
  saveSettings();
  setVault(values);
  emit('env-values', 'sidebar');
}

export async function setSecret(name, value, previousName) {
  if (!VAULT_NAME.test(name)) throw new Error('Vault names can use letters, digits, ".", "_" and "-" (up to 64).');
  await loadVault();
  if (previousName && previousName !== name) delete values[previousName];
  values[name] = String(value ?? '');
  await persist();
}

export async function deleteSecret(name) {
  await loadVault();
  delete values[name];
  await persist();
}

export async function revealSecret(name) {
  await loadVault();
  return values[name] ?? '';
}

export const secretNames = () => (loaded ? vaultNames() : [...(state.settings.vaultKeys || [])]);

/** Parse a .env file into { NAME: value } (quotes, export prefixes and comments handled). */
export function parseDotEnv(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z0-9_.-]+)\s*=\s*(.*)?\s*$/.exec(line);
    if (!m) continue;
    let v = (m[2] || '').trim();
    if (/^"(.*)"$/s.test(v)) v = v.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"');
    else if (/^'(.*)'$/s.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    out[m[1]] = v;
  }
  return out;
}

export async function importDotEnv(text) {
  const parsed = parseDotEnv(text);
  const names = Object.keys(parsed);
  if (!names.length) throw new Error('No NAME=value lines found.');
  await loadVault();
  Object.assign(values, parsed);
  await persist();
  return names.length;
}
