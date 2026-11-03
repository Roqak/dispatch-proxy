// The Vault tab: add, edit, reveal and remove {{vault:…}} secrets.

import { h, icon, toast, errText, confirmDialog, modal } from './dom.js';
import { loadVault, setSecret, deleteSecret, revealSecret, secretNames, importDotEnv, VAULT_NAME } from '../vault.js';

export function renderVaultTab(root) {
  const body = h('div', { class: 'pane' });
  const render = async () => {
    try { await loadVault(); } catch (e) {
      body.replaceChildren(h('div', { class: 'note err' }, icon('alert'), h('span', null, `Couldn't open the vault: ${errText(e)}`)));
      return;
    }
    const names = secretNames();
    const rows = names.map((name) => {
      const val = h('span', { class: 'mono vault-val' }, '••••••••');
      let shown = false;
      return h('tr', null,
        h('td', { class: 'mono' }, name),
        h('td', null, val),
        h('td', { class: 'vault-actions' },
          h('button', { class: 'icon-btn sm', title: 'Show or hide the value', onclick: async () => { shown = !shown; val.textContent = shown ? (await revealSecret(name)) || '(empty)' : '••••••••'; } }, icon('eye')),
          h('button', { class: 'icon-btn sm', title: 'Copy {{vault:…}} reference', onclick: async () => { await navigator.clipboard.writeText(`{{vault:${name}}}`); toast(`Copied {{vault:${name}}}`); } }, icon('copy')),
          h('button', { class: 'icon-btn sm', title: 'Edit', onclick: () => editor(name) }, icon('edit')),
          h('button', { class: 'icon-btn sm', title: 'Delete', onclick: async () => {
            if (!(await confirmDialog({ title: `Delete "${name}"?`, message: `Requests using {{vault:${name}}} will send the placeholder text instead.`, confirm: 'Delete', danger: true }))) return;
            await deleteSecret(name); render();
          } }, icon('trash'))));
    });
    body.replaceChildren(
      h('div', { class: 'row', style: { marginBottom: '12px' } },
        h('button', { class: 'btn sm primary', onclick: () => editor() }, icon('plus'), 'Add secret'),
        h('button', { class: 'btn sm', onclick: dotEnvDialog }, 'Import .env…'),
        h('span', { class: 'grow' })),
      names.length
        ? h('table', { class: 'kv vault-table' }, h('thead', null, h('tr', null, h('th', null, 'Name'), h('th', null, 'Value'), h('th'))), h('tbody', null, rows))
        : h('div', { class: 'md-empty' }, 'No secrets yet. Add API keys, tokens and passwords here instead of in environments.'),
      h('p', { class: 'hint' }, 'Use ', h('span', { class: 'mono' }, '{{vault:name}}'), ' in any URL, header, body or auth field. Values stay in your system keychain: they never sync to Postman, aren\'t exported, aren\'t readable from scripts, and code snippets and copied cURL show the placeholder.'));
  };

  const editor = (name = '') => {
    const nameIn = h('input', { class: 'input mono', value: name, placeholder: 'stripe_key', spellcheck: 'false' });
    const valIn = h('input', { class: 'input mono', type: 'password', placeholder: name ? 'Leave empty to keep the current value' : 'Value', spellcheck: 'false', autocomplete: 'off' });
    const err = h('p', { class: 'hint', style: { color: 'var(--err)', minHeight: '16px', margin: '6px 0 0' } });
    modal({
      title: name ? `Edit ${name}` : 'Add secret',
      body: h('div', null, h('div', { class: 'form-grid' }, h('label', null, 'Name'), nameIn, h('label', null, 'Value'), h('div', { class: 'row' }, h('div', { class: 'grow' }, valIn), h('button', { class: 'icon-btn', title: 'Show', onclick: () => { valIn.type = valIn.type === 'password' ? 'text' : 'password'; } }, icon('eye')))), err),
      actions: [{ label: 'Cancel' }, { label: 'Save', primary: true, onClick: async () => {
        const n = nameIn.value.trim();
        if (!VAULT_NAME.test(n)) { err.textContent = 'Use letters, digits, ".", "_" and "-" only.'; return false; }
        if (n !== name && secretNames().includes(n)) { err.textContent = `"${n}" already exists.`; return false; }
        try {
          const value = valIn.value === '' && name ? await revealSecret(name) : valIn.value;
          await setSecret(n, value, name || undefined);
          toast(`Saved {{vault:${n}}}`);
          render();
        } catch (e) { err.textContent = errText(e); return false; }
        return true;
      } }],
    });
  };

  const dotEnvDialog = () => {
    const ta = h('textarea', { class: 'textarea mono', rows: 8, spellcheck: 'false', placeholder: 'API_KEY=sk_live_…\nexport DB_PASSWORD="…"' });
    modal({
      title: 'Import a .env file',
      body: h('div', null, ta, h('p', { class: 'hint' }, 'Paste the file\'s contents. Each NAME=value becomes {{vault:NAME}}; existing names are replaced.')),
      actions: [{ label: 'Cancel' }, { label: 'Import', primary: true, onClick: async () => {
        try { const n = await importDotEnv(ta.value); toast(`Imported ${n} secret${n === 1 ? '' : 's'}`); render(); } catch (e) { toast(errText(e), { error: true }); return false; }
        return true;
      } }],
    });
  };

  root.replaceChildren(
    h('div', { class: 'crumbs' }, icon('key'), h('b', null, 'Vault'), h('span', { class: 'faint', style: { marginLeft: '6px' } }, 'stored in your keychain, never synced')),
    body);
  render();
}
