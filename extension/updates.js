import { engineVersionLabel, versionDisplayState } from './version-label.js';
import { renderDevelopment } from './development.js';
import { RELEASES_URL, GITHUB_ORIGINS } from './github-updates.js';
import { stored } from './update-storage.js';
import { verifyInstallation, verifyDirectoryIdentity } from './update-install.js';
import { verifyRecoveryDirectory, validateJournal } from './update-recovery.js';
import { updatesMarkup, updatePresentation, confirmationPresentation } from './updates-view.js';

export function mountUpdates(root, { readStatus } = {}) {
  root.innerHTML = updatesMarkup;
  const $ = id => root.querySelector(`#updates-${id}`);
  const text = (id, value) => { if ($(id).textContent !== value) $(id).textContent = value; };
  let state, busy = false, polling = false, directory, displayedOperation, downloadAccess = false;
  let refreshRevision = 0;
  // Searching public releases needs no host permission; downloading does
  // (GitHub redirects assets to a host without CORS headers). Like the folder
  // picker, the request runs after the room preflight within the click's
  // transient activation, so an active room never shows a prompt.
  async function ensureDownloadAccess() {
    if (downloadAccess) return;
    if (!await chrome.permissions.request(GITHUB_ORIGINS)) throw new Error('Ohne Zugriff auf GitHub kann das Update nicht geladen werden.');
    downloadAccess = true;
    // The permission dialog can outlast the click needed for folder access.
    if (navigator.userActivation && !navigator.userActivation.isActive) throw new Error('Zugriff auf GitHub erlaubt. Bitte die Aktion erneut anklicken.');
  }
  $('release-link').href = RELEASES_URL;
  const request = async (action, extra = {}) => {
    const response = await chrome.runtime.sendMessage({ target: 'background', type: 'ui', action, ...extra });
    if (!response?.ok) throw new Error(response?.error || 'Die Erweiterung antwortet nicht.');
    return response.result;
  };
  async function action(run) {
    if (busy) return 'Ein Vorgang läuft bereits.';
    let failure = '';
    refreshRevision++; // Invalidate status reads started before this action.
    const page = root.ownerDocument;
    const origin = root.contains(page.activeElement) ? page.activeElement : null;
    busy = true; $('error').hidden = true; $('message').textContent = '';
    setDisabled(true);
    try { await run(); }
    catch (error) { failure = error.message; $('error').textContent = error.message; $('error').hidden = false; }
    finally {
      await refreshFolder();
      busy = false; setDisabled(!!state?.updating);
      // Disabling a focused native button can move focus to body. Restore it
      // after the action, unless the user already chose another focus target.
      if (root.checkVisibility() && origin && (page.activeElement === page.body || page.activeElement === origin)) {
        const target = root.contains(origin) && origin.checkVisibility() && !origin.disabled ? origin : $('heading');
        target.focus();
      }
    }
    return failure;
  }

  async function refreshFolder() {
    $('folder').textContent = directory ? 'Ändern' : 'Auswählen';
    $('folder').setAttribute('aria-label', directory ? 'Installationsordner ändern' : 'Installationsordner auswählen');
    const installLabel = directory ? 'Jetzt aktualisieren' : 'Ordner wählen & aktualisieren';
    $('install').setAttribute('aria-label', installLabel); $('install').title = installLabel;
    $('folder-warning').hidden = true;
    if (!directory) {
      text('folder-status', 'Wird beim ersten Update gewählt');
      return;
    }
    let permission;
    try { permission = await directory.queryPermission({ mode: 'readwrite' }); }
    catch { /* Keep the saved selection so the user can replace an unavailable folder. */ }
    text('folder-status', directory.name);
    $('folder-warning').hidden = permission !== 'denied';
    $('folder-warning').textContent = 'Schreibzugriff gesperrt. Bitte den Ordner erneut auswählen.';
  }

  async function refresh(snapshot) {
    const revision = ++refreshRevision;
    const nextState = snapshot || await (readStatus ? readStatus() : request('update-status').then(versionDisplayState));
    const granted = await Promise.resolve().then(() => chrome.permissions.contains(GITHUB_ORIGINS)).catch(() => false);
    if (revision !== refreshRevision) return;
    downloadAccess = granted;
    const previousAccess = state && updatePresentation(state.updates).needsAccess;
    state = nextState;
    const local = !!state.localBuild;
    const developmentChannel = state.channel === 'local';
    renderDevelopment(state, (name, extra) => action(async () => { await request(name, extra); await refresh(); }), $('development-controls'));
    $('local-panel').hidden = !local; $('release-panel').hidden = !!state.sourceBuild;
    $('source-panel').hidden = !state.sourceBuild;
    const label = state.channels.find(option => option.value === state.channel).label;
    const update = state.updates;
    const presentation = updatePresentation(update);
    const recoveryWarning = state.recovery?.pending;
    text('heading', state.recovery?.pending ? 'Wiederherstellung erforderlich' : developmentChannel || state.sourceBuild ? 'Lokaler Entwicklungsstand' : presentation.heading);
    const appVersion = chrome.runtime.getManifest().version;
    $('installed').textContent = `${label} · ${engineVersionLabel(state)}${appVersion !== state.engineVersion ? ` · App ${appVersion}` : ''}`;
    if (previousAccess !== presentation.needsAccess) {
      $('setup').open = presentation.needsAccess;
    }
    $('preview-setting').hidden = state.channel !== 'experimental';
    $('show-preview').checked = state.showExperimentalPreview;
    $('preview-hint').textContent = state.experimentalTag ? 'Zeigt zusätzlich die Preview-Nummer der installierten Version.'
      : state.experimentalTag === undefined ? 'Der Hintergrund verwendet noch den vorherigen Build. Zum Anzeigen der Preview-Nummer die Erweiterung einmal neu laden. Deine Auswahl bleibt gespeichert.'
        : 'Dieser Build enthält keine Preview-Nummer. Bei einem Release wird sie angezeigt.';
    $('access-status').textContent = presentation.accessLabel;
    $('folder-setting').hidden = local || (!update.configured && !recoveryWarning && !state.recovery?.canRestore);
    $('forget-token').hidden = !update.hasToken;
    $('save-token').textContent = 'Speichern & prüfen';
    text('update-status', developmentChannel ? 'Für Release-Updates Stable oder Experimental auswählen.' : presentation.status);
    $('update-status').hidden = !$('update-status').textContent;
    // One row like the popup banner: version, release page, installation.
    $('release').hidden = developmentChannel || !update.available;
    $('target').textContent = update.available ? update.tag || update.name || update.commit?.slice(0, 12) || 'Release' : '';
    $('last-check').hidden = developmentChannel || presentation.needsAccess;
    $('last-check').textContent = (update.lastSuccessfulCheckAt
      ? `Zuletzt geprüft: ${new Date(update.lastSuccessfulCheckAt).toLocaleString('de-DE')}`
      : 'Noch nicht geprüft') + ' · automatisch alle 30 Minuten und beim Öffnen.';
    if (update.access?.retryAt > Date.now()) {
      $('last-check').textContent += ` Erneut prüfen ab ${new Date(update.access.retryAt).toLocaleTimeString('de-DE')}.`;
    } else if (update.access?.automaticPauseUntil > Date.now()) {
      $('last-check').textContent += ` GitHub-Anfragelimit fast erreicht: automatische Prüfung pausiert bis ${new Date(update.access.automaticPauseUntil).toLocaleTimeString('de-DE')}.`;
    }
    $('changelog').hidden = developmentChannel || !update.available || !update.url;
    $('changelog').href = update.url || RELEASES_URL;
    const progress = state.updating ? (state.updateOperation?.progress?.total ? state.updateOperation.progress.done / state.updateOperation.progress.total : 0) : null;
    if (progress != null) { $('install').dataset.progress = String(Math.round(progress * 100)); $('install').style.setProperty('--progress', String(progress)); }
    else { delete $('install').dataset.progress; $('install').style.removeProperty('--progress'); }
    $('room-block').hidden = local || (!state.room && !state.roomStatusUnavailable);
    text('room-block', state.roomStatusUnavailable ? 'Raumstatus derzeit nicht prüfbar. Bitte erneut versuchen.'
      : 'Für Ordnerzugriff und Installation zuerst den Raum verlassen.');
    // A pending review replaces the install button with its own confirmation.
    const review = !local && !state.updating && !state.recovery?.pending ? state.updateOperation?.confirmation : null;
    $('confirm').hidden = !review;
    if (review) {
      const view = confirmationPresentation(review);
      text('confirm-summary', view.summary); text('confirm-details', view.details);
    }
    $('install').hidden = !!review || !!state.recovery?.pending || !!state.recovery?.blocked || local || !update.configured || !update.available || !!update.error;
    // Unreachable releases without a token: the token is the next action; the
    // periodic automatic check notices when the repository becomes public.
    $('check').hidden = developmentChannel || !update.configured || ['missing', 'invalid-token', 'not-found'].includes(update.access?.status) || (!local && update.available && !update.error);
    $('release-link').href = update.url || RELEASES_URL;
    $('restore').hidden = local || !state.recovery?.canRestore;
    $('restore').textContent = state.recovery?.pending ? 'Unterbrochenes Update wiederherstellen' : 'Vorherige Version wiederherstellen';
    $('verify-repair').hidden = local || !recoveryWarning;
    $('recovery-help').hidden = !recoveryWarning;
    text('recovery-help', state.recovery?.message || '');
    if (state.recovery?.pending) $('options').open = true;
    const operation = state.updateOperation;
    const operationKey = JSON.stringify(operation);
    if (operationKey !== displayedOperation) {
      displayedOperation = operationKey;
      $('message').textContent = operation?.message || '';
      $('error').textContent = operation?.confirmation ? '' : operation?.error || '';
      $('error').hidden = !operation?.error || !!operation.confirmation;
    }
    setDisabled(busy || state.updating);
  }

  function setDisabled(disabled) {
    root.setAttribute('aria-busy', String(disabled));
    root.querySelectorAll('button, input').forEach(element => { element.disabled = disabled; });
    for (const id of ['install', 'restore', 'folder', 'verify-repair', 'confirm-install']) $(id).disabled = disabled || !state || !!state.room || !!state.roomStatusUnavailable;
    if (state?.updates?.access?.retryAt > Date.now()) $('check').disabled = true;
    if (!disabled && state?.development) {
      renderDevelopment(state, (name, extra) => action(async () => { await request(name, extra); await refresh(); }), $('development-controls'));
    }
  }

  $('show-preview').onchange = event => {
    const checked = event.target.checked;
    void action(async () => {
      await chrome.storage.local.set({ showExperimentalPreview: checked });
      await refresh();
    });
  };

  $('save-token').onclick = () => {
    if (busy) return;
    const token = $('token').value.trim();
    if (!token) { text('error', 'Bitte einen GitHub-Token einfügen.'); $('error').hidden = false; $('token').setAttribute('aria-invalid', 'true'); $('token').focus(); return; }
    $('token').removeAttribute('aria-invalid');
    const permission = chrome.permissions.request(GITHUB_ORIGINS);
    void action(async () => {
      if (!await permission) throw new Error('Der Zugriff auf GitHub wurde nicht erlaubt.');
      downloadAccess = true;
      await request('update-configure', { token }); $('token').value = ''; await refresh();
    });
  };
  $('token').addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); $('save-token').click(); }
  });
  $('forget-token').onclick = () => action(async () => { await request('update-configure', { token: '' }); await refresh(); });
  $('check').onclick = () => action(async () => {
    $('check').textContent = 'Wird geprüft …';
    try { await request('update-check'); await refresh(); }
    finally { $('check').textContent = 'Jetzt prüfen'; }
  });
  async function directoryFromClick(choose = false, restoring = false, verifyingRepair = false) {
    if (!state || state.room) throw new Error('Für Ordnerzugriff und Installation zuerst den Raum verlassen.');
    // Polling can lag a room opened in another view. Check again before even
    // showing a picker/permission prompt; the background also guards writes.
    const current = await request('update-status');
    state.room = current.room;
    state.roomStatusUnavailable = current.roomStatusUnavailable;
    state.recovery = current.recovery;
    state.updating = current.updating;
    $('room-block').hidden = !state.room && !state.roomStatusUnavailable;
    text('room-block', state.roomStatusUnavailable ? 'Raumstatus derzeit nicht prüfbar. Bitte erneut versuchen.'
      : 'Für Ordnerzugriff und Installation zuerst den Raum verlassen.');
    if (state.roomStatusUnavailable) throw new Error('Raumstatus derzeit nicht prüfbar. Bitte erneut versuchen.');
    if (state.room) throw new Error('Für Ordnerzugriff und Installation zuerst den Raum verlassen.');
    if (state.updating) throw new Error('Ein Update läuft. Bitte zuerst abschließen.');
    if (navigator.userActivation && !navigator.userActivation.isActive) {
      throw new Error('Raumstatus geprüft. Bitte die Ordneraktion erneut anklicken.');
    }
    // Installing and verifying download the published package; a pending
    // recovery or an explicit restore only uses the local backup.
    if (!choose && !restoring && (verifyingRepair || (!state.recovery?.pending && !state.recovery?.blocked))) await ensureDownloadAccess();
    let selected = directory;
    if (choose || !selected) {
      if (!window.showDirectoryPicker) throw new Error('Dieser Browser unterstützt den Ordnerzugriff nicht. Bitte den manuellen ZIP-Download verwenden.');
      try {
        // The status preflight must finish within Chrome’s transient click activation.
        selected = await window.showDirectoryPicker({ id: 'video-sync-installation', mode: 'readwrite', startIn: directory || 'downloads' });
      } catch (error) {
        if (error.name !== 'AbortError') throw error;
        $('message').textContent = directory ? 'Der bisherige Ordner bleibt ausgewählt.' : 'Ordnerauswahl abgebrochen.';
        return null;
      }
    } else {
      // This call also needs the click; an existing grant returns without a prompt.
      if (await selected.requestPermission({ mode: 'readwrite' }) !== 'granted') {
        throw new Error('Schreibzugriff nicht erlaubt. Dein Ordner bleibt gespeichert. Bitte erneut versuchen oder unter „Weitere Optionen“ ändern.');
      }
    }
    try {
      if (verifyingRepair) {
        await verifyInstallation(selected);
      } else if (choose && state?.recovery?.pending) {
        // Selecting the loaded directory never authorizes a rollback to a
        // different handle: the runner checks the journal binding again.
        await verifyDirectoryIdentity(selected);
      } else if (state?.recovery?.pending && !state.recovery.blocked) {
        const journal = await stored('updateJournal');
        await validateJournal(journal);
        await verifyRecoveryDirectory(selected, journal.backup);
      } else if (restoring && !state?.recovery?.blocked) {
        await verifyRecoveryDirectory(selected, await stored('backup'));
      } else if (state?.recovery?.blocked) {
        // Selection still proves the actual loaded directory. The separate
        // repair action additionally requires a complete published package.
        await verifyDirectoryIdentity(selected);
      } else { await verifyInstallation(selected); }
    }
    catch (error) {
      if (error.name === 'NotFoundError') throw new Error('Der Ordner wurde nicht gefunden oder enthält keine vollständige Video-Sync-Installation. Bitte den geladenen Erweiterungsordner erneut auswählen.');
      if (error.name === 'NotAllowedError') throw new Error('Chrome hat den Ordnerzugriff nicht erlaubt. Bitte den Ordner erneut auswählen und den Zugriff freigeben.');
      throw error;
    }
    await stored('directory', selected);
    directory = selected;
    return selected;
  }
  $('folder').onclick = () => action(async () => {
    if (await directoryFromClick(true)) $('message').textContent = 'Ordner gespeichert.';
  });
  $('show-installation').onclick = () => action(() => chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` }));
  // The background owns disk writes so closing the popup cannot interrupt them.
  for (const kind of ['install', 'restore', 'verify-repair']) {
    $(kind).onclick = () => action(async () => {
      if (!await directoryFromClick(false, kind === 'restore', kind === 'verify-repair')) return;
      await request(`update-${kind}`);
      await refresh();
    });
  }
  // The confirmation is bound to the reviewed target: the background checks
  // the id again after downloading and verifying the package once more.
  $('confirm-install').onclick = () => action(async () => {
    const id = state?.updateOperation?.confirmation?.id;
    if (!id) return;
    if (!await directoryFromClick(false)) return;
    await request('update-install', { confirmation: id });
    await refresh();
  });
  $('confirm-cancel').onclick = () => action(async () => { await request('update-dismiss'); await refresh(); });
  return {
    // Installs from the popup banner with the banner click's activation. The
    // snapshot supplies status when this view has not rendered yet.
    async install(snapshot) {
      if (busy) return { ok: false, error: 'Ein Vorgang läuft bereits.' };
      if (!state && snapshot) state = snapshot;
      if (directory === undefined) directory = await stored('directory');
      const failure = await action(async () => {
        if (!await directoryFromClick(false)) throw new Error(directory ? 'Installation abgebrochen.' : 'Ordnerauswahl abgebrochen.');
        await request('update-install');
        await refresh();
      });
      return failure ? { ok: false, error: failure } : { ok: true };
    },
    async refresh(snapshot) {
      if (busy || polling) return;
      polling = true;
      const revision = refreshRevision;
      try {
        const savedDirectory = await stored('directory');
        if (busy || revision !== refreshRevision) return;
        directory = savedDirectory;
        await refresh(snapshot);
        if (!busy) await refreshFolder();
      } catch (error) { $('error').textContent = error.message; $('error').hidden = false; }
      finally { polling = false; }
    }
  };
}
