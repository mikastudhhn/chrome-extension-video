import { versionDisplayState } from './version-label.js';
import { mountDiagnostics } from './diagnostics-view.js';
import { fault, responseError } from './runtime-errors.js';
import { renderPopup, formatTime } from './popup-view.js';
import { StatusFeed, observeStatus } from './status-feed.js';
import { mountUpdates } from './updates.js';
import { ServerSetting, renderServerSetting } from './server-setting.js';
import { DEFAULT_SERVER } from './config.js';
import { createInvitation, parseInvitation, serverOrigin } from './invitation.js';
import { describeRoomError, readableError } from './errors.js';
import { mountOnboarding } from './onboarding.js';
import { STORE } from './distribution.js';

const $ = id => document.getElementById(id);
const diagnosticsView = mountDiagnostics($('diagnostics-panel'), { request: diagnosticRequest });
let current = null;
let pending = false;
let actionError = '';
let roomError = null;
let viewRevision = 0;
let frameAccess = null;
let playerChoices = null;
let titleRevision = 0;
const allSites = { origins: ['https://*/*', 'http://*/*'] };
let allSitesAllowed = false;
let controlQueue = Promise.resolve();
let queuedControls = 0;
let optimisticPlayback = null;
let pendingAction = '';
let actionRevision = 0;
let joinTouched = false;
// An invitation for a server other than the saved one waits for an explicit confirmation.
let serverConfirmation = null;
let copiedUntil = 0;
let displayedRoom = null;
let videoLabel = 'Ausgewählter Video-Tab';
let labelledTab = null;
let loaded = false;
let settingsOpen = false;
let updatesOpen = false;
let updatesView;
let serverSetting;
let onboarding;
const onboardingOpen = () => !!onboarding?.active && !settingsOpen;
let focusedControl;
let disabledFocus;
document.addEventListener('focusin', event => { focusedControl = event.target; disabledFocus = null; });
const text = (id, value) => { if ($(id).textContent !== value) $(id).textContent = value; };

function showSettings(open) {
  if (open !== settingsOpen) { viewRevision++; clearActionErrors(); }
  updatesOpen = false;
  $('updates-page').hidden = true;
  settingsOpen = open;
  $('player-page').hidden = open;
  $('player-actions').hidden = open;
  $('settings').hidden = !open;
  $('open-settings').setAttribute('aria-expanded', String(open));
  $(open ? 'settings-back' : 'open-settings').focus();
  if (open) void feed.refresh();
}
$('open-onboarding').addEventListener('click', () => { showSettings(false); void onboarding.open(0).then(render); });
function clearActionErrors() { actionError = ''; roomError = null; }
$('open-settings').addEventListener('click', () => { showSettings(!settingsOpen); render(); });
$('settings-back').addEventListener('click', () => { showSettings(false); render(); });
$('room-error-dismiss').addEventListener('click', () => {
  const action = roomError?.action || 'create';
  clearActionErrors(); render(); $(action).focus();
});
$('room-error-server').addEventListener('click', () => { showSettings(true); render(); $('server').focus(); $('server').select(); });
$('room-error-invitation').addEventListener('click', () => { clearActionErrors(); render(); $('code').focus(); $('code').select(); });
$('error-dismiss').addEventListener('click', () => { void act('dismiss-notice'); });
$('release-channel').addEventListener('change', event => act('set-channel', { channel: event.target.value }));
$('theme').addEventListener('change', event => { void chrome.storage.local.set({ theme: event.target.value }); });
function openUpdates() {
  showSettings(true);
  updatesOpen = true;
  $('settings').hidden = true;
  $('updates-page').hidden = false;
  updatesView ??= mountUpdates($('updates-content'), { readStatus: () => feed.refresh() });
  void updatesView.refresh(current);
  document.querySelector('main').scrollTop = 0;
  $('updates-back').focus();
  render();
}
$('updates-back').addEventListener('click', () => {
  showSettings(true); render(); $('open-updates').focus();
});
$('open-updates').addEventListener('click', openUpdates);
$('update-banner-details').addEventListener('click', openUpdates);
let updateBannerError = '';
$('update-banner-install').addEventListener('click', () => {
  if (pending || current?.updating) return;
  // The folder picker needs this click's activation: no other awaits before install().
  updatesView ??= mountUpdates($('updates-content'), { readStatus: () => feed.refresh() });
  updateBannerError = '';
  render();
  void updatesView.install(current).then(async result => {
    updateBannerError = result.ok ? '' : result.error || '';
    await feed.refresh();
    render();
  });
});
$('lab-start').addEventListener('click', () => {
  if (pending) return;
  // Permission request stays inside the explicit click. No microphone is requested.
  const permission = chrome.permissions.request({ permissions: ['tabCapture'] });
  attachAction(async () => {
    if (!await permission) throw new Error('Der Tab-Tonzugriff wurde nicht erlaubt.');
    current = await request('lab-start');
  });
});
$('lab-cancel').addEventListener('click', () => act('lab-cancel'));
$('lab-copy').addEventListener('click', async () => {
  try {
    const { outcome, message, duration, activeSeconds, rmsDb, sampleRate, completedAt } = current.lab;
    await navigator.clipboard.writeText(JSON.stringify({ version: current.engineVersion, browser: navigator.userAgent,
      outcome, message, duration, activeSeconds, rmsDb, sampleRate, completedAt }, null, 2));
    text('feedback', 'Diagnose kopiert. Enthält Messwerte, keine Tonaufnahme oder Raumdaten.');
  } catch { actionError = 'Die Diagnose konnte nicht kopiert werden.'; render(); }
});

