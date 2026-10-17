import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../server/index.js';
import { Signaling } from '../extension/signaling.js';
import { PROTOCOL, CAPABILITIES } from '../extension/protocol.js';
import { RoomRequests } from '../server/room-requests.js';
import { Timeline } from '../extension/timeline.js';
import { errorPayload, fault, httpError, errorResponse, responseError } from '../extension/runtime-errors.js';
import { describeRoomError } from '../extension/errors.js';
import { Connection } from '../extension/connection.js';

async function serverFor(t, factory = createServer) {
  const server = factory({ env: {}, pollTimeoutMs: 10 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}
const waitFor = async check => {
  const end = Date.now() + 3000;
  while (!check()) { if (Date.now() > end) throw new Error('Delivery timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
};

test('relay delivers state and intents between host and guest and negotiates capabilities', async t => {
  const base = await serverFor(t);
  const hostEvents = [], guestEvents = [], failures = [];
  const host = new Signaling(base, event => hostEvents.push(event), error => failures.push(error));
  const guest = new Signaling(base, event => guestEvents.push(event), error => failures.push(error));
  try {
    const member = await host.open(); await guest.open(member.code);
    host.poll(); guest.poll();
    const timeline = new Timeline(() => Date.now());
    host.send({ type: 'state', state: timeline.snapshot() });
    guest.send({ type: 'intent', epoch: 0, intent: { type: 'pause' } });
    await waitFor(() => hostEvents.some(event => event.type === 'data') && guestEvents.some(event => event.type === 'data'));
    assert.deepEqual(failures, []);
    assert.equal(host.supports('structured-errors-v1'), true);
  } finally { await host.close(); await guest.close(); }
});

test('the transport requires a signed lease and a current member, rejects broken responses and never retries creation', async () => {
  const connection = new Signaling('http://localhost', () => {}, () => {});
  let requests = 0, probes = 0;
  const health = { ok: true, protocol: PROTOCOL, roomRequests: new RoomRequests().offer() };
  const member = { protocol: PROTOCOL, code: 'ABC234', token: 'a'.repeat(43), role: 'host', capabilities: [...CAPABILITIES], peerCapabilities: [] };
  const respond = reply => async path => { if (path === '/health') { probes++; return health; } requests++; return reply; };
  connection.request = respond(member);
  assert.deepEqual(await connection.open(), member);
  assert.equal(connection.supports('relay-v2'), false, 'no guest has announced capabilities yet');
  connection.member.peerCapabilities = ['relay-v2'];
  assert.equal(connection.supports('relay-v2'), true);
  assert.equal(connection.supports('structured-errors-v1'), false);
  for (const [reply, code] of [[{ ...member, token: [] }, 'INVALID_RESPONSE'], [{ ...member, protocol: 2 }, 'INCOMPATIBLE_PROTOCOL'],
    [{ ...member, code: '123456789012' }, 'INVALID_RESPONSE'], [{ ...member, capabilities: undefined }, 'INVALID_RESPONSE']]) {
    const next = new Signaling('http://localhost', () => {}, () => {});
    next.request = respond(reply);
    await assert.rejects(next.open(), { code });
  }
  assert.equal(requests, 5, 'one creation request each, never retried');
  const old = new Signaling('http://localhost', () => {}, () => {});
  old.request = async path => { if (path === '/health') return { ok: true, protocol: 2 }; throw new Error('must not create'); };
  await assert.rejects(old.open(), { code: 'INCOMPATIBLE_PROTOCOL' });
  assert.equal(probes, 5);
});

test('invalid poll batches cannot deliver a prefix, acknowledge events or reconnect forever', async () => {
  const received = [], errors = [];
  const connection = new Signaling('http://localhost', event => received.push(event), error => errors.push(error));
  connection.member = { role: 'host' };
  connection.request = async () => ({ events: [{ id: 1, type: 'peer-joined' }, { id: 2, type: 'data', at: 0, message: { type: 'sample', sample: [] } }] });
  await connection.poll();
  assert.equal(connection.cursor, 0);
  assert.deepEqual(received, []);
  assert.equal(errors[0].code, 'INVALID_RESPONSE');
  let attempts = 0;
  await assert.rejects(connection.retry(() => { attempts++; throw fault('INVALID_MESSAGE', 400); }, 'send'), { code: 'INVALID_MESSAGE' });
  assert.equal(attempts, 1);
});

test('HTTP semantic errors retain code/category/retryability and old error string', async t => {
  const base = await serverFor(t);
  const response = await fetch(`${base}/rooms/QQQQQQ/join`, { method: 'POST', body: JSON.stringify({ protocol: PROTOCOL, capabilities: CAPABILITIES }) });
  const body = await response.json();
  assert.equal(response.status, 404);
  assert.equal(typeof body.error, 'string');
  const error = httpError(body, response.status);
  assert.equal(error.code, 'ROOM_NOT_FOUND'); assert.equal(error.category, 'room'); assert.equal(error.retryable, false);
  const changedText = { ...body.failure, message: 'Unrelated translated text', token: 'secret', stack: 'private', details: { token: 'secret' } };
  assert.equal(describeRoomError(changedText, 'join', base).editInvitation, true);
  assert.doesNotMatch(JSON.stringify(errorPayload(changedText)), /secret|private/);
  assert.equal(httpError({ error: 'Dieser Raum ist bereits mit zwei Personen belegt.' }, 409).code, 'ROOM_FULL');
});

test('Connection reconstructs structured worker errors and the runtime/UI roundtrip preserves semantics', async t => {
  const original = globalThis.Worker;
  class FakeWorker { postMessage() {} }
  globalThis.Worker = FakeWorker;
  t.after(() => { globalThis.Worker = original; });
  const asynchronous = [];
  const connection = new Connection('http://localhost', () => {}, error => asynchronous.push(error), () => {});
  const opened = connection.open();
  connection.worker.onmessage({ data: { type: 'error', ...errorResponse(fault('ROOM_FULL', 409)) } });
  await assert.rejects(opened, { code: 'ROOM_FULL', category: 'room', retryable: false, status: 409 });
  connection.worker.onmessage({ data: { type: 'error', ...errorResponse(fault('SESSION_ENDED', 401)) } });
  // Offscreen and Background each serialize a runtime response; Chrome clones it.
  const offscreen = structuredClone(errorResponse(asynchronous[0]));
  const background = structuredClone(errorResponse(responseError(offscreen)));
  const popup = responseError(background);
  assert.equal(popup.code, 'SESSION_ENDED'); assert.equal(popup.status, 401);
  assert.equal(popup.retryable, false);
  assert.equal(describeRoomError(responseError(errorResponse(fault('ROOM_FULL', 409))), 'join', '').title, 'Dieser Raum ist voll');
});

