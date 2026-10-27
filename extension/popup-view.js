import { engineVersionLabel } from './version-label.js';
import { STORE } from './distribution.js';
import { parseInvitation } from './invitation.js';
import { readableError } from './errors.js';
const $ = id => document.getElementById(id);
const text = (id, value) => { if ($(id).textContent !== value) $(id).textContent = value; };

export const CODE_LENGTH = 6;
// Renders a six-character room code as cells. `active` marks the next input cell.
export function renderCodeCells(container, code = '', active = -1) {
  if (container.childElementCount !== CODE_LENGTH) {
    container.replaceChildren(...Array.from({ length: CODE_LENGTH }, () => Object.assign(container.ownerDocument.createElement('span'), { className: 'code-cell' })));
  }
  [...container.children].forEach((cell, index) => {
    const character = code[index] || '';
    if (cell.textContent !== character) cell.textContent = character;
    cell.dataset.active = String(index === active);
  });
}
// What the join cells show for raw input: the parsed code, or the typed characters so far.
export function previewCode(value, savedServer) {
  try { return { ...parseInvitation(value, savedServer), valid: true }; }
  catch { return { code: value.replace(/\s/g, '').slice(0, CODE_LENGTH).toUpperCase(), server: null, valid: false }; }
}

export function roomGuidance(local, room, optimisticPlayback) {
  const state = room.state;
  const peer = room.role === 'host' ? 'guest' : 'host';
  if (!local) return ['missing', 'Dein Video fehlt', 'Verbinde deinen Video-Tab erneut.'];
  if (room.reconnecting) return ['reconnecting', 'Wir verbinden euch erneut', 'Danach mit Abspielen fortsetzen.'];
  if (!room.connected) return room.role === 'host'
    ? ['inviting', 'Einladung teilen', '']
    : ['connecting', 'Verbindung wird aufgebaut', ''];
  if (room.resetting) return ['aligning', 'Neue Szene vorbereiten', ''];
  if (state?.phase !== 'synced') return state?.members?.[room.role]?.ready
    ? ['ready', 'Du bist bereit', 'Warte auf die zweite Person.']
    : ['aligning', 'Findet dieselbe Szene', 'Beide Videos am selben Moment anhalten.'];
  if (local.blocked) return ['blocked', 'Starte einmal im Video', 'Dein Browser braucht einen Klick auf Play.'];
  if (state.members?.[peer]?.blocked) return ['blocked', 'Die zweite Person ist dran', 'Einmal Play im Originalplayer drücken.'];
  if (state.waiting) return ['buffering', local.buffering ? 'Dein Video lädt nach' : 'Das zweite Video lädt nach', 'Es geht automatisch weiter.'];
  const playing = optimisticPlayback ? optimisticPlayback === 'play' : local.pendingPlayback ? local.pendingPlayback === 'play' : state.playing;
  return playing ? ['playing', 'Wiedergabe', ''] : ['paused', 'Pausiert', ''];
}

export function participantLabels(local, room) {
  const members = room.state?.members || {};
  const peer = room.role === 'host' ? 'guest' : 'host';
  if (!room.connected) return {
    self: local ? 'Du · Verbunden' : 'Du · Video fehlt',
    peer: room.reconnecting ? 'Zweite Person · Unterbrochen' : 'Zweite Person · Noch nicht da'
  };
  if (room.state?.phase !== 'synced') return {
    self: members[room.role]?.ready ? '✓ Du bist bereit' : 'Du · Szene auswählen',
    peer: members[peer]?.ready ? '✓ Zweite Person bereit' : 'Zweite Person · Szene wählen'
  };
  return {
    self: !local ? 'Du · Video fehlt' : local.blocked ? 'Du · Play im Video nötig'
      : local.buffering ? 'Du · Lädt nach' : 'Du · Verbunden',
    peer: members[peer]?.blocked ? 'Zweite Person · Play nötig'
      : room.state.waiting && !local?.buffering ? 'Zweite Person · Lädt nach' : 'Zweite Person · Verbunden'
  };
}

