import assert from 'node:assert/strict';
import { PROTOCOL, CAPABILITIES } from '../extension/protocol.js';

// Each package has one runtime; the selected channel only names the release stream.
export function errorTestChannels(selected = '') {
  assert.ok(['stable', 'experimental'].includes(selected), `Invalid TEST_CHANNEL: ${selected}`);
  return [selected];
}

export async function browserErrorContracts({ popup, channel, server, gate, rooms, api, rawApi, record, until }) {
  await record(`${channel}: HTTP code survives worker/offscreen/background and drives popup text`, async () => {
    gate.mode = 'structured-open';
    const response = await rawApi('join', { server, code: 'QQQQQQ' });
    assert.equal(response.ok, false);
    assert.equal(response.failure.code, 'ROOM_FULL');
    assert.equal(response.failure.category, 'room');
    assert.equal(response.failure.retryable, false);
    assert.equal(response.failure.status, 409);
    assert.equal(response.error, response.failure.message);
    assert.doesNotMatch(response.error, /Failed to fetch/);
    assert.equal((await api('status')).room, null);
    await popup.locator('#code').fill('QQQQQQ'); await popup.locator('#join').click();
    await popup.locator('#room-error').waitFor({ state: 'visible' });
    assert.equal(await popup.locator('#room-error-title').textContent(), 'Dieser Raum ist voll');
    assert.equal(await popup.locator('#room-error-server').isVisible(), false);
    await popup.locator('#room-error-dismiss').click();
  });
  await record(`${channel}: malformed poll body reaches the session notice as fatal INVALID_RESPONSE`, async () => {
    gate.mode = 'malformed-events';
    await api('create', { server });
    await popup.locator('#error-panel').waitFor({ state: 'visible' });
    const status = await api('status');
    assert.equal(status.noticeError.code, 'INVALID_RESPONSE');
    assert.equal(status.noticeError.category, 'protocol');
    assert.equal(status.noticeError.retryable, false);
    assert.equal(status.notice, status.noticeError.message);
    assert.equal(status.room, null);
    assert.equal(await popup.locator('#error').textContent(), status.notice);
    await popup.locator('#error-dismiss').click();
  });
  gate.mode = 'online';
  for (const kind of ['body-timeout', 'socket-close', 'malformed-json', 'local-abort']) {
    await record(`${channel}: packaged browser worker relay ${kind}`, async () => {
      const host = rooms.create({ protocol: PROTOCOL, capabilities: [...CAPABILITIES] }), receiver = rooms.authenticate(host.token);
      // Rooms.close replaces the queue; retain the original delivery ledger for local abort.
      const deliveries = receiver.events;
      const fault = gate.fault = { kind, attempts: [], headersSent: false, bodyClosed: false };
      // Exercise the unmodified packaged Worker with a durable resync command.
      // The Node peer keeps its queue unread so duplicate execution is observable.
      try {
        await popup.evaluate(({ server, code }) => {
          const events = [];
          const worker = new Worker(chrome.runtime.getURL('connection-worker.js'), { type: 'module' });
          window.errorProbe = { worker, events };
          worker.onmessage = ({ data }) => {
            if (data.type === 'opened') {
              // Never copy bearer tokens into evidence.
              events.push({ type: 'opened' });
              worker.postMessage({ type: 'send', message: { type: 'resync', requestId: 'browser-body-error' } });
            } else events.push(data);
          };
          worker.onerror = event => events.push({ type: 'worker-error', message: event.message });
          worker.postMessage({ type: 'open', server, code });
        }, { server, code: host.code });
        const events = () => popup.evaluate(() => window.errorProbe.events);
        await until('relay delivered before interrupted acknowledgement', () => fault.headersSent);
        if (kind === 'local-abort') {
          await popup.evaluate(() => window.errorProbe.worker.postMessage({ type: 'close' }));
          await until('browser cancelled body and left room', () => fault.bodyClosed && !rooms.rooms.has(host.code));
        } else if (kind === 'malformed-json') {
          await until('fatal worker error', async () => (await events()).some(event => event.type === 'error'));
          const failures = (await events()).filter(event => event.type === 'error');
          assert.equal(failures.length, 1);
          assert.equal(failures[0].failure.code, 'INVALID_RESPONSE');
          assert.equal(failures[0].failure.category, 'protocol');
          assert.equal(failures[0].failure.retryable, false);
          assert.equal(failures[0].error, failures[0].failure.message);
        } else {
          await until('identical batch recovered', () => fault.attempts.length === 2);
          // Let the worker receive the second acknowledgement before inspecting its events.
          await new Promise(resolve => setTimeout(resolve, 300));
          assert.equal(fault.attempts[0].body, fault.attempts[1].body);
        }
        const observed = await events();
        assert.deepEqual(observed.filter(event => event.type === 'worker-error'), []);
        const sendStates = observed.filter(event => event.type === 'status' && event.lane === 'send').map(event => event.reconnecting);
        const recovered = ['body-timeout', 'socket-close'].includes(kind);
        // A single interrupted acknowledgement is retried within the reconnect
        // grace period, so it never reports the lane as reconnecting.
        assert.deepEqual(sendStates, []);
        if (kind !== 'malformed-json') assert.deepEqual(observed.filter(event => event.type === 'error'), []);
        assert.equal(fault.attempts.length, recovered ? 2 : 1);
        for (const attempt of fault.attempts) {
          assert.equal(attempt.status, 200);
          assert.deepEqual(JSON.parse(attempt.acknowledgement), { ok: true });
          assert.equal(JSON.parse(attempt.body).sequence, 1);
        }
        assert.deepEqual(deliveries.filter(event => event.type === 'data').map(event => event.message),
          [{ type: 'resync', requestId: 'browser-body-error' }], 'Lost ACK must not execute resync twice');
      } finally {
        try {
          await popup.evaluate(() => window.errorProbe?.worker.postMessage({ type: 'close' }));
          await until('probe room closed', () => !rooms.rooms.has(host.code));
        } finally {
          await popup.evaluate(() => { window.errorProbe?.worker.terminate(); delete window.errorProbe; });
          if (rooms.rooms.has(host.code)) rooms.close(rooms.rooms.get(host.code));
          gate.fault = null;
        }
      }
    });
  }
}
