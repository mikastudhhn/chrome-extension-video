import { createOffscreenHost } from '../extension/offscreen-host.js';
import { fault, errorResponse } from '../extension/runtime-errors.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { discoverPlayer, callPlayer, guardPlayerAccess } from '../extension/player-frames.js';

const candidate = (id, area = 60000) => ({ id, area, time: 5, duration: 120, label: 'Movie' });
function fixture(t, frames) {
  const original = globalThis.chrome;
  const calls = [], contexts = new Map();
  for (const frame of frames) {
    const player = {
      probe: () => frame.videos || [], beginFrameScan() { frame.openScan = true; },
      announceFrame: () => frame.announcement || Promise.resolve(),
      finishFrameScan() { frame.openScan = false; return { mapped: frame.mapped || [], embeddings: frame.embeddings || [] }; },
      attach: selection => ({ time: frame.videos.find(video => video.id === selection.playerId)?.time, selected: selection.playerId }),
      sample: () => ({ time: 5 }), apply: () => ({ time: 5 })
    };
    contexts.set(frame.documentId, vm.createContext({ window: { __videoSyncOwner: frame.owner || 'installation-a', __videoSyncPlayer: player }, Date }));
  }
  globalThis.crypto ??= webcrypto;
  globalThis.chrome = {
    runtime: { id: 'installation-a' },
    permissions: { contains: async ({ origins }) => !frames.some(frame => frame.missing && `${new URL(frame.url).origin}/*` === origins[0]) },
    webNavigation: { getAllFrames: async () => frames },
    scripting: { executeScript: async options => {
      calls.push(options);
      const id = options.target.documentIds[0];
      const frame = frames.find(frame => frame.documentId === id);
      if (frame.scriptError) throw new Error(frame.scriptError);
      if (frame.noScriptResult) return [{}];
      if (frame.missing) throw new Error('Missing permission');
      if (options.files) return [{}];
      const context = contexts.get(id);
      context.args = options.args || [];
      return [{ result: await vm.runInContext(`(${options.func.toString()})(...args)`, context) }];
    } }
  };
  t.after(() => { globalThis.chrome = original; });
  return { calls, contexts };
}

for (const missing of [false, true]) {
  test(`a failed background frame does not hide a loaded video or request useless access (missing permission: ${missing})`, async t => {
    fixture(t, [
      { frameId: 0, parentFrameId: -1, documentId: 'top', url: 'https://top.test', videos: [candidate('main')],
        embeddings: [{ url: 'https://background.test/', area: 60000 }] },
      { frameId: 1, parentFrameId: 0, documentId: 'failed', url: 'https://background.test/',
        errorOccurred: true, scriptError: 'Frame with ID 1 is showing error page', missing }
    ]);
    const result = await discoverPlayer(1);
    assert.equal(result.playerId, 'main');
    assert.equal(result.documentId, 'top');
    assert.deepEqual(result.missingOrigins, []);
    assert.equal((await callPlayer({ tabId: 1, action: 'attach' })).sample.selected, 'main');
  });
}

test('a failed player frame alone never becomes a candidate or a binding', async t => {
  fixture(t, [
    { frameId: 0, parentFrameId: -1, documentId: 'top', url: 'https://top.test' },
    { frameId: 1, parentFrameId: 0, documentId: 'failed', url: 'https://player.test/',
      errorOccurred: true, scriptError: 'Frame with ID 1 is showing error page' }
  ]);
  assert.deepEqual((await discoverPlayer(1)).candidates, []);
  await assert.rejects(callPlayer({ tabId: 1, action: 'attach' }), /Kein geladenes Video/);
});

test('a navigation error does not exclude a still-accessible player document', async t => {
  fixture(t, [{ frameId: 0, parentFrameId: -1, documentId: 'top', url: 'https://top.test',
    errorOccurred: true, videos: [candidate('main')] }]);
  assert.equal((await discoverPlayer(1)).playerId, 'main');
});

test('an unexplained frame inspection failure still prevents an incomplete player selection', async t => {
  fixture(t, [
    { frameId: 0, parentFrameId: -1, documentId: 'top', url: 'https://top.test', videos: [candidate('main')] },
    { frameId: 1, parentFrameId: 0, documentId: 'other', url: 'https://player.test/', scriptError: 'Document changed during inspection' }
  ]);
  await assert.rejects(discoverPlayer(1), /unvollständig/);
});

