import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionLifecycle } from '../extension/session-lifecycle.js';
import { PlayerBinding } from '../extension/player-binding.js';
// A session tick makes one browser call: apply with its planned command, or a plain sample.
const tickCall = message => message.action === 'sample' || (message.action === 'apply' && ['sync', 'release'].includes(message.command?.type));

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const sample = (mediaId = 'media-1') => ({ mediaId, playerId: 'player', time: 5, duration: 120, paused: true, buffering: false, intents: [] });
const drain = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function fixture() {
  let nextTimer = 0, now = 100000, local = sample();
  let nextConnection = deferred();
  const timers = new Map(), calls = [], connections = [], events = [];
  const request = async message => {
    calls.push(structuredClone(message));
    if (message.action === 'attach') return { ok: true, result: { documentId: 'doc', playerId: 'player', frameId: 2, sample: { ...local, bindingId: message.command.bindingId } } };
    return { ok: true, result: local };
  };
  const session = new SessionLifecycle({ requestPlayer: request, now: () => now,
    schedule: (run, ms) => { const id = ++nextTimer; timers.set(id, { run, ms }); return id; }, unschedule: id => timers.delete(id),
    changed: state => events.push(state),
    connect: (server, event, error, status) => {
      const pending = deferred();
      const connection = { server, pending, event, error, status, closed: false, sent: [],
        open: () => pending.promise, close() { this.closed = true; pending.reject(Object.assign(new Error('cancelled'), { code: 'ABORTED' })); }, send(message) { this.sent.push(message); } };
      connections.push(connection); nextConnection.resolve(connection); nextConnection = deferred(); return connection;
    }
  });
  return { session, calls, timers, connections, events, setSample: value => { local = value; },
    attach: () => session.handle({ action: 'attach', tabId: 1, documentId: 'doc', playerId: 'player', frameId: 2 }),
    async create() { const connected = nextConnection.promise; const pending = session.handle({ action: 'create', server: 'https://example.test' }); (await connected).pending.resolve({ code: 'ABC234', role: 'host' }); return pending; },
    async tick() { const [id, timer] = timers.entries().next().value; timers.delete(id); now += timer.ms; timer.run(); await session.queue; await drain(); }
  };
}

test('unconnected, selected and left sessions own no background polling timer', async () => {
  const f = fixture();
  assert.equal(f.session.status().lifecycle.phase, 'disconnected');
  await f.attach();
  assert.equal(f.timers.size, 0);
  assert.equal(f.calls.length, 1);
  await f.create();
  assert.equal(f.timers.size, 1);
  await f.tick();
  assert.equal(f.timers.size, 1);
  await f.session.handle({ action: 'leave' });
  assert.equal(f.timers.size, 0);
  const before = f.calls.length;
  for (let n = 0; n < 100; n++) await f.session.handle({ action: 'status' });
  assert.equal(f.calls.length, before);
  const state = f.session.status();
  assert.equal(state.room, null); assert.equal(state.tabId, 1);
  assert.equal(state.lifecycle.playerBound, false); assert.equal(state.lifecycle.phase, 'ended');
  await f.create();
  assert.equal(f.calls.filter(call => call.action === 'attach').length, 2, 'a new room verifies the remembered selection');
  await f.session.stop();
});

test('leave cancels a pending room open immediately and old errors cannot end the next room', async () => {
  const f = fixture(); await f.attach();
  const opening = f.session.handle({ action: 'create', server: 'https://example.test' });
  const rejected = assert.rejects(opening, { code: 'ABORTED' });
  await drain();
  const previous = f.connections[0];
  assert.equal(f.session.status().lifecycle.phase, 'connecting');
  await f.session.handle({ action: 'leave' }); await rejected;
  assert.equal(previous.closed, true);
  await f.create();
  previous.error(new Error('late failure')); previous.status({ lane: 'receive', reconnecting: true });
  assert.equal(f.session.status().room.code, 'ABC234');
  assert.equal(f.session.status().notice, '');
  await f.session.stop();
});

test('late attach reply cannot overwrite a new selected document or resurrect a left binding', async () => {
  const pending = deferred(), reached = deferred();
  const calls = [];
  const binding = new PlayerBinding(async message => {
    calls.push(message);
    if (message.tabId === 1 && message.action === 'attach') { reached.resolve(); return pending.promise; }
    return { ok: true, result: { documentId: 'new', playerId: 'player', sample: sample('new') } };
  });
  const attaching = binding.attach({ tabId: 1, documentId: 'old' });
  const cancelled = assert.rejects(attaching, { code: 'ABORTED' });
  await reached.promise;
  await binding.attach({ tabId: 2, documentId: 'new' });
  await cancelled;
  pending.resolve({ ok: true, result: { documentId: 'old', sample: sample('old') } });
  await drain();
  assert.equal(binding.local.mediaId, 'new'); assert.equal(binding.selection.tabId, 2);
  assert.ok(calls.find(call => call.action === 'detach').command.expectedBindingId);
});

