import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createServer } from '../server/index.js';
import { Rooms, ROOM_LIMITS } from '../server/rooms.js';
import { PROTOCOL, CAPABILITIES, LIMITS, normalizeMessage, validMessage } from '../extension/protocol.js';

const hello = { protocol: PROTOCOL, capabilities: [...CAPABILITIES] };
const uuid = '0f8fad5b-d9cb-469f-a165-70867728950e';
const intent = { type: 'seek', time: 12.5, at: 1729000000000.5, advancing: false, epoch: 3, id: 7, mediaId: uuid };
const sample = { time: 5, duration: 100, mediaId: uuid, paused: true, buffering: false, at: 1, advancing: false, adapter: 'HTML5' };
const state = { phase: 'synced', epoch: 1, revision: 2, at: 3, position: 4, playing: false, wantsPlay: false, waiting: false,
  anchors: { host: 1, guest: 2 }, members: { host: { present: true, ready: true, blocked: false }, guest: { present: true, ready: true, blocked: false } },
  acknowledgedIntents: { guest: { id: 7, mediaId: uuid, revision: 2 } } };

async function listen(server, t) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}
const post = (body, headers = {}) => ({ method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
const pair = (rooms = new Rooms()) => {
  const host = rooms.create(hello), guest = rooms.join(host.code, hello);
  return { rooms, host: rooms.members.get(host.token), guest: rooms.members.get(guest.token) };
};

test('normalized messages keep every protocol field and drop everything else, also nested', () => {
  const padding = 'x'.repeat(20_000);
  const cases = [
    [{ type: 'ping', sent: 1, padding }, 'guest', { type: 'ping', sent: 1 }],
    [{ type: 'pong', sent: 1, received: 2, padding }, 'host', { type: 'pong', sent: 1, received: 2 }],
    [{ type: 'ready', epoch: 1, padding }, 'guest', { type: 'ready', epoch: 1 }],
    [{ type: 'resync', requestId: 'r', padding }, 'guest', { type: 'resync', requestId: 'r' }],
    [{ type: 'intent', epoch: 3, intent: { ...intent, padding }, padding }, 'guest', { type: 'intent', epoch: 3, intent }],
    [{ type: 'sample', sample: { ...sample, bindingId: 'b', playerId: 'p', capabilities: { play: true }, intents: [{ ...intent, padding }], padding } },
      'guest', { type: 'sample', sample: { ...sample, intents: [intent] } }],
    [{ type: 'state', resetId: 'reset', state: { ...state, padding, anchors: { ...state.anchors },
      members: { host: { ...state.members.host, padding }, guest: { ...state.members.guest } },
      acknowledgedIntents: { guest: { ...state.acknowledgedIntents.guest, padding } } } }, 'host', { type: 'state', state, resetId: 'reset' }]
  ];
  for (const [input, role, expected] of cases) {
    const normalized = normalizeMessage(input, role);
    assert.deepEqual(normalized, expected);
    assert.equal(validMessage(normalized, role), true);
    assert.ok(JSON.stringify(normalized).length < 1000);
  }
  const { acknowledgedIntents, ...withoutAcknowledgement } = state;
  assert.deepEqual(normalizeMessage({ type: 'state', state: withoutAcknowledgement }, 'host'), { type: 'state', state: withoutAcknowledgement });
  assert.equal(acknowledgedIntents.guest.id, 7);
  assert.equal(normalizeMessage({ type: 'state', state }, 'guest'), null);
  assert.equal(normalizeMessage({ type: 'sample', sample: { ...sample, time: -1 } }, 'guest'), null);
});

test('relay forwards only normalized messages and rejects one whose protocol fields exceed the byte limit', () => {
  const { rooms, host, guest } = pair();
  rooms.relayData(guest, { sequence: 1, messages: [{ type: 'sample', sample: { ...sample, secret: 'x'.repeat(8000) }, extra: [1, 2, 3] }] });
  const queued = host.events.at(-1);
  assert.deepEqual(queued.message, { type: 'sample', sample });
  assert.ok(queued.bytes < 300);
  assert.equal(host.queuedBytes, queued.bytes);
  // A sample with the maximum of 20 intents and UUID media IDs is legitimate.
  const full = { ...sample, intents: Array.from({ length: LIMITS.intents }, (_, index) => ({ ...intent, id: index + 1 })) };
  rooms.relayData(guest, { sequence: 2, messages: [{ type: 'sample', sample: full }] });
  // Escaped control characters inflate bounded strings beyond the message limit.
  const escaped = '\u0001'.repeat(LIMITS.mediaId);
  const inflated = { ...sample, mediaId: escaped, intents: Array.from({ length: LIMITS.intents }, () => ({ ...intent, mediaId: escaped })) };
  assert.throws(() => rooms.relayData(guest, { sequence: 3, messages: [{ type: 'sample', sample: inflated }] }), { code: 'REQUEST_TOO_LARGE' });
  assert.equal(guest.sentSequence, 2);
});

test('receiver queues are bounded by bytes; the server-wide queue budget rejects retryably', () => {
  const big = { ...sample, intents: Array.from({ length: LIMITS.intents }, (_, index) => ({ ...intent, id: index + 1, mediaId: 'm'.repeat(LIMITS.mediaId) })) };
  const { rooms, host, guest } = pair();
  let sequence = 0;
  // Alternating commands prevent sample coalescing, the worst case for a queue.
  while (rooms.rooms.size) {
    rooms.relayData(guest, { sequence: ++sequence, messages: [{ type: 'sample', sample: big }, { type: 'ready', epoch: sequence }] });
    if (rooms.rooms.size) assert.ok(host.queuedBytes <= ROOM_LIMITS.memberQueueBytes);
  }
  assert.ok(sequence < LIMITS.events / 2, 'byte bound triggers before the count bound');
  assert.equal(rooms.queuedBytes, 0);
  assert.equal(host.events[0].type, 'room-closed');

  const shared = new Rooms({ queueBudgetBytes: 15_000 });
  const first = pair(shared), second = pair(shared);
  shared.relayData(first.guest, { sequence: 1, messages: [{ type: 'sample', sample: big }, { type: 'ready', epoch: 1 }, { type: 'sample', sample: big }] });
  assert.throws(() => shared.relayData(second.guest, { sequence: 1, messages: [{ type: 'sample', sample: big }, { type: 'ready', epoch: 1 }, { type: 'sample', sample: big }, { type: 'ready', epoch: 2 }] }),
    { code: 'SERVER_BUSY', retryable: true });
  assert.equal(second.guest.sentSequence, 0);
  const acknowledged = shared.poll(first.host, first.host.sequence, new AbortController().signal, 1);
  return acknowledged.then(() => {
    assert.ok(shared.queuedBytes < 1000);
    shared.relayData(second.guest, { sequence: 1, messages: [{ type: 'sample', sample: big }, { type: 'ready', epoch: 1 }] });
    assert.equal(second.guest.sentSequence, 1);
  });
});

test('a newer poll replaces the parked one, which answers empty', async () => {
  const { rooms, host, guest } = pair();
  await rooms.poll(host, 0, new AbortController().signal, 10); // peer-joined
  const first = rooms.poll(host, host.sequence, new AbortController().signal, 5000);
  const second = rooms.poll(host, host.sequence, new AbortController().signal, 5000);
  assert.deepEqual(await first, []);
  rooms.relayData(guest, { sequence: 1, messages: [{ type: 'resync', requestId: 'r' }] });
  const events = await second;
  assert.equal(events.length, 1);
  assert.equal(events[0].message.type, 'resync');
  assert.equal(host.wait, null);
});

test('rooms per creator address are capped, unjoined invitations expire, every room has a lifetime', () => {
  let now = 0;
  const rooms = new Rooms({ now: () => now });
  const owned = [1, 2, 3].map(() => rooms.create(hello, '192.0.2.1'));
  assert.throws(() => rooms.create(hello, '192.0.2.1'), { code: 'RATE_LIMITED', status: 429 });
  rooms.create(hello, '192.0.2.2');
  rooms.close(rooms.rooms.get(owned[0].code), 'leave');
  rooms.create(hello, '192.0.2.1');
  assert.equal(rooms.owners.get('192.0.2.1'), 3);
  const joined = rooms.join(owned[1].code, hello);
  // Keep members active so only the age limits apply.
  const keep = () => { for (const member of rooms.members.values()) rooms.touch(member); };
  for (now = 0; now <= ROOM_LIMITS.unjoinedMs; now += 60_000) { keep(); rooms.sweep(); }
  now += 60_000; keep(); rooms.sweep();
  assert.deepEqual([...rooms.rooms.keys()], [joined.code]);
  assert.equal(rooms.owners.get('192.0.2.1'), 1);
  for (; now <= ROOM_LIMITS.lifetimeMs; now += 60_000) { keep(); rooms.sweep(); }
  now += 60_000; keep();
  assert.throws(() => rooms.authenticate(joined.token), { code: 'SESSION_ENDED' });
  assert.equal(rooms.rooms.size, 0);
  assert.equal(rooms.owners.size, 0);
});

test('rejected requests do not refresh room activity', () => {
  let now = 0;
  const rooms = new Rooms({ now: () => now, idleMs: 100 });
  const { host, guest } = pair(rooms);
  now = 60;
  rooms.authenticate(guest.token);
  assert.throws(() => rooms.relayData(guest, { sequence: 1, messages: [{ type: 'state', state }] }), { code: 'INVALID_MESSAGE' });
  assert.equal(guest.touched, 0);
  rooms.relayData(guest, { sequence: 1, messages: [{ type: 'ready', epoch: 1 }] });
  assert.equal(guest.touched, 60);
  now = 101;
  assert.throws(() => rooms.authenticate(host.token), { code: 'SESSION_ENDED' });
});

test('HTTP: per-address token bucket covers health and bogus tokens; X-Real-IP identifies clients behind the proxy', async t => {
  const server = createServer({ env: { TRUST_PROXY: '1' }, limits: { floodBurst: 5, floodRatePerSecond: 0.001 } });
  const base = await listen(server, t);
  const from = ip => ({ headers: { 'x-real-ip': ip, 'x-forwarded-for': '203.0.113.99' } });
  const statuses = [];
  for (let index = 0; index < 3; index++) statuses.push((await fetch(`${base}/health`, from('192.0.2.10'))).status);
  for (let index = 0; index < 3; index++) statuses.push((await fetch(`${base}/events`, { headers: { ...from('192.0.2.10').headers, Authorization: 'Bearer bogus' } })).status);
  assert.deepEqual(statuses, [200, 200, 200, 401, 401, 429]);
  const limited = await fetch(`${base}/health`, from('192.0.2.10'));
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).failure.code, 'RATE_LIMITED');
  assert.equal((await fetch(`${base}/health`, from('192.0.2.11'))).status, 200);
  // IPv6 clients are counted per /64.
  for (let index = 0; index < 5; index++) assert.equal((await fetch(`${base}/health`, from(`2001:db8:1:2::${index + 1}`))).status, 200);
  assert.equal((await fetch(`${base}/health`, from('2001:db8:1:2:ffff::1'))).status, 429);
  assert.equal((await fetch(`${base}/health`, from('2001:db8:1:3::1'))).status, 200);
  assert.ok(server.operatingSnapshot().limited.flood >= 3);
  // Local development without a proxy is exempt from address limits.
  const local = await listen(createServer({ env: {}, limits: { floodBurst: 1, floodRatePerSecond: 0.001 } }), t);
  for (let index = 0; index < 5; index++) assert.equal((await fetch(`${local}/health`)).status, 200);
});

