// Renders live token values so the gallery always reflects tokens.css.
const styles = getComputedStyle(document.documentElement);
const roles = ['bg', 'surface', 'surface-muted', 'surface-hover', 'field', 'border', 'border-strong', 'text', 'text-muted', 'text-disabled',
  'accent', 'accent-hover', 'accent-active', 'on-accent', 'accent-soft', 'accent-soft-hover', 'focus', 'success',
  'warning', 'warning-surface', 'warning-border', 'danger', 'danger-hover', 'on-danger', 'danger-surface'];
const swatches = document.getElementById('swatches');
function renderSwatches() {
  const computed = getComputedStyle(document.documentElement);
  swatches.replaceChildren(...roles.map(role => {
    const item = document.createElement('div');
    item.className = 'swatch';
    const chip = document.createElement('div');
    chip.className = 'swatch-chip';
    chip.style.background = `var(--color-${role})`;
    const name = document.createElement('code');
    name.textContent = `--color-${role}`;
    const value = document.createElement('span');
    value.textContent = computed.getPropertyValue(`--color-${role}`).trim();
    item.append(chip, name, value);
    return item;
  }));
}
renderSwatches();

const spaces = document.getElementById('spaces');
for (const step of [1, 2, 3, 4, 5, 6, 7, 8]) {
  const item = document.createElement('div');
  item.className = 'space';
  const bar = document.createElement('div');
  bar.className = 'space-bar';
  bar.style.width = bar.style.height = `var(--space-${step})`;
  const label = document.createElement('span');
  label.textContent = `space-${step} · ${styles.getPropertyValue(`--space-${step}`).trim() || styles.getPropertyValue(`--size-${step}`).trim()}`;
  item.append(bar, label);
  spaces.append(item);
}

// Theme switch without chrome.storage: the page is a plain document.
const select = document.getElementById('guide-theme');
const media = matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  const value = select.value;
  document.documentElement.dataset.theme = value === 'system' ? (media.matches ? 'dark' : 'light') : value;
  requestAnimationFrame(renderSwatches);
}
select.addEventListener('change', applyTheme);
media.addEventListener('change', applyTheme);
