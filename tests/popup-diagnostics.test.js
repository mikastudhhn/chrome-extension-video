import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { mountDiagnostics } from '../extension/diagnostics-view.js';
import { StatusFeed, observeStatus } from '../extension/status-feed.js';
import { ServerSetting, renderServerSetting } from '../extension/server-setting.js';
import { fault, responseError } from '../extension/runtime-errors.js';

// Execute the actual popup wiring with the real feed and diagnostics view. Only
// browser APIs and unrelated presentation are replaced by this DOM boundary.
const source = (await readFile(new URL('../extension/popup.js', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '');
const settle = () => new Promise(setImmediate);
class Element extends EventTarget {
  constructor() { super(); this.attributes = {}; this.dataset = {}; this.textContent = ''; this.disabled = false; }
  setAttribute(name, value) { this.attributes[name] = value; }
  click() { if (!this.disabled) this.dispatchEvent(new Event('click')); }
  focus() {}
}
async function popupFixture(reply) {
  const elements = new Map(), snapshots = [], downloads = [], messages = [];
  const get = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  get('diagnostics-panel').querySelector = selector => get(selector.slice(1));
  const document = Object.assign(new EventTarget(), {
    hidden: false, getElementById: get, querySelectorAll: () => []
  });
  const window = new EventTarget();
  const event = () => ({ addListener() {}, removeListener() {} });
  let state = { channel: 'experimental', diagnosticsAvailable: true, lifecycle: { instanceId: 'session', revision: 1 }, room: null };
  const chrome = {
    runtime: { id: 'test', onMessage: event(), sendMessage: async message => {
      messages.push(message);
      return message.action === 'status' ? { ok: true, result: state } : reply(message.action);
    } },
    storage: { local: { get: async () => ({}) }, onChanged: event() },
    tabs: { onUpdated: event() },
    permissions: { contains: async () => false, onAdded: event(), onRemoved: event() }
  };
  await vm.runInNewContext(`(async () => { ${source}\n })()`, {
    document, window, chrome, StatusFeed, observeStatus: feed => observeStatus(feed, { runtime: chrome.runtime, storage: chrome.storage, page: document, windowObject: window }), fault, responseError, DEFAULT_SERVER: 'http://127.0.0.1:1234',
    versionDisplayState: value => value,
    ServerSetting, renderServerSetting: setting => renderServerSetting(setting, document),
    renderPopup: ({ current }) => snapshots.push(current),
    mountDiagnostics: (root, options) => mountDiagnostics(root, { ...options, download: text => downloads.push(JSON.parse(text)) }),
    mountOnboarding: () => ({ active: false, step: 0, init: async () => false, open: async () => {}, update() {}, refreshPermission: async () => {} })
  });
  return { get, downloads, messages, snapshots, state,
    switchChannel: async () => {
      state = { ...state, channel: 'stable', diagnosticsAvailable: false };
      document.dispatchEvent(new Event('visibilitychange')); await settle();
    },
    close: () => window.dispatchEvent(new Event('pagehide'))
  };
}

test('popup export and clear preserve the session snapshot and download the actual report', async t => {
  let events = [{ at: Date.now(), kind: 'phase', phase: 'synced' }];
  const f = await popupFixture(async action => {
    if (action === 'diagnostics-clear') { events = []; return { ok: true, result: { cleared: true } }; }
    return { ok: true, result: { schema: 1, storage: 'session-memory', events } };
  });
  t.after(f.close);
  f.get('diagnostics-export').click(); await settle();
  assert.equal(f.downloads.length, 1);
  assert.equal(f.downloads[0].events.length, 1);
  assert.match(f.get('diagnostics-feedback').textContent, /Download gestartet/);
  f.get('diagnostics-clear').click(); await settle();
  assert.match(f.get('diagnostics-feedback').textContent, /Diagnose gelöscht/);
  f.get('diagnostics-export').click(); await settle();
  assert.deepEqual(f.downloads[1].events, []);
  assert.ok(f.snapshots.every(state => state === f.state), 'diagnostic responses must never replace session state');
  assert.equal(f.get('diagnostics-export').disabled, false);
  // Opening the popup also sends one debounced update check.
  assert.deepEqual(f.messages.map(message => message.action), ['status', 'update-check-opened', 'diagnostics-export', 'diagnostics-clear', 'diagnostics-export']);
});

test('popup rejects malformed/error diagnostic envelopes without corrupting status or reporting success', async t => {
  let response;
  const f = await popupFixture(async () => response);
  t.after(f.close);
  for (response of [undefined, { ok: true }, { ok: 'true', result: { schema: 1, storage: 'session-memory', events: [], cleared: true } },
    { ok: false, error: 'PRIVATE', result: { schema: 1, storage: 'session-memory', events: [], cleared: true } }]) {
    f.get('diagnostics-export').click(); await settle();
    assert.match(f.get('diagnostics-feedback').textContent, /^Export nicht möglich/);
    f.get('diagnostics-clear').click(); await settle();
    assert.match(f.get('diagnostics-feedback').textContent, /^Löschen nicht bestätigt/);
  }
  assert.equal(f.downloads.length, 0);
  assert.ok(f.snapshots.every(state => state === f.state));
});

test('popup still discards a pending diagnostic export when the status channel changes', async t => {
  let resolve;
  const f = await popupFixture(() => new Promise(done => { resolve = done; }));
  t.after(f.close);
  f.get('diagnostics-export').click();
  await f.switchChannel();
  resolve({ ok: true, result: { schema: 1, storage: 'session-memory', events: [] } }); await settle();
  assert.equal(f.downloads.length, 0);
  assert.equal(f.get('diagnostics-export').disabled, true);
  assert.equal(f.get('diagnostics-feedback').textContent, '');
});