function rawRequest(port, text) {
  const socket = net.connect(port, '127.0.0.1');
  let received = '';
  socket.setEncoding('utf8');
  socket.on('data', chunk => { received += chunk; });
  socket.on('error', () => {});
  const closed = new Promise(resolve => socket.once('close', () => resolve(received)));
  socket.write(text);
  return { socket, closed, received: () => received };
}

test('HTTP: concurrent requests per address are charged before the body is read; long polls have their own budget', async t => {
  const rooms = new Rooms();
  const server = createServer({ rooms, env: { TRUST_PROXY: '1' }, pollTimeoutMs: 60_000, limits: { requestsPerClient: 2, pollsPerClient: 1 } });
  const base = await listen(server, t);
  const port = server.address().port;
  const slow = [1, 2].map(() => rawRequest(port, 'POST /rooms HTTP/1.1\r\nHost: x\r\nX-Real-IP: 192.0.2.20\r\nContent-Length: 100\r\n\r\n{'));
  t.after(() => { for (const request of slow) request.socket.destroy(); });
  while (server.operatingSnapshot().inFlight < 2) await new Promise(resolve => setImmediate(resolve));
  const rejected = await fetch(`${base}/rooms`, post(hello, { 'x-real-ip': '192.0.2.20' }));
  assert.equal(rejected.status, 429);
  assert.equal((await fetch(`${base}/rooms`, post(hello, { 'x-real-ip': '192.0.2.21' }))).status, 201);
  const host = rooms.create(hello), guest = rooms.join(host.code, hello);
  const poll = fetch(`${base}/events?after=0`, { headers: { 'x-real-ip': '192.0.2.20', Authorization: `Bearer ${guest.token}` } });
  while (!rooms.members.get(guest.token).wait) await new Promise(resolve => setImmediate(resolve));
  // The poll lane is separate from the two occupied request slots, and has its own cap.
  assert.equal((await fetch(`${base}/events?after=0`, { headers: { 'x-real-ip': '192.0.2.20', Authorization: `Bearer ${host.token}` } })).status, 429);
  for (const request of slow) request.socket.destroy();
  while (server.operatingSnapshot().inFlight > 1) await new Promise(resolve => setImmediate(resolve));
  assert.equal((await fetch(`${base}/rooms`, post(hello, { 'x-real-ip': '192.0.2.20' }))).status, 201);
  rooms.close(rooms.rooms.get(host.code));
  assert.equal((await (await poll).json()).events[0].type, 'room-closed');
  assert.ok(server.operatingSnapshot().limited.concurrency >= 2);
});

