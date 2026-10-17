import test from 'node:test';
import assert from 'node:assert/strict';
import { browserMatrix } from '../scripts/browser-test-matrix.js';
import { errorTestChannels } from '../scripts/browser-error-contracts.js';
import { errorGate } from '../scripts/browser-error-gate.js';
import { createServer } from '../server/index.js';
import { Rooms } from '../server/rooms.js';
import { PROTOCOL, CAPABILITIES } from '../extension/protocol.js';

const hello = { protocol: PROTOCOL, capabilities: [...CAPABILITIES] };

const listen = async server => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
};
async function fixture(t) {
  const rooms = new Rooms(), relay = createServer({ rooms });
  const gate = errorGate(await listen(relay));
  const url = await listen(gate.server);
  gate.mode = 'online';
  t.after(async () => {
    for (const server of [gate.server, relay]) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  });
  return { rooms, gate, url };
}

test('error matrix covers both candidate packages with their own channel', () => {
  const suites = browserMatrix({ stable: { extension: '/candidate-stable' }, experimental: { extension: '/candidate-experimental' } })
    .filter(suite => suite.script === 'e2e-errors.js');
  assert.deepEqual(suites.map(suite => [suite.name, suite.env.TEST_EXTENSION, errorTestChannels(suite.env.TEST_CHANNEL)]), [
    ['errors-stable-candidate', '/candidate-stable', ['stable']],
    ['errors-experimental-candidate', '/candidate-experimental', ['experimental']]
  ]);
  assert.deepEqual(errorTestChannels('experimental'), ['experimental']);
  assert.throws(() => errorTestChannels('local'), /Invalid TEST_CHANNEL/);
  assert.throws(() => errorTestChannels(''), /Invalid TEST_CHANNEL/);
});

for (const kind of ['body-timeout', 'socket-close', 'malformed-json', 'local-abort']) {
  test(`browser HTTP fixture ${kind} corrupts only the first ACK after real relay execution`, async t => {
    const { rooms, gate, url } = await fixture(t);
    const host = rooms.create(hello), guest = rooms.join(host.code, hello), receiver = rooms.authenticate(host.token);
    const body = JSON.stringify({ sequence: 1, messages: [{ type: 'resync', requestId: 'fixture-proof' }] });
    const fault = gate.fault = { kind, attempts: [] };
    const abort = new AbortController();
    const options = { method: 'POST', headers: { Authorization: `Bearer ${guest.token}`, 'Content-Type': 'application/json' }, body };
    const response = await fetch(`${url}/relay`, { ...options,
      signal: kind === 'body-timeout' ? AbortSignal.timeout(500) : abort.signal });
    assert.equal(response.status, 200);
    assert.equal(fault.headersSent, true);
    assert.equal(receiver.events.filter(event => event.type === 'peer-joined').length, 1);
    assert.deepEqual(receiver.events.filter(event => event.type === 'data').map(event => event.message), [{ type: 'resync', requestId: 'fixture-proof' }]);
    if (kind === 'local-abort') {
      const reader = response.body.getReader();
      assert.equal(new TextDecoder().decode((await reader.read()).value), '{');
      abort.abort();
      await assert.rejects(reader.read(), { name: 'AbortError' });
    } else if (kind === 'malformed-json') {
      assert.equal(await response.text(), '{', 'complete body, not a transport interruption');
    } else await assert.rejects(response.text(), { name: kind === 'body-timeout' ? 'TimeoutError' : 'TypeError' });
    assert.equal(fault.attempts.length, 1);
    assert.deepEqual(fault.attempts[0], { body, status: 200, acknowledgement: '{"ok":true}' });
    const retry = await fetch(`${url}/relay`, options);
    assert.deepEqual(await retry.json(), { ok: true });
    assert.equal(fault.attempts.length, 2);
    assert.equal(fault.attempts[1].body, body);
    assert.equal(receiver.events.filter(event => event.type === 'data').length, 1, 'Server deduplicates a repeated sequence');
  });
}

test('browser HTTP fixture delivers contradictory structured error text and a complete malformed poll body', async t => {
  const { gate, url } = await fixture(t);
  gate.mode = 'structured-open';
  const response = await fetch(`${url}/rooms/QQQQQQ/join`, { method: 'POST' });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: 'Failed to fetch', failure: {
    code: 'ROOM_FULL', category: 'connection', retryable: true, message: 'Failed to fetch'
  } });
  gate.mode = 'malformed-events';
  const poll = await fetch(`${url}/events?after=0`);
  assert.equal(poll.status, 200);
  assert.equal(await poll.text(), '{');
});
