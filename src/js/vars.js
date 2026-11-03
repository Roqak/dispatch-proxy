// Variable scopes and {{variable}} substitution, matching Postman's precedence:
// local (pm.variables) > environment > collection > global.

import { uuid } from './model.js';

const FIRST = ['James', 'Ada', 'Tunde', 'Mei', 'Lars', 'Priya', 'Kofi', 'Sofia'];
const LAST = ['Okafor', 'Smith', 'Chen', 'Garcia', 'Adeyemi', 'Novak', 'Khan', 'Rossi'];
const CITIES = ['Lagos', 'London', 'Nairobi', 'Toronto', 'Lisbon', 'Accra', 'Berlin', 'Austin'];
const STREETS = ['Marina Road', 'Oak Street', 'Allen Avenue', 'King Street', 'Harbour Lane', 'Mill Road'];
const COUNTRIES = [['Nigeria', 'NG'], ['United Kingdom', 'GB'], ['Kenya', 'KE'], ['Canada', 'CA'], ['Portugal', 'PT'], ['Ghana', 'GH'], ['Germany', 'DE'], ['United States', 'US']];
const CURRENCIES = [['NGN', 'Naira', '₦'], ['GBP', 'Pound Sterling', '£'], ['USD', 'US Dollar', '$'], ['EUR', 'Euro', '€'], ['KES', 'Kenyan Shilling', 'KSh'], ['GHS', 'Cedi', 'GH₵']];
const COMPANIES = ['Northwind', 'Bluefield', 'Copperleaf', 'Brightpath', 'Ironbridge', 'Silverline'];
const JOB_AREAS = ['Accounts', 'Operations', 'Marketing', 'Security', 'Integration', 'Research'];
const JOB_TYPES = ['Engineer', 'Manager', 'Analyst', 'Designer', 'Consultant', 'Specialist'];
const JOB_DESCRIPTORS = ['Senior', 'Lead', 'Principal', 'Junior', 'Chief', 'Regional'];
const PRODUCTS = ['Chair', 'Table', 'Keyboard', 'Shoes', 'Wallet', 'Lamp', 'Bottle'];
const ADJECTIVES = ['Sleek', 'Rustic', 'Ergonomic', 'Handmade', 'Compact', 'Durable'];
const MATERIALS = ['Steel', 'Wooden', 'Cotton', 'Leather', 'Granite', 'Plastic'];
const DEPARTMENTS = ['Books', 'Electronics', 'Garden', 'Grocery', 'Sports', 'Toys'];
const NOUNS = ['ledger', 'bridge', 'signal', 'account', 'payment', 'network', 'record'];
const VERBS = ['transfer', 'settle', 'verify', 'connect', 'process', 'confirm'];
const LOREM = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua'.split(' ');
const FILES = [['report', 'pdf', 'application/pdf'], ['photo', 'jpg', 'image/jpeg'], ['data', 'json', 'application/json'], ['notes', 'txt', 'text/plain'], ['sheet', 'csv', 'text/csv']];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const rint = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const hex = (n) => Array.from({ length: n }, () => '0123456789abcdef'[rint(0, 15)]).join('');
const digits = (n) => Array.from({ length: n }, () => rint(0, 9)).join('');
const words = (n) => Array.from({ length: n }, () => pick(LOREM)).join(' ');
const sentence = () => { const s = words(rint(5, 10)); return `${s[0].toUpperCase()}${s.slice(1)}.`; };
const daysFromNow = (d) => new Date(Date.now() + d * 86400000).toString();
const firstName = () => pick(FIRST);
const lastName = () => pick(LAST);
const userName = () => `${firstName()}.${lastName()}${rint(1, 99)}`.toLowerCase();

