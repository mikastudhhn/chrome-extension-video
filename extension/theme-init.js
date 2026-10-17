// Classic script, loaded in <head> before the body paints: resolves the stored
// appearance ("light" | "dark" | "system") to a data-theme attribute. Views
// only write chrome.storage.local.theme; this script applies every change.
(() => {
  const root = document.documentElement;
  const media = matchMedia('(prefers-color-scheme: dark)');
  let preference = 'system';
  const apply = () => { root.dataset.theme = preference === 'system' ? (media.matches ? 'dark' : 'light') : preference; };
  const set = value => { preference = ['light', 'dark'].includes(value) ? value : 'system'; apply(); };
  apply();
  media.addEventListener('change', apply);
  if (globalThis.chrome?.storage?.local) {
    chrome.storage.local.get('theme').then(({ theme }) => set(theme)).catch(() => {});
    chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.theme) set(changes.theme.newValue); });
  }
})();
