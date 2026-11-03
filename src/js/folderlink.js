// Keeps collections that are linked to a folder (see gitfs.js) in step with it:
// every change is written to the files, and edits made outside Dispatch (git
// pull, a teammate's commit, a text editor) are loaded back in.

import { bridge } from './bridge.js';
import * as S from './store.js';
import { state, emit } from './store.js';
import { ensureIds, uuid } from './model.js';
import { toast, errText, confirmDialog } from './ui/dom.js';

// The file format code loads only once a collection is linked to a folder.
const gitfs = () => import('./gitfs.js');

const timers = new WeakMap();
// Entries with a write queued or in flight: their folder is ours, not an outside edit.
const busy = new WeakSet();

export async function writeFolder(entry) {
  if (!entry.linkedDir || !entry.data) return;
  const G = await gitfs();
  const files = G.toFiles(entry.data, { paths: entry.folderPaths || {} });
  busy.add(entry);
  try {
    await bridge.folderWrite(entry.linkedDir, files, true);
    entry.folderSig = G.signature(files);
    entry.folderPaths = G.pathsOf(files);
    if (entry.folderError) { delete entry.folderError; emit('sidebar'); }
  } catch (e) {
    entry.folderError = errText(e);
    emit('sidebar');
    throw e;
  } finally {
    if (!timers.get(entry)) busy.delete(entry);
  }
  S.saveWorkspace();
}

function scheduleWrite(entry) {
  if (!entry.linkedDir) return;
  clearTimeout(timers.get(entry));
  busy.add(entry);
  timers.set(entry, setTimeout(() => {
    timers.delete(entry);
    writeFolder(entry).catch((e) => toast(`Couldn't save "${entry.name}" to its folder: ${errText(e)}`, { error: true }));
  }, 400));
}
S.collectionHooks.add(scheduleWrite);

/** Save a collection into a folder and keep it there. */
export async function linkToFolder(entry) {
  await S.ensureCollection(entry);
  const dir = await bridge.pickFolder();
  if (!dir) return false;
  const existing = (await gitfs()).ownFiles(await bridge.folderRead(dir));
  if (existing.some((f) => f.path === 'collection.json')) {
    const choice = await confirmDialog({
      title: 'This folder already has a collection',
      message: `Load the version in the folder into "${entry.name}", or overwrite the folder with what's in Dispatch?`,
      confirm: 'Overwrite folder', danger: true,
      extra: { label: 'Load from folder', value: 'load' },
    });
    if (!choice) return false;
    entry.linkedDir = dir;
    if (choice === 'load') { await applyFolder(entry, existing); return true; }
  }
  entry.linkedDir = dir;
  await writeFolder(entry);
  toast(`"${entry.name}" now saves to ${dir}`);
  emit('sidebar');
  return true;
}

/** Create a collection from a folder written by Dispatch (e.g. a cloned repo). */
export async function openFolder() {
  const dir = await bridge.pickFolder();
  if (!dir) return null;
  const G = await gitfs();
  const own = G.ownFiles(await bridge.folderRead(dir));
  const taken = (state.ws.collections || []).find((c) => c.linkedDir === dir);
  if (taken) throw new Error(`That folder is already linked to "${taken.name}".`);
  const data = ensureIds(G.fromFiles(own));
  const entry = { uid: `local-${uuid()}`, name: data.info.name, data, dirty: !!S.isCloud(), updatedAt: null, pendingCreate: S.isCloud(), localUpdatedAt: Date.now(), linkedDir: dir, folderSig: G.signature(own), folderPaths: G.pathsFromTree(data) };
  state.ws.collections.push(entry);
  S.saveWorkspace();
  emit('sidebar');
  if (S.isCloud() && state.hasKey) await S.pushCollection(entry);
  return entry;
}

export function unlinkFolder(entry) {
  const dir = entry.linkedDir;
  delete entry.linkedDir;
  delete entry.folderSig;
  delete entry.folderPaths;
  delete entry.folderError;
  const stillUsed = (state.ws?.collections || []).some((c) => c.linkedDir === dir);
  if (dir && !stillUsed) bridge.folderForget(dir).catch(() => {});
  S.saveWorkspace();
  emit('sidebar');
}

async function applyFolder(entry, own) {
  const G = await gitfs();
  const data = ensureIds(G.fromFiles(own));
  entry.data = data;
  entry.folderSig = G.signature(own);
  // Hand-added files get ids now; remember their names so the rewrite keeps them.
  entry.folderPaths = G.pathsFromTree(data);
  await S.collectionChanged(entry); // rewrites the files in canonical form and pushes if syncing
  emit('tabs-refresh');
}

let checking = false;
/** Reload linked collections whose files changed outside Dispatch. */
export async function checkFolders() {
  if (checking || !state.ws) return;
  checking = true;
  try {
    for (const entry of state.ws.collections || []) {
      if (!entry.linkedDir || busy.has(entry)) continue;
      const G = await gitfs();
      let own;
      try { own = G.ownFiles(await bridge.folderRead(entry.linkedDir)); } catch (e) {
        if (entry.folderError !== errText(e)) { entry.folderError = errText(e); emit('sidebar'); }
        continue;
      }
      if (!own.length || G.signature(own) === entry.folderSig) continue;
      try {
        await applyFolder(entry, own);
        toast(`Loaded changes to "${entry.name}" from its folder`);
      } catch (e) {
        entry.folderError = errText(e);
        emit('sidebar');
        toast(`"${entry.name}"'s folder has a problem: ${errText(e)}`, { error: true });
      }
    }
  } finally { checking = false; }
}
