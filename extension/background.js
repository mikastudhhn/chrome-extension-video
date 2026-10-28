import { createOffscreenHost } from './offscreen-host.js';
import { fault, errorResponse, responseError } from './runtime-errors.js';
import { discoverPlayer, callPlayer } from './player-frames.js';
import { channelName, channelOptions, validateChannelSwitch } from './channels.js';
import { checkUpdates, configureUpdates, updateStatus, UPDATE_INTERVAL_MINUTES } from './update-service.js';
import { stored } from './update-storage.js';
import { recovery, updateRecovery, completeUpdate } from './background-updates.js';
import { featuresFor } from './features.js';
import { createDevelopmentSession } from './development.js';
import { STORE } from './distribution.js';
import { DEFAULT_SERVER } from './config.js';
import { buildErrorReport, sendErrorReport, clientInfo, browserInfo, REPORT_LIMITS } from './error-report.js';

let uiQueue = Promise.resolve();
let uiGeneration = 0;
let exclusiveRunning = false;
const buildInfo = fetch(chrome.runtime.getURL('build-info.json')).then(response => response.json()).then(build => {
  if (!build || typeof build !== 'object' || Array.isArray(build)) throw new Error('Build-Metadaten nicht lesbar.');
  return build;
}).catch(() => ({ unreadable: true }));
// Every player call checks the update lock, and status reads the channel. Keep
// both in memory and follow storage changes instead of reading per message.
let storedChannel = null, storedUpdateLock = null;
const cached = (key, area) => area.get(key).then(value => value[key]);
const readChannel = () => storedChannel ??= cached('channel', chrome.storage.local).catch(error => { storedChannel = null; throw error; });
const readUpdateLock = () => storedUpdateLock ??= cached('updateLock', chrome.storage.session).catch(error => { storedUpdateLock = null; throw error; });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.channel) storedChannel = Promise.resolve(changes.channel.newValue);
  if (area === 'session' && changes.updateLock) storedUpdateLock = Promise.resolve(changes.updateLock.newValue);
});
const selectedChannel = async () => channelName(await readChannel(), await buildInfo);
const development = buildInfo.then(build => createDevelopmentSession({ build, selectedChannel, reload: queueDevelopmentReload }));
const features = async () => featuresFor((await buildInfo).channel);
const { ensureOffscreen, readStatus, runtimeRequest, labRequest } = createOffscreenHost({ features });
void restoreDevelopment();
void chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || (sender.tab && !sender.url?.startsWith(chrome.runtime.getURL('')))) return;
  if (message.target !== 'background') return;
  // Leave/replace must interrupt a pending join or browser operation. Status
  // reads and player callbacks never wait behind a user mutation.
  const ui = message.type === 'ui';
  const interrupt = ui && !exclusiveRunning && ['leave', 'attach'].includes(message.action);
  if (interrupt) { uiGeneration++; uiQueue = Promise.resolve(); }
  const generation = uiGeneration;
  const guard = () => { if (ui && generation !== uiGeneration) throw fault('ABORTED'); };
  // A report upload may take seconds; it must not hold back room actions.
  const serialize = ui && !['status', 'update-status', 'update-check', 'update-check-opened', 'update-configure', 'diagnostics-report'].includes(message.action);
  const exclusive = ui && ['set-channel', 'local-reload', 'update-install', 'update-restore', 'update-verify-repair'].includes(message.action);
  const run = async () => {
    guard();
    if (exclusive) exclusiveRunning = true;
    try { return await handle(message, sender, guard); }
    finally { if (exclusive) exclusiveRunning = false; }
  };
  const result = serialize ? uiQueue.then(run) : run();
  if (serialize) uiQueue = result.catch(() => {});
  result.then(result => respond({ ok: true, result }), error => respond(errorResponse(error)));
  return true;
});

