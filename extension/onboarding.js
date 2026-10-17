import { serverOrigin } from './invitation.js';
import { GITHUB_ORIGINS } from './github-updates.js';

// Step-by-step first run inside the popup. Every step is resumable: the
// native permission dialog closes the popup, so progress is stored before
// each request and the step re-checks its own state when the popup reopens.
export const ONBOARDING_STEPS = ['welcome', 'permission', 'server', 'updates', 'appearance', 'done'];
export const ONBOARDING_VERSION = 1;
const ALL_SITES = { origins: ['https://*/*', 'http://*/*'] };

export function onboardingPending(stored) {
  return !stored || typeof stored !== 'object' || !stored.completedAt;
}

export async function checkServerHealth(origin, fetchImpl = fetch, timeoutMs = 4000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${origin}/health`, { signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!response.ok) return { ok: false, message: `Der Server antwortet mit Status ${response.status}.` };
    const body = await response.json().catch(() => null);
    if (body?.ok !== true) return { ok: false, message: 'Unter dieser Adresse läuft kein Video-Sync-Server.' };
    return { ok: true, protocol: body.protocol };
  } catch (error) {
    return { ok: false, message: error.name === 'AbortError' ? 'Der Server hat nicht rechtzeitig geantwortet.' : 'Der Server ist nicht erreichbar. Adresse und Verbindung prüfen.' };
  } finally { clearTimeout(timer); }
}

export function mountOnboarding(root, {
  storage = chrome.storage.local, permissions = chrome.permissions, request, serverSetting, setTheme, setChannel,
  channels = () => [{ value: 'stable', label: 'Stable' }, { value: 'experimental', label: 'Experimental' }],
  onChange = () => {}, fetchImpl = fetch
}) {
  // Step panels live in `root`; the step buttons sit in the shared action bar below <main>.
  const $ = id => root.ownerDocument.getElementById(`onboarding-${id}`);
  const text = (id, value) => { const node = $(id); if (node && node.textContent !== value) node.textContent = value; };
  let state = { version: ONBOARDING_VERSION, step: 0, completedAt: null, skipped: false };
  let active = false, busy = false, current = null;
  let allSites = false, githubAllowed = false, serverCheck = null, hasToken = false, message = '';

  async function persist(patch) {
    state = { ...state, ...patch, version: ONBOARDING_VERSION };
    await storage.set({ onboarding: state });
  }
  async function load() {
    const { onboarding } = await storage.get('onboarding');
    if (onboarding && typeof onboarding === 'object') state = { ...state, ...onboarding };
    if (!Number.isInteger(state.step) || state.step < 0 || state.step >= ONBOARDING_STEPS.length) state.step = 0;
  }
  async function refreshPermission() {
    [allSites, githubAllowed] = await Promise.all([permissions.contains(ALL_SITES), permissions.contains(GITHUB_ORIGINS)]);
  }

  function stepName() { return ONBOARDING_STEPS[state.step]; }

  async function go(step) {
    message = ''; serverCheck = null;
    await persist({ step: Math.max(0, Math.min(ONBOARDING_STEPS.length - 1, step)) });
    if (['permission', 'updates'].includes(stepName())) await refreshPermission();
    render();
    focusStep();
  }
  async function finish(skipped = false) {
    await persist({ completedAt: Date.now(), skipped, step: 0 });
    active = false;
    render();
    onChange({ completed: true });
  }

  function focusStep() {
    const panel = root.querySelector(`[data-step="${stepName()}"]`);
    // Inputs inside a closed optional section (the GitHub token) are not focus targets.
    const target = [...(panel?.querySelectorAll('input:not([hidden]), select') || [])].find(element => element.checkVisibility()) ||
      root.ownerDocument.querySelector(`[data-step-action="${stepName()}"].primary:not([hidden])`);
    (target || $('title'))?.focus({ preventScroll: false });
  }

  async function guarded(run) {
    if (busy) return;
    busy = true; message = ''; render();
    try { await run(); }
    catch (error) { message = error?.message || String(error); }
    finally { busy = false; render(); }
  }

  // ---- step actions ----
  $('start').onclick = () => go(1);
  $('later').onclick = () => finish(true);
  $('back').onclick = () => go(state.step - 1);
  $('allow').onclick = () => {
    if (busy) return;
    // The dialog closes the popup on most Chrome builds; the step is stored before the request.
    const permission = permissions.request(ALL_SITES);
    guarded(async () => {
      if (!await permission) throw new Error('Die Freigabe wurde nicht erteilt. Du kannst sie jederzeit hier oder beim Verbinden nachholen.');
      await refreshPermission();
      await go(2);
    });
  };
  $('permission-next').onclick = () => go(2);
  $('permission-skip').onclick = () => go(2);
  $('server').addEventListener('input', () => { serverCheck = null; message = ''; render(); });
  $('server-form').addEventListener('submit', event => {
    event.preventDefault();
    if (busy) return;
    let origin;
    try { origin = serverOrigin($('server').value); }
    catch (error) { message = error.message; render(); return; }
    const permission = allSites ? Promise.resolve(true) : permissions.request({ origins: [`${origin}/*`] });
    guarded(async () => {
      if (!await permission) throw new Error('Ohne Freigabe für den Server kann kein Raum erstellt werden.');
      serverCheck = await checkServerHealth(origin, fetchImpl);
      if (!serverCheck.ok) { message = serverCheck.message; return; }
      if (!await serverSetting.save(origin)) throw new Error(serverSetting.error);
      await go(3);
    });
  });
  $('server-anyway').onclick = () => guarded(async () => {
    const origin = serverOrigin($('server').value);
    if (!await serverSetting.save(origin)) throw new Error(serverSetting.error);
    await go(3);
  });
  $('token-form').addEventListener('submit', event => {
    event.preventDefault();
    if (busy) return;
    const token = $('token').value.trim();
    if (!token) { message = 'Bitte einen GitHub-Token einfügen. Er ist optional; Updates funktionieren auch ohne.'; render(); $('token').focus(); return; }
    const permission = permissions.request(GITHUB_ORIGINS);
    guarded(async () => {
      if (!await permission) throw new Error('Der Zugriff auf GitHub wurde nicht erlaubt.');
      githubAllowed = true;
      await request('update-configure', { token });
      $('token').value = '';
      hasToken = true;
      await go(4);
    });
  });
  // The token stays optional: public releases are checked without one. The
  // GitHub grant only enables downloads; the dialog may close the popup, and
  // the stored step resumes here.
  $('updates-allow').onclick = () => {
    if (busy) return;
    const permission = permissions.request(GITHUB_ORIGINS);
    guarded(async () => {
      if (!await permission) throw new Error('Der Zugriff wurde nicht erteilt. Chrome fragt sonst beim ersten Update erneut.');
      githubAllowed = true;
      await go(4);
    });
  };
  $('token').addEventListener('input', () => { message = ''; render(); });
  $('updates-skip').onclick = () => go(4);
  $('updates-next').onclick = () => go(4);
  $('theme').addEventListener('change', event => setTheme(event.target.value));
  $('channel').addEventListener('change', event => { const channel = event.target.value; guarded(() => setChannel(channel)); });
  $('appearance-next').onclick = () => go(5);
  $('finish').onclick = () => finish(false);

  function render() {
    if (!active) return;
    const step = stepName();
    root.setAttribute('aria-busy', String(busy));
    root.dataset.step = step;
    root.querySelectorAll('[data-step]').forEach(panel => { panel.hidden = panel.dataset.step !== step; });
    root.ownerDocument.querySelectorAll('[data-step-action]').forEach(button => { button.hidden = button.dataset.stepAction !== step; });
    $('stepper').querySelectorAll('.step-dot').forEach((dot, index) => {
      dot.dataset.state = index < state.step ? 'done' : index === state.step ? 'current' : 'todo';
    });
    $('stepper').setAttribute('aria-label', `Schritt ${state.step + 1} von ${ONBOARDING_STEPS.length}`);
    $('back').hidden = state.step === 0 || step === 'done';
    // permission
    $('allow').hidden = step !== 'permission' || allSites;
    $('permission-next').hidden = step !== 'permission' || !allSites;
    $('permission-skip').hidden = step !== 'permission' || allSites;
    $('permission-state').hidden = !allSites;
    $('allow').disabled = busy;
    // server
    if (document.activeElement !== $('server') && $('server').value !== serverSetting.draft && !$('server').value) $('server').value = serverSetting.saved;
    $('server').disabled = busy;
    $('server-check').disabled = busy;
    text('server-check', busy && step === 'server' ? 'Prüfen …' : 'Prüfen & weiter');
    $('server-anyway').hidden = step !== 'server' || !(serverCheck && !serverCheck.ok);
    $('server-ok').hidden = !(serverCheck && serverCheck.ok);
    // updates
    const tokenTyped = !hasToken && !!$('token').value.trim();
    $('token-details').hidden = hasToken;
    $('token-save').hidden = step !== 'updates' || !tokenTyped;
    $('updates-allow').hidden = step !== 'updates' || githubAllowed || tokenTyped;
    $('updates-next').hidden = step !== 'updates' || !githubAllowed || tokenTyped;
    $('updates-skip').hidden = step !== 'updates' || githubAllowed;
    $('updates-state').hidden = !githubAllowed && !hasToken;
    text('updates-state', hasToken ? '✓ Eigener GitHub-Token eingerichtet' : '✓ GitHub-Downloads erlaubt');
    $('token').disabled = busy;
    $('token-save').disabled = busy;
    $('updates-allow').disabled = busy;
    // appearance
    const options = channels();
    const key = JSON.stringify(options);
    if ($('channel').dataset.options !== key) {
      $('channel').replaceChildren(...options.map(option => new Option(option.label, option.value)));
      $('channel').dataset.options = key;
    }
    if (current?.channel && !busy) $('channel').value = current.channel;
    $('channel').disabled = busy;
    // message
    text('message', message);
    $('message').hidden = !message;
  }

  return {
    get active() { return active; },
    get step() { return state.step; },
    async init() {
      await load();
      active = onboardingPending(state);
      if (active) { await refreshPermission(); render(); }
      return active;
    },
    async open(step = 0) {
      await load();
      active = true;
      await go(step);
      onChange({ completed: false });
    },
    update(snapshot, { theme } = {}) {
      current = snapshot;
      hasToken = !!snapshot?.updates?.hasToken;
      if (theme && $('theme').value !== theme) $('theme').value = theme;
      if (active) render();
    },
    async refreshPermission() { await refreshPermission(); if (active) render(); }
  };
}
