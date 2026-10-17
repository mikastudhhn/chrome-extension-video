// Cancellation must also cover an attach still discovering its document.
const cancelledBindings = new Map();

const conflictMessage = 'Eine andere oder ältere Video-Sync-Installation verwendet diesen Tab. Zweite Installation deaktivieren und Video-Tab neu laden.';

// A MAIN-world singleton without an owner (or with another owner) belongs to a
// different installed extension and must never be replaced.
export async function guardPlayerAccess(tabId, documentId) {
  if (!Number.isInteger(tabId)) throw new Error('Kein Video-Tab gefunden.');
  const frames = documentId ? [{ documentId }] : await chrome.webNavigation.getAllFrames({ tabId });
  const results = await Promise.allSettled((frames || []).map(async frame => {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId, documentIds: [frame.documentId] }, world: 'MAIN', injectImmediately: true,
      func: owner => {
        if ((window.__videoSyncOwner && window.__videoSyncOwner !== owner) ||
            (window.__videoSyncPlayer && !window.__videoSyncOwner)) return false;
        window.__videoSyncOwner = owner;
        return true;
      }, args: [chrome.runtime.id]
    });
    return result?.result;
  }));
  if (results.some(result => result.status === 'fulfilled' && result.value === false)) throw new Error(conflictMessage);
}

async function inspect(tabId, frame, operation, args = [], deadline = Date.now() + 6000) {
  const [result] = await beforeDeadline(chrome.scripting.executeScript({
    target: { tabId, documentIds: [frame.documentId] }, world: 'MAIN', injectImmediately: true,
    func: (owner, operation, args) => {
      if (window.__videoSyncOwner !== owner) throw new Error('Video-Sync-Instanzkonflikt. Video-Tab neu laden.');
      return window.__videoSyncPlayer[operation](...args);
    }, args: [chrome.runtime.id, operation, args]
  }), deadline);
  return result?.result;
}

function beforeDeadline(operation, deadline) {
  let timer;
  return Promise.race([operation, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Player-Erkennung hat zu lange gedauert. Bitte erneut versuchen.')),
      Math.max(1, deadline - Date.now()));
  })]).finally(() => clearTimeout(timer));
}