test('HTTP: a trickled body times out, while a long poll may outlast the request timeout', async t => {
  const rooms = new Rooms();
  const server = createServer({ rooms, env: {}, pollTimeoutMs: 1500, limits: { bodyTimeoutMs: 300, requestTimeoutMs: 600, headersTimeoutMs: 400 } });
  const base = await listen(server, t);
  const port = server.address().port;
  const started = Date.now();
  const trickle = rawRequest(port, 'POST /rooms HTTP/1.1\r\nHost: x\r\nContent-Length: 400\r\n\r\n{');
  const drip = setInterval(() => trickle.socket.write(' '), 100);
  t.after(() => { clearInterval(drip); trickle.socket.destroy(); });
  const response = await trickle.closed;
  clearInterval(drip);
  // A regular JSON answer (which proxies forward), then the connection closes.
  assert.match(response, /^HTTP\/1\.1 408/);
  assert.match(response, /Connection: close/i);
  assert.match(response, /"code":"TIMEOUT"/);
  assert.ok(Date.now() - started < 1500);
  assert.equal(rooms.rooms.size, 0);
  const headers = rawRequest(port, 'GET /health HTTP/1.1\r\nHost: x\r\n');
  assert.match(await headers.closed, /^HTTP\/1\.1 408/);
  const host = rooms.create(hello);
  const poll = await fetch(`${base}/events?after=0`, { headers: { Authorization: `Bearer ${host.token}` } });
  assert.equal(poll.status, 200);
  assert.deepEqual((await poll.json()).events, []);
  assert.equal(rooms.rooms.size, 1);
});

