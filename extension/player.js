/* Runs only in a tab explicitly selected by the user. No room credentials enter the page. */
(() => {
  if (window.__videoSyncPlayer?.version === 8) return;
  window.__videoSyncPlayer?.detach?.();
  window.__videoSyncPlayer?.dispose?.();
  const STALL_MS = 500, SEEK_LOADING_MS = 1500;
  let video = null;
  let adapter = null;
  let expectedPause = null;
  let expectedSeek = null;
  let blocked = false;
  let syncing = false;
  let lastContact = Date.now();
  let mediaId = null;
  let bindingId = null;
  const cancelledBindings = new Map();
  let mediaIdentity = null;
  let intents = [];
  let listeners = [];
  let lastCorrection = 0;
  let intentSequence = 0;
  let pendingIntent = null;
  let syncEpoch = null;
  let bufferingSince = null;
  let seekLoading = false;
  let loadGeneration = 0;
  let watchdog = null;
  let playGeneration = 0;
  let desiredPlaying = false;
  let starting = null;
  let waitingSince = null;
  let resumeCorrection = null;
  let seekCatchup = null;

  function watchPlayback() {
    if (!syncing || watchdog !== null) return;
    watchdog = setInterval(() => {
      try { assertOwner(); if (Date.now() - lastContact > 3000) pause(); }
      catch { syncing = false; stopWatchdog(); }
    }, 500);
  }
  function stopWatchdog() { if (watchdog !== null) clearInterval(watchdog); watchdog = null; }
  function cancelStart() {
    playGeneration++; desiredPlaying = false;
    starting = null; waitingSince = null; resumeCorrection = null; seekCatchup = null;
  }
  function playbackEvent(type) {
    if (type === 'waiting') {
      // Seeking has its own intent/correction guard; do not turn every seeked
      // event into a second position correction.
      if (syncing && !video.seeking) waitingSince ??= now();
      return;
    }
    if (type !== 'playing') return;
    const delayedStart = starting && now() - starting.at >= 120;
    const recoveredBuffer = waitingSince !== null && now() - waitingSince >= 500;
    if (syncing && desiredPlaying && (delayedStart || recoveredBuffer)) {
      resumeCorrection = { mediaId, epoch: syncEpoch, intentSequence, until: now() + 2500 };
    }
    starting = null; waitingSince = null;
  }
  const owner = window.__videoSyncOwner;
  // IDs belong to this document/installation, not to an injector generation.
  // Weak keys retain no removed elements; Dev reload can rebind exactly its selection.
  if (!window.__videoSyncCandidates || window.__videoSyncCandidates.owner !== owner) window.__videoSyncCandidates = { owner, ids: new WeakMap() };
  const candidateIds = window.__videoSyncCandidates.ids;
  const candidatesById = new Map();
  const observations = new WeakMap();
  const frameScans = new Map();
  const now = () => performance.timeOrigin + performance.now();

  function pause() {
    cancelStart();
    if (!video || video.paused) return;
    expectedPause = { value: true, until: Date.now() + 2000 };
    try { adapter.pause(); }
    catch { video.pause(); } // Native pause remains the safety fallback when a private API disappears.
    if (adapter.capabilities.rate) video.playbackRate = 1;
  }

  async function waitForPause(expiresAt = Infinity) {
    if (video.paused) return;
    const element = video;
    // Provider controls may pause asynchronously. Confirm the settled frame,
    // but leave time for the reply within the surrounding player deadline.
    await new Promise(resolve => {
      const finish = () => {
        element.removeEventListener('pause', finish);
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, Math.max(0, Math.min(1000, expiresAt - Date.now())));
      element.addEventListener('pause', finish, { once: true });
    });
  }

  async function play(expiresAt = Infinity) {
    const element = video, medium = mediaId, binding = bindingId, sequence = intentSequence, generation = ++playGeneration;
    const playbackAdapter = adapter;
    desiredPlaying = true;
    starting = { at: now() };
    const expected = { value: false, until: Date.now() + 2000 };
    expectedPause = expected;
    try {
      await playbackAdapter.play();
      if (window.__videoSyncPlayer !== api || window.__videoSyncOwner !== owner) return;
      if (video !== element) { element.pause(); return; }
      if (bindingId !== binding || mediaId !== medium || generation !== playGeneration) {
        // A reused node belongs to its current binding/play attempt. An old
        // deadline cannot pause that owner's Play or emit a new Pause intent.
        if (!desiredPlaying) pause();
        return;
      }
      if (Date.now() >= expiresAt) pause();
    } catch (error) {
      if (expectedPause === expected) expectedPause = null;
      if (video !== element || mediaId !== medium || intentSequence !== sequence || generation !== playGeneration) return;
      if (error.name !== 'AbortError') { blocked = true; pause(); }
    }
  }

  // Walk the composed ancestry: opacity on a host or assigned slot also hides media.
  function visibleArea(element) {
    const rect = element.getBoundingClientRect();
    if (!element.isConnected || rect.width <= 0 || rect.height <= 0) return 0;
    // visibility is inherited but a descendant may override it. Its computed
    // value, unlike an ancestor's opacity/display, determines its own visibility.
    const visibility = getComputedStyle(element).visibility;
    if (visibility === 'hidden' || visibility === 'collapse') return 0;
    for (let node = element; node; node = node.assignedSlot || node.parentElement || node.getRootNode?.().host) {
      const style = getComputedStyle(node);
      if (style.display === 'none' ||
          style.contentVisibility === 'hidden' || Number(style.opacity || 1) === 0) return 0;
    }
    return rect.width * rect.height;
  }

  function elements(selector, root = document) {
    const result = [...root.querySelectorAll(selector)];
    for (const element of root.querySelectorAll('*')) {
      if (element.shadowRoot) result.push(...elements(selector, element.shadowRoot));
    }
    return result;
  }

  function probe() {
    const found = elements('video').filter(element => Number.isFinite(element.duration) &&
      element.duration > 0 && visibleArea(element) > 0);
    candidatesById.clear();
    return found.map((element, index) => {
      if (!candidateIds.has(element)) candidateIds.set(element, crypto.randomUUID());
      const id = candidateIds.get(element);
      candidatesById.set(id, element);
      return { id, area: visibleArea(element), duration: element.duration, time: element.currentTime,
        label: element.getAttribute('aria-label') || element.getAttribute('title') || document.title || `Video ${index + 1}` };
    });
  }

  // A child announces its document to its actual parent Window. Comparing event.source
  // with contentWindow survives redirects and duplicate src URLs. No credentials cross here.
  function beginFrameScan(token, deadline) {
    finishFrameScan(token);
    if (Date.now() >= deadline) throw new Error('Player-Erkennung hat zu lange gedauert. Bitte erneut versuchen.');
    const scan = { children: new Map() };
    scan.listener = event => {
      if (event.data?.videoSyncFrame !== token || typeof event.data.documentId !== 'string') return;
      const element = elements('iframe, frame').find(element => element.contentWindow === event.source);
      if (!element) return;
      scan.children.set(event.data.documentId, visibleArea(element));
      event.source.postMessage({ videoSyncFrameAck: token, documentId: event.data.documentId }, '*');
    };
    window.addEventListener('message', scan.listener);
    scan.timer = setTimeout(() => finishFrameScan(token), Math.max(1, deadline - Date.now()));
    frameScans.set(token, scan);
  }

  function announceFrame(token, documentId, deadline) {
    if (window.parent === window) return Promise.resolve();
    return new Promise(resolve => {
      const done = () => { clearTimeout(timer); window.removeEventListener('message', listener); resolve(); };
      const listener = event => {
        if (event.source === window.parent && event.data?.videoSyncFrameAck === token && event.data.documentId === documentId) done();
      };
      const timer = setTimeout(done, Math.max(1, deadline - Date.now()));
      window.addEventListener('message', listener);
      window.parent.postMessage({ videoSyncFrame: token, documentId }, '*');
    });
  }

  function finishFrameScan(token) {
    const scan = frameScans.get(token);
    if (!scan) return { mapped: [], embeddings: [] };
    clearTimeout(scan.timer);
    window.removeEventListener('message', scan.listener);
    frameScans.delete(token);
    return { mapped: [...scan.children].map(([documentId, area]) => ({ documentId, area })),
      embeddings: elements('iframe, frame').map(element => ({ url: element.src, area: visibleArea(element) })) };
  }

  function observe(selection) {
    assertOwner();
    const candidate = probe().find(candidate => candidate.id === selection?.playerId);
    if (!candidate) throw new Error('Das ausgewählte Video ist nicht mehr verfügbar. Bitte erneut auswählen.');
    const element = candidatesById.get(candidate.id);
    const source = `${location.pathname}${location.search || ''}|${element.currentSrc}|${element.duration}`;
    if (observations.get(element)?.source !== source) observations.set(element, { source, mediaId: crypto.randomUUID() });
    // A visible lobby may inspect its remembered selection without attaching,
    // installing listeners, starting a watchdog, or pausing native playback.
    return { time: element.currentTime, at: now(), duration: element.duration,
      paused: element.paused, buffering: !!element.error || element.readyState < 3 || element.seeking,
      advancing: !element.paused && element.readyState >= 3 && !element.seeking,
      mediaId: observations.get(element).mediaId, playerId: candidate.id, bindingId: null, intents: [] };
  }

  function attach(selection) {
    for (const [id, until] of cancelledBindings) if (Date.now() > until) cancelledBindings.delete(id);
    if (selection?.bindingId && cancelledBindings.has(selection.bindingId)) throw new Error('Player-Verbindung abgebrochen.');
    const candidates = probe();
    const candidate = selection?.playerId ? candidates.find(candidate => candidate.id === selection.playerId) :
      candidates.length === 1 ? candidates[0] : null;
    if (!candidate) throw new Error(candidates.length > 1 && !selection?.playerId
      ? 'Mehrere Videos gefunden. Bitte im Popup ein Video auswählen.'
      : 'Das ausgewählte Video ist nicht mehr sichtbar oder geladen. Bitte erneut auswählen.');
    if (isNetflix() && candidates.length > 1) {
      throw new Error('Netflix zeigt mehrere Videos. Andere Player schließen und die Episode erneut verbinden; die private Steuerung lässt sich nicht eindeutig zuordnen.');
    }
    const element = candidatesById.get(candidate.id);
    const nextAdapter = createAdapter(element);
    detach();
    video = element;
    bindingId = selection?.bindingId || crypto.randomUUID();
    adapter = nextAdapter;
    blocked = false;
    pause();
    mediaIdentity = identity();
    mediaId = crypto.randomUUID();
    for (const type of ['play', 'pause', 'playing', 'waiting', 'seeking', 'ended', 'emptied', 'loadstart']) {
      const listener = () => {
        if (type === 'emptied' || type === 'loadstart') { loadGeneration++; cancelStart(); return; }
        if (type === 'playing' || type === 'waiting') { playbackEvent(type); return; }
        capture(type);
      };
      video.addEventListener(type, listener);
      listeners.push([type, listener]);
    }
    return sample();
  }

  function isNetflix() { return location.hostname === 'netflix.com' || location.hostname.endsWith('.netflix.com'); }

  function createAdapter(element) { return isNetflix() ? netflixAdapter() : html5Adapter(element); }

  function html5Adapter(element) {
    return { name: 'HTML5', capabilities: { play: true, pause: true, seek: true, rate: true, mediaIdentity: 'media-load' },
      identity: () => '', time: () => element.currentTime,
      play: () => element.play(), pause: () => element.pause(), seek: time => { element.currentTime = time; } };
  }

  function netflixSession() {
    const api = window.netflix?.appContext?.state?.playerApp?.getAPI?.()?.videoPlayer;
    const ids = api?.getAllPlayerSessionIds?.();
    const watchIds = Array.isArray(ids) ? ids.filter(value => typeof value === 'string' && value.includes('watch')) : [];
    const player = watchIds.length === 1 && api.getVideoPlayerBySessionId?.(watchIds[0]);
    if (!player || !['play', 'pause', 'seek', 'getCurrentTime'].every(name => typeof player[name] === 'function')) {
      throw new Error('Netflix-Steuerung derzeit nicht eindeutig verfügbar. Episode öffnen oder Seite neu laden, dann Video erneut verbinden. Der Adapter ist experimentell.');
    }
    return { id: watchIds[0], player };
  }

  function netflixAdapter() {
    netflixSession();
    // Resolve every operation again: a provider can replace its private player in-place.
    return { name: 'Netflix · experimentell',
      capabilities: { play: true, pause: true, seek: true, rate: false, mediaIdentity: 'provider-session' },
      identity: () => netflixSession().id, time: () => netflixSession().player.getCurrentTime() / 1000,
      play: () => netflixSession().player.play(), pause: () => netflixSession().player.pause(),
      seek: time => netflixSession().player.seek(time * 1000) };
  }

  function identity() {
    return `${location.origin}${location.pathname}${location.search || ''}|${video.currentSrc}|${loadGeneration}|${adapter.identity()}`;
  }

  function assertOwner() {
    if (window.__videoSyncPlayer !== api || window.__videoSyncOwner !== owner) {
      detach();
      throw new Error('Eine andere Video-Sync-Installation hat den Player übernommen. Zweite Installation deaktivieren und Video-Tab neu laden.');
    }
  }

  function capture(type) {
    if (type === 'play') { blocked = false; desiredPlaying = true; starting ??= { at: now() }; }
    if (type === 'play' || type === 'pause') {
      const paused = type === 'pause';
      if (expectedPause && expectedPause.until > Date.now() && expectedPause.value === paused) {
        expectedPause = null; return;
      }
      expectedPause = null;
    }
    if (type === 'seeking' && expectedSeek && expectedSeek.until > Date.now() &&
        Math.abs(adapter.time() - expectedSeek.time) < 0.04) { expectedSeek = null; return; }
    if (type === 'seeking') { expectedSeek = null; starting = null; waitingSince = null; resumeCorrection = null; }
    if (type === 'pause' || type === 'ended') cancelStart();
    if (!syncing) return;
    queueIntent(type === 'seeking' ? 'seek' : type === 'ended' ? 'pause' : type);
  }

  function queueIntent(type) {
    seekCatchup = null;
    const intent = { type,
      time: adapter.time(), at: now(), advancing: !video.paused,
      id: ++intentSequence, mediaId, epoch: syncEpoch };
    pendingIntent = intent;
    intents.push(intent);
    if (intents.length > 20) intents.shift();
    announceIntent();
  }

  // Native Play/Pause/Seek: ask this installation's isolated bridge to sample
  // now instead of on the next tick. The event carries no data; the extension
  // still reads the intent through sample().
  function announceIntent() {
    try { if (typeof CustomEvent === 'function') document.dispatchEvent(new CustomEvent(`videosync-intent:${owner}`)); } catch {}
  }

  function sample() {
    assertOwner();
    lastContact = Date.now();
    if (!video || !video.isConnected) throw new Error('Der Video-Tab wurde verändert. Video erneut verbinden und ausrichten.');
    let nextId;
    try { nextId = identity(); }
    catch (error) { pause(); syncing = false; throw error; }
    if (mediaIdentity !== nextId) {
      pause();
      syncing = false;
      stopWatchdog();
      mediaIdentity = nextId;
      mediaId = crypto.randomUUID();
      intents = [];
      pendingIntent = null;
      intentSequence = 0;
      syncEpoch = null;
      expectedPause = null; expectedSeek = null;
    }
    const loading = video.readyState < 3 || video.seeking;
    if (loading) { bufferingSince ??= Date.now(); seekLoading ||= video.seeking; }
    else { bufferingSince = null; seekLoading = false; }
    const result = {
      time: adapter.time(), at: now(), duration: video.duration, paused: video.paused,
      advancing: !video.paused && !loading,
      // A cached seek briefly reports loading as well. Do not bounce the room
      // through Pause/Play for that transition; sustained loading still stops it.
      // Loading that follows a seek is expected and may take longer on a busy
      // device; a stall during playback is reported sooner.
      buffering: !!video.error || (loading && (!syncing || Date.now() - bufferingSince >= (seekLoading ? SEEK_LOADING_MS : STALL_MS))),
      blocked, mediaId, bindingId, playerId: candidateIds.get(video), adapter: adapter.name, capabilities: adapter.capabilities, intents
    };
    return result;
  }

  async function apply(command) {
    const current = sample();
    // Bind at send time, never here: an earlier sample may already have observed
    // the new medium while an old command is still in flight. Reattach also gets
    // a fresh mediaId, so delayed commands cannot cross player bindings either.
    if (Date.now() >= (command?.expiresAt ?? Infinity)) return current;
    if (command?.expectedBindingId && command.expectedBindingId !== bindingId) return current;
    if (command?.expectedMediaId !== mediaId || command.expectedPlayerId !== candidateIds.get(video)) return current;
    lastContact = Date.now();
    if (!video?.isConnected) throw new Error('Video nicht mehr verfügbar.');
    if (command.type === 'pause') {
      pause();
      if (command.waitForPause) await waitForPause(command.expiresAt);
      return sample();
    }
    if (command.type === 'release') { syncing = false; stopWatchdog(); pendingIntent = null; intents = []; syncEpoch = null; pause(); if (adapter.capabilities.rate) video.playbackRate = 1; return sample(); }
    if (command.type === 'control') {
      syncing = true;
      watchPlayback();
      syncEpoch = command.epoch;
      if (command.control === 'play') {
        queueIntent('play');
        void play(command.expiresAt);
      } else if (command.control === 'pause') {
        pause();
        queueIntent('pause');
      } else if (command.control === 'forward' || command.control === 'back') {
        const time = Math.min(video.duration, Math.max(0, adapter.time() + (command.control === 'forward' ? 10 : -10)));
        expectedSeek = { time, until: Date.now() + 2000 };
        starting = null; waitingSince = null; resumeCorrection = null;
        adapter.seek(time);
        queueIntent('seek');
      } else throw new Error('Unbekannter Playerbefehl.');
      return sample();
    }
    if (command.type !== 'sync' || !Number.isFinite(command.time)) throw new Error('Ungültiger Playerbefehl.');
    syncing = true;
    watchPlayback();
    if (syncEpoch !== command.epoch) {
      pendingIntent = null;
      intents = [];
      syncEpoch = command.epoch;
      resumeCorrection = null;
      seekCatchup = null;
    }
    if (command.ack?.mediaId === mediaId) {
      intents = intents.filter(intent => intent.id > command.ack.id);
      if (pendingIntent && command.ack.id >= pendingIntent.id) {
        // A delayed acknowledged native seek can leave about one second of drift.
        // Preserve the gesture's continuity: briefly catch up at 6%, without
        // seeking back onto the host's later acknowledgement frame.
        if (pendingIntent.type === 'seek' && pendingIntent.advancing) {
          seekCatchup = { mediaId, epoch: syncEpoch, intentSequence, until: now() + 10000 };
        }
        pendingIntent = null;
      }
    }
    // Sampling sends the intent, but only its acknowledgement may release this
    // guard. An older playing state must never undo a native Pause/Play/Seek.
    if (pendingIntent) { if (adapter.capabilities.rate) video.playbackRate = 1; return sample(); }
    const time = Math.min(video.duration, Math.max(0, command.time));
    const difference = time - adapter.time();
    if (!command.playing) pause();
    if (resumeCorrection && (resumeCorrection.mediaId !== mediaId || resumeCorrection.epoch !== syncEpoch ||
        resumeCorrection.intentSequence !== intentSequence || now() > resumeCorrection.until)) resumeCorrection = null;
    if (seekCatchup && (seekCatchup.mediaId !== mediaId || seekCatchup.epoch !== syncEpoch ||
        seekCatchup.intentSequence !== intentSequence || now() >= seekCatchup.until || Math.abs(difference) <= 0.12 || command.force)) seekCatchup = null;
    const continuousCatchup = command.playing && seekCatchup && adapter.capabilities.rate;
    const resumed = command.playing && resumeCorrection && !video.seeking && video.readyState >= 3;
    const needsSeek = (command.force && Math.abs(difference) > 0.04) || (!continuousCatchup &&
      ((resumed && Math.abs(difference) > 0.12) || Math.abs(difference) > (command.playing ? 0.9 : 0.18)));
    if (needsSeek && !video.seeking && Date.now() - lastCorrection > 600) {
      expectedSeek = { time, until: Date.now() + 2000 };
      lastCorrection = Date.now();
      adapter.seek(time);
      resumeCorrection = null;
    }
    if (resumed && Math.abs(difference) <= 0.12) resumeCorrection = null;
    // Netflix's rate support is deliberately not assumed; larger drift is corrected with seeks.
    const rateAdjustment = continuousCatchup ? 0.06 : 0.04;
    if (adapter.capabilities.rate) video.playbackRate = command.playing && Math.abs(difference) > 0.12 && (continuousCatchup || Math.abs(difference) < 0.9)
      ? 1 + (difference > 0 ? rateAdjustment : -rateAdjustment) : 1;
    if (command.playing && video.paused && !blocked) {
      await play(command.expiresAt);
    }
    return sample();
  }

  function detach(command) {
    if (command?.expectedBindingId) {
      cancelledBindings.set(command.expectedBindingId, Date.now() + 10000);
      if (command.expectedBindingId !== bindingId) return;
    }
    if (command && video && !command.expectedBindingId) {
      const current = sample();
      if (command.expectedMediaId !== mediaId || command.expectedPlayerId !== candidateIds.get(video)) return current;
    }
    if (video) {
      pause();
      if (adapter.capabilities.rate) video.playbackRate = 1;
      for (const [type, listener] of listeners) video.removeEventListener(type, listener);
    }
    stopWatchdog();
    cancelStart();
    listeners = [];
    intents = [];
    pendingIntent = null;
    intentSequence = 0;
    syncEpoch = null;
    bufferingSince = null;
    seekLoading = false;
    syncing = false;
    video = null;
    adapter = null;
    bindingId = null;
    expectedPause = null; expectedSeek = null;
  }

  const api = window.__videoSyncPlayer = { version: 8, probe, observe, attach, sample, apply, detach, beginFrameScan, announceFrame, finishFrameScan,
    dispose: () => { detach(); stopWatchdog(); for (const token of frameScans.keys()) finishFrameScan(token); } };
})();
