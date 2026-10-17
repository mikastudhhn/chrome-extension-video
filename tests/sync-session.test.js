import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomSession } from '../extension/room-session.js';
import { Signaling } from '../extension/signaling.js';
import { createServer } from '../server/index.js';

// Two real RoomSessions over the real relay and the real Signaling client.
// Players are replaced by plain samples; the heartbeat runs on a short loop
// like the offscreen tick.
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(description, check, timeout = 8000) {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > end) throw new Error(`Timeout: ${description}`);
    await wait(20);
  }
}

async function pair(t) {
  const server = createServer({ env: {} });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const signals = {}, pauses = { host: [], guest: [] }, failures = [];
  const sample = role => ({ time: role === 'host' ? 5 : 10, at: Date.now(), duration: 120, paused: true, buffering: false,
    advancing: false, mediaId: `${role}-media`, intents: [] });
  const room = role => new RoomSession({ now: () => Date.now(), changed: () => {}, failed: error => failures.push(error),
    diagnose: (kind, fields) => { if (kind === 'pause') pauses[role].push(fields.reason); },
    connect: (url, onEvent, onError, onStatus) => {
      const signal = signals[role] = new Signaling(url, onEvent, onError, onStatus);
      return { server: url, open: async code => { const member = await signal.open(code); void signal.poll(); return member; },
        send: message => signal.send(message), close: () => signal.close() };
    } });
  const host = room('host'), guest = room('guest');
  await host.open(base, null, sample('host'));
  await guest.open(base, host.code, sample('guest'));
  // Media time advances while the room plays, like a real player.
  const played = { host: 0, guest: 0 };
  let last = Date.now();
  const loop = setInterval(() => {
    const now = Date.now();
    for (const [role, session] of [['host', host], ['guest', guest]]) {
      const playing = !!session.state?.playing;
      if (playing) played[role] += (now - last) / 1000;
      const base = sample(role);
      session.sample({ ...base, time: base.time + played[role], paused: !playing, advancing: playing });
      session.heartbeat();
    }
    last = now;
  }, 100);
  t.after(async () => {
    clearInterval(loop);
    host.close(); guest.close();
    await wait(50);
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  });
  await until('both connected', () => host.connected && guest.connected);
  host.ready(host.timeline.epoch);
  guest.ready(guest.state.epoch);
  await until('synced', () => guest.state?.phase === 'synced');
  host.intent({ type: 'play' });
  await until('both playing', () => host.state.playing && guest.state?.playing);
  return { host, guest, signals, pauses, failures };
}

function failOnce(signal, path) {
  const request = signal.request.bind(signal);
  let failed = false;
  signal.request = (...args) => {
    if (!failed && args[0].startsWith(path)) { failed = true; return Promise.reject(new TypeError('Failed to fetch')); }
    return request(...args);
  };
  return () => failed;
}

test('one failed /relay or /events request pauses nobody', async t => {
  const { host, guest, signals, pauses, failures } = await pair(t);
  const injected = [failOnce(signals.host, '/relay'), failOnce(signals.guest, '/relay'), failOnce(signals.guest, '/events')];
  const disconnected = { host: 0, guest: 0 };
  const watch = setInterval(() => {
    if (!host.connected) disconnected.host++;
    if (!guest.connected) disconnected.guest++;
  }, 20);
  await wait(3000);
  clearInterval(watch);
  assert.ok(injected.every(failed => failed()), 'every lane saw one failure');
  assert.deepEqual(pauses, { host: [], guest: [] });
  assert.deepEqual(disconnected, { host: 0, guest: 0 });
  assert.equal(host.timeline.wantsPlay, true);
  assert.equal(guest.state.playing, true);
  assert.deepEqual(failures, []);
});

test('a persistent outage still pauses both and reports reconnecting', async t => {
  const { host, guest, signals, pauses } = await pair(t);
  const request = signals.host.request.bind(signals.host);
  let offline = true;
  signals.host.request = (...args) => offline ? Promise.reject(new TypeError('Failed to fetch')) : request(...args);
  await until('outage pauses both', () => !host.timeline.wantsPlay && host.reconnecting && guest.reconnecting, 6000);
  // The guest holds the last host state; its player is paused because that state is stale.
  assert.equal(guest.connected, false);
  assert.ok(pauses.host.includes('network'));
  assert.ok(pauses.guest.includes('network'));
  offline = false;
  await until('same room recovers', () => host.connected && guest.connected && guest.state.epoch === host.state.epoch, 10_000);
  assert.equal(host.state.playing, false, 'recovery never resumes on its own');
});

test('unchanged sessions send keepalives instead of a batch per tick, and changes go out at once', async t => {
  const { host, guest, signals } = await pair(t);
  const batches = { host: [], guest: [] };
  for (const role of ['host', 'guest']) {
    const request = signals[role].request.bind(signals[role]);
    signals[role].request = (...args) => {
      if (args[0] === '/relay') batches[role].push(args[2].messages.map(message => message.type));
      return request(...args);
    };
  }
  await wait(4000);
  // The loop ticks every 100 ms: 40 ticks. Keepalive ~1/s, its ping every other
  // batch, plus answers to the peer's pings.
  for (const role of ['host', 'guest']) {
    assert.ok(batches[role].length <= 9, `${role}: ${JSON.stringify(batches[role])}`);
    assert.ok(batches[role].length >= 4, `${role} keeps the session fresh`);
    assert.ok(batches[role].some(types => types.includes('ping') && types.length > 1), `${role} pings travel with a keepalive`);
  }
  assert.equal(host.connected && guest.connected, true);
  const sent = batches.host.length;
  host.intent({ type: 'pause' });
  await until('pause reached the guest', () => guest.state.wantsPlay === false, 1000);
  assert.ok(batches.host.length > sent);
});