test('HTTP: a keep-alive connection idle longer than the header timeout is reused without error', async t => {
  const server = createServer({ env: {}, limits: { headersTimeoutMs: 300, requestTimeoutMs: 400, keepAliveTimeoutMs: 5000 } });
  await listen(server, t);
  const socket = net.connect(server.address().port, '127.0.0.1');
  socket.setEncoding('utf8');
  t.after(() => socket.destroy());
  let received = '';
  socket.on('data', chunk => { received += chunk; });
  const request = 'GET /health HTTP/1.1\r\nHost: x\r\nConnection: keep-alive\r\n\r\n';
  socket.write(request);
  while (!received.includes('"ok":true')) await new Promise(resolve => setTimeout(resolve, 10));
  await new Promise(resolve => setTimeout(resolve, 1200));
  assert.equal(socket.destroyed, false);
  received = '';
  socket.write(request);
  while (!received.includes('"ok":true')) {
    assert.equal(socket.destroyed, false);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.match(received, /^HTTP\/1\.1 200/);
});

test('HTTP: body limits are 4 KiB for handshakes and 16 KiB for relay batches; responses carry no bookkeeping', async t => {
  const rooms = new Rooms();
  const base = await listen(createServer({ rooms, env: {} }), t);
  assert.equal((await fetch(`${base}/rooms`, post({ ...hello, padding: 'x'.repeat(5000) }))).status, 413);
  const host = rooms.create(hello), guest = rooms.join(host.code, hello);
  const relay = body => fetch(`${base}/relay`, post(body, { Authorization: `Bearer ${guest.token}` }));
  const tooLarge = await relay({ sequence: 1, messages: [{ type: 'ready', epoch: 1, padding: 'x'.repeat(17_000) }] });
  assert.equal(tooLarge.status, 413);
  assert.equal((await tooLarge.json()).failure.code, 'REQUEST_TOO_LARGE');
  assert.equal((await relay({ sequence: 1, messages: [{ type: 'ready', epoch: 1, padding: 'x'.repeat(10_000) }] })).status, 200);
  const { events } = await (await fetch(`${base}/events?after=0`, { headers: { Authorization: `Bearer ${host.token}` } })).json();
  assert.deepEqual(Object.keys(events[0]).sort(), ['capabilities', 'id', 'type']);
  assert.deepEqual(Object.keys(events[1]).sort(), ['ageMs', 'at', 'id', 'message', 'type']);
  assert.deepEqual(events[1].message, { type: 'ready', epoch: 1 });
});

test('HTTP: failed join lookups are throttled per address and for all addresses together', async t => {
  const rooms = new Rooms();
  const server = createServer({ rooms, env: { TRUST_PROXY: '1' }, limits: { lookupFailuresPerClient: 3, lookupFailureBurst: 5, lookupFailureRatePerSecond: 0.001 } });
  const base = await listen(server, t);
  const target = rooms.create(hello);
  const join = (code, ip) => fetch(`${base}/rooms/${code}/join`, post(hello, { 'x-real-ip': ip }));
  const statuses = [];
  for (let index = 0; index < 4; index++) statuses.push((await join('AAAAAA', '192.0.2.30')).status);
  assert.deepEqual(statuses, [404, 404, 404, 429]);
  // Once spent, even a correct code is refused, so guessing reveals nothing.
  assert.equal((await join(target.code, '192.0.2.30')).status, 429);
  assert.equal((await join('BBBBBB', '192.0.2.31')).status, 404);
  assert.equal((await join('CCCCCC', '192.0.2.32')).status, 404);
  assert.equal((await join(target.code, '192.0.2.33')).status, 429, 'global failure budget spent');
  assert.equal(rooms.rooms.get(target.code).members.length, 1);
  assert.ok(server.operatingSnapshot().limited.lookups >= 3);
});

test('CLI prints an aggregate status line on SIGUSR2 without identifiers', async t => {
  const child = spawn(process.execPath, ['server/index.js'], { cwd: process.cwd(), env: { ...process.env, HOST: '127.0.0.1', PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let output = '';
  const waitFor = pattern => new Promise(resolve => {
    const check = () => { if (pattern.test(output)) { child.stdout.off('data', onData); resolve(); } };
    const onData = chunk => { output += chunk; check(); };
    child.stdout.on('data', onData); check();
  });
  await waitFor(/relay started/);
  child.kill('SIGUSR2');
  await waitFor(/"event":"status"/);
  const line = JSON.parse(output.split('\n').find(entry => entry.includes('"event":"status"')));
  assert.deepEqual(Object.keys(line).sort(), ['activeMembers', 'activeRooms', 'draining', 'event', 'heapMB', 'inFlight', 'joinedRooms', 'parkedPolls', 'queuedBytes', 'rssMB']);
  assert.equal(line.activeRooms, 0);
  child.kill('SIGTERM');
  await once(child, 'exit');
});