// One banner replaces every update button: it shows only when there is
// something to do, and offers the release page and the installation inline.
export function updateBannerState({ current, pending, updatesOpen, updateBannerError }) {
  if (!current || updatesOpen) return null;
  const update = current.updates, operation = current.updateOperation;
  if (current.recovery?.pending) return { tone: 'attention', title: 'Update wiederherstellen', hint: 'Ein Update wurde unterbrochen. Details öffnen.', action: 'open' };
  if (current.updating) {
    const progress = operation?.progress?.total ? operation.progress.done / operation.progress.total : 0;
    return { tone: 'neutral', title: 'Update wird installiert', hint: operation?.message || '', action: 'install', icon: 'download', disabled: true, progress,
      url: update?.url || null, buttonLabel: `Installation läuft, ${Math.round(progress * 100)} %` };
  }
  if (!update?.available || !update.configured || update.error || current.sourceBuild || current.localBuild) return null;
  const version = update.tag || update.name || 'Neue Version';
  // A downgrade or new permissions are confirmed in the update details only.
  if (operation?.confirmation) return { tone: 'attention', title: 'Bestätigung erforderlich', hint: 'Das Update braucht deine Bestätigung. Details öffnen.', action: 'open', url: update.url || null };
  const failure = updateBannerError || operation?.error;
  const room = !!current.room;
  return {
    tone: failure ? 'attention' : 'neutral', title: failure ? 'Update fehlgeschlagen' : 'Neue Version verfügbar', url: update.url || null, action: 'install',
    hint: failure || (room ? 'Zum Installieren zuerst den Raum verlassen.' : `${version} · Update-Details öffnen`), icon: failure ? 'refresh' : 'download', disabled: room || pending,
    buttonLabel: failure ? 'Update erneut versuchen' : room ? 'Zum Installieren zuerst den Raum verlassen' : `${version} herunterladen und installieren`
  };
}

function renderUpdateBanner(input) {
  const banner = updateBannerState(input);
  $('update-banner').hidden = !banner;
  if (!banner) return;
  $('update-banner').dataset.tone = banner.tone;
  $('update-banner').setAttribute('aria-busy', String(banner.progress != null));
  text('update-banner-title', banner.title);
  $('update-banner-details').title = banner.hint || 'Update-Details öffnen';
  $('update-banner-notes').hidden = !banner.url;
  if (banner.url) $('update-banner-notes').href = banner.url;
  const install = $('update-banner-install');
  install.hidden = banner.action !== 'install';
  install.disabled = !!banner.disabled;
  // SVG elements have no `hidden` property; toggle the attribute instead.
  install.querySelector('.icon-download').toggleAttribute('hidden', banner.icon !== 'download');
  install.querySelector('.icon-refresh').toggleAttribute('hidden', banner.icon !== 'refresh');
  install.setAttribute('aria-label', banner.buttonLabel || 'Update installieren');
  install.title = banner.buttonLabel || 'Update installieren';
  if (banner.progress != null) { install.dataset.progress = String(Math.round(banner.progress * 100)); install.style.setProperty('--progress', String(banner.progress)); }
  else { delete install.dataset.progress; install.style.removeProperty('--progress'); }
}

