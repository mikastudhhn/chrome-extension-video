import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from '../server/index.js';
import { Rooms } from '../server/rooms.js';
import { RoomRequests } from '../server/room-requests.js';
import { Signaling } from '../extension/signaling.js';
import { PROTOCOL, CAPABILITIES } from '../extension/protocol.js';

const hello = { protocol: PROTOCOL, capabilities: [...CAPABILITIES] };
const post = body => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function listen(server, t) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}
const client = base => new Signaling(base, () => {}, () => {});

test('lost real HTTP create/join responses recover the same seats and emit one peer event', async t => {
  for (const loss of ['disconnect', 'gateway-502']) await t.test(loss, async t => {
  const rooms = new Rooms(), relay = createServer({ rooms });
  const base = await listen(relay, t);
  const lost = new Set(), attempts = [];
  const proxy = http.createServer((request, response) => {
    const upstream = http.request(`${base}${request.url}`, { method: request.method, headers: request.headers }, result => {
      const chunks = [];
      result.on('data', chunk => chunks.push(chunk));
      result.on('end', () => {
        if (request.method === 'POST' && (request.url === '/rooms' || request.url.endsWith('/join'))) {
          attempts.push({ path: request.url, result: JSON.parse(Buffer.concat(chunks)) });
          if (!lost.has(request.url)) {
            lost.add(request.url);
            if (loss === 'disconnect') response.destroy();
            else { response.writeHead(502); response.end('Bad Gateway'); }
            return;
          }
        }
        response.writeHead(result.statusCode, result.headers); response.end(Buffer.concat(chunks));
      });
    });
    upstream.on('error', () => response.destroy());
    request.pipe(upstream);
  });
  const address = await listen(proxy, t);
  const host = client(address), guest = client(address);
  const first = await host.open();
  const second = await guest.open(first.code);
  assert.equal(rooms.rooms.size, 1);
  assert.equal(rooms.members.size, 2);
  assert.equal(second.code, first.code);
  assert.equal(attempts.length, 4);
  assert.deepEqual(attempts[0].result, attempts[1].result);
  assert.deepEqual(attempts[2].result, attempts[3].result);
  assert.equal(rooms.members.get(first.token).events.filter(event => event.type === 'peer-joined').length, 1);
  assert.equal(relay.operatingSnapshot().replays, 2);
  await host.close(); await guest.close();
  });
});

test('lease expiry, restart, conflicting IDs, closed rooms and full cache never create duplicate seats', () => {
  let now = 1000;
  const rooms = new Rooms({ now: () => now });
  const requests = new RoomRequests({ now: () => now, limit: 1 });
  const handshake = { ...hello, roomRequest: { ...requests.offer(), id: randomUUID() } };
  const create = () => requests.run(handshake, '/rooms', rooms, () => rooms.create(hello));
  const member = create();
  assert.deepEqual(create(), member);
  assert.throws(() => requests.run(handshake, '/different', rooms, () => rooms.create(hello)), { code: 'ROOM_REQUEST_CONFLICT' });
  const other = { ...hello, roomRequest: { ...requests.offer(), id: randomUUID() } };
  assert.throws(() => requests.run(other, '/rooms', rooms, () => rooms.create(hello)), { code: 'SERVER_BUSY' });
  assert.equal(requests.entries.size, 1);
  const restarted = new RoomRequests({ now: () => now });
  assert.throws(() => restarted.run(handshake, '/rooms', rooms, () => rooms.create(hello)), { code: 'ROOM_REQUEST_EXPIRED' });
  const forged = { ...hello, roomRequest: { ...handshake.roomRequest, expiresAt: now + 60001 } };
  assert.throws(() => requests.run(forged, '/rooms', rooms, () => rooms.create(hello)), { code: 'ROOM_REQUEST_EXPIRED' });
  rooms.close(rooms.rooms.get(member.code));
  assert.throws(create, { code: 'SESSION_ENDED' });
  now += 60000; requests.sweep();
  assert.equal(requests.entries.size, 0);
  assert.throws(create, { code: 'ROOM_REQUEST_EXPIRED' });
  assert.equal(rooms.rooms.size, 0);
});

