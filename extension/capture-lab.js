import { AudioMetrics, diagnosticOutcome, TEST_SECONDS } from './audio-metrics.js';
import { observePlayerStatus as playerStatus } from './offscreen.js';

let generation = 0, resources = null;
let state = { running: false, outcome: 'idle', message: 'Prüfe, ob dein Player Ton für einen späteren Vergleich bereitstellt.' };
const status = () => ({ ...state, ...(resources ? resources.metrics.snapshot() : {}) });

async function finish(token, outcome, message) {
  if (token !== generation) return;
  generation++;
  const current = resources;
  resources = null;
  if (current) {
    clearTimeout(current.timer); clearInterval(current.monitor);
    current.stream?.getTracks().forEach(track => track.stop());
    current.node?.disconnect(); current.source?.disconnect();
    await current.context?.close().catch(() => {});
  }
  const metrics = current?.metrics.snapshot();
  state = { ...state, ...metrics, running: false, completedAt: new Date().toISOString(),
    ...(outcome ? { outcome, message } : diagnosticOutcome(metrics || { duration: 0 })) };
}

async function start(message) {
  if (state.running) throw new Error('Es läuft bereits ein Tontest.');
  const token = ++generation;
  const current = resources = { metrics: new AudioMetrics(), stream: null, context: null, timer: null, monitor: null };
  state = { running: true, outcome: 'starting', message: 'Tonzugriff wird vorbereitet …', tabId: message.tabId, startedAt: new Date().toISOString() };
  // This also bounds a hung permission/stream request. A late stream is stopped below.
  current.timer = setTimeout(() => { void finish(token, 'unavailable', 'Der Tonzugriff hat nicht rechtzeitig geantwortet.'); }, 6000);
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: message.streamId } }, video: false
    });
    if (token !== generation) { stream.getTracks().forEach(track => track.stop()); return; }
    current.stream = stream;
    if (!stream.getAudioTracks().length) throw new Error('Der Browser hat keine Tonspur bereitgestellt.');
    const context = current.context = new AudioContext();
    const source = current.source = context.createMediaStreamSource(stream);
    // tabCapture redirects playback; immediately reconnect it to preserve sound.
    source.connect(context.destination);
    await context.resume();
    await context.audioWorklet.addModule('audio-meter-worklet.js');
    if (token !== generation) return;
    const node = current.node = new AudioWorkletNode(context, 'video-sync-meter');
    source.connect(node);
    // The meter outputs zeros, keeping analysis active without doubling the sound.
    node.connect(context.destination);
    node.port.onmessage = ({ data }) => { if (token === generation) current.metrics.add(data); };
    node.onprocessorerror = () => { void finish(token, 'error', 'Die Tonanalyse wurde vom Browser unterbrochen.'); };
    stream.getAudioTracks()[0].onended = () => { void finish(token, 'unavailable', 'Der Browser hat den Tonzugriff beendet.'); };
    clearTimeout(current.timer);
    state = { ...state, outcome: 'capturing', message: `Ton wird ${TEST_SECONDS} Sekunden geprüft. Das Video weiterlaufen lassen.` };
    current.timer = setTimeout(() => { void finish(token); }, TEST_SECONDS * 1000);
    let checking = false;
    current.monitor = setInterval(async () => {
      if (checking || token !== generation) return;
      checking = true;
      try {
        const player = await playerStatus();
        if (token !== generation) return;
        if (!player?.local || player.tabId !== message.tabId || player.documentId !== message.documentId || player.local.mediaId !== message.mediaId || player.room) {
          void finish(token, 'cancelled', 'Tontest beendet: Video oder Sitzung hat sich geändert.');
        } else if (player.local.paused || player.local.buffering) {
          void finish(token, 'cancelled', 'Das Video wurde pausiert oder lädt nach. Bei laufendem Video erneut testen.');
        }
      } catch {
        void finish(token, 'cancelled', 'Die Verbindung zum Video wurde unterbrochen.');
      } finally { checking = false; }
    }, 500);
  } catch (error) {
    const description = error.name === 'NotAllowedError'
      ? 'Der Browser hat den Tonzugriff nicht erlaubt. Das belegt allein keine DRM-Sperre.'
      : `Tonzugriff fehlgeschlagen: ${error.message}`;
    await finish(token, 'error', description);
  }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.tab || message.target !== 'capture-lab') return;
  if (message.action === 'start') {
    if (state.running) { respond({ ok: false, error: 'Es läuft bereits ein Tontest.' }); return; }
    void start(message);
  } else if (message.action === 'cancel' || (message.action === 'tab-closed' && message.tabId === state.tabId)) {
    if (state.running) {
      finish(generation, 'cancelled', 'Tontest beendet.').then(() => respond({ ok: true, result: status() }));
      return true;
    }
  }
  respond({ ok: true, result: status() });
});
