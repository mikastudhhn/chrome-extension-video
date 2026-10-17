import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Rooms } from '../server/rooms.js';
import { Signaling } from '../extension/signaling.js';
import { PROTOCOL, CAPABILITIES } from '../extension/protocol.js';

const hello = { protocol: PROTOCOL, capabilities: [...CAPABILITIES] };

async function serve(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}

for (const interruption of ['timeout', 'socket-close']) {
  test(`a ${interruption} after relay headers retries identical bytes without replaying the command`, async t => {
    const rooms = new Rooms(), host = rooms.create(hello), guest = rooms.join(host.code, hello);
    const sender = rooms.authenticate(guest.token), receiver = rooms.authenticate(host.token);
    const bodies = [], failures = [], interruptions = [], statuses = [];
    const base = await serve(t, async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk;
      bodies.push(body);
      rooms.relayData(sender, JSON.parse(body));
      response.writeHead(200, { 'Content-Type': 'application/json' });
      if (bodies.length === 1) {
        response.write('{');
        if (interruption === 'socket-close') {
          const timer = setTimeout(() => response.destroy(), 20);
          response.on('close', () => clearTimeout(timer));
        }
      } else response.end('{"ok":true}');
    });
    const connection = new Signaling(base, () => {}, error => failures.push(error), status => statuses.push(status));
    t.after(() => connection.abort.abort());
    connection.member = { ...guest, protocol: 2 };
    const request = connection.request.bind(connection);
    connection.request = async (...args) => {
      try { return await request(...args.slice(0, 3), interruptions.length ? 1000 : 100); }
      catch (error) { interruptions.push({ code: error.code, retryable: error.retryable }); throw error; }
    };
    connection.queue.push({ type: 'resync', requestId: 'body-interruption' });
    await connection.flush();
    assert.deepEqual(interruptions, [{ code: interruption === 'timeout' ? 'TIMEOUT' : 'NETWORK_ERROR', retryable: true }]);
    assert.deepEqual(failures, []);
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0], bodies[1], 'same sequence and payload after delivery with lost response');
    assert.equal(sender.sentSequence, 1);
    assert.equal(receiver.events.filter(event => event.type === 'data').length, 1);
    assert.equal(connection.pendingBatch, null);
    assert.equal(connection.sequence, 1);
    // One interrupted response is retried within the grace period: no interruption status.
    assert.deepEqual(statuses, []);
  });
}

test('a completely received malformed JSON response is fatal and never retried', async t => {
  let attempts = 0;
  const base = await serve(t, (request, response) => {
    attempts++;
    request.resume();
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end('{');
  });
  const connection = new Signaling(base, () => {}, () => {});
  t.after(() => connection.abort.abort());
  await assert.rejects(connection.retry(() => connection.request('/events', 'GET', undefined, 1000), 'receive'),
    { code: 'INVALID_RESPONSE', retryable: false });
  assert.equal(attempts, 1);
});

test('local abort while receiving a body stays cancelled without retry or a fatal poll callback', async t => {
  let attempts = 0, headersReceived;
  const headers = new Promise(resolve => { headersReceived = resolve; });
  const base = await serve(t, (request, response) => {
    attempts++;
    request.resume();
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.write('{');
  });
  const failures = [], connection = new Signaling(base, () => {}, error => failures.push(error));
  t.after(() => connection.abort.abort());
  // Observe real fetch header completion so abort is definitely during body read.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    const response = await originalFetch(...args);
    headersReceived();
    return response;
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  let caught;
  const request = connection.request.bind(connection);
  connection.request = async (...args) => {
    try { return await request(...args); }
    catch (error) { caught = error; throw error; }
  };
  const polling = connection.poll();
  await headers;
  connection.abort.abort();
  await polling;
  assert.equal(caught.code, 'ABORTED');
  assert.equal(caught.retryable, false);
  assert.equal(attempts, 1);
  assert.deepEqual(failures, []);
});