const feed = new StatusFeed({
  prepare: versionDisplayState,
  request: (action, extra) => chrome.runtime.sendMessage({ target: 'background', type: 'ui', action, ...extra }),
  changed: state => { current = state; loaded = true; onboarding?.update(state, { theme: $('theme').value }); render(); if (updatesOpen) void updatesView.refresh(state); },
  failed: error => { actionError = error; render(); },
  visible: () => !document.hidden,
  observePlayer: () => !pending && !updatesOpen,
  interval: state => !state?.lifecycle ? 600 : state.room ? 1500
    : state.lab?.running || state.development || state.updating ? 1000
      : state.tabId != null && !updatesOpen ? 1500 : null
});
function commandContext() {
  return { expectedSession: current?.lifecycle, expectedEpoch: current?.room?.state?.epoch,
    expectedPlayer: current?.local ? { mediaId: current.local.mediaId, playerId: current.playerId, bindingId: current.bindingId } : undefined };
}
// Reports and deletion acknowledgements are not session snapshots.
async function diagnosticRequest(action, extra = {}) {
  const response = await chrome.runtime.sendMessage({ target: 'background', type: 'ui', action, ...extra });
  if (response?.ok !== true) throw responseError(response);
  if (!Object.hasOwn(response, 'result')) throw fault('INVALID_RESPONSE');
  return response.result;
}
function request(action, extra = {}) {
  if (['control', 'ready', 'resync'].includes(action)) extra = { ...commandContext(), ...extra };
  return feed.action(action, extra);
}

async function act(action, extra = {}) {
  if (pending && action !== 'leave') return;
  const operation = ++actionRevision;
  pending = true;
  pendingAction = action;
  clearActionErrors();
  const startedView = viewRevision;
  render();
  try {
    current = await request(action, extra);
    if (settingsOpen && (action === 'resync' || action === 'leave')) showSettings(false);
  }
  catch (error) { if (error.code !== 'ABORTED' && operation === actionRevision && startedView === viewRevision) actionError = error; }
  finally { if (operation === actionRevision) { pending = false; pendingAction = ''; render(); } }
}

