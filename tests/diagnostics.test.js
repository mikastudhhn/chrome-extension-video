import test from 'node:test';
import assert from 'node:assert/strict';
import { Diagnostics, DIAGNOSTIC_LIMITS } from '../extension/diagnostics.js';

test('diagnostics retain only explicitly permitted bounded fields, including export metadata', () => {
  const buffer = new Diagnostics();
  const secret = 'https://secret.invalid/title?token=SECRET';
  buffer.record('failure', { code: 'NETWORK_ERROR', message: secret, token: secret, room: secret, mediaId: secret });
  buffer.record('player', { adapter: secret });
  buffer.record(secret, { reason: 'user' });
  buffer.record('phase', { phase: secret });
  buffer.record('rtt', { rttMs: Infinity });
  const result = buffer.export({ appVersion: '0.5.0', engineVersion: secret, protocol: 2, title: secret });
  assert.equal(result.events.length, 1);
  assert.deepEqual(Object.keys(result.events[0]), ['at', 'kind', 'code']);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(result.appVersion, '0.5.0');
  assert.equal(result.engineVersion, undefined);
  result.events[0].token = secret;
  assert.equal(JSON.stringify(buffer.export()).includes(secret), false);
  buffer.clear();
});

test('diagnostics enforce count/byte limits and expire even without another record or export', () => {
  let now = 0, callback, cancelled = 0;
  const buffer = new Diagnostics({ now: () => now, schedule: fn => { callback = fn; return 1; }, unschedule: () => cancelled++ });
  for (let i = 0; i < 1000; i++) buffer.record('phase', { phase: 'synced', reason: 'network', adapter: 'html5', code: 'NETWORK_ERROR', lane: 'receive', reconnecting: true, rttMs: 59999 });
  assert.ok(buffer.events.length <= DIAGNOSTIC_LIMITS.events);
  assert.ok(JSON.stringify(buffer.events).length <= DIAGNOSTIC_LIMITS.bytes);
  assert.ok(buffer.events.length > 0);
  now = DIAGNOSTIC_LIMITS.retentionMs;
  callback();
  assert.equal(buffer.events.length, 0);
  assert.equal(buffer.export().events.length, 0);
  buffer.record('phase', { phase: 'ended' });
  buffer.clear();
  callback(); // Already queued expiry callbacks cannot restore deleted data.
  assert.deepEqual(buffer.export().events, []);
  assert.ok(cancelled > 0);
});

test('RTT samples are throttled; deleting permits a new sample without restoring history', () => {
  let now = 0;
  const buffer = new Diagnostics({ now: () => now });
  buffer.record('rtt', { rttMs: 23.8 });
  buffer.record('rtt', { rttMs: 100 });
  now = 10000;
  buffer.record('rtt', { rttMs: 31 });
  assert.deepEqual(buffer.export().events.map(event => event.rttMs), [24, 31]);
  buffer.clear();
  assert.deepEqual(buffer.export().events, []);
  buffer.record('rtt', { rttMs: 42 });
  assert.deepEqual(buffer.export().events.map(event => event.rttMs), [42]);
  buffer.clear();
});

test('RoomSession hooks report transport interruption, alignment and RTT without session objects', async () => {
  const { RoomSession } = await import('../extension/room-session.js');
  const buffer = new Diagnostics();
  let connectionStatus;
  const room = new RoomSession({ now: () => 1000, diagnose: (kind, fields) => buffer.record(kind, fields),
    connect: (_server, _event, _error, status) => {
      connectionStatus = status;
      return { open: async () => ({ role: 'host', code: 'PRIVATE_ROOM', token: 'PRIVATE_TOKEN' }), send() {}, close() {} };
    }, changed() {}, failed(error) { throw error; } });
  await room.open('https://PRIVATE_URL.invalid', null,
    { mediaId: 'PRIVATE_MEDIA', time: 0, duration: 120, paused: true, buffering: false });
  connectionStatus({ lane: 'receive', reconnecting: true, token: 'PRIVATE_TOKEN' });
  room.interrupt(); room.reset('user');
  room.receive({ type: 'pong', sent: 950, received: 975 });
  const result = buffer.export();
  assert.deepEqual(result.events.map(event => event.kind), ['transport', 'pause', 'alignment', 'rtt']);
  assert.equal(result.events.at(-1).rttMs, 50);
  assert.equal(JSON.stringify(result).includes('PRIVATE_'), false);
  room.close();
  connectionStatus({ lane: 'receive', reconnecting: false });
  assert.equal(buffer.export().events.length, 4);
  buffer.clear();
});