async function handle(message, sender, guard = () => {}) {
  await updateRecovery;
  const build = await buildInfo;
  const dev = await development;
  const updateLock = await readUpdateLock();
  if (updateLock && !['status', 'update-status'].includes(message.action)) throw new Error('Ein Update läuft. Bitte zuerst abschließen.');
  if (message.type === 'ui' && (message.action === 'update-status' || (message.action === 'status' && recovery.pending))) {
    return { ...await updateViewStatus(build, dev, updateLock), notice: recovery.message || '' };
  }
  if (recovery.pending && !['update-install', 'update-restore', 'update-verify-repair', 'update-check', 'update-configure'].includes(message.action)) {
    throw new Error(recovery.message);
  }
  if (message.type === 'discover-player' || message.type === 'player') {
    return message.type === 'player' ? callPlayer(message) : discoverPlayer(message.tabId);
  }
  if (message.type === 'ui') {
    let channel = await selectedChannel();
    const audio = featuresFor(build.channel).audioDiagnostics;
    if (['diagnostics-export', 'diagnostics-clear'].includes(message.action)) {
      if (sender.url !== chrome.runtime.getURL('popup.html')) throw fault('PERMISSION_DENIED');
      await ensureOffscreen();
      const version = chrome.runtime.getManifest().version;
      return runtimeRequest({ action: message.action, appVersion: version, engineVersion: version });
    }
    // Only after the person's click in the popup: the filtered diagnosis, the
    // reduced session state and their note go to the current or saved server.
    if (message.action === 'diagnostics-report') {
      if (sender.url !== chrome.runtime.getURL('popup.html')) throw fault('PERMISSION_DENIED');
      await ensureOffscreen();
      const manifest = chrome.runtime.getManifest();
      const [diagnostics, status, { server }] = await Promise.all([
        runtimeRequest({ action: 'diagnostics-export', appVersion: manifest.version, engineVersion: manifest.version }),
        runtimeRequest({ action: 'status' }), chrome.storage.local.get('server')]);
      const note = typeof message.note === 'string' ? message.note.slice(0, REPORT_LIMITS.noteChars) : '';
      const report = buildErrorReport({ diagnostics, status, client: clientInfo(manifest, build, STORE), browser: browserInfo(), note });
      return sendErrorReport(status.room?.server || server || DEFAULT_SERVER, report);
    }
    if (message.action === 'update-configure') {
      await configureUpdates(message.token);
      return checkUpdates(channel, build, true);
    }
    if (message.action === 'update-check') return checkUpdates(channel, build, true);
    // Declining a pending confirmation only clears the displayed review.
    if (message.action === 'update-dismiss') { await chrome.storage.session.remove('updateOperation'); return { ok: true }; }
    // Opening the popup is an automatic trigger: debounced like the alarm.
    if (message.action === 'update-check-opened') return checkUpdates(channel, build);
    if (['update-install', 'update-restore', 'update-verify-repair'].includes(message.action)) {
      if (STORE) throw new Error('Diese Installation aktualisiert Chrome über den Chrome Web Store.');
      if (![chrome.runtime.getURL('popup.html'), chrome.runtime.getURL('updates.html')].includes(sender.url)) {
        throw new Error('Updates nur in den Einstellungen starten.');
      }
      if (build.local || build.source) throw new Error('Lokale Entwicklungsbuilds und Quelldateien werden nicht überschrieben.');
      if (!recovery.pending) {
        await ensureOffscreen();
        const status = await runtimeRequest({ action: 'status' });
        if (status.room) throw new Error('Für ein Update zuerst den Raum verlassen.');
        if (audio) await labRequest('cancel');
      }
      if (recovery.blocked && message.action !== 'update-verify-repair') throw new Error(recovery.message);
      if (recovery.pending) {
        const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
        if (contexts.length) await chrome.offscreen.closeDocument();
      }
      const directory = await stored('directory');
      await chrome.storage.session.set({ updateLock: true, updateOperation: {
        message: message.action === 'update-verify-repair' ? 'Installation wird mit dem veröffentlichten Paket abgeglichen …' : recovery.pending || message.action === 'update-restore' ? 'Vorherige Version wird wiederhergestellt …' : 'Update wird geladen und geprüft …'
      } });
      storedUpdateLock = Promise.resolve(true);
      void completeUpdate({ channel, restore: message.action === 'update-restore', verifyRepair: message.action === 'update-verify-repair', directory,
        confirmation: message.action === 'update-install' && typeof message.confirmation === 'string' ? message.confirmation : undefined });
      return { ok: true };
    }
    let status;
    if (message.action === 'status') status = await readStatus(message, true);
    else await ensureOffscreen();
    if (message.action === 'dev-pause') {
      if (!dev) throw new Error('Kein lokaler Entwicklungsbuild.');
      await dev.setPaused(message.paused);
      message = { action: 'status' };
    }
    if (message.action === 'local-reload') {
      if (!dev || channel !== 'local') throw new Error('Zum Neuladen zuerst Dev auswählen.');
      const state = await dev.refresh();
      if (!state.online || state.state !== 'live') throw new Error('Der Dev-Helfer hat keinen fertigen Build.');
      await reloadDevelopment();
      return { ok: true };
    }
    if (message.action === 'set-channel') {
      if (STORE) throw new Error('Diese Installation aktualisiert Chrome über den Chrome Web Store.');
      // The channel only selects the release stream; room and video stay connected.
      const devState = dev ? await dev.refresh() : null;
      validateChannelSwitch(message.channel, build, devState, channel);
      if (message.channel === 'local' && channel !== 'local' && !devState?.ready) {
        throw new Error('Dev wird noch vorbereitet. Bitte auf einen erfolgreichen Build warten.');
      }
      if (channel !== message.channel) {
        await chrome.storage.local.set({ channel: message.channel });
        storedChannel = Promise.resolve(message.channel);
        channel = message.channel;
        void chrome.runtime.sendMessage({ target: 'session-observers', type: 'session-changed' }).catch(() => {});
        void checkUpdates(channel, build);
        // Selection is explicit even when automatic reload is paused.
        if (channel === 'local' && devState?.pending && devState.state === 'live') await reloadDevelopment();
      }
      message = { action: 'status' };
    }
    if (message.action === 'lab-start') {
      if (!audio) throw new Error('Der Tontest ist nur in Experimental-Paketen oder dem lokalen Branch verfügbar.');
      const status = await runtimeRequest({ action: 'status', observePlayer: true });
      if (!status.local || status.tabId == null) throw new Error('Zuerst ein Video verbinden.');
      if (status.room) throw new Error('Den Tontest vor dem Beitritt zu einem Raum durchführen.');
      if (status.local.paused) throw new Error('Zuerst im Video Play drücken und dann das Popup dort öffnen.');
      const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (active?.id !== status.tabId) throw new Error('Öffne die Extension direkt im verbundenen Video-Tab.');
      if ((await labRequest('status')).running) throw new Error('Es läuft bereits ein Tontest.');
      const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: status.tabId });
      await labRequest('start', { streamId, tabId: status.tabId, documentId: status.documentId, mediaId: status.local.mediaId });
      message = { action: 'status' };
    } else if (message.action === 'lab-cancel') {
      if (audio) await labRequest('cancel');
      message = { action: 'status' };
    } else if (audio && ['attach', 'create', 'join', 'leave'].includes(message.action)) {
      await labRequest('cancel');
    }
    if (message.action === 'dismiss-notice') {
      const status = await runtimeRequest({ action: 'status' });
      await dismissNotice(channel, status);
      message = { action: 'status' };
    }
    try { guard(); status ??= await runtimeRequest(message); }
    catch (error) {
      // Failed room setup is returned to its initiating action. Older released
      // runtimes also retain it as a notice; do not show that duplicate forever.
      if (['create', 'join'].includes(message.action)) {
        const failed = await runtimeRequest({ action: 'status' }).catch(() => null);
        if (failed?.notice && !failed.room && responseError({ error: failed.notice }).message === error.message) await dismissNotice(channel, failed);
      }
      throw error;
    }
    guard();
    const key = `dismissedNotice:${channel}`;
    const dismissed = (await chrome.storage.session.get(key))[key];
    if (dismissed === noticeIdentity(status)) status = { ...status, notice: '', noticeError: null };
    else if (dismissed) await chrome.storage.session.remove(key);
    return { ...status, ...await updateViewStatus(build, dev, updateLock, status),
      lab: !status.roomStatusUnavailable && audio ? await labRequest('status') : null };
  }
  throw new Error('Unbekannte Anfrage.');
}

