import test from 'node:test';
import assert from 'node:assert/strict';
import { Signaling } from '../extension/signaling.js';
import { createServer } from '../server/index.js';

async function until(check) {
  const end = Date.now() + 8000;
  while (!check()) {
    if (Date.now() > end) throw new Error('Connection did not recover');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test('HTTPS reconnects after a failed poll and a lost POST response without replaying controls', async t => {
  const server = createServer({ env: {}, pollTimeoutMs: 50 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const received = [], failures = [], status = [];
  const host = new Signaling(base, event => received.push(event), error => failures.push(error), event => status.push(event));
  const guest = new Signaling(base, () => {}, error => failures.push(error));
  t.after(async () => { await host.close(); await guest.close(); });
  const member = await host.open(); await guest.open(member.code);
  const request = host.request.bind(host);
  let losePoll = true;
  host.request = (...args) => {
    if (losePoll && args[0].startsWith('/events')) { losePoll = false; throw new TypeError('network offline'); }
    return request(...args);
  };
  const send = guest.request.bind(guest);
  let loseResponse = true;
  guest.request = async (...args) => {
    const response = await send(...args);
    if (loseResponse && args[0] === '/relay') { loseResponse = false; throw new TypeError('response lost after delivery'); }
    return response;
  };
  host.poll(); guest.poll();
  guest.send({ type: 'resync', requestId: 'exactly-once' });
  guest.send({ type: 'intent', intent: { type: 'pause' }, epoch: 1 });
  await until(() => received.filter(event => event.type === 'data').length === 2 && !guest.sending);
  assert.equal(received.filter(event => event.message?.type === 'resync').length, 1);
  assert.deepEqual(received.filter(event => event.type === 'data').map(event => event.message.type), ['resync', 'intent']);
  // Each lane failed once and recovered within the grace period: no interruption.
  assert.deepEqual(status, []);
  assert.deepEqual(failures, []);
});

test('a lane reports reconnecting only after its failure persisted, and recovery once', async () => {
  const status = [];
  const connection = new Signaling('https://example.invalid', () => {}, () => {}, event => status.push(event));
  connection.reconnectGraceMs = 250;
  let attempts = 0;
  const started = Date.now();
  assert.equal(await connection.retry(() => {
    if (Date.now() - started < 600) { attempts++; throw new TypeError('Failed to fetch'); }
    return 'recovered';
  }, 'send'), 'recovered');
  assert.ok(attempts >= 2);
  assert.deepEqual(status, [{ lane: 'send', reconnecting: true }, { lane: 'send', reconnecting: false }]);
  assert.equal(await connection.retry(() => 'again', 'send'), 'again');
  assert.equal(status.length, 2, 'healthy requests emit no status');
  connection.abort.abort();
});

test('retry handles a 502 proxy failure; permanent authorization errors end the connection', async () => {
  const status = [];
  const connection = new Signaling('https://example.invalid', () => {}, () => {}, event => status.push(event));
  let attempts = 0;
  assert.equal(await connection.retry(() => {
    if (++attempts === 1) throw Object.assign(new Error('Bad gateway'), { status: 502 });
    return 'recovered';
  }, 'receive'), 'recovered');
  assert.equal(attempts, 2);
  await assert.rejects(connection.retry(() => { throw Object.assign(new Error('Session ended'), { status: 401 }); }, 'receive'), /Session ended/);
  connection.abort.abort();
});

test('development checkpoint resumes the same seat and retries an uncertain batch exactly once', async t => {
  const server = createServer({ env: {}, pollTimeoutMs: 50 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const received = [], failures = [];
  const host = new Signaling(base, event => received.push(event), error => failures.push(error));
  const guest = new Signaling(base, () => {}, error => failures.push(error));
  const member = await host.open(); await guest.open(member.code);
  host.poll(); guest.poll();
  const request = guest.request.bind(guest);
  let delivered = false;
  guest.request = async (...args) => {
    const result = await request(...args);
    if (args[0] === '/relay') { delivered = true; throw new TypeError('response lost'); }
    return result;
  };
  guest.send({ type: 'resync', requestId: 'before-reload' });
  await until(() => delivered);
  const checkpoint = guest.suspend();
  assert.equal(checkpoint.pendingBatch.sequence, 1);
  const resumed = new Signaling(base, () => {}, error => failures.push(error));
  t.after(async () => { await resumed.close(); await host.close(); });
  assert.deepEqual(resumed.resume(checkpoint), guest.member);
  resumed.poll();
  resumed.send({ type: 'resync', requestId: 'after-reload' });
  await until(() => received.filter(event => event.type === 'data').length === 2 && !resumed.sending);
  assert.deepEqual(received.filter(event => event.type === 'data').map(event => event.message.requestId), ['before-reload', 'after-reload']);
  assert.deepEqual(failures, []);
});

test('a backlog after an outage leaves in sequential batches of at most 8 KiB', async () => {
  const { MAX_BATCH_BYTES } = await import('../extension/signaling.js');
  const connection = new Signaling('https://example.invalid', () => {}, error => { throw error; });
  connection.member = { role: 'guest', token: 'x'.repeat(43) };
  const intents = Array.from({ length: 20 }, (_, index) => ({ type: 'seek', time: 12.345678 + index, at: 1792250435165.8 + index,
    advancing: true, id: index + 1, mediaId: '04cde9d8-0041-4e60-a15e-56ba0457a08b', epoch: 3 }));
  const sample = { time: 30.79, duration: 50, paused: false, buffering: false, mediaId: '04cde9d8-0041-4e60-a15e-56ba0457a08b', intents };
  const queued = [];
  for (let index = 0; index < 24; index++) {
    // Durable messages between samples prevent coalescing, as during a real outage.
    queued.push({ type: 'sample', sample }, { type: 'intent', intent: intents[index % 20], epoch: 3 });
  }
  connection.queue.push(...queued);
  const bodies = [];
  connection.request = async (path, method, batch) => { bodies.push(JSON.stringify(batch)); return { ok: true }; };
  await connection.flush();
  assert.ok(bodies.length > 1);
  for (const body of bodies) assert.ok(new TextEncoder().encode(body).length <= MAX_BATCH_BYTES, `${body.length} bytes`);
  const batches = bodies.map(body => JSON.parse(body));
  assert.deepEqual(batches.map(batch => batch.sequence), batches.map((_, index) => index + 1));
  assert.deepEqual(batches.flatMap(batch => batch.messages), queued);
  connection.abort.abort();
});
