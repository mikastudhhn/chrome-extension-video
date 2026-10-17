import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Timeline } from '../extension/timeline.js';

import { PlayerBinding } from '../extension/player-binding.js';
import { SessionLifecycle } from '../extension/session-lifecycle.js';
// A session tick makes one browser call: apply with its planned command, or a plain sample.
const tickCall = message => message.action === 'sample' || (message.action === 'apply' && ['sync', 'release'].includes(message.command?.type));

const sample = mediaId => ({ mediaId, playerId: 'player', time: 5, duration: 120, paused: true, buffering: false, intents: [] });

test('Offscreen binding captures expected media before asynchronous routing and never restamps a pending command', async () => {
  let finish, received, localSample = sample('media-before');
  const binding = new PlayerBinding(async message => {
    if (message.action === 'attach') return { ok: true, result: { documentId: 'doc', playerId: 'player', sample: localSample } };
    received = message;
    return new Promise(resolve => { finish = () => resolve({ ok: true, result: localSample }); });
  });
  await binding.attach({ tabId: 1, documentId: 'doc', playerId: 'player' });
  const pending = binding.apply({ type: 'release' });
  await Promise.resolve();
  assert.equal(received.command.expectedMediaId, 'media-before');
  localSample = sample('media-after');
  finish(); await pending;
  assert.equal(received.command.expectedMediaId, 'media-before');
  const next = binding.apply({ type: 'release' }); await Promise.resolve();
  assert.equal(received.command.expectedMediaId, 'media-after');
  finish(); await next;
});

const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };

async function sessionPlayer(role = 'host') {
  const video = Object.assign(new EventTarget(), {
    duration: 120, currentTime: 5, currentSrc: 'blob:same', readyState: 4, seeking: false,
    paused: true, isConnected: true, playbackRate: 1,
    getAttribute: () => null, getBoundingClientRect: () => ({ width: 300, height: 200 }),
    play() { this.paused = false; this.dispatchEvent(new Event('play')); return Promise.resolve(); },
    pause() { if (!this.paused) { this.paused = true; this.dispatchEvent(new Event('pause')); } }
  });
  const timers = new Set();
  const page = vm.createContext({
    window: { __videoSyncOwner: 'installation' }, document: { querySelectorAll: () => [video] },
    location: { origin: 'https://video.test', hostname: 'video.test', pathname: '/movie' },
    crypto: webcrypto, performance, Date, setTimeout, clearTimeout,
    setInterval: () => { const timer = {}; timers.add(timer); return timer; }, clearInterval: timer => timers.delete(timer),
    getComputedStyle: () => ({ visibility: 'visible', opacity: '1' })
  });
  vm.runInContext(readFileSync(new URL('../extension/player.js', import.meta.url), 'utf8'), page);
  const player = page.window.__videoSyncPlayer;
  const commands = [], sent = [];
  const request = async message => {
    commands.push(structuredClone(message));
    if (message.action === 'attach') {
      const sample = player.attach(message.command);
      return { ok: true, result: { sample, documentId: 'doc', playerId: sample.playerId } };
    }
    return { ok: true, result: await player[message.action]({ ...message.command, playerId: message.playerId }) };
  };
  const session = new SessionLifecycle({ schedule: () => 1, unschedule() {}, now: () => 100000,
    connect: server => ({ server, open: async () => ({ role, code: 'ABC234' }), send: value => sent.push(value), close() {} }),
    requestPlayer: request });
  await session.handle({ action: 'attach', tabId: 1 });
  await session.handle({ action: role === 'host' ? 'create' : 'join', server: 'https://example.test', code: 'ABC234' });
  const room = session.room;
  room.connected = true; room.peerJoined = true; room.lastState = 100000;
  if (role === 'host') room.publish();
  else room.state = new Timeline(() => 100000).tick();
  return { session, room, player, video, request, commands, sent, timers };
}