// This status path has no Offscreen dependency, including in updates.html.
async function updateViewStatus(build, dev, updating, sessionStatus) {
  const channel = await selectedChannel();
  // Recovery must never start or depend on a damaged player. Outside recovery,
  // read only an already-running player so the view can block folder prompts.
  let room = sessionStatus?.room || null, roomStatusUnavailable = !!sessionStatus?.roomStatusUnavailable;
  let lifecycle = sessionStatus?.lifecycle;
  if (sessionStatus === undefined && !recovery.pending && !updating) {
    const status = await readStatus();
    room = status.room; lifecycle = status.lifecycle;
    roomStatusUnavailable = !!status.roomStatusUnavailable;
  }
  return { room, lifecycle, roomStatusUnavailable, channel, channels: STORE ? [] : channelOptions(build, dev?.status(), channel), store: STORE, development: dev?.status(),
    localBuild: build.local, sourceBuild: !!build.source, recovery,
    showExperimentalPreview: (await chrome.storage.local.get('showExperimentalPreview')).showExperimentalPreview === true,
    experimentalTag: build.candidateTag || null, engineVersion: chrome.runtime.getManifest().version,
    updates: await updateStatus(channel, build), updating: !!updating,
    updateOperation: (await chrome.storage.session.get('updateOperation')).updateOperation, features: featuresFor(build.channel) };
}

function queueDevelopmentReload() {
  const task = uiQueue.then(async () => {
    if (await selectedChannel() !== 'local') return false;
    const dev = await development;
    const state = await dev.refresh();
    if (!state.ready || state.paused || !state.pending) return false;
    exclusiveRunning = true;
    try { await reloadDevelopment(); return true; }
    finally { exclusiveRunning = false; }
  });
  uiQueue = task.catch(() => {});
  return task;
}