test('concurrent duplicate joins succeed once while a different ID still sees a full room', async t => {
  const rooms = new Rooms();
  const base = await listen(createServer({ rooms }), t);
  const host = rooms.create(hello);
  const offer = (await (await fetch(`${base}/health`)).json()).roomRequests;
  const join = id => fetch(`${base}/rooms/${host.code}/join`, { method: 'POST', body: JSON.stringify({ ...hello, roomRequest: { ...offer, id } }) });
  const id = randomUUID();
  const results = await Promise.all(Array.from({ length: 8 }, () => join(id)));
  assert.ok(results.every(response => response.status === 201));
  const members = await Promise.all(results.map(response => response.json()));
  assert.equal(new Set(members.map(member => member.token)).size, 1);
  assert.equal((await join(randomUUID())).status, 409);
  assert.equal(rooms.members.size, 2);
});

test('a server without signed room leases is incompatible; permanent responses are never retried', async t => {
  let posts = 0;
  const oldServer = http.createServer((request, response) => {
    if (request.url === '/health') { response.end(JSON.stringify({ ok: true, protocol: 2 })); return; }
    posts++; response.destroy();
  });
  const old = client(await listen(oldServer, t));
  await assert.rejects(old.open(), { code: 'INCOMPATIBLE_PROTOCOL' });
  assert.equal(posts, 0);
  const base = await listen(createServer({ rooms: new Rooms() }), t);
  for (const code of ['ROOM_FULL', 'ROOM_NOT_FOUND', 'RATE_LIMITED', 'SERVER_BUSY', 'ROOM_REQUEST_EXPIRED']) {
    const connection = client(base);
    let attempts = 0;
    connection.request = async path => {
      if (path === '/health') return { roomRequests: new RoomRequests().offer() };
      attempts++; throw Object.assign(new Error('permanent'), { code, status: 409 });
    };
    await assert.rejects(connection.open(), { code });
    assert.equal(attempts, 1);
  }
});

test('room/cache/rate-limit overload recovers and counters expose no identifiers', async t => {
  let now = Date.now();
  const rooms = new Rooms({ limit: 1 });
  const server = createServer({ rooms, requestLimit: 1, rateLimitEntries: 2, now: () => now });
  const base = await listen(server, t);
  const host = await (await fetch(`${base}/rooms`, post(hello))).json();
  assert.equal((await fetch(`${base}/rooms`, post(hello))).status, 503);
  rooms.close(rooms.rooms.get(host.code));
  assert.equal((await fetch(`${base}/rooms`, post(hello))).status, 201);
  for (let i = 0; i < 28; i++) await fetch(`${base}/rooms`, post(hello));
  assert.equal((await fetch(`${base}/rooms`, post(hello))).status, 429);
  const snapshot = server.operatingSnapshot();
  assert.ok(snapshot.responses.failed > 0);
  assert.ok(snapshot.responses.rejected > 0);
  assert.equal(snapshot.activeRooms, 1);
  assert.ok(snapshot.latencyMs.count > 0);
  assert.ok(!JSON.stringify(snapshot).includes(host.code));
  assert.ok(!JSON.stringify(snapshot).includes(host.token));
  assert.equal((await fetch(`${base}/health`)).status, 200);
  now += 60001;
  for (const room of rooms.rooms.values()) rooms.close(room);
  assert.equal((await fetch(`${base}/rooms`, post(hello))).status, 201);
});