for (const noScriptResult of [false, true]) {
  test(`hidden sandbox helper frames do not block the main player (empty script result: ${noScriptResult})`, async t => {
    fixture(t, [
      { frameId: 0, parentFrameId: -1, documentId: 'top', url: 'https://top.test', videos: [candidate('main')],
        embeddings: [{ url: 'about:blank', area: 0 }] },
      { frameId: 1, parentFrameId: 0, documentId: 'sandbox', url: 'about:blank', noScriptResult,
        scriptError: noScriptResult ? null : 'Scripts are blocked in this sandbox' }
    ]);
    const found = await discoverPlayer(1);
    assert.equal(found.playerId, 'main');
    assert.deepEqual(found.missingOrigins, []);
    assert.equal((await callPlayer({ tabId: 1, action: 'attach' })).sample.selected, 'main');
  });
}

for (const embeddings of [[], [{ url: 'about:blank', area: 60000 }],
  [{ url: 'about:blank', area: 0 }, { url: 'https://redirect.test/', area: 60000 }]]) {
  test(`a sandbox frame with uncertain visibility still blocks selection: ${JSON.stringify(embeddings)}`, async t => {
    fixture(t, [
      { frameId: 0, parentFrameId: -1, documentId: 'top', url: 'https://top.test', videos: [candidate('main')], embeddings },
      { frameId: 1, parentFrameId: 0, documentId: 'sandbox', url: 'about:blank', noScriptResult: true }
    ]);
    await assert.rejects(discoverPlayer(1), /unvollständig/);
  });
}

test('redirected and duplicate iframe URLs use document mappings, never the larger hidden sibling', async t => {
  const frames = [
    { frameId: 0, parentFrameId: -1, documentId: 'top', url: 'https://top.test',
      mapped: [{ documentId: 'visible', area: 60000 }, { documentId: 'hidden', area: 0 }],
      embeddings: [{ url: 'https://redirect.test', area: 60000 }, { url: 'https://redirect.test', area: 0 }] },
    { frameId: 1, parentFrameId: 0, documentId: 'visible', url: 'https://final.test', videos: [candidate('a')] },
    { frameId: 2, parentFrameId: 0, documentId: 'hidden', url: 'https://final.test', videos: [candidate('b', 700000)] }
  ];
  fixture(t, frames);
  const result = await discoverPlayer(1);
  assert.equal(result.documentId, 'visible');
  assert.equal(result.playerId, 'a');
  assert.equal(result.candidates.length, 1);
  assert.ok(frames.every(frame => !frame.openScan));
});

test('multiple frame candidates require selection and attach revalidates visibility of that exact candidate', async t => {
  const top = { frameId: 0, parentFrameId: -1, documentId: 'top', url: 'https://top.test', videos: [candidate('main')],
    mapped: [{ documentId: 'child', area: 60000 }] };
  fixture(t, [top, { frameId: 1, parentFrameId: 0, documentId: 'child', url: 'https://child.test', videos: [candidate('trailer')] }]);
  const result = await discoverPlayer(1);
  assert.equal(result.documentId, null);
  await assert.rejects(callPlayer({ tabId: 1, action: 'attach' }), /Mehrere Videos/);
  const selected = await callPlayer({ tabId: 1, documentId: 'child', playerId: 'trailer', action: 'attach' });
  assert.equal(selected.sample.selected, 'trailer');
  top.mapped[0].area = 0;
  await assert.rejects(callPlayer({ tabId: 1, documentId: 'child', playerId: 'trailer', action: 'attach' }), /nicht mehr verfügbar/);
});

test('discovery waits beyond 250ms for a parent acknowledgement and cleans up its scans', async t => {
  const frames = [
    { frameId: 0, parentFrameId: -1, documentId: 'top', url: 'https://top.test', mapped: [{ documentId: 'child', area: 60000 }] },
    { frameId: 1, parentFrameId: 0, documentId: 'child', url: 'https://child.test', videos: [candidate('video')],
      announcement: new Promise(resolve => setTimeout(resolve, 300)) }
  ];
  fixture(t, frames);
  const result = await discoverPlayer(1);
  assert.equal(result.playerId, 'video');
  assert.ok(frames.every(frame => !frame.openScan));
});