async function reloadDevelopment() {
  await ensureOffscreen();
  await labRequest('cancel');
  const checkpoint = await runtimeRequest({ action: 'dev-checkpoint' });
  try { await chrome.storage.local.set({ devResume: { ...checkpoint, savedAt: Date.now() } }); }
  catch (error) {
    await runtimeRequest({ action: 'dev-restore', checkpoint });
    throw error;
  }
  if (checkpoint.tabId != null && checkpoint.documentId) {
    await chrome.scripting.executeScript({ target: { tabId: checkpoint.tabId, documentIds: [checkpoint.documentId] }, world: 'MAIN',
      func: owner => {
        if (window.__videoSyncOwner !== owner) return;
        window.__videoSyncPlayer?.dispose?.(); delete window.__videoSyncPlayer; delete window.__videoSyncOwner;
      }, args: [chrome.runtime.id]
    }).catch(() => {});
  }
  setTimeout(() => chrome.runtime.reload(), 100);
}

async function restoreDevelopment() {
  if (!(await buildInfo).local) return;
  const { devResume } = await chrome.storage.local.get('devResume');
  if (!devResume) return;
  await chrome.storage.local.remove('devResume');
  if (await selectedChannel() !== 'local' || Date.now() - devResume.savedAt > 120_000) return;
  const task = uiQueue.then(async () => {
    await ensureOffscreen();
    await runtimeRequest({ action: 'dev-restore', checkpoint: devResume });
    // Extension pages opened as tabs survive reload with an invalidated context.
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (['popup.html', 'updates.html'].some(file => tab.url === chrome.runtime.getURL(file))) await chrome.tabs.reload(tab.id).catch(() => {});
    }
  });
  uiQueue = task.catch(() => {});
  await uiQueue;
}

function noticeIdentity(status) {
  return JSON.stringify([status.notice, status.room?.code || null, status.tabId, status.documentId]);
}

async function dismissNotice(channel, status) {
  if (status.notice) await chrome.storage.session.set({ [`dismissedNotice:${channel}`]: noticeIdentity(status) });
}

chrome.tabs.onRemoved.addListener(tabId => {
  chrome.runtime.sendMessage({ target: 'capture-lab', action: 'tab-closed', tabId }).catch(() => {});
  chrome.runtime.sendMessage({ target: 'offscreen', action: 'tab-closed', tabId }).catch(() => {});
});
chrome.webNavigation.onCommitted.addListener(details => {
  chrome.runtime.sendMessage({ target: 'offscreen', action: 'document-changed', tabId: details.tabId,
    frameId: details.frameId, documentId: details.documentId }).catch(() => {});
  if (details.frameId === 0) chrome.runtime.sendMessage({ target: 'capture-lab', action: 'tab-closed', tabId: details.tabId }).catch(() => {});
});

async function scheduledUpdateCheck() {
  await checkUpdates(await selectedChannel(), await buildInfo);
}
// Public releases need no token, so every installation checks on this cadence.
// Store packages have neither the updater nor the alarms permission.
if (!STORE) {
  chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'check-github-updates') void scheduledUpdateCheck(); });
  chrome.runtime.onStartup.addListener(async () => {
    await chrome.alarms.create('check-github-updates', { periodInMinutes: UPDATE_INTERVAL_MINUTES });
    void scheduledUpdateCheck();
  });
}
chrome.runtime.onInstalled.addListener(async details => {
  // A missing record means first run. Updates of existing installations skip the steps.
  if (details.reason === 'update' && !(await chrome.storage.local.get('onboarding')).onboarding) {
    await chrome.storage.local.set({ onboarding: { version: 1, step: 0, completedAt: Date.now(), skipped: true } });
  }
  if (STORE) return;
  await updateRecovery;
  const { updateCompleted } = await chrome.storage.local.get('updateCompleted');
  await chrome.alarms.create('check-github-updates', { periodInMinutes: UPDATE_INTERVAL_MINUTES });
  if (updateCompleted && !recovery.pending) {
    await chrome.storage.local.remove('updateCompleted');
    void scheduledUpdateCheck();
    await chrome.storage.session.set({ updateOperation: { message: updateCompleted === 'restored' ? 'Dateien des vorherigen Stands geprüft wiederhergestellt. Erweiterung wurde neu gestartet.' : updateCompleted === 'verified' ? 'Installation mit dem veröffentlichten Paket abgeglichen. Erweiterung wurde neu gestartet.' : 'Update installiert und Dateien geprüft. Erweiterung wurde neu gestartet.' } });
  }
});
