import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from '../server/index.js';
import { responseError } from '../extension/runtime-errors.js';
import { describeRoomError } from '../extension/errors.js';

test('real worker, offscreen and background listeners carry HTTP error identity to UI without duplicate notices', async t => {
  const originals = Object.fromEntries(['chrome', 'Worker', 'self', 'fetch', 'setInterval', 'setTimeout', 'indexedDB'].map(key => [key, globalThis[key]]));
  const server = createServer({ env: {}, pollTimeoutMs: 10 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const [key, value] of Object.entries(originals)) globalThis[key] = value;
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const listeners = [], wire = [];
  const noopEvent = { addListener() {} };
  const local = { channel: 'experimental' }, session = {};
  const storage = values => ({ get: async () => ({ ...values }), set: async data => Object.assign(values, data),
    remove: async key => { delete values[key]; }, setAccessLevel: async () => {} });
  const sender = { id: 'test', url: 'chrome-extension://test/popup.html' };
  const dispatch = message => new Promise((resolve, reject) => {
    for (const listener of listeners) {
      const accepted = listener(structuredClone(message), sender, response => {
        wire.push({ target: message.target, response: structuredClone(response) });
        resolve(structuredClone(response));
      });
      if (accepted) return;
    }
    reject(new Error(`No listener: ${message.target}`));
  });
  const sample = { time: 5, duration: 100, mediaId: 'video', paused: true, buffering: false };
  globalThis.chrome = {
    storage: { local: storage(local), session: storage(session), onChanged: { addListener() {} } },
    runtime: { id: 'test', getManifest: () => ({version: '0.5.0'}), getURL: path => `chrome-extension://test/${path}`, getContexts: async () => [{ documentUrl: 'chrome-extension://test/offscreen.html' }],
      onMessage: { addListener: listener => listeners.push(listener) }, onStartup: noopEvent, onInstalled: noopEvent,
      sendMessage: async message => {
        if (message.target === 'background' && message.type === 'player') return { ok: true,
          result: message.action === 'attach' ? { sample, documentId: 'document' } : sample };
        if (message.target === 'capture-lab') return { ok: true, result: {} };
        return dispatch(message);
      } },
    tabs: { onRemoved: noopEvent }, webNavigation: { onCommitted: noopEvent }, alarms: { onAlarm: noopEvent }
  };
  // Empty persistent storage: recovery performs real adapter reads and must
  // discover no pending journal before allowing ordinary protocol operations.
  const journalReads = [];
  globalThis.indexedDB = { open: () => {
    const request = {};
    queueMicrotask(() => {
      request.result = {
        transaction: (store, mode) => {
          assert.equal(store, 'settings'); assert.equal(mode, 'readonly');
          const transaction = { objectStore: () => ({ get: key => {
            journalReads.push(key);
            queueMicrotask(() => transaction.oncomplete());
            return { result: undefined };
          } }) };
          return transaction;
        }, close() {}
      };
      request.onsuccess();
    });
    return request;
  } };
  globalThis.setInterval = () => 0; // No polling or browser process in this Node boundary test.
  globalThis.setTimeout = (...args) => { const timer = originals.setTimeout(...args); timer.unref(); return timer; };
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith('chrome-extension://test/')) {
      const file = String(url).slice('chrome-extension://test/'.length);
      return { json: async () => JSON.parse(await readFile(`extension/${file}`, 'utf8')) };
    }
    return originals.fetch(url, options);
  };
  let worker;
  globalThis.self = {
    postMessage: data => { wire.push({ target: 'worker', response: structuredClone(data) }); queueMicrotask(() => worker.onmessage({ data: structuredClone(data) })); },
    close() {}
  };
  await import('../extension/connection-worker.js');
  globalThis.Worker = class {
    constructor() { worker = this; }
    postMessage(data) { void globalThis.self.onmessage({ data: structuredClone(data) }); }
    terminate() {}
  };
  await import('../extension/offscreen.js');
  await import('../extension/background.js');
  const attached = await dispatch({ target: 'background', type: 'ui', action: 'attach', tabId: 1 });
  assert.equal(attached.ok, true, JSON.stringify(attached));
  assert.deepEqual(journalReads, ['updateJournal', 'backup']);
  assert.equal(attached.result.recovery.pending, false);
  const response = await dispatch({ target: 'background', type: 'ui', action: 'join', server: base, code: 'QQQQQQ' });
  assert.equal(response.ok, false);
  for (const boundary of ['worker', 'offscreen', 'background']) {
    const failure = wire.find(entry => entry.target === boundary && entry.response.failure)?.response.failure;
    assert.deepEqual({ code: failure?.code, category: failure?.category, retryable: failure?.retryable, status: failure?.status },
      { code: 'ROOM_NOT_FOUND', category: 'room', retryable: false, status: 404 });
  }
  const ui = describeRoomError(responseError(response), 'join', base);
  assert.equal(ui.title, 'Raum nicht gefunden'); assert.equal(ui.editInvitation, true); assert.equal(ui.retry, false);
  const status = await dispatch({ target: 'background', type: 'ui', action: 'status' });
  assert.equal(status.result.notice, '');
  assert.equal(status.result.noticeError, null);
});