test('shutdown releases long polls, rejects slow pending creates and bounds idle socket lifetime', async t => {
  const rooms = new Rooms();
  const server = createServer({ rooms, pollTimeoutMs: 60000 });
  const base = await listen(server, t);
  const host = rooms.create(hello);
  const guest = rooms.join(host.code, hello);
  const poll = fetch(`${base}/events`, { headers: { Authorization: `Bearer ${guest.token}` } });
  // Wait on observable server state rather than a timing assumption.
  while (!rooms.members.get(guest.token).wait) await new Promise(resolve => setImmediate(resolve));
  const socket = net.connect(server.address().port, '127.0.0.1');
  await once(socket, 'connect');
  socket.on('error', () => {}); // Forced shutdown may reset an incomplete HTTP request.
  const socketClosed = new Promise(resolve => socket.once('close', resolve));
  socket.write('POST /rooms HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100\r\n\r\n{');
  while (server.operatingSnapshot().inFlight < 2) await new Promise(resolve => setImmediate(resolve));
  const start = Date.now();
  const shutdown = server.shutdown({ deadlineMs: 100 });
  assert.equal(server.shutdown(), shutdown);
  assert.equal((await (await poll).json()).events[0].type, 'room-closed');
  await shutdown;
  socket.destroy(); await socketClosed;
  assert.ok(Date.now() - start < 2000);
  assert.equal(server.operatingSnapshot().activeRooms, 0);
  assert.equal(server.operatingSnapshot().closed.shutdown, 1);
});

test('admission bounds preserve health after open requests and rate-limit identities are released', async t => {
  const rooms = new Rooms();
  const server = createServer({ rooms, maxInFlight: 1, pollTimeoutMs: 60000 });
  const base = await listen(server, t);
  const host = rooms.create(hello), guest = rooms.join(host.code, hello);
  const poll = fetch(`${base}/events`, { headers: { Authorization: `Bearer ${guest.token}` } });
  while (!rooms.members.get(guest.token).wait) await new Promise(resolve => setImmediate(resolve));
  assert.equal((await fetch(`${base}/health`)).status, 503);
  rooms.close(rooms.rooms.get(host.code));
  await (await poll).json();
  assert.equal((await fetch(`${base}/health`)).status, 200);
  let now = Date.now();
  const bounded = createServer({ env: { TRUST_PROXY: '1' }, rateLimitEntries: 1, now: () => now });
  const address = await listen(bounded, t);
  // Only the proxy-set X-Real-IP identifies a client; X-Forwarded-For is client-controlled.
  const create = ip => fetch(`${address}/rooms`, { method: 'POST', headers: { 'x-real-ip': ip, 'x-forwarded-for': '198.51.100.7' }, body: JSON.stringify(hello) });
  assert.equal((await create('192.0.2.1')).status, 201);
  assert.equal((await create('192.0.2.2')).status, 503);
  now += 60001;
  assert.equal((await create('192.0.2.2')).status, 201);
});

test('a POST body arriving during shutdown cannot create a late room', async t => {
  const rooms = new Rooms();
  const server = createServer({ rooms });
  await listen(server, t);
  let responseText = '';
  const socket = net.connect(server.address().port, '127.0.0.1');
  socket.setEncoding('utf8');
  socket.on('data', chunk => { responseText += chunk; });
  socket.on('error', () => {});
  await once(socket, 'connect');
  const closed = new Promise(resolve => socket.once('close', resolve));
  socket.write('POST /rooms HTTP/1.1\r\nHost: localhost\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{');
  while (server.operatingSnapshot().inFlight < 1) await new Promise(resolve => setImmediate(resolve));
  const shutdown = server.shutdown({ deadlineMs: 1000 });
  socket.write('}');
  await closed; await shutdown;
  assert.match(responseText, /503 Service Unavailable/);
  assert.match(responseText, /SERVER_DRAINING/);
  assert.equal(rooms.rooms.size, 0);
});

