import test from 'node:test';
import assert from 'node:assert/strict';

test('real Offscreen routes export/delete, records lifecycle hooks and rejects content-script callers', async t => {
  const original = globalThis.chrome;
  let listener;
  const secret = 'PRIVATE_MEDIA_AND_ROOM_IDENTIFIER';
  globalThis.chrome = { runtime: {
    id: 'diagnostics-test', getURL: path => `chrome-extension://diagnostics-test/${path}`,
    onMessage: { addListener(fn) { listener = fn; } },
    async sendMessage(message) {
      if (message.target === 'session-observers') return;
      const sample = { mediaId: secret, playerId: secret, bindingId: secret, time: 0, duration: 120,
        paused: true, buffering: false, adapter: 'HTML5' };
      return { ok: true, result: message.action === 'attach' ? { sample, documentId: secret, playerId: secret } : sample };
    }
  } };
  t.after(() => { globalThis.chrome = original; });
  await import('../extension/offscreen.js');
  const send = action => new Promise(resolve => listener({ target: 'offscreen', ...action },
    { id: 'diagnostics-test', url: 'chrome-extension://diagnostics-test/popup.html' }, resolve));
  await send({ action: 'attach', tabId: 1 });
  const exported = await send({ action: 'diagnostics-export', appVersion: '0.5.0', engineVersion: '0.5.0' });
  assert.equal(exported.ok, true);
  assert.ok(exported.result.events.some(event => event.kind === 'phase'));
  assert.ok(exported.result.events.some(event => event.adapter === 'html5'));
  assert.equal(JSON.stringify(exported).includes(secret), false);
  assert.equal(exported.result.protocol, 3);
  assert.equal((await send({ action: 'status' })).result.diagnosticsAvailable, true);
  let responded = false;
  listener({ target: 'offscreen', action: 'diagnostics-clear' },
    { id: 'diagnostics-test', tab: { id: 1 }, url: 'https://untrusted.invalid' }, () => { responded = true; });
  assert.equal(responded, false);
  assert.ok((await send({ action: 'diagnostics-export' })).result.events.length > 0);
  assert.deepEqual(await send({ action: 'diagnostics-clear' }), { ok: true, result: { cleared: true } });
  assert.deepEqual((await send({ action: 'diagnostics-export' })).result.events, []);
});