test('a player timeout retains only one underlying browser operation; late completion is discarded', async () => {
  const binding = new PlayerBinding(async message => ({ ok: true, result: { documentId: 'doc', sample: sample() } }), { timeoutMs: 10 });
  await binding.attach({ tabId: 1, documentId: 'doc' });
  const pending = deferred(); let calls = 0;
  binding.request = () => { calls++; return pending.promise; };
  await assert.rejects(binding.sample(), { code: 'PLAYER_TIMEOUT' });
  await assert.rejects(binding.sample(), { code: 'PLAYER_TIMEOUT' });
  assert.equal(calls, 1);
  pending.resolve({ ok: true, result: sample('stale') }); await drain();
  assert.equal(binding.local.mediaId, 'media-1');
  binding.request = async () => ({ ok: true, result: sample('fresh') });
  assert.equal((await binding.sample()).mediaId, 'fresh');
});

test('navigation only invalidates the selected document and retains the room for realignment', async () => {
  const f = fixture(); await f.attach(); await f.create();
  const generation = f.session.generation;
  await f.session.handle({ action: 'document-changed', tabId: 1, frameId: 3, documentId: 'other' });
  assert.equal(f.session.generation, generation);
  await f.session.handle({ action: 'document-changed', tabId: 1, frameId: 2, documentId: 'replacement' });
  assert.equal(f.session.status().tabId, null);
  assert.equal(f.session.status().lifecycle.phase, 'interrupted');
  assert.equal(f.session.status().room.state.phase, 'aligning');
  assert.equal(f.connections[0].closed, false);
  await f.attach();
  assert.equal(f.session.status().room.state.playing, false);
  await f.session.stop();
});

test('late sampled data and queued controls are rejected across leave and replacement', async () => {
  const f = fixture(); await f.attach(); await f.create();
  const pending = deferred(), reached = deferred();
  const oldRequest = f.session.player.request;
  f.session.player.request = message => {
    if (tickCall(message)) { reached.resolve(); return pending.promise; }
    return oldRequest(message);
  };
  const tick = f.tick(); await reached.promise;
  const control = f.session.handle({ action: 'control', control: 'play' });
  const rejected = assert.rejects(control, { code: 'ABORTED' });
  await f.session.stop();
  pending.resolve({ ok: true, result: sample('old-late') });
  await tick; await rejected;
  assert.equal(f.session.status().local.mediaId, 'media-1');
  assert.equal(f.session.status().room, null);
  assert.equal(f.timers.size, 0);
});

test('unexpected worker loss closes the room, detaches the player and cannot restart playback', async () => {
  const f = fixture(); await f.attach(); await f.create();
  f.connections[0].error(Object.assign(new Error('worker died'), { code: 'WORKER_INTERRUPTED' }));
  await drain();
  assert.equal(f.session.status().room, null);
  assert.equal(f.session.status().noticeError.code, 'WORKER_INTERRUPTED');
  assert.equal(f.session.status().lifecycle.playerBound, false);
  assert.equal(f.timers.size, 0);
});

test('replacing a player while joining cancels that room instead of letting its late result detach the replacement', async () => {
  const f = fixture(); await f.attach();
  const opening = f.session.handle({ action: 'create', server: 'https://example.test' });
  const cancelled = assert.rejects(opening, { code: 'ABORTED' });
  await drain();
  await f.session.handle({ action: 'attach', tabId: 2, documentId: 'replacement' });
  await cancelled;
  assert.equal(f.connections[0].closed, true);
  assert.equal(f.session.status().room, null);
  assert.equal(f.session.status().tabId, 2);
  assert.equal(f.session.status().lifecycle.playerBound, true);
});

test('a wake from the selected document replaces the periodic delay; other documents are ignored', async () => {
  const f = fixture(); await f.attach(); await f.create();
  // The first ticks publish the new room state, which itself wakes one follow-up tick.
  for (let n = 0; n < 5 && [...f.timers.values()][0].ms !== 350; n++) await f.tick();
  const [periodic] = [...f.timers.values()];
  assert.equal(periodic.ms, 350);
  f.session.playerWake({ tabId: 1, documentId: 'other' });
  f.session.playerWake({ tabId: 9, documentId: 'doc' });
  assert.deepEqual([...f.timers.values()].map(timer => timer.ms), [350]);
  f.session.playerWake({ tabId: 1, documentId: 'doc' });
  const timers = [...f.timers.values()].map(timer => timer.ms);
  assert.equal(timers.length, 1, 'ticks stay serialized');
  assert.ok(timers[0] <= 40, `woken tick runs at once, got ${timers[0]} ms`);
  await f.session.stop();
});

test('a tick makes one player call and observers are notified only for visible changes', async () => {
  const f = fixture(); await f.attach(); await f.create();
  await f.tick(); await f.tick();
  const calls = f.calls.length, notified = f.events.length;
  for (let n = 0; n < 6; n++) await f.tick();
  assert.equal(f.calls.length - calls, 6, 'apply answers with its sample; no separate sample call');
  assert.equal(f.events.length, notified, 'an unchanged paused session does not broadcast every tick');
  f.setSample({ ...sample(), paused: false });
  await f.tick();
  assert.equal(f.events.length, notified + 1);
  assert.equal(f.events.at(-1).local.paused, false);
  await f.session.stop();
});
