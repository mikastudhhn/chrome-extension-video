import { fault, errorResponse, responseError } from '../extension/runtime-errors.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { channelName, channelOptions, validateChannelSwitch } from '../extension/channels.js';
import { UPDATE_INTERVAL_MINUTES } from '../extension/update-service.js';

const source = (await Promise.all(['offscreen-host.js', 'background-updates.js', 'background.js'].map(file => readFile(`extension/${file}`, 'utf8')))).join('\n').replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
const flush = () => new Promise(setImmediate);
function harness({ configure = () => {}, runtimeReply, features = {}, pending = false, blocked = false, room = null, brokenBuild = false, offscreenPresent = false, brokenPlayer = false, readRecovery, updates = { configured: false }, run = async () => ({ outcome: 'restored' }) } = {}) {
  let listener, reloads = 0, offscreenCalls = 0, playerCalls = 0, guardCalls = 0, runs = 0;
  const session = {}, local = {}, timers = new Set(), hooks = {}, runtimeMessages = [];
  const event = name => ({ addListener: fn => { hooks[name] = fn; } });
  // Like chrome.storage, writes notify onChanged listeners (background caches the lock and channel).
  const storage = (data, area) => ({
    get: async () => ({ ...data }),
    set: async values => {
      const changes = Object.fromEntries(Object.entries(values).map(([key, newValue]) => [key, { oldValue: data[key], newValue }]));
      Object.assign(data, values); hooks.storageChanged?.(changes, area);
    },
    remove: async keys => {
      const changes = {};
      for (const key of [keys].flat()) if (key in data) { changes[key] = { oldValue: data[key] }; delete data[key]; }
      hooks.storageChanged?.(changes, area);
    }, setAccessLevel: async () => {}
  });
  const environment = {
    console, channelName, channelOptions, validateChannelSwitch, fault, errorResponse, responseError,
    // The real player router checks ownership inside every discovery and call.
    discoverPlayer: async () => { guardCalls++; playerCalls++; return {}; },
    callPlayer: async () => { guardCalls++; playerCalls++; return {}; },
    recoveryStatus: readRecovery || (async () => ({ pending, blocked, canRestore: pending && !blocked, message: pending ? 'Recovery required' : '' })),
    stored: async () => ({}),
    updateStatus: async () => updates, checkUpdates: async () => ({}), configureUpdates: async () => {},
    UPDATE_INTERVAL_MINUTES, createDevelopmentSession: () => null, featuresFor: () => features,
    runUpdate: async options => { runs++; return run(options); },
    fetch: async url => {
      assert.ok(url.startsWith('chrome-extension://test/'), 'normal usage must not fetch GitHub');
      return { json: async () => {
      if (brokenBuild && url.endsWith('build-info.json')) throw new Error('Broken metadata');
      return { version: '0.5.0', local: null };
    } }; },
    setInterval: fn => { timers.add(fn); return fn; }, clearInterval: fn => timers.delete(fn),
    chrome: {
      runtime: { id: 'test', getURL: file => `chrome-extension://test/${file}`, getManifest: () => ({ version: '0.5.0' }),
        getContexts: async () => offscreenPresent ? [{ contextType: 'OFFSCREEN_DOCUMENT', documentUrl: 'chrome-extension://test/offscreen.html' }] : [], onMessage: { addListener: fn => { listener = fn; } }, onStartup: event('startup'), onInstalled: event('installed'),
        sendMessage: async message => { runtimeMessages.push(message); offscreenCalls++; if (pending || brokenPlayer) throw new Error('Offscreen cannot start'); return runtimeReply ? runtimeReply(message) : { ok: true, result: { room } }; },
        reload: () => { reloads++; } },
      storage: { local: storage(local, 'local'), session: storage(session, 'session'), onChanged: event('storageChanged') },
      offscreen: { createDocument: async () => { offscreenCalls++; if (pending) throw new Error('Offscreen cannot start'); } },
      tabs: { onRemoved: event('removed'), query: async () => [{ id: 1 }] }, tabCapture: { getMediaStreamId: async () => 'test-stream' }, webNavigation: { onCommitted: event('committed') },
      alarms: { onAlarm: event('alarm'), create: async () => {} }
    }
  };
  configure(environment);
  vm.runInNewContext(source, environment);
  return {
    send: (action, sender = {}, extra = {}) => new Promise(resolve => listener({ target: 'background', type: 'ui', action, ...extra },
      { id: 'test', url: 'chrome-extension://test/updates.html', ...sender }, resolve)),
    sendPlayer: type => new Promise(resolve => listener({ target: 'background', type, tabId: 1 }, { id: 'test' }, resolve)),
    session, local, timers, runtimeMessages, hooks,
    get guardCalls() { return guardCalls; },
    get playerCalls() { return playerCalls; },
    get offscreenCalls() { return offscreenCalls; }, get runs() { return runs; }, get reloads() { return reloads; }
  };
}