test('unmapped accessible child produces a retry message rather than a false single-player selection', async t => {
  const frames = [
    { frameId: 0, parentFrameId: -1, documentId: 'top', url: 'https://top.test', videos: [candidate('main')] },
    { frameId: 1, parentFrameId: 0, documentId: 'child', url: 'https://child.test', videos: [candidate('other')] }
  ];
  fixture(t, frames);
  await assert.rejects(discoverPlayer(1), /unvollständig/);
  assert.ok(frames.every(frame => !frame.openScan));
});

test('permission discovery ignores known hidden frames and requests the next visible embedding', async t => {
  fixture(t, [
    { frameId: 0, parentFrameId: -1, documentId: 'top', url: 'https://top.test',
      embeddings: [{ url: 'https://wrapper.test/', area: 60000 }, { url: 'https://hidden.test/', area: 0 }] },
    { frameId: 1, parentFrameId: 0, documentId: 'wrapper', url: 'https://wrapper.test/', missing: true },
    { frameId: 2, parentFrameId: 0, documentId: 'hidden', url: 'https://hidden.test/', missing: true },
    { frameId: 3, parentFrameId: 1, documentId: 'nested', url: 'https://nested.test/', missing: true }
  ]);
  assert.deepEqual((await discoverPlayer(1)).missingOrigins, ['https://wrapper.test/*']);
});

test('ownership guards do not modify another installation or an unowned legacy player', async t => {
  const { contexts } = fixture(t, [{ frameId: 0, parentFrameId: -1, documentId: 'top', url: 'https://top.test', owner: 'installation-b' }]);
  await assert.rejects(guardPlayerAccess(1), /andere oder ältere/);
  assert.equal(contexts.get('top').window.__videoSyncOwner, 'installation-b');
  delete contexts.get('top').window.__videoSyncOwner;
  await assert.rejects(guardPlayerAccess(1), /andere oder ältere/);
});

test('sampling checks ownership in its one script execution, including foreign takeover', async t => {
  const { calls, contexts } = fixture(t, [{ frameId: 0, parentFrameId: -1, documentId: 'top', url: 'https://top.test' }]);
  assert.equal((await callPlayer({ tabId: 1, documentId: 'top', action: 'sample' })).time, 5);
  assert.equal(calls.length, 1);
  contexts.get('top').window.__videoSyncOwner = 'installation-b';
  await assert.rejects(callPlayer({ tabId: 1, documentId: 'top', action: 'sample' }), /Instanzkonflikt/);
  assert.equal(calls.length, 2);
});

test('an unresponsive child exhausts the shared scan budget, reports retry and removes completed-frame listeners', async t => {
  const frames = [
    { frameId: 0, parentFrameId: -1, documentId: 'top', url: 'https://top.test', videos: [candidate('main')] },
    { frameId: 1, parentFrameId: 0, documentId: 'child', url: 'https://child.test', videos: [candidate('other')], announcement: new Promise(() => {}) }
  ];
  fixture(t, frames);
  await assert.rejects(discoverPlayer(1), /zu lange|unvollständig/);
  assert.ok(frames.every(frame => !frame.openScan));
});

test('a command whose offscreen deadline elapsed cannot mutate the page after delayed routing', async t => {
  const { calls } = fixture(t, [{ frameId: 0, parentFrameId: -1, documentId: 'top', url: 'https://top.test' }]);
  await assert.rejects(callPlayer({ tabId: 1, documentId: 'top', action: 'apply', command: { type: 'sync', playing: true, time: 90 }, requestDeadline: Date.now() - 1 }), /abgelaufen/);
  assert.equal(calls.length, 0);
});