// Only inspect the tab explicitly selected in the popup. Credentials never enter a frame.
export async function discoverPlayer(tabId) {
  if (!Number.isInteger(tabId)) throw new Error('Kein Video-Tab gefunden.');
  const deadline = Date.now() + 6000;
  const frames = await beforeDeadline(chrome.webNavigation.getAllFrames({ tabId }), deadline);
  if (!frames?.length) throw new Error('Diese Seite kann nicht mit einem Video verbunden werden.');
  await beforeDeadline(guardPlayerAccess(tabId), deadline);
  const token = crypto.randomUUID();
  const accessible = [];
  try {
    const results = await beforeDeadline(Promise.allSettled(frames.map(async frame => {
      const url = new URL(frame.url);
      if (!['http:', 'https:', 'about:', 'blob:'].includes(url.protocol)) return null;
      try {
        const target = { tabId, documentIds: [frame.documentId] };
        await beforeDeadline(chrome.scripting.executeScript({ target, world: 'MAIN', files: ['player.js'], injectImmediately: true }), deadline);
        const videos = await inspect(tabId, frame, 'probe', [], deadline);
        // Script-disabled sandbox frames can return an empty injection result.
        if (!Array.isArray(videos)) throw new Error('Player frame did not answer.');
        await inspect(tabId, frame, 'beginFrameScan', [token, deadline], deadline);
        const inspected = { ...frame, videos };
        accessible.push(inspected);
        return inspected;
      } catch {
        // Chrome error documents cannot be scripted or host a usable player.
        // A failed background navigation must not invalidate healthy video frames.
        if (frame.errorOccurred) return null;
        if (['http:', 'https:'].includes(url.protocol)) {
          const origin = `${url.origin}/*`;
          if (!await chrome.permissions.contains({ origins: [origin] })) return { ...frame, missingOrigin: origin };
        }
        return { ...frame, unavailable: true };
      }
    })), deadline);
    const inspected = results.filter(result => result.status === 'fulfilled' && result.value).map(result => result.value);
    // Install every listener first. Only children with an accessible parent need
    // an acknowledgement; missing parent access is handled by the permission UI.
    const parents = new Set(accessible.map(frame => frame.frameId));
    await beforeDeadline(Promise.allSettled(accessible.filter(frame => parents.has(frame.parentFrameId))
      .map(frame => inspect(tabId, frame, 'announceFrame', [token, frame.documentId, deadline], deadline))), deadline);
    await beforeDeadline(Promise.allSettled(accessible.map(async frame => {
      frame.children = await inspect(tabId, frame, 'finishFrameScan', [token], deadline);
      frame.scanFinished = true;
    })), deadline);
    const byId = new Map(inspected.map(frame => [frame.frameId, frame]));
    if (Date.now() >= deadline || inspected.some(frame => frame.unavailable && !knownHiddenFrame(frame, byId)) || accessible.some(frame => !frame.children ||
        (parents.has(frame.parentFrameId) && !accessible.find(parent => parent.frameId === frame.parentFrameId)
          ?.children?.mapped.some(child => child.documentId === frame.documentId)))) {
      throw new Error('Player-Erkennung ist noch unvollständig oder die Seite wurde verändert. Bitte erneut versuchen.');
    }
    const candidates = accessible.flatMap(frame => {
      const area = visibleArea(frame, byId);
      return area > 0 ? frame.videos.map(video => ({ ...video, playerId: video.id, documentId: frame.documentId,
        frameId: frame.frameId, origin: new URL(frame.url).origin, area: Math.min(video.area, area) })) : [];
    });
    candidates.sort((a, b) => b.area - a.area || a.frameId - b.frameId);
    const missingOrigins = new Set(inspected.filter(frame => frame.missingOrigin && permissionNeeded(frame, byId))
      .map(frame => frame.missingOrigin));
    return { documentId: candidates.length === 1 ? candidates[0].documentId : null,
      playerId: candidates.length === 1 ? candidates[0].playerId : null,
      candidates, missingOrigins: [...missingOrigins].sort() };
  } finally {
    // Also attempt immediate cleanup after a failed scan. Frozen documents have
    // their own deadline timer and cannot retain a listener indefinitely on resume.
    await Promise.allSettled(accessible.filter(frame => !frame.scanFinished).map(frame => inspect(tabId, frame, 'finishFrameScan', [token], Date.now() + 100)));
  }
}

// An unscriptable frame has no Window/document handshake. Only ignore it
// when its ancestor mapping, or every possible embedding, proves it hidden.
// Matching URLs alone is unsafe because another visible iframe may redirect.
function knownHiddenFrame(frame, byId) {
  const visited = new Set();
  while (frame.parentFrameId !== -1) {
    if (visited.has(frame.frameId)) return false;
    visited.add(frame.frameId);
    const parent = byId.get(frame.parentFrameId);
    if (!parent) return false;
    const children = parent.children;
    const mapped = children?.mapped.find(child => child.documentId === frame.documentId);
    if (mapped ? mapped.area === 0 : children?.embeddings.length && children.embeddings.every(child => child.area === 0)) return true;
    frame = parent;
  }
  return false;
}

function visibleArea(frame, byId) {
  let area = Infinity;
  const visited = new Set();
  while (frame.parentFrameId !== -1) {
    if (visited.has(frame.frameId)) return 0;
    visited.add(frame.frameId);
    const parent = byId.get(frame.parentFrameId);
    const embedding = parent?.children?.mapped.find(child => child.documentId === frame.documentId);
    if (!embedding) return 0;
    area = Math.min(area, embedding.area);
    frame = parent;
  }
  return area;
}

function permissionNeeded(frame, byId) {
  if (frame.parentFrameId === -1) return true;
  const parent = byId.get(frame.parentFrameId);
  if (!parent?.children || visibleArea(parent, byId) <= 0) return false;
  const embeddings = parent.children.embeddings;
  const matches = embeddings.filter(child => child.url.split('#')[0] === frame.url.split('#')[0]);
  // A redirect may change the URL. This offers permission, never a player binding;
  // after the grant the exact Window/document mapping is mandatory.
  return (matches.length ? matches : embeddings).some(child => child.area > 0);
}