// An invitation's server is used only for that join and never saved as the
// default. A server other than the saved one needs a confirmation click first.
async function roomAction(action, confirmed = null) {
  if (pending) return;
  const operation = ++actionRevision;
  const startedView = viewRevision;
  if (serverSetting.saving) return;
  let server = serverSetting.saved;
  pending = true;
  pendingAction = action;
  clearActionErrors();
  render();
  try {
    const invitation = action === 'join' ? parseInvitation($('code').value, serverSetting.saved) : null;
    server = invitation?.server || serverOrigin(serverSetting.saved);
    if (invitation && server !== serverOrigin(serverSetting.saved) &&
        (confirmed?.server !== server || confirmed.code !== invitation.code)) {
      serverConfirmation = { server, code: invitation.code };
      return;
    }
    serverConfirmation = null;
    // Still inside the click: Chrome only shows its permission dialog for a user gesture.
    const permission = chrome.permissions.request({ origins: [`${server}/*`] });
    if (!await permission) throw fault('PERMISSION_DENIED');
    current = await request(action, { server, code: invitation?.code });
  } catch (error) {
    if (error.code !== 'ABORTED' && operation === actionRevision && startedView === viewRevision) {
      roomError = describeRoomError(error, action, server);
      if (action === 'join') joinTouched = true;
    }
  } finally { if (operation === actionRevision) { pending = false; pendingAction = ''; render(); } }
}

async function attachVideo(tabId) {
  const response = await chrome.runtime.sendMessage({ target: 'background', type: 'discover-player', tabId });
  if (!response?.ok) throw responseError(response);
  const discovery = response.result;
  playerChoices = null;
  frameAccess = discovery.missingOrigins.length ? { tabId, origins: discovery.missingOrigins } : null;
  if (discovery.candidates?.length && (discovery.candidates.length > 1 || frameAccess)) {
    playerChoices = { tabId, candidates: discovery.candidates };
    const buttons = discovery.candidates.map((candidate, index) => {
      const button = document.createElement('button');
      button.className = 'secondary player-choice';
      button.textContent = `${index + 1}. ${candidate.label} · ${formatTime(candidate.time)} / ${formatTime(candidate.duration)} · ${candidate.origin}`;
      button.addEventListener('click', () => attachAction(async () => {
        current = await request('attach', { tabId, documentId: candidate.documentId, playerId: candidate.playerId });
        playerChoices = null; frameAccess = null;
        render(); $('show-video').focus();
      }));
      return button;
    });
    $('player-choices').replaceChildren(...buttons);
    render();
    return;
  }
  if (!discovery.documentId) {
    if (frameAccess) return;
    throw new Error('Kein geladenes Video gefunden. Video zuerst öffnen und kurz abspielen, dann erneut verbinden.');
  }
  current = await request('attach', { tabId, documentId: discovery.documentId, playerId: discovery.playerId });
}

$('cancel-player-choice').addEventListener('click', () => {
  playerChoices = null; frameAccess = null; render();
  $(current?.local ? 'change-video' : 'attach').focus();
});

function showVideoLabel(label) {
  videoLabel = label;
  text('player-description', label);
  $('show-video').title = label;
  $('show-video').setAttribute('aria-label', `Zum Video wechseln: ${label}`);
}

function updateVideoLabel(tab) {
  showVideoLabel(tab.title || (tab.url ? new URL(tab.url).hostname : 'Ausgewählter Video-Tab'));
}

chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (!current?.local || current.tabId !== tabId || (!('title' in change) && !('url' in change))) return;
  titleRevision++;
  updateVideoLabel(tab);
});

async function attachAction(run) {
  if (pending) return;
  const operation = ++actionRevision;
  pending = true;
  pendingAction = 'attach';
  clearActionErrors();
  const startedView = viewRevision;
  render();
  try { await run(); }
  catch (error) { if (error.code !== 'ABORTED' && operation === actionRevision && startedView === viewRevision) actionError = error; }
  finally {
    if (operation === actionRevision) {
      pending = false; pendingAction = ''; render();
      if (playerChoices && !actionError) $('player-choices').querySelector('button')?.focus();
    }
  }
}