export function renderPopup({ current, pending, pendingAction, loaded, settingsOpen, updatesOpen,
  allSitesAllowed, frameAccess, playerChoices, roomError, actionError, joinTouched, copiedUntil,
  queuedControls, optimisticPlayback, savedServer, updateBannerError, onboardingOpen = false }) {
  const local = current?.local;
  const room = current?.room;
  const state = room?.state;
  const synced = state?.phase === 'synced';
  const experimental = !!current?.features?.audioDiagnostics;
  const lab = current?.lab;
  const channels = current?.channels || [{ value: 'stable', label: 'Stable' }, { value: 'experimental', label: 'Experimental' }];
  const optionsKey = JSON.stringify(channels);
  if ($('release-channel').dataset.options !== optionsKey) {
    $('release-channel').replaceChildren(...channels.map(option => new Option(option.label, option.value)));
    $('release-channel').dataset.options = optionsKey;
  }
  const channel = current?.channel || 'stable';
  const label = channels.find(option => option.value === channel)?.label || 'Stable';
  $('release-channel').value = channel;
  $('release-channel').disabled = pending || !!current?.updating;
  text('channel-label', label);
  // Store installations follow the Web Store; there is no release stream to show or choose.
  $('channel-label').hidden = STORE;
  $('release-channel-row').hidden = STORE;
  $('channel-hint').hidden = STORE;
  $('open-updates').hidden = STORE;
  const appVersion = chrome.runtime.getManifest().version, version = engineVersionLabel(current);
  text('edition', `${STORE ? 'Chrome Web Store' : label} ${version}${version === appVersion ? '' : ` · App ${appVersion}`}`);
  $('experimental-credit').hidden = !['experimental', 'local'].includes(channel);
  renderUpdateBanner({ current, pending, updatesOpen: updatesOpen || onboardingOpen, updateBannerError });
  $('player-page').hidden = onboardingOpen || settingsOpen;
  $('player-actions').hidden = onboardingOpen || settingsOpen;
  $('capture-lab').hidden = !experimental;
  $('lab-start').hidden = !!lab?.running;
  $('lab-start').disabled = pending || !local || !!room || local.paused;
  $('lab-cancel').hidden = !lab?.running;
  $('lab-cancel').disabled = pending;
  text('lab-status', room ? 'Den Raum für einen Tontest zuerst verlassen.' : !local ? 'Zuerst ein Video verbinden.' : lab?.message || 'Video abspielen und den Tontest starten.');
  $('lab-metrics').hidden = !lab?.sampleRate;
  text('lab-metrics', lab?.sampleRate ? `${lab.duration} s geprüft · ${lab.activeSeconds} s mit Ton · Pegel ${lab.rmsDb === null ? 'Stille' : `${lab.rmsDb} dBFS`}` : '');
  $('lab-copy').hidden = !lab?.completedAt || !!lab?.running;
  document.querySelector('main').setAttribute('aria-busy', String(pending || !loaded));
  $('setup').hidden = !!local && !frameAccess && !playerChoices;
  $('player-selection').hidden = !playerChoices;
  $('player-choices').querySelectorAll('button').forEach(button => { button.disabled = pending; });
  $('cancel-player-choice').disabled = pending;
  $('video-summary').hidden = !local;
  $('permissions').hidden = allSitesAllowed || !!local;
  $('allow-all').hidden = allSitesAllowed || !!local;
  $('allow-all').disabled = pending;
  text('allow-all', pendingAction === 'attach' ? 'Verbinden …' : 'Erlauben & verbinden');
  text('setup-title', pendingAction === 'attach' ? 'Player suchen …' : room ? 'Video erneut verbinden' : 'Video verbinden');
  text('setup-description', playerChoices ? 'Wähle das Video, das du gemeinsam ansehen möchtest.' : 'Öffne die Extension in deinem Video-Tab.');
  $('attach').hidden = !!playerChoices || (!!local && !frameAccess);
  $('attach').className = allSitesAllowed ? 'primary' : 'text-button full-width';
  $('attach').disabled = pending;
  text('attach', pendingAction === 'attach' ? 'Suchen …' : allSitesAllowed ? 'Video verbinden' : 'Nur dieses Video');
  text('position', local ? formatTime(local.time) : '—');
  $('lobby').hidden = !local || !!room || !!frameAccess || !!playerChoices;
  $('create').hidden = $('lobby').hidden;
  $('room').hidden = !room;
  $('create').disabled = !local || pending;
  text('create', pendingAction === 'create' ? 'Raum wird erstellt …' : roomError?.action === 'create' && roomError.retry ? 'Erneut versuchen' : 'Raum erstellen');
  text('join', pendingAction === 'join' ? 'Verbindung wird aufgebaut …' : roomError?.action === 'join' && roomError.retry ? 'Erneut versuchen' : 'Beitreten');
  $('room-error').hidden = !roomError || !!room || !local || settingsOpen;
  if (roomError) {
    const slot = $(roomError.action === 'join' ? 'join-feedback' : 'create-feedback');
    if ($('room-error').parentElement !== slot) slot.append($('room-error'));
    text('room-error-title', roomError.title);
    text('room-error-detail', roomError.detail);
    $('room-error-server').hidden = !roomError.editServer;
    $('room-error-invitation').hidden = !roomError.editInvitation;
  }
  let invitation = null, invitationError = '';
  if ($('code').value.trim()) {
    try { invitation = parseInvitation($('code').value, savedServer); }
    catch (error) { invitationError = error.message; }
  }
  const preview = previewCode($('code').value, savedServer);
  const typing = $('code').ownerDocument.activeElement === $('code');
  renderCodeCells($('code-cells'), preview.code, typing && !preview.valid ? Math.min(preview.code.length, CODE_LENGTH - 1) : -1);
  const pastedServer = preview.valid && /Server:/i.test($('code').value) ? preview.server : '';
  text('code-server', pastedServer ? `Server: ${pastedServer}` : '');
  $('code-server').hidden = !pastedServer;
  $('join').disabled = !local || pending || !invitation;
  $('code').setAttribute('aria-invalid', String(joinTouched && !!invitationError));
  text('join-hint', joinTouched && invitationError ? invitationError : '');
  $('join-hint').hidden = !(joinTouched && invitationError);
  $('frame-access').hidden = !frameAccess;
  $('allow-player').disabled = pending;
  text('frame-access-description', frameAccess ? `Weitere eingebettete Player benötigen Zugriff auf ${frameAccess.origins.map(origin => new URL(origin).hostname).join(', ')}.` : '');
  $('server-settings').hidden = !!room;
  $('session-details').hidden = !room;
  $('video-actions').hidden = !local;
  $('change-video').disabled = pending || queuedControls > 0;
  $('room-settings').hidden = !room;
  $('resync').hidden = !room || !synced;
  $('leave').hidden = !room;
  const server = room?.server || savedServer || '';
  text('environment', /^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(server)
    ? 'Lokaler Test · Auf diesem Rechner' : 'Nur Steuerdaten · Deine Videos bleiben bei dir');
  text('copy', Date.now() < copiedUntil ? '✓ Einladung kopiert' : 'Einladung kopieren');
  text('copy-again', Date.now() < copiedUntil ? '✓ Einladung kopiert' : 'Einladung erneut kopieren');
  if (room) {
    const peer = room.role === 'host' ? 'guest' : 'host';
    const ownReady = !!state?.members?.[room.role]?.ready;
    const peerReady = !!state?.members?.[peer]?.ready;
    const [mode, heading, instruction] = roomGuidance(local, room, optimisticPlayback);
    $('room').dataset.state = mode;
    text('status', heading);
    text('instruction', instruction);
    $('instruction').hidden = !instruction;
    $('members').hidden = false;
    $('invite').hidden = mode !== 'inviting';
    $('copy').hidden = mode !== 'inviting';
    renderCodeCells($('room-code'), room.code || '');
    $('room-code').setAttribute('aria-label', room.code ? `Raumcode ${room.code}` : 'Raumcode wird erstellt');
    text('details-code', room.code || '…');
    $('self-ready').dataset.ready = String(ownReady);
    $('peer-ready').dataset.ready = String(peerReady);
    const members = participantLabels(local, room);
    text('self-ready', members.self);
    text('peer-ready', members.peer);
    text('connection-detail', `${local?.adapter || 'Player'} · ${room.server?.startsWith('https:') ? 'HTTPS' : 'HTTP'}${Number.isFinite(room.rtt) ? ` · ${Math.round(room.rtt)} ms Antwortzeit` : ''} · ${room.server || ''}`);
    $('ready').hidden = synced || !room.connected || !local;
    $('ready').disabled = pending || room.resetting || !state || local?.buffering || ownReady;
    text('ready', pendingAction === 'ready' ? 'Szene wird bestätigt …' : ownReady ? '✓ Deine Szene ist bestätigt' : local?.buffering ? 'Video lädt noch …' : 'Diese Szene bestätigen');
    $('unblock').hidden = !local?.blocked || !synced;
    $('playback').hidden = !synced || !local;
    const playbackIntent = optimisticPlayback || local?.pendingPlayback;
    const wantsPlay = playbackIntent ? playbackIntent === 'play' : state?.wantsPlay;
    text('play', wantsPlay ? 'Pause' : 'Abspielen');
    $('play').dataset.control = wantsPlay ? 'pause' : 'play';
    document.querySelectorAll('[data-control]').forEach(button => { button.disabled = pending || !room.connected || !local; });
    $('resync').disabled = pending || queuedControls > 0;
    $('leave').disabled = pendingAction === 'leave';
  } else {
    // Room actions live in the fixed action bar outside #room, so they hide explicitly.
    for (const id of ['copy', 'ready', 'unblock', 'playback']) $(id).hidden = true;
  }
  const error = actionError || (!roomError && (current?.noticeError || current?.notice)) || '';
  text('error', error ? readableError(error) : '');
  $('error-panel').hidden = !error;
}

export function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return '—';
  const value = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(value / 60);
  const tail = `${String(minutes % 60).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
  return value >= 3600 ? `${Math.floor(value / 3600)}:${tail}` : `${minutes}:${String(value % 60).padStart(2, '0')}`;
}