export async function callPlayer({ tabId, documentId, playerId, action, command, requestDeadline }) {
  if (!Number.isInteger(tabId)) throw new Error('Kein Video-Tab verbunden.');
  for (const [id, until] of cancelledBindings) if (Date.now() > until) cancelledBindings.delete(id);
  if (action === 'detach' && command?.expectedBindingId) cancelledBindings.set(command.expectedBindingId, Date.now() + 10000);
  const requestedBindingId = command?.bindingId;
  let selectedFrameId;
  const expiresAt = Math.min(requestDeadline ?? Infinity, Date.now() + (action === 'attach' ? 9000 : 1900));
  if (Date.now() >= expiresAt) throw new Error('Player-Anfrage abgelaufen. Bitte erneut versuchen.');
  if (action === 'attach') {
    const discovery = await discoverPlayer(tabId);
    const candidate = playerId ? discovery.candidates.find(candidate => candidate.playerId === playerId && candidate.documentId === documentId) :
      discovery.candidates.length === 1 && (!documentId || discovery.documentId === documentId) ? discovery.candidates[0] : null;
    if (!candidate) {
      if (playerId) throw new Error('Das ausgewählte Video ist nicht mehr verfügbar. Bitte im Popup erneut auswählen.');
      if (discovery.candidates.length > 1) throw new Error('Mehrere Videos gefunden. Bitte im Popup ein Video auswählen.');
      if (discovery.missingOrigins.length) throw new Error('Der eingebettete Player benötigt Zugriff. Bitte das Video über das Popup verbinden und den Player erlauben.');
      throw new Error('Kein geladenes Video gefunden. Video zuerst öffnen und kurz abspielen.');
    }
    documentId = candidate.documentId;
    playerId = candidate.playerId;
    if (requestedBindingId && cancelledBindings.has(requestedBindingId)) throw new Error('Player-Verbindung abgebrochen.');
    command = { playerId, bindingId: requestedBindingId };
    selectedFrameId = candidate.frameId;
  }
  if (!documentId) throw new Error('Kein Video verbunden.');
  // Preserve the requested binding through delayed routing; never infer it from
  // the page's current selection.
  if (action === 'observe') command = { playerId };
  if (action === 'apply' || action === 'detach') command = { ...command, expectedPlayerId: playerId };
  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId, documentIds: [documentId] }, world: 'MAIN', injectImmediately: true,
      func: async (owner, action, command, expiresAt) => {
        try {
          if (Date.now() >= expiresAt) throw new Error('Player-Anfrage abgelaufen. Bitte erneut versuchen.');
          const player = window.__videoSyncPlayer;
          if (window.__videoSyncOwner !== owner) throw new Error('Video-Sync-Instanzkonflikt. Video-Tab neu laden.');
          if (!player || !['attach', 'observe', 'sample', 'apply', 'detach'].includes(action)) throw new Error('Video erneut verbinden.');
          return { ok: true, value: await player[action]({ ...command, expiresAt }) };
        } catch (error) { return { ok: false, error: error.message }; }
      }, args: [chrome.runtime.id, action, command || null, expiresAt]
    });
  } catch {
    throw new Error('Der Video-Player wurde geschlossen oder neu geladen. Video erneut verbinden und ausrichten.');
  }
  const result = results[0]?.result;
  if (!result?.ok) throw new Error(result?.error || 'Der Player antwortet nicht.');
  if (action === 'attach') {
    // Optional: native Play/Pause/Seek wake the session at once. Without the
    // bridge they are still picked up by the next periodic sample.
    await chrome.scripting.executeScript({ target: { tabId, documentIds: [documentId] }, files: ['player-bridge.js'], injectImmediately: true }).catch(() => {});
  }
  return action === 'attach' ? { sample: result.value, documentId, playerId, frameId: selectedFrameId } : result.value;
}