test('fresh worker with empty session discovers recovery and serves status without Offscreen or intact build metadata', async () => {
  const worker = harness({ pending: true, brokenBuild: true });
  for (const action of ['status', 'update-status']) {
    const status = await worker.send(action);
    assert.equal(status.ok, true);
    assert.equal(status.result.recovery.pending, true);
    assert.match(status.result.updateOperation.error, /Recovery required/);
  }
  assert.equal(worker.runs, 0, 'startup never installs or restores automatically');
  assert.equal(worker.offscreenCalls, 0);
  assert.equal((await worker.sendPlayer('discover-player')).ok, false);
  assert.equal((await worker.sendPlayer('player')).ok, false);
  assert.equal(worker.guardCalls, 0, 'journal gate runs before player access');
  const denied = await worker.send('set-channel');
  assert.equal(denied.ok, false);
  assert.equal(denied.failure.code, 'ACTION_FAILED');
  assert.equal(denied.failure.category, 'action');
  assert.equal(denied.failure.retryable, false);
  assert.equal(responseError(denied).message, 'Recovery required');
  assert.equal(worker.offscreenCalls, 0, 'structured errors cannot bypass the journal gate');
  assert.equal((await worker.send('update-restore')).ok, true);
  await flush();
  assert.equal(worker.runs, 1);
  assert.equal(worker.reloads, 1);
  assert.equal(worker.offscreenCalls, 0);
  assert.equal(worker.local.updateCompleted, 'restored');
});

test('recovery writes require an extension settings sender and serialize against other updates', async () => {
  let finish;
  const worker = harness({ pending: true, run: () => new Promise(resolve => { finish = resolve; }) });
  assert.equal((await worker.send('update-restore', { url: 'chrome-extension://test/offscreen.html' })).ok, false);
  assert.equal(worker.runs, 0);
  assert.equal((await worker.send('update-restore')).ok, true);
  const concurrent = await worker.send('update-install');
  assert.match(concurrent.error, /Update läuft/);
  assert.equal(concurrent.failure.message, concurrent.error);
  assert.equal(responseError(concurrent).retryable, false);
  assert.match((await worker.send('update-restore')).error, /Update läuft/);
  assert.equal((await worker.send('update-status')).result.updating, true);
  finish({ outcome: 'restored' }); await flush();
  assert.equal(worker.runs, 1);
  assert.equal(worker.timers.size, 0);
});

test('unknown recovery state blocks install/restore but permits explicit published-package verification', async () => {
  const worker = harness({ pending: true, blocked: true });
  assert.equal((await worker.send('update-install')).ok, false);
  assert.equal((await worker.send('update-restore')).ok, false);
  assert.equal(worker.runs, 0);
  assert.equal((await worker.send('update-verify-repair')).ok, true);
  await flush();
  assert.equal(worker.offscreenCalls, 0);
});

test('ordinary install still refuses an active room and status reads never start installation', async () => {
  const worker = harness({ room: { code: 'test-room' } });
  assert.equal((await worker.send('update-status')).ok, true);
  assert.equal(worker.offscreenCalls, 0);
  assert.match((await worker.send('update-install')).error, /Raum verlassen/);
  assert.equal(worker.runs, 0);
});

test('failed recovery leaves an actionable error, releases only the live lock and never reloads', async () => {
  const worker = harness({ pending: true, run: async () => { throw new Error('Recovery readback failed'); } });
  assert.equal((await worker.send('update-restore')).ok, true);
  await flush();
  const status = await worker.send('update-status');
  assert.equal(status.result.recovery.pending, true);
  assert.equal(status.result.updating, false);
  assert.match(status.result.updateOperation.error, /readback failed/);
  assert.equal(worker.reloads, 0);
  assert.equal(worker.timers.size, 0);
});