for (const role of ['host', 'guest']) {
  test(`${role} Ready waits for a delayed player pause and confirms the settled frame`, async t => {
    const f = await sessionPlayer(role);
    t.after(() => f.session.stop());
    await f.video.play();
    const requested = deferred();
    f.video.pause = () => requested.resolve();
    let completed = false;
    const ready = f.session.handle({ action: 'ready' }).then(
      value => { completed = true; return value; },
      error => { completed = true; return { error }; }
    );
    await requested.promise;
    await new Promise(resolve => setImmediate(resolve));
    const completedBeforePause = completed;
    f.video.currentTime = 5.7;
    f.video.paused = true;
    f.video.dispatchEvent(new Event('pause'));
    const result = await ready;
    assert.equal(completedBeforePause, false, 'Ready must not finish before the player pauses');
    assert.equal(result.error, undefined);
    if (role === 'host') assert.equal(f.room.timeline.anchors.host, 5.7);
    else {
      const index = f.sent.findIndex(message => message.type === 'ready');
      assert.ok(index > 0);
      assert.equal(f.sent[index - 1].sample.paused, true);
      assert.equal(f.sent[index - 1].sample.time, 5.7);
    }
  });

  test(`${role} Ready reports an ignored pause instead of confirming a playing video`, async t => {
    const f = await sessionPlayer(role);
    t.after(() => f.session.stop());
    await f.video.play();
    f.video.pause = () => {};
    f.session.player.request = message => f.request(message.action === 'apply'
      ? { ...message, command: { ...message.command, expiresAt: Date.now() + 30 } } : message);
    await assert.rejects(f.session.handle({ action: 'ready' }), /Video pausieren/);
    assert.equal(f.room.timeline.anchors[role], undefined);
    assert.equal(f.sent.some(message => message.type === 'ready'), false);
  });

  test(`${role} Ready cannot confirm a replacement medium while waiting for pause`, async t => {
    const f = await sessionPlayer(role);
    t.after(() => f.session.stop());
    await f.video.play();
    const requested = deferred();
    f.video.pause = () => requested.resolve();
    const ready = f.session.handle({ action: 'ready' });
    const rejected = assert.rejects(ready, { code: 'ABORTED' });
    await requested.promise;
    f.video.dispatchEvent(new Event('loadstart'));
    f.video.paused = true;
    f.video.dispatchEvent(new Event('pause'));
    await rejected;
    assert.equal(f.room.timeline.anchors[role], undefined);
    assert.equal(f.sent.some(message => message.type === 'ready'), false);
  });
}

test('a held session tick and simultaneous Popup Play or Seek cannot control the replacement medium', async () => {
  for (const control of ['play', 'forward']) {
    const f = await sessionPlayer('guest');
    f.room.state = { ...f.room.state, phase: 'synced', anchors: { host: 5, guest: 5 }, playing: false };
    const held = deferred(), sampled = deferred();
    f.session.player.request = async message => {
      const response = await f.request(message);
      if (tickCall(message)) { sampled.resolve(response.result); await held.promise; }
      return response;
    };
    const before = f.session.status();
    f.video.dispatchEvent(new Event('loadstart'));
    const tick = f.session.enqueue(generation => f.session.tick(generation));
    const changed = await sampled.promise;
    assert.notEqual(changed.mediaId, before.local.mediaId);
    // The real Session handler captures the click while the tick still owns the
    // old offscreen snapshot. The page has already observed the replacement.
    const controlling = f.session.handle({ action: 'control', control, expectedSession: before.lifecycle });
    held.resolve(); await tick; await controlling;
    const command = f.commands.find(message => message.command?.type === 'control').command;
    assert.equal(command.expectedMediaId, before.local.mediaId);
    assert.equal(command.expectedPlayerId, before.playerId);
    assert.equal(command.expectedBindingId, before.bindingId);
    assert.equal(f.video.currentTime, 5, control);
    assert.equal(f.video.paused, true, control);
    assert.equal(f.session.status().local.mediaId, changed.mediaId);
    await f.session.stop();
  }
});

for (const role of ['host', 'guest']) {
  for (const transition of ['queued-sample', 'pause-response', 'new-alignment', 'unchanged']) {
    test(`${role} Ready preserves its clicked medium and alignment through ${transition}`, async () => {
      const f = await sessionPlayer(role);
      const before = f.session.status(), sentBefore = f.sent.length;
      const held = deferred(), reached = deferred();
      let tick;
      if (transition === 'queued-sample') {
        f.session.player.request = async message => {
          const response = await f.request(message);
          if (tickCall(message)) { reached.resolve(); await held.promise; }
          return response;
        };
        f.video.currentTime = 99; f.video.dispatchEvent(new Event('loadstart'));
        tick = f.session.enqueue(generation => f.session.tick(generation));
        await reached.promise;
      } else if (transition !== 'unchanged') {
        f.session.player.request = async message => {
          if (message.action === 'apply' && message.command.type === 'pause') { reached.resolve(); await held.promise; }
          return f.request(message);
        };
      }
      const ready = f.session.handle({ action: 'ready', expectedSession: before.lifecycle });
      const rejected = transition === 'unchanged' ? null : assert.rejects(ready, { code: 'ABORTED' });
      if (transition === 'pause-response') {
        await reached.promise;
        f.video.currentTime = 99; f.video.dispatchEvent(new Event('loadstart'));
      } else if (transition === 'new-alignment') {
        await reached.promise;
        if (role === 'host') f.room.reset();
        else f.room.state = { ...f.room.state, epoch: f.room.state.epoch + 1 };
      }
      held.resolve(); if (tick) await tick;
      if (rejected) await rejected; else await ready;
      const confirmed = role === 'host' ? f.room.timeline.anchors.host !== undefined
        : f.sent.slice(sentBefore).some(message => message.type === 'ready');
      assert.equal(confirmed, transition === 'unchanged');
      if (role === 'host' && confirmed) assert.equal(f.room.timeline.anchors.host, 5);
      const pause = f.commands.findLast(message => message.command?.type === 'pause');
      if (pause) {
        assert.equal(pause.command.expectedMediaId, before.local.mediaId);
        assert.equal(pause.command.expectedBindingId, before.bindingId);
      }
      await f.session.stop();
    });
  }
}

