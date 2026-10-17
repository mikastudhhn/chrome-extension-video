// Included only in dist/development/extension, never in release packages.

export async function createDevelopmentSession({ build, selectedChannel, reload }) {
  const helper = build.local?.helper;
  if (!helper) return null;
  let online = false, latest = null, reloading = false, reloadError = '';
  let paused = !!(await chrome.storage.local.get('devPaused')).devPaused;
  let polling;

  const status = () => ({ online, paused, branch: latest?.branch || build.local.branch,
    state: !online ? 'offline' : reloadError || latest?.error ? 'error' : reloading || latest?.state === 'building' ? 'building' : 'live',
    error: reloadError || latest?.error || '',
    ready: online && latest?.state === 'ready' && !latest?.error,
    pending: !!latest?.buildId && latest.buildId !== build.local.buildId });

  async function refresh() {
    if (polling) return polling;
    polling = (async () => {
      try {
        const response = await fetch(`${helper.origin}/status`, { cache: 'no-store',
          headers: { Authorization: `Bearer ${helper.token}` }, signal: AbortSignal.timeout(1500) });
        if (!response.ok) throw new Error('Dev-Helfer nicht erreichbar.');
        latest = await response.json();
        online = true;
      } catch { online = false; }
      return status();
    })().finally(() => { polling = null; });
    return polling;
  }

  async function tick() {
    try {
      await refresh();
      // The storage API also keeps the development service worker awake while polling.
      const channel = await selectedChannel();
      if (!reloading && !paused && !reloadError && channel === 'local' && online &&
          latest.state === 'ready' && !latest.error && status().pending) {
        reloading = true;
        try { if (!await reload()) reloading = false; }
        catch (error) { reloadError = error.message; reloading = false; }
      }
    } finally { setTimeout(tick, 1000); }
  }
  void tick();
  return { status, refresh,
    async setPaused(value) {
      paused = !!value; reloadError = '';
      await chrome.storage.local.set({ devPaused: paused });
    }
  };
}

export function renderDevelopment(state, action, panel = document.getElementById('development-controls')) {
  const prefix = panel?.id === 'updates-development-controls' ? 'updates-' : '';
  if (!panel || !state?.development) return;
  const dev = state.development;
  panel.hidden = !dev.online && state.channel !== 'local';
  if (!panel.firstChild) {
    const label = document.createElement('p');
    label.id = `${prefix}dev-status`; label.style.overflowWrap = 'anywhere'; label.className = 'hint'; label.setAttribute('role', 'status');
    const pause = document.createElement('button');
    pause.id = `${prefix}dev-pause`; pause.className = 'text-button full-width';
    pause.onclick = () => action('dev-pause', { paused: pause.getAttribute('aria-pressed') !== 'true' });
    const reload = document.createElement('button');
    reload.id = `${prefix}local-reload`; reload.className = 'text-button full-width';
    reload.textContent = 'Jetzt neu laden'; reload.onclick = () => action('local-reload');
    panel.append(label, pause, reload);
  }
  const labels = { offline: 'Dev offline', error: 'Build fehlgeschlagen', building: 'Wird aktualisiert …', live: 'Live' };
  const status = panel.querySelector(`#${prefix}dev-status`);
  const detail = dev.error || (state.channel !== 'local' ? 'Dev auswählen, um lokale Änderungen zu testen.' :
    dev.paused ? `Auto-Reload pausiert${dev.pending ? ' · Änderung bereit' : ''}` : 'Änderungen werden automatisch übernommen.');
  status.textContent = `${labels[dev.state]} · ${detail}`;
  const pause = panel.querySelector(`#${prefix}dev-pause`);
  pause.textContent = dev.paused ? 'Auto-Reload fortsetzen' : 'Auto-Reload pausieren';
  pause.setAttribute('aria-pressed', String(dev.paused));
  pause.hidden = state.channel !== 'local';
  const reload = panel.querySelector(`#${prefix}local-reload`);
  reload.hidden = state.channel !== 'local';
  reload.disabled = !dev.ready;
}
