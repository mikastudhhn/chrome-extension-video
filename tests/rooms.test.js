import test from 'node:test';
import assert from 'node:assert/strict';
import { Rooms } from '../server/rooms.js';
import { createServer } from '../server/index.js';
import { PROTOCOL, CAPABILITIES } from '../extension/protocol.js';

const hello = { protocol: PROTOCOL, capabilities: [...CAPABILITIES] };
const post = body => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('rooms allow exactly two different members and cannot be joined again', () => {
  const rooms = new Rooms();
  const host = rooms.create(hello);
  const guest = rooms.join(host.code, hello);
  assert.equal(host.role, 'host'); assert.equal(guest.role, 'guest');
  assert.notEqual(host.token, guest.token);
  assert.throws(() => rooms.join(host.code, hello), error => error.status === 409);
  rooms.close(rooms.authenticate(guest.token).room);
  assert.throws(() => rooms.join(host.code, hello), error => error.status === 404);
  assert.throws(() => rooms.authenticate(host.token), error => error.status === 401);
});

test('idle rooms expire and leave wakes pending polls', async () => {
  let now = 0;
  const rooms = new Rooms({ now: () => now, idleMs: 100 });
  const host = rooms.create(hello), guest = rooms.join(host.code, hello);
  const pending = rooms.poll(rooms.authenticate(guest.token), 0, new AbortController().signal, 1000);
  now = 101; rooms.sweep();
  assert.equal((await pending)[0].type, 'room-closed');
  assert.equal(rooms.rooms.size, 0);
});

test('HTTP handles competing joins, rejects foreign web origins, and requires a member token', async t => {
  const server = createServer({ env: {}, pollTimeoutMs: 5 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Video Sync/);
  const module = await fetch(`${base}/demo.js`, { headers: { Origin: base } });
  assert.equal(module.status, 200);
  const range = await fetch(`${base}/scene-a.webm`, { headers: { Range: 'bytes=0-99' } });
  assert.equal(range.status, 206);
  assert.equal((await range.arrayBuffer()).byteLength, 100);
  assert.match(range.headers.get('Content-Range'), /^bytes 0-99\//);
  const host = await (await fetch(`${base}/rooms`, post(hello))).json();
  assert.match(host.code, /^[A-Z2-9]{6}$/);
  assert.equal(host.protocol, PROTOCOL);
  assert.equal('iceServers' in host, false);
  const joins = await Promise.all([1, 2, 3].map(() => fetch(`${base}/rooms/${host.code}/join`, post(hello))));
  assert.deepEqual(joins.map(response => response.status).sort(), [201, 409, 409]);
  assert.equal((await fetch(`${base}/events`)).status, 401);
  assert.equal((await fetch(`${base}/rooms`, { method: 'POST', headers: { Origin: 'https://untrusted.example' } })).status, 403);
  const authenticated = await fetch(`${base}/events?after=0`, { headers: { Authorization: `Bearer ${host.token}` } });
  assert.equal(authenticated.status, 200);
  assert.equal((await authenticated.json()).events[0].type, 'peer-joined');
  // Old clients get a clear protocol error instead of a room; removed endpoints are gone.
  for (const body of [{}, { protocol: 2, capabilities: ['relay-v2'] }]) {
    const old = await fetch(`${base}/rooms`, post(body));
    assert.equal(old.status, 400);
    assert.equal((await old.json()).failure.code, 'INCOMPATIBLE_PROTOCOL');
  }
  assert.equal((await fetch(`${base}/rooms`, { method: 'POST' })).status, 400);
  assert.equal((await fetch(`${base}/rooms/${host.code}`)).status, 404);
  assert.equal((await fetch(`${base}/signal`, { method: 'POST', headers: { Authorization: `Bearer ${host.token}` } })).status, 404);
});

test('rooms are addressed by their six-character invitation code only', () => {
  const rooms = new Rooms();
  const host = rooms.create(hello);
  assert.match(host.code, /^[A-Z2-9]{6}$/);
  assert.equal('shortCode' in host, false);
  const guest = rooms.join(host.code, hello);
  assert.equal(guest.code, host.code);
  assert.throws(() => rooms.join(host.code, hello), error => error.status === 409);
  rooms.close(rooms.authenticate(host.token).room);
  assert.throws(() => rooms.join(host.code, hello), error => error.status === 404);
  assert.equal(rooms.rooms.size, 0);
});

test('relay batches are authenticated, ordered and idempotent after a lost acknowledgement', async () => {
  const rooms = new Rooms();
  const host = rooms.create(hello), guest = rooms.join(host.code, hello);
  const sender = rooms.authenticate(guest.token), receiver = rooms.authenticate(host.token);
  const batch = { sequence: 1, messages: [{ type: 'resync', requestId: 'once' }] };
  rooms.relayData(sender, batch);
  rooms.relayData(sender, batch);
  assert.equal(receiver.events.filter(event => event.type === 'data').length, 1);
  assert.throws(() => rooms.relayData(sender, { ...batch, sequence: 3 }), error => error.status === 400);
  assert.throws(() => rooms.relayData(receiver, { sequence: 1, messages: [{ type: 'ready', epoch: 1 }] }), error => error.status === 400);
  assert.throws(() => rooms.relayData(sender, { sequence: 2, messages: [{ type: 'state', state: {} }] }), error => error.status === 400);
});

test('offline telemetry stays bounded and fresh while ordered commands remain intact', () => {
  const rooms = new Rooms();
  const host = rooms.create(hello), guest = rooms.join(host.code, hello);
  const sender = rooms.authenticate(guest.token), receiver = rooms.authenticate(host.token);
  for (let sequence = 1; sequence <= 6000; sequence++) {
    rooms.relayData(sender, { sequence, messages: [
      { type: 'sample', sample: { time: sequence, duration: 10000, paused: true, buffering: false, mediaId: 'video' } }, { type: 'ping', sent: sequence }
    ] });
  }
  assert.equal(rooms.rooms.size, 1);
  assert.equal(receiver.events.length, 3); // peer-joined, latest sample, latest ping
  assert.equal(receiver.events[1].message.sample.time, 6000);
  rooms.relayData(sender, { sequence: 6001, messages: [
    { type: 'ready', epoch: 1 }, { type: 'sample', sample: { time: 6001, duration: 10000, paused: true, buffering: false, mediaId: 'video' } }
  ] });
  assert.equal(receiver.events[1].message.sample.time, 6000); // confirmed sample stays before ready
  assert.equal(receiver.events.at(-2).message.type, 'ready');
});

test('healthy rooms survive eight hours; an expired member cannot revive a room before sweep', async () => {
  let now = 0;
  const rooms = new Rooms({ now: () => now });
  const host = rooms.create(hello), guest = rooms.join(host.code, hello);
  for (now = 0; now <= 8 * 60 * 60 * 1000; now += 20_000) {
    rooms.touch(rooms.authenticate(host.token)); rooms.touch(rooms.authenticate(guest.token)); rooms.sweep();
    assert.equal(rooms.rooms.size, 1);
  }
  now += 300_001;
  assert.throws(() => rooms.authenticate(host.token), error => error.status === 401);
  assert.equal(rooms.rooms.size, 0);
});