test('update-only status reads an existing room but never starts a player during recovery', async () => {
  const worker = harness({ room: { code: 'active' }, offscreenPresent: true });
  const status = await worker.send('update-status');
  assert.equal(status.result.room.code, 'active');
  assert.equal(status.result.roomStatusUnavailable, false);
  assert.equal(worker.offscreenCalls, 1, 'one status read, no offscreen creation');
  const recovering = harness({ pending: true, offscreenPresent: true });
  assert.equal((await recovering.send('update-status')).result.recovery.pending, true);
  assert.equal(recovering.offscreenCalls, 0);
  const broken = harness({ offscreenPresent: true, brokenPlayer: true });
  assert.equal((await broken.send('update-status')).result.roomStatusUnavailable, true);
});

test('merged player selection forwards exact player/document identity and is rejected by a journal gate', async () => {
  const chosen = { tabId: 7, documentId: 'chosen-document', playerId: 'chosen-player' };
  const normal = harness();
  const attached = await normal.send('attach', {}, chosen);
  assert.equal(attached.ok, true, attached.error);
  const forwarded = normal.runtimeMessages.find(message => message.action === 'attach');
  assert.equal(forwarded.tabId, chosen.tabId);
  assert.equal(forwarded.documentId, chosen.documentId);
  assert.equal(forwarded.playerId, chosen.playerId);
  const interrupted = harness({ pending: true });
  assert.equal((await interrupted.send('attach', {}, chosen)).ok, false);
  assert.equal(interrupted.runtimeMessages.length, 0);
});

test('background leave bypasses a pending join, while status aggregation reads the owner only once', async () => {
  let releaseJoin, reached;
  const joining = new Promise(resolve => { reached = resolve; });
  const worker = harness({ offscreenPresent: true, runtimeReply: async message => {
    if (message.action === 'join') { reached(); return new Promise(resolve => { releaseJoin = resolve; }); }
    return { ok: true, result: { room: null, lifecycle: { instanceId: 'owner', revision: 1 } } };
  } });
  const join = worker.send('join'); await joining;
  assert.equal((await worker.send('status')).ok, true, 'status never waits behind a held join');
  const left = await worker.send('leave');
  assert.equal(left.ok, true);
  releaseJoin({ ok: true, result: { room: { code: 'stale' } } });
  assert.equal((await join).failure.code, 'ABORTED');
  const before = worker.runtimeMessages.length;
  const status = await worker.send('status');
  assert.equal(status.result.lifecycle.instanceId, 'owner');
  assert.equal(worker.runtimeMessages.length - before, 1, 'update metadata reuses the same room snapshot');
});

test('the sound test requests a fresh visible observation before accepting a passive selection', async () => {
  let observed = false, captured = false;
  const worker = harness({ features: { audioDiagnostics: true }, runtimeReply: async message => {
    if (message.target === 'capture-lab') {
      if (message.action === 'start') { assert.equal(observed, true); captured = true; }
      return { ok: true, result: { running: captured } };
    }
    if (message.observePlayer) observed = true;
    return { ok: true, result: { tabId: 1, documentId: 'doc', room: null,
      local: { mediaId: 'passive', paused: !observed, time: observed ? 17 : 5 } } };
  } });
  worker.local.channel = 'experimental';
  const response = await worker.send('lab-start');
  assert.equal(response.ok, true, response.error);
  assert.equal(captured, true);
  assert.equal(worker.runtimeMessages.find(message => message.target === 'offscreen').observePlayer, true);
});

const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };

test('a channel switch only changes the release stream and keeps the running room and document', async () => {
  const created = [];
  let closed = 0;
  const worker = harness({ room: { code: 'active' }, offscreenPresent: true, configure: env => {
    env.chrome.offscreen.closeDocument = async () => { closed++; };
    const create = env.chrome.offscreen.createDocument;
    env.chrome.offscreen.createDocument = async options => { created.push(options); return create(options); };
  } });
  const response = await worker.send('set-channel', {}, { channel: 'experimental' });
  assert.equal(response.ok, true, response.error);
  assert.equal(worker.local.channel, 'experimental');
  assert.equal(response.result.channel, 'experimental');
  assert.equal(response.result.room.code, 'active', 'the room stays connected');
  assert.equal(closed, 0); assert.deepEqual(created, []);
  assert.equal(worker.runtimeMessages.some(message => message.action === 'leave'), false);
  assert.equal((await worker.send('set-channel', {}, { channel: 'main' })).ok, false);
  assert.equal(worker.local.channel, 'experimental');
});