const attachCurrentVideo = () => attachAction(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^https?:/.test(tab.url || '')) throw new Error('Öffne die Extension im Tab mit deinem Video.');
  await attachVideo(tab.id);
});
$('attach').addEventListener('click', attachCurrentVideo);
$('change-video').addEventListener('click', attachCurrentVideo);
async function showVideo() {
  if (!current?.tabId) return;
  try {
    const tab = await chrome.tabs.update(current.tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } catch { actionError = 'Der Video-Tab ist nicht mehr geöffnet. Verbinde dein Video erneut.'; render(); }
}
$('show-video').addEventListener('click', showVideo);
$('unblock').addEventListener('click', showVideo);
$('allow-all').addEventListener('click', () => {
  if (pending) return;
  // Keep the permission request in the click handler, before any async work.
  const permission = chrome.permissions.request(allSites);
  attachAction(async () => {
    if (!await permission) throw new Error('Die Freigabe wurde nicht erteilt. Du kannst weiterhin einzelne Player erlauben.');
    await refreshPermissions();
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id && /^https?:/.test(tab.url || '')) await attachVideo(tab.id);
  });
});
async function refreshPermissions() {
  allSitesAllowed = await chrome.permissions.contains(allSites);
  render();
}
chrome.permissions.onAdded.addListener(() => { void refreshPermissions(); void onboarding?.refreshPermission(); });
chrome.permissions.onRemoved.addListener(refreshPermissions);
$('allow-player').addEventListener('click', () => {
  if (!frameAccess || pending) return;
  const access = frameAccess;
  // Request directly from a fresh click so Chrome can show its site permission dialog.
  const permission = chrome.permissions.request({ origins: access.origins });
  attachAction(async () => {
    if (!await permission) throw new Error('Ohne Zugriff auf den eingebetteten Player kann das Video nicht verbunden werden.');
    await attachVideo(access.tabId);
  });
});
$('create').addEventListener('click', () => roomAction('create'));
$('join-form').addEventListener('submit', event => { event.preventDefault(); roomAction('join'); });
$('code').addEventListener('input', () => { joinTouched = false; serverConfirmation = null; clearActionErrors(); render(); });
$('server-confirm-join').addEventListener('click', () => { if (serverConfirmation) roomAction('join', serverConfirmation); });
$('server-confirm-cancel').addEventListener('click', () => { serverConfirmation = null; render(); $('code').focus(); });
$('code').addEventListener('blur', () => { joinTouched = true; render(); });
$('code').addEventListener('focus', () => render());
$('code').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('join-form').requestSubmit(); }
});
$('server').addEventListener('input', () => {
  serverSetting.edit($('server').value); clearActionErrors(); render();
});
$('server-settings').addEventListener('submit', async event => {
  event.preventDefault();
  const saving = serverSetting.save();
  renderServerSetting(serverSetting);
  const saved = await saving;
  render();
  $(saved ? 'server-feedback' : 'server').focus();
});
$('server-cancel').addEventListener('click', () => {
  serverSetting.cancel(); render(); $('server').focus();
});
for (const action of ['ready', 'resync', 'leave']) $(action).addEventListener('click', () => act(action));
document.querySelectorAll('[data-control]').forEach(button => button.addEventListener('click', () => {
  if (pending || !current?.room?.connected) return;
  const control = button.dataset.control;
  if (control === 'play' || control === 'pause') optimisticPlayback = control;
  const context = commandContext();
  queuedControls++;
  clearActionErrors();
  render();
  // Keep every click in order while allowing another click immediately.
  controlQueue = controlQueue.then(async () => {
    try { current = await request('control', { control, ...context }); }
    catch (error) { if (error.code !== 'ABORTED') actionError = error; }
    finally {
      if (--queuedControls === 0) optimisticPlayback = null;
      render();
    }
  });
}));
async function copyInvitation() {
  clearActionErrors();
  const startedView = viewRevision;
  try {
    await navigator.clipboard.writeText(createInvitation(current.room.code, current.room.server));
    copiedUntil = Date.now() + 2500;
    text('feedback', 'Einladung mit Raumcode und Serveradresse kopiert.');
    render();
  } catch {
    if (startedView === viewRevision) actionError = 'Kopieren nicht möglich. Bitte erneut versuchen oder die Einladung in den Einstellungen teilen.';
    render();
  }
}
$('copy').addEventListener('click', copyInvitation);
$('copy-again').addEventListener('click', copyInvitation);

function renderServerConfirmation(room, local) {
  const visible = !!serverConfirmation && !room && !!local && !settingsOpen;
  const wasHidden = $('server-confirm').hidden;
  $('server-confirm').hidden = !visible;
  if (!visible) return;
  text('server-confirm-title', `Unbekannter Server ${new URL(serverConfirmation.server).host} – beitreten?`);
  $('server-confirm-join').disabled = pending;
  $('server-confirm-cancel').disabled = pending;
  if (wasHidden) $('server-confirm-join').focus();
}