// Postman's dynamic variables, with small built-in word lists standing in for Faker.
export const DYNAMIC = {
  $guid: () => uuid(),
  $randomUUID: () => uuid(),
  $timestamp: () => String(Math.floor(Date.now() / 1000)),
  $isoTimestamp: () => new Date().toISOString(),
  $randomInt: () => String(rint(0, 1000)),
  $randomBoolean: () => String(Math.random() < 0.5),
  $randomAlphaNumeric: () => 'abcdefghijklmnopqrstuvwxyz0123456789'[rint(0, 35)],
  $randomColor: () => pick(['red', 'green', 'blue', 'black', 'white', 'orange', 'purple']),
  $randomHexColor: () => `#${hex(6)}`,
  $randomAbbreviation: () => pick(['API', 'HTTP', 'JSON', 'SQL', 'TCP', 'XML', 'SSL', 'USB']),
  // Names and people
  $randomFirstName: firstName,
  $randomLastName: lastName,
  $randomFullName: () => `${firstName()} ${lastName()}`,
  $randomNamePrefix: () => pick(['Mr.', 'Mrs.', 'Ms.', 'Dr.']),
  $randomNameSuffix: () => pick(['Jr.', 'Sr.', 'II', 'III']),
  $randomJobArea: () => pick(JOB_AREAS),
  $randomJobDescriptor: () => pick(JOB_DESCRIPTORS),
  $randomJobType: () => pick(JOB_TYPES),
  $randomJobTitle: () => `${pick(JOB_DESCRIPTORS)} ${pick(JOB_AREAS)} ${pick(JOB_TYPES)}`,
  // Contact and location
  $randomPhoneNumber: () => `${rint(200, 999)}-${rint(200, 999)}-${rint(1000, 9999)}`,
  $randomPhoneNumberExt: () => `${rint(1, 99)}-${rint(200, 999)}-${rint(200, 999)}-${rint(1000, 9999)}`,
  $randomCity: () => pick(CITIES),
  $randomStreetName: () => pick(STREETS),
  $randomStreetAddress: () => `${rint(1, 999)} ${pick(STREETS)}`,
  $randomCountry: () => pick(COUNTRIES)[0],
  $randomCountryCode: () => pick(COUNTRIES)[1],
  $randomLatitude: () => (Math.random() * 180 - 90).toFixed(4),
  $randomLongitude: () => (Math.random() * 360 - 180).toFixed(4),
  // Internet
  $randomEmail: () => `${userName()}@example.com`,
  $randomExampleEmail: () => `${userName()}@example.org`,
  $randomUserName: userName,
  $randomPassword: () => Array.from({ length: 15 }, () => 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'[rint(0, 55)]).join(''),
  $randomDomainWord: () => pick(COMPANIES).toLowerCase(),
  $randomDomainSuffix: () => pick(['com', 'net', 'org', 'io', 'info']),
  $randomDomainName: () => `${pick(COMPANIES).toLowerCase()}.${pick(['com', 'net', 'org', 'io'])}`,
  $randomUrl: () => `https://${pick(COMPANIES).toLowerCase()}.${pick(['com', 'net', 'org', 'io'])}`,
  $randomIP: () => Array.from({ length: 4 }, () => rint(1, 254)).join('.'),
  $randomIPV6: () => Array.from({ length: 8 }, () => hex(4)).join(':'),
  $randomMACAddress: () => Array.from({ length: 6 }, () => hex(2)).join(':'),
  $randomProtocol: () => pick(['http', 'https']),
  $randomSemver: () => `${rint(0, 9)}.${rint(0, 20)}.${rint(0, 20)}`,
  $randomLocale: () => pick(['en', 'fr', 'de', 'pt', 'es', 'yo', 'sw']),
  $randomUserAgent: () => pick(['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36']),
  $randomImageUrl: () => `https://picsum.photos/seed/${hex(8)}/640/480`,
  $randomAvatarImage: () => `https://i.pravatar.cc/150?u=${hex(8)}`,
  // Business and finance
  $randomCompanyName: () => `${pick(COMPANIES)} ${pick(['Ltd', 'Group', 'Labs', 'Partners'])}`,
  $randomCompanySuffix: () => pick(['Ltd', 'LLC', 'Inc', 'Group']),
  $randomCatchPhrase: () => `${pick(ADJECTIVES)} ${pick(NOUNS)} ${pick(['platform', 'solution', 'service'])}`,
  $randomBs: () => `${pick(VERBS)} ${pick(['scalable', 'real-time', 'secure'])} ${pick(NOUNS)}s`,
  $randomPrice: () => (Math.random() * 1000).toFixed(2),
  $randomBankAccount: () => digits(8),
  $randomBankAccountName: () => pick(['Savings Account', 'Current Account', 'Business Account', 'Checking Account']),
  $randomBankAccountBic: () => `${pick(['ABCD', 'BANK', 'FIRS', 'ZENI'])}${pick(COUNTRIES)[1]}${hex(2).toUpperCase()}`,
  $randomBankAccountIban: () => `GB${digits(2)}${pick(['NWBK', 'BARC', 'LOYD'])}${digits(14)}`,
  $randomCreditCardMask: () => digits(4),
  $randomTransactionType: () => pick(['deposit', 'withdrawal', 'payment', 'invoice']),
  $randomCurrencyCode: () => pick(CURRENCIES)[0],
  $randomCurrencyName: () => pick(CURRENCIES)[1],
  $randomCurrencySymbol: () => pick(CURRENCIES)[2],
  $randomBitcoin: () => `1${Array.from({ length: 33 }, () => '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'[rint(0, 57)]).join('')}`,
  // Products
  $randomProduct: () => pick(PRODUCTS),
  $randomProductAdjective: () => pick(ADJECTIVES),
  $randomProductMaterial: () => pick(MATERIALS),
  $randomProductName: () => `${pick(ADJECTIVES)} ${pick(MATERIALS)} ${pick(PRODUCTS)}`,
  $randomDepartment: () => pick(DEPARTMENTS),
  // Words and text
  $randomNoun: () => pick(NOUNS),
  $randomVerb: () => pick(VERBS),
  $randomIngverb: () => `${pick(VERBS).replace(/e$/, '')}ing`,
  $randomAdjective: () => pick(ADJECTIVES).toLowerCase(),
  $randomWord: () => pick([...NOUNS, ...VERBS]),
  $randomWords: () => words(rint(2, 4)),
  $randomPhrase: () => sentence(),
  $randomLoremWord: () => pick(LOREM),
  $randomLoremWords: () => words(3),
  $randomLoremSentence: sentence,
  $randomLoremSentences: () => Array.from({ length: rint(2, 4) }, sentence).join(' '),
  $randomLoremParagraph: () => Array.from({ length: rint(3, 5) }, sentence).join(' '),
  $randomLoremParagraphs: () => Array.from({ length: 3 }, () => Array.from({ length: rint(3, 5) }, sentence).join(' ')).join('\n\n'),
  $randomLoremText: () => Array.from({ length: rint(2, 4) }, sentence).join(' '),
  $randomLoremSlug: () => words(3).replace(/ /g, '-'),
  $randomLoremLines: () => Array.from({ length: rint(2, 4) }, sentence).join('\n'),
  // Files
  $randomFileName: () => { const f = pick(FILES); return `${f[0]}_${hex(4)}.${f[1]}`; },
  $randomFileExt: () => pick(FILES)[1],
  $randomFileType: () => pick(FILES)[2].split('/')[0],
  $randomMimeType: () => pick(FILES)[2],
  $randomCommonFileName: () => { const f = pick(FILES); return `${f[0]}.${f[1]}`; },
  $randomCommonFileExt: () => pick(FILES)[1],
  $randomCommonFileType: () => pick(FILES)[2].split('/')[0],
  $randomFilePath: () => `/home/${userName()}/${pick(FILES)[0]}.${pick(FILES)[1]}`,
  $randomDirectoryPath: () => `/${pick(['usr', 'var', 'opt', 'home'])}/${pick(NOUNS)}`,
  // Dates
  $randomDatePast: () => daysFromNow(-rint(1, 365)),
  $randomDateFuture: () => daysFromNow(rint(1, 365)),
  $randomDateRecent: () => daysFromNow(-Math.random() * 2),
  $randomMonth: () => pick(MONTHS),
  $randomWeekday: () => pick(WEEKDAYS),
  // Databases
  $randomDatabaseColumn: () => pick(['id', 'name', 'email', 'createdAt', 'updatedAt', 'status']),
  $randomDatabaseType: () => pick(['int', 'varchar', 'text', 'boolean', 'timestamp']),
  $randomDatabaseCollation: () => pick(['utf8_unicode_ci', 'utf8_general_ci', 'ascii_bin']),
  $randomDatabaseEngine: () => pick(['InnoDB', 'MyISAM', 'MEMORY', 'ARCHIVE']),
};

/**
 * A variable scope, modelled on Postman's "initial" vs "current" values.
 *
 * - `values` is the shared list that syncs with Postman (environment values use
 *   `enabled: false`, collection variables use `disabled: true`).
 * - `overlay` holds local current values. Scripts write here, so a token set by
 *   `pm.environment.set` never overwrites the shared value in your team's
 *   workspace. `null` in the overlay means "unset".
 */
export class Scope {
  constructor(values, overlay, onChange, name) {
    this.values = values || [];
    this.overlay = overlay || {};
    this.onChange = onChange || (() => {});
    this.name = name;
  }
  _initial(key) {
    return this.values.find((v) => v.key === key && v.enabled !== false && !v.disabled);
  }
  has(key) {
    if (Object.prototype.hasOwnProperty.call(this.overlay, key)) return this.overlay[key] !== null;
    return !!this._initial(key);
  }
  get(key) {
    if (Object.prototype.hasOwnProperty.call(this.overlay, key)) return this.overlay[key] ?? undefined;
    return this._initial(key)?.value;
  }
  set(key, value) {
    const str = typeof value === 'string' ? value : value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
    this.overlay[key] = str;
    this.onChange();
  }
  unset(key) {
    this.overlay[key] = null;
    this.onChange();
  }
  clear() {
    for (const v of this.values) this.overlay[v.key] = null;
    for (const k of Object.keys(this.overlay)) this.overlay[k] = null;
    this.onChange();
  }
  keys() {
    return [...new Set([...this.values.map((v) => v.key), ...Object.keys(this.overlay)])];
  }
  isSecret(key) {
    return this.values.find((v) => v.key === key)?.type === 'secret';
  }
  toObject() {
    const o = {};
    for (const k of this.keys()) if (this.has(k)) o[k] = this.get(k);
    return o;
  }
}

// Vault secrets, written as {{vault:name}}. They live in the OS keychain, never
// sync, and are only filled in when a request is actually sent: scripts, code
// snippets and copied cURL see the placeholder.
const vault = new Map();
export const VAULT_PREFIX = 'vault:';
export function setVault(entries) {
  vault.clear();
  for (const [k, v] of Object.entries(entries || {})) vault.set(k, String(v));
}
export const vaultNames = () => [...vault.keys()].sort();

export class Resolver {
  /** scopes: { local, environment, collection, globals } as Scope instances */
  constructor(scopes, { vault: useVault = true } = {}) {
    this.scopes = scopes;
    this.order = ['local', 'data', 'environment', 'collection', 'globals'];
    this.useVault = useVault;
  }
  /** The same scopes, with {{vault:…}} left unresolved (for scripts and snippets). */
  withoutVault() {
    return this.useVault ? new Resolver(this.scopes, { vault: false }) : this;
  }
  lookup(name) {
    if (name.startsWith(VAULT_PREFIX)) {
      const key = name.slice(VAULT_PREFIX.length).trim();
      return this.useVault && vault.has(key) ? { value: vault.get(key), scope: 'vault', secret: true } : null;
    }
    for (const s of this.order) {
      const sc = this.scopes[s];
      if (sc?.has(name)) return { value: sc.get(name), scope: s, secret: !!sc.isSecret?.(name) };
    }
    if (name.startsWith('$') && DYNAMIC[name]) return { value: DYNAMIC[name](), scope: 'dynamic' };
    return null;
  }
  /** Every variable name in reach, each with the scope that wins, then the dynamic ones. */
  names() {
    const seen = new Map();
    for (const s of this.order) {
      const sc = this.scopes[s];
      if (!sc) continue;
      for (const k of sc.keys()) if (k && !seen.has(k) && sc.has(k)) seen.set(k, { name: k, scope: s, value: sc.get(k), secret: !!sc.isSecret?.(k) });
    }
    const vaulted = this.useVault ? vaultNames().map((k) => ({ name: `${VAULT_PREFIX}${k}`, scope: 'vault', value: '', secret: true })) : [];
    return [...seen.values(), ...vaulted, ...Object.keys(DYNAMIC).map((k) => ({ name: k, scope: 'dynamic' }))];
  }
  /**
   * Replace {{vars}} in a string. Unknown variables are left as-is (like Postman).
   * With `mask`, secret values come out as dots, for showing on screen.
   */
  replace(str, depth = 0, { mask = false } = {}) {
    if (typeof str !== 'string' || !str.includes('{{')) return str;
    const out = str.replace(/\{\{([^{}]+?)\}\}/g, (m, name) => {
      const hit = this.lookup(name.trim());
      if (!hit) return m;
      return mask && hit.secret ? '••••••' : String(hit.value ?? '');
    });
    return depth < 5 && out !== str && out.includes('{{') ? this.replace(out, depth + 1, { mask }) : out;
  }
  unresolved(str) {
    const missing = [];
    String(str || '').replace(/\{\{([^{}]+?)\}\}/g, (m, name) => {
      if (!this.lookup(name.trim())) missing.push(name.trim());
      return m;
    });
    return missing;
  }
}

// ---------- current values in the editors ----------
// `rows` is a shared list (environment `values` or collection `variable`) and
// `overlay` its current values. `enabledKey` is 'enabled' for environments and
// globals, 'disabled' for collections.

/** Names that only have a current value, such as ones a script created with pm.environment.set. */
export function localOnlyKeys(rows, overlay) {
  return Object.keys(overlay).filter((k) => k && overlay[k] !== null && !rows.some((r) => r.key === k));
}

/**
 * Postman's "Persist": copy each current value into the shared value, adding
 * rows for names that only existed locally, then clear those current values.
 * Returns how many variables changed.
 */
export function persistCurrent(rows, overlay, enabledKey) {
  let n = 0;
  for (const k of Object.keys(overlay)) {
    if (!k || overlay[k] === null) continue;
    const row = rows.find((r) => r.key === k);
    if (row) { if (row.value !== overlay[k]) { row.value = overlay[k]; n++; } }
    else { rows.push({ key: k, value: overlay[k], type: 'default', ...(enabledKey === 'enabled' ? { enabled: true } : {}) }); n++; }
    delete overlay[k];
  }
  return n;
}

/** Postman's "Reset": drop every current value so the shared values apply again. */
export function resetCurrent(overlay) {
  for (const k of Object.keys(overlay)) delete overlay[k];
}