test('the offscreen document requests audio capture only for packages with audio diagnostics', async () => {
  for (const [audioDiagnostics, reasons] of [[false, ['WORKERS']], [true, ['WORKERS', 'USER_MEDIA']]]) {
    const created = [];
    const worker = harness({ features: { audioDiagnostics }, configure: env => {
      env.chrome.offscreen.createDocument = async options => { created.push(options); };
    } });
    assert.equal((await worker.send('status', {}, {})).ok, true);
    assert.equal(created.length, 1);
    assert.equal(created[0].url, 'offscreen.html');
    assert.deepEqual(Array.from(created[0].reasons), reasons);
  }
});

test('legacy room setup errors dismiss their normalized duplicate, preserving unrelated session notices', async () => {
  for (const action of ['create', 'join']) {
    for (const notice of ['Failed to fetch', 'Der Raum wurde beendet.']) {
      const worker = harness({ runtimeReply: message => message.action === action
        ? { ok: false, error: 'Failed to fetch' }
        : { ok: true, result: { room: null, notice } } });
      const failed = await worker.send(action);
      assert.equal(failed.ok, false);
      assert.equal(failed.failure.code, 'NETWORK_ERROR');
      const status = await worker.send('status');
      assert.equal(status.result.notice, notice === 'Failed to fetch' ? '' : notice);
      if (notice === 'Failed to fetch') assert.ok(worker.session['dismissedNotice:stable']);
    }
  }
});

test('the alarm runs every thirty minutes and opening the popup triggers a debounced, never forced check', async () => {
  const checks = [], alarms = [];
  const worker = harness({ configure: env => {
    env.checkUpdates = async (channel, build, force) => { checks.push({ channel, force: !!force }); return { configured: true }; };
    env.chrome.alarms.create = async (name, options) => { alarms.push({ name, ...options }); };
  } });
  await worker.hooks.installed({ reason: 'update' });
  await worker.hooks.startup();
  assert.deepEqual(alarms, [{ name: 'check-github-updates', periodInMinutes: 30 }, { name: 'check-github-updates', periodInMinutes: 30 }]);
  await flush();
  checks.length = 0;
  worker.hooks.alarm({ name: 'check-github-updates' }); await flush();
  assert.deepEqual(checks, [{ channel: 'stable', force: false }]);
  const opened = await worker.send('update-check-opened', { url: 'chrome-extension://test/popup.html' });
  assert.equal(opened.ok, true, opened.error);
  assert.deepEqual(checks.at(-1), { channel: 'stable', force: false }, 'the popup check uses the shared automatic debounce');
  assert.equal(worker.runs, 0, 'opening the popup never installs');
  await worker.send('update-check');
  assert.deepEqual(checks.at(-1), { channel: 'stable', force: true });
});

test('a required confirmation is stored for the view, its id is forwarded only to installation, and dismiss clears it', async () => {
  const review = { id: 'a'.repeat(64), from: '0.6.0.15', to: '0.6.0.12', downgrade: true, changes: [] };
  const options = [];
  const worker = harness({ run: async received => {
    options.push(received);
    if (!received.restore && received.confirmation !== review.id) throw Object.assign(new Error('Bestätigung erforderlich'), { confirmation: review });
    return { outcome: received.restore ? 'restored' : 'installed' };
  } });
  assert.equal((await worker.send('update-install')).ok, true); await flush();
  assert.deepEqual((await worker.send('update-status')).result.updateOperation.confirmation, review);
  assert.equal(worker.reloads, 0);
  assert.equal((await worker.send('update-dismiss')).ok, true);
  assert.equal((await worker.send('update-status')).result.updateOperation, undefined);
  assert.equal((await worker.send('update-restore', {}, { confirmation: review.id })).ok, true); await flush();
  assert.equal(options.at(-1).confirmation, undefined, 'restore never carries an installation confirmation');
  assert.equal((await worker.send('update-install', {}, { confirmation: review.id })).ok, true); await flush();
  assert.equal(options.at(-1).confirmation, review.id);
  assert.equal(worker.reloads, 2);
});