test('Ready arriving late from a visible UI keeps the clicked identity and epoch instead of the latest owner snapshot', async () => {
  for (const change of ['medium', 'alignment']) {
    const f = await sessionPlayer();
    const clicked = f.session.status();
    if (change === 'medium') {
      f.video.currentTime = 99; f.video.dispatchEvent(new Event('loadstart'));
      f.room.sample(await f.session.player.sample()); f.room.publish();
    } else f.room.reset();
    await assert.rejects(f.session.handle({ action: 'ready', expectedSession: clicked.lifecycle,
      expectedPlayer: { mediaId: clicked.local.mediaId, playerId: clicked.playerId, bindingId: clicked.bindingId },
      expectedEpoch: clicked.room.state.epoch }), { code: 'ABORTED' });
    assert.equal(f.room.timeline.anchors.host, undefined);
    await f.session.stop();
  }
});

test('Leave then native Play is freshly observable for the lobby and sound test without rebinding or idle work', async () => {
  const f = await sessionPlayer();
  await f.session.handle({ action: 'leave' });
  assert.equal(f.timers.size, 0);
  f.video.currentTime = 17; await f.video.play();
  const count = f.commands.length;
  const passive = await f.session.handle({ action: 'status' });
  assert.equal(passive.local.paused, true);
  assert.equal(f.commands.length, count, 'ordinary status never probes in the background');
  const observed = await f.session.handle({ action: 'status', observePlayer: true });
  assert.equal(observed.local.time, 17);
  assert.equal(observed.local.paused, false);
  assert.equal(observed.lifecycle.playerBound, false);
  assert.equal(observed.local.bindingId, null);
  assert.equal(f.video.paused, false, 'observation does not pause native playback');
  assert.equal(f.timers.size, 0, 'observation installs no watchdog');
  assert.deepEqual(f.commands.slice(count).map(message => message.action), ['observe']);
  f.video.isConnected = false;
  const missing = await f.session.handle({ action: 'status', observePlayer: true });
  assert.equal(missing.local, null, 'a missing passive selection cannot authorize a sound test');
});

test('merged player binding keeps per-action deadlines and structured timeout errors', async t => {
  const scheduled = [], messages = [];
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => { const timer = { callback, delay }; scheduled.push(timer); return timer; });
  t.mock.method(globalThis, 'clearTimeout', timer => { if (timer) timer.cleared = true; });
  const binding = new PlayerBinding(async message => {
    messages.push(structuredClone(message));
    if (message.action === 'attach') return { ok: true, result: {
      documentId: 'selected-document', playerId: 'selected-player', sample: sample('selected-medium')
    } };
    return new Promise(() => {});
  });
  const started = Date.now();
  await binding.attach({ tabId: 1 });
  assert.equal(scheduled[0].delay, 10000);
  assert.equal(scheduled[0].cleared, true);
  assert.ok(messages[0].requestDeadline >= started + 9900);
  const pending = binding.apply({ type: 'pause' }); await Promise.resolve();
  assert.equal(messages[1].playerId, 'selected-player');
  assert.equal(messages[1].documentId, 'selected-document');
  assert.equal(messages[1].command.expectedMediaId, 'selected-medium');
  assert.equal(scheduled[1].delay, 2000);
  assert.ok(messages[1].requestDeadline <= Date.now() + 1900);
  scheduled[1].callback();
  await assert.rejects(pending, { code: 'PLAYER_TIMEOUT', category: 'player', retryable: true });
  assert.equal(scheduled[1].cleared, true);
});