// Exercise the real background dispatch as well as the MAIN-world call.
function backgroundFixture() {
  let listener;
  const event = { addListener() {} };
  const chrome = globalThis.chrome;
  Object.assign(chrome.runtime, { getURL: path => `chrome-extension://installation-a/${path}`,
    onMessage: { addListener(fn) { listener = fn; } }, onInstalled: event, onStartup: event });
  chrome.storage = { local: { async get() { return { channel: 'stable' }; }, async setAccessLevel() {} }, session: { async get() { return {}; } }, onChanged: { addListener() {} } };
  chrome.tabs = { onRemoved: event }; chrome.webNavigation.onCommitted = event; chrome.alarms = { onAlarm: event };
  const context = vm.createContext({ chrome, discoverPlayer, callPlayer,
    createOffscreenHost, fault, errorResponse, updateRecovery: Promise.resolve(), recovery: { pending: false },
    channelName: value => value, featuresFor: () => ({ audioDiagnostics: false }),
    fetch: async () => ({ json: async () => ({ local: null }) }), createDevelopmentSession: () => null, STORE: false });
  const source = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '');
  vm.runInContext(source, context);
  return message => new Promise((resolve, reject) => listener({ target: 'background', ...message },
    { id: 'installation-a' }, response => response.ok ? resolve(response.result) : reject(new Error(response.error))));
}

test('background dispatch uses one atomic ownership check and player call', async t => {
  const { calls, contexts } = fixture(t, [{ frameId: 0, parentFrameId: -1, documentId: 'top', url: 'https://top.test' }]);
  const request = backgroundFixture();
  const invoked = [];
  contexts.get('top').window.__videoSyncPlayer = Object.fromEntries(['sample', 'apply', 'detach'].map(action =>
    [action, command => { invoked.push({ action, command }); return { time: 5 }; }]));
  for (const action of ['sample', 'apply', 'detach']) {
    assert.equal((await request({ type: 'player', tabId: 1, documentId: 'top', action, command: { type: 'sync', time: 40, playing: true } })).time, 5);
  }
  assert.equal(calls.length, 3, 'no separate preflight on the status/control path');
  assert.deepEqual(invoked.map(call => call.action), ['sample', 'apply', 'detach']);
  contexts.get('top').window.__videoSyncOwner = 'installation-b';
  await assert.rejects(request({ type: 'player', tabId: 1, documentId: 'top', action: 'apply', command: { type: 'pause' } }), /Instanzkonflikt/);
  assert.equal(invoked.length, 3, 'a foreign singleton receives no operation');
  assert.equal(calls.length, 4);
});

test('cancelling an attach during document discovery prevents its eventual page mutation', async t => {
  const { contexts } = fixture(t, [{ frameId: 0, parentFrameId: -1, documentId: 'top', url: 'https://top.test', videos: [candidate('main')] }]);
  const original = chrome.webNavigation.getAllFrames;
  let continueDiscovery;
  const discovery = new Promise(resolve => { continueDiscovery = resolve; });
  chrome.webNavigation.getAllFrames = async (...args) => {
    await discovery;
    return original(...args);
  };
  let attachments = 0;
  contexts.get('top').window.__videoSyncPlayer.attach = () => { attachments++; return {}; };
  contexts.get('top').window.__videoSyncPlayer.detach = () => {};
  const pending = callPlayer({ tabId: 1, action: 'attach', command: { bindingId: 'pending-binding' } });
  await callPlayer({ tabId: 1, documentId: 'top', action: 'detach', command: { expectedBindingId: 'pending-binding' } });
  continueDiscovery();
  await assert.rejects(pending, /abgebrochen/);
  assert.equal(attachments, 0);
});

test('passive observation routes only the selected candidate through the ownership guard', async t => {
  const { calls, contexts } = fixture(t, [{ frameId: 0, parentFrameId: -1, documentId: 'top', url: 'https://top.test' }]);
  contexts.get('top').window.__videoSyncPlayer.observe = selection => ({ playerId: selection.playerId, paused: false, time: 17 });
  const observed = await callPlayer({ tabId: 1, documentId: 'top', playerId: 'selected', action: 'observe' });
  assert.equal(observed.playerId, 'selected'); assert.equal(observed.time, 17);
  assert.equal(calls.length, 1, 'no attach or discovery mutation');
  contexts.get('top').window.__videoSyncOwner = 'other-installation';
  await assert.rejects(callPlayer({ tabId: 1, documentId: 'top', playerId: 'selected', action: 'observe' }), /Instanzkonflikt/);
});