function render() {
  const activeBeforeRender = document.activeElement;
  diagnosticsView.update(current, pending);
  const local = current?.local, room = current?.room;
  showVideoLabel(videoLabel);
  if (local && labelledTab !== current.tabId) {
    labelledTab = current.tabId;
    const tabId = labelledTab;
    const revision = ++titleRevision;
    chrome.tabs.get(tabId).then(tab => {
      if (!current?.local || current.tabId !== tabId || titleRevision !== revision) return;
      updateVideoLabel(tab);
    }).catch(() => {});
  }
  if (!local) { labelledTab = null; titleRevision++; showVideoLabel('Ausgewählter Video-Tab'); }
  if (displayedRoom !== (room?.code || null)) {
    displayedRoom = room?.code || null;
    if (settingsOpen) showSettings(false);
    copiedUntil = 0;
  }
  renderPopup({ current, pending, pendingAction, loaded, settingsOpen, updatesOpen,
    allSitesAllowed, frameAccess, playerChoices, roomError, actionError, joinTouched, copiedUntil,
    queuedControls, optimisticPlayback, savedServer: serverSetting?.saved, updateBannerError, onboardingOpen: onboardingOpen() });
  renderServerConfirmation(room, local);
  $('onboarding').hidden = !onboardingOpen();
  $('onboarding-actions').hidden = !onboardingOpen();
  if (serverSetting) renderServerSetting(serverSetting);
  if (pending && focusedControl === activeBeforeRender && focusedControl?.disabled) disabledFocus = focusedControl;
  if (!pending && disabledFocus) {
    const origin = disabledFocus;
    disabledFocus = null;
    if (!updatesOpen && document.activeElement === document.body && origin.checkVisibility() && !origin.disabled) origin.focus();
  }
  // An async result may remove the initiating button. Move focus once to the
  // next task, without moving it on ordinary status or time updates.
  if (!pending && !updatesOpen && !onboardingOpen() && !serverSetting?.saving && focusedControl && (!focusedControl.checkVisibility() || focusedControl.disabled)) {
    const target = settingsOpen ? 'settings-back'
      : roomError ? 'room-error-dismiss' : playerChoices ? null
        : room ? ($('copy').checkVisibility() ? 'copy' : $('playback').checkVisibility() ? 'play' : 'status')
          : local ? 'create' : 'attach';
    if (target && !$(target).disabled) $(target).focus();
  }
}

const settings = await chrome.storage.local.get(['server', 'theme']);
$('theme').value = ['light', 'dark'].includes(settings.theme) ? settings.theme : 'system';
serverSetting = new ServerSetting(settings.server || DEFAULT_SERVER, server => chrome.storage.local.set({ server }));
renderServerSetting(serverSetting);
onboarding = mountOnboarding($('onboarding'), {
  request, serverSetting,
  setTheme: theme => { $('theme').value = theme; void chrome.storage.local.set({ theme }); },
  setChannel: channel => act('set-channel', { channel }),
  channels: () => current?.channels || [{ value: 'stable', label: 'Stable' }, { value: 'experimental', label: 'Experimental' }],
  onChange: ({ completed }) => {
    render();
    if (completed && allSitesAllowed && !current?.local) void attachAction(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id && /^https?:/.test(tab.url || '')) await attachVideo(tab.id);
    });
  }
});
await onboarding.init();
onboarding.update(current, { theme: $('theme').value });
observeStatus(feed);
await feed.refresh();
// Opening the popup also looks for updates; the background debounces this
// check. Installing still requires a click. Refresh only if the banner changes.
// Chrome updates Web Store installations itself.
if (!STORE) void chrome.runtime.sendMessage({ target: 'background', type: 'ui', action: 'update-check-opened' })
  .then(response => response?.ok && !!response.result?.available !== !!current?.updates?.available ? feed.refresh() : null).catch(() => {});
await refreshPermissions();
if (allSitesAllowed && !onboarding.active && !current?.local && !current?.recovery?.pending) {
  await attachAction(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id && /^https?:/.test(tab.url || '')) await attachVideo(tab.id);
  });
}
feed.arm();
