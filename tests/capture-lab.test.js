import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { AudioMetrics, diagnosticOutcome, TEST_SECONDS } from '../extension/audio-metrics.js';

const source = (await readFile('extension/capture-lab.js', 'utf8')).replace(/^import .*;\n/gm, '');
const flush = () => new Promise(resolve => setImmediate(resolve));
function harness(getUserMedia, observePlayer) {
  let listener, node, stopped = 0, closed = 0;
  const timers = new Map();
  const track = { stop: () => stopped++ };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const player = { tabId: 1, documentId: 'doc', local: { paused: false, buffering: false }, room: null };
  const context = {
    AudioMetrics, diagnosticOutcome, TEST_SECONDS, console,
    playerStatus: () => observePlayer ? observePlayer() : player,
    setTimeout: (fn, ms) => { timers.set(ms, fn); return ms; }, clearTimeout: id => timers.delete(id),
    setInterval: (fn, ms) => { timers.set(ms, fn); return ms; }, clearInterval: id => timers.delete(id),
    navigator: { mediaDevices: { getUserMedia: getUserMedia || (async () => stream) } },
    AudioContext: class {
      constructor() { this.destination = {}; this.audioWorklet = { addModule: async () => {} }; }
      createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
      async resume() {} async close() { closed++; }
    },
    AudioWorkletNode: class { constructor() { node = this; this.port = {}; } connect() {} disconnect() {} },
    chrome: { runtime: { id: 'test', onMessage: { addListener: fn => { listener = fn; } },
      sendMessage: async () => ({ ok: true, result: { tabId: 1, documentId: 'doc', local: { paused: false, buffering: false }, room: null } }) } }
  };
  vm.runInNewContext(source, context);
  const send = (action, extra = {}) => new Promise(resolve => listener({ target: 'capture-lab', action, ...extra }, { id: 'test' }, resolve));
  return { send, stream, timers, player, get node() { return node; }, get stopped() { return stopped; }, get closed() { return closed; } };
}

test('capture terminates at the deadline, reports only aggregate metrics and releases audio', async () => {
  const lab = harness();
  await lab.send('start', { tabId: 1, documentId: 'doc', streamId: 'one-use' });
  await flush();
  assert.equal((await lab.send('status')).result.outcome, 'capturing');
  for (let i = 0; i < 70; i++) lab.node.port.onmessage({ data: { samples: 4800, squares: 48, sampleRate: 48000, peak: 0.2 } });
  lab.timers.get(8000)(); await flush();
  const result = (await lab.send('status')).result;
  assert.equal(result.outcome, 'signal'); assert.equal(result.running, false);
  assert.equal(result.duration, 7); assert.equal(lab.stopped, 1); assert.equal(lab.closed, 1);
  assert.equal(lab.timers.size, 0);
});
test('cancel during stream acquisition closes a late stream and cannot restart capture', async () => {
  let resolveStream;
  const lab = harness(() => new Promise(resolve => { resolveStream = resolve; }));
  await lab.send('start', { tabId: 1 });
  await lab.send('cancel');
  resolveStream(lab.stream); await flush();
  assert.equal(lab.stopped, 1);
  assert.equal(lab.node, undefined);
  assert.equal((await lab.send('status')).result.outcome, 'cancelled');
});
test('closing another tab is harmless, closing the captured tab stops the stream', async () => {
  const lab = harness();
  await lab.send('start', { tabId: 1, documentId: 'doc' }); await flush();
  await lab.send('tab-closed', { tabId: 2 });
  assert.equal((await lab.send('status')).result.running, true);
  await lab.send('tab-closed', { tabId: 1 });
  assert.equal(lab.stopped, 1); assert.equal((await lab.send('status')).result.running, false);
});
test('permission failures are reported as access errors, not a proved DRM restriction', async () => {
  const lab = harness(async () => { throw Object.assign(new Error('denied'), { name: 'NotAllowedError' }); });
  await lab.send('start', { tabId: 1 }); await flush();
  const result = (await lab.send('status')).result;
  assert.equal(result.outcome, 'error'); assert.match(result.message, /keine DRM-Sperre/);
  assert.equal(lab.timers.size, 0);
});

test('startup timeout bounds an unresponsive browser and closes its late stream', async () => {
  let resolveStream;
  const lab = harness(() => new Promise(resolve => { resolveStream = resolve; }));
  await lab.send('start', { tabId: 1 });
  lab.timers.get(6000)(); await flush();
  assert.equal((await lab.send('status')).result.outcome, 'unavailable');
  resolveStream(lab.stream); await flush();
  assert.equal(lab.stopped, 1); assert.equal(lab.node, undefined);
});

test('pause, buffering, same-document media changes and room entry cancel diagnostics', async () => {
  for (const mutate of [player => { player.local.paused = true; }, player => { player.local.buffering = true; },
    player => { player.local.mediaId = 'next-episode'; }, player => { player.room = { code: 'test' }; }]) {
    const lab = harness();
    await lab.send('start', { tabId: 1, documentId: 'doc' }); await flush();
    mutate(lab.player);
    await lab.timers.get(500)(); await flush();
    assert.equal((await lab.send('status')).result.outcome, 'cancelled');
    assert.equal(lab.stopped, 1); assert.equal(lab.closed, 1); assert.equal(lab.timers.size, 0);
  }
});

test('an active sound test awaits fresh observations without overlapping them or reviving cancelled capture', async () => {
  let resolve, reads = 0;
  const lab = harness(undefined, () => { reads++; return new Promise(yes => { resolve = yes; }); });
  await lab.send('start', { tabId: 1, documentId: 'doc' }); await flush();
  const monitor = lab.timers.get(500);
  const pending = monitor(); await monitor();
  assert.equal(reads, 1);
  await lab.send('cancel');
  resolve({ tabId: 1, documentId: 'doc', local: { paused: false, buffering: false }, room: null });
  await pending;
  assert.equal((await lab.send('status')).result.running, false);
  assert.equal(lab.timers.size, 0);
  assert.equal(lab.stopped, 1);
});
