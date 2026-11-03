// Lazy loader for the larger bundled libraries, so they cost nothing until used.

const VENDOR = {
  marked: ['vendor/marked.min.js', () => globalThis.marked],
  purify: ['vendor/purify.min.js', () => globalThis.DOMPurify],
  handlebars: ['vendor/handlebars.min.js', () => globalThis.Handlebars],
  yaml: ['vendor/js-yaml.min.js', () => globalThis.jsyaml],
  pmlibs: ['vendor/postman-libs.min.js', () => globalThis.__pmLibs],
};
const loading = {};

/** Load a bundled library the first time something needs it. */
export function loadVendor(name) {
  const [src, get] = VENDOR[name];
  if (get()) return Promise.resolve(get());
  loading[name] = loading[name] || new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => (get() ? resolve(get()) : reject(new Error(`${name} didn't load`)));
    s.onerror = () => { delete loading[name]; reject(new Error(`Couldn't load ${src}`)); };
    document.head.append(s);
  });
  return loading[name];
}