test('CLI handles SIGTERM with a successful exit and only aggregate shutdown output', async t => {
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: process.cwd(), env: { ...process.env, HOST: '127.0.0.1', PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let output = '', errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  const started = new Promise(resolve => child.stdout.on('data', chunk => {
    output += chunk;
    if (output.includes('relay started')) resolve();
  }));
  const exited = once(child, 'exit');
  await started;
  child.kill('SIGTERM');
  const [code, signal] = await exited;
  assert.equal(code, 0);
  assert.equal(signal, null);
  assert.equal(errors, '');
  assert.match(output, /"event":"shutdown"/);
  assert.doesNotMatch(output, /localhost|127\.0\.0\.1|https?:|token|roomCode/);
});

test('memoized Create and Join recover at the exact shared-IP admission boundary', async t => {
  for (const action of ['create', 'join']) await t.test(action, async t => {
    const rooms = new Rooms(), relay = createServer({ rooms });
    const base = await listen(relay, t);
    // 29 successful POSTs consume the shared NAT budget before the target action.
    let invitation;
    for (let index = 0; index < 29; index++) {
      const response = await fetch(`${base}/rooms`, post(hello));
      assert.equal(response.status, 201);
      invitation = (await response.json()).code;
    }
    let lost = false;
    const statuses = [], tokens = [];
    const proxy = http.createServer((request, response) => {
      const upstream = http.request(`${base}${request.url}`, { method: request.method, headers: request.headers }, result => {
        const chunks = [];
        result.on('data', chunk => chunks.push(chunk));
        result.on('end', () => {
          if (request.method === 'POST') {
            statuses.push(result.statusCode);
            tokens.push(JSON.parse(Buffer.concat(chunks)).token);
            if (!lost) { lost = true; response.destroy(); return; }
          }
          response.writeHead(result.statusCode, result.headers); response.end(Buffer.concat(chunks));
        });
      });
      upstream.on('error', () => response.destroy());
      request.pipe(upstream);
    });
    const connection = client(await listen(proxy, t));
    const member = await connection.open(action === 'join' ? invitation : undefined);
    assert.deepEqual(statuses, [201, 201]);
    assert.equal(tokens[0], tokens[1]);
    assert.equal(member.token, tokens[0]);
    assert.equal(connection.member.token, member.token);
    assert.equal(rooms.rooms.size, action === 'create' ? 30 : 29);
    assert.equal(rooms.members.size, 30);
    assert.equal(relay.operatingSnapshot().replays, 1);
    if (action === 'join') assert.equal(rooms.rooms.get(invitation).members[0].events.filter(event => event.type === 'peer-joined').length, 1);
    // Recovering a known operation never opens the admission budget for a new one.
    const offer = (await (await fetch(`${base}/health`)).json()).roomRequests;
    assert.equal((await fetch(`${base}/rooms`, { method: 'POST',
      body: JSON.stringify({ ...hello, roomRequest: { ...offer, id: randomUUID() } }) })).status, 429);
    await connection.close();
  });
});

test('a known signed ID has a separate bounded replay allowance without another mutation', () => {
  const rooms = new Rooms(), requests = new RoomRequests();
  const handshake = { ...hello, roomRequest: { ...requests.offer(), id: randomUUID() } };
  let mutations = 0;
  const run = () => requests.run(handshake, '/rooms', rooms, () => { mutations++; return rooms.create(hello); });
  const result = run();
  for (let replay = 0; replay < 10; replay++) assert.deepEqual(run(), result);
  assert.throws(run, { code: 'RATE_LIMITED' });
  assert.equal(mutations, 1);
  assert.equal(rooms.rooms.size, 1);
});

test('a later admission denial preserves uncertainty after an earlier lost response', async () => {
  for (const code of ['RATE_LIMITED', 'SERVER_BUSY', 'SERVER_DRAINING']) {
    const connection = client('http://localhost');
    let posts = 0;
    connection.request = async path => {
      if (path === '/health') return { roomRequests: new RoomRequests().offer() };
      posts++;
      if (posts === 1) throw Object.assign(new Error('response lost'), { code: 'NETWORK_ERROR' });
      throw Object.assign(new Error('admission denied'), { code, status: code === 'RATE_LIMITED' ? 429 : 503 });
    };
    await assert.rejects(connection.open(), { code: 'ROOM_SETUP_UNCERTAIN', retryable: false });
    assert.equal(posts, 2);
    assert.equal(connection.member, null);
  }
});
