// Real MV3 requests cross a local HTTP boundary; no fetch mocks in the extension.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from '../server/index.js';
import { Rooms } from '../server/rooms.js';

import { chromium, evidence } from './browser-test-context.js';
import { extensionApi, sendUiMessage } from './browser-test-api.js';
import { errorGate } from './browser-error-gate.js';
import { errorTestChannels, browserErrorContracts } from './browser-error-contracts.js';
const channels = errorTestChannels(process.env.TEST_CHANNEL);
const profile = await mkdtemp(join(tmpdir(), 'video-sync-errors-'));
const rooms = new Rooms();
const relay = createServer({ rooms });
const errors = [], consoleErrors = [], passed = [];
let context, gate, base;
const until = async (label, check) => {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(`Timeout: ${label}`);
};
const record = async (label, run) => { await run(); passed.push(label); console.log(`PASS ${label}`); };
try {
  await new Promise(resolve => relay.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${relay.address().port}`;
  gate = errorGate(base);
  await new Promise(resolve => gate.server.listen(0, '127.0.0.1', resolve));
  const server = `http://127.0.0.1:${gate.server.address().port}`;
  const extension = resolve(process.env.TEST_EXTENSION || 'extension');
  const build = JSON.parse(await readFile(join(extension, 'build-info.json'), 'utf8'));
  const runtimeCoverage = channels.map(channel => ({ channel, profile: build.channel }));
  context = await chromium.launchPersistentContext(profile, {
    headless: true, viewport: { width: 360, height: 600 },
    ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : { channel: 'chromium' }),
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
  });
  context.on('page', page => {
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', entry => { if (['warning', 'error'].includes(entry.type())) consoleErrors.push({ text: entry.text(), url: entry.location().url }); });
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).hostname;
  const video = await context.newPage(); await video.goto(base);
  await video.waitForFunction(() => document.querySelector('video').readyState >= 3);
  const popup = await context.newPage(); await popup.goto(`chrome-extension://${id}/popup.html`);
  assert.equal(await popup.title(), 'Video Sync');
  await until('initial render', async () => await popup.locator('main').getAttribute('aria-busy') === 'false');
  const rawApi = (action, extra = {}) => sendUiMessage(popup, action, extra);
  const api = extensionApi(popup);
  const tabId = await popup.evaluate(async base => (await chrome.tabs.query({})).find(tab => tab.url === `${base}/`).id, base);
  await mkdir(evidence, { recursive: true });
  for (const { channel } of runtimeCoverage) {
    await api('set-channel', { channel }); await api('attach', { tabId });
    await popup.reload();
    await popup.locator('#lobby').waitFor({ state: 'visible' });
    await popup.locator('#open-settings').click(); await popup.locator('#server').fill(server);
    if (await popup.locator('#server-save').isEnabled()) {
      await popup.locator('#server-save').click();
      await popup.waitForFunction(() => document.getElementById('server-feedback').textContent === 'Serveradresse gespeichert.');
    }
    await popup.locator('#settings-back').click();
    gate.mode = 'offline';
    await record(`${channel}: failed create stays in place, names the server and offers retry`, async () => {
      await popup.locator('#create').click();
      await popup.locator('#room-error').waitFor({ state: 'visible' });
      assert.equal(await popup.locator('#settings').isVisible(), false);
      assert.equal(await popup.locator('#create').textContent(), 'Erneut versuchen');
      assert.match(await popup.locator('#room-error-title').textContent(), /Lokaler Server nicht erreichbar/);
      assert.ok((await popup.locator('#room-error-detail').textContent()).includes(new URL(server).host));
      assert.equal(await popup.locator('#create-feedback #room-error').count(), 1);
      assert.equal(await popup.locator('#error-panel').isVisible(), false);
      assert.equal((await api('status')).notice, '');
      assert.equal((await api('status')).room, null);
      await popup.locator('body').screenshot({ path: join(evidence, `${channel}-server-unreachable.png`) });
      const size = await popup.evaluate(() => ({ width: document.documentElement.scrollWidth, height: document.body.getBoundingClientRect().height }));
      assert.ok(size.width <= 360 && size.height <= 600);
    });
    await record(`${channel}: settings opens only on request and old errors stay cleared after back/reopen`, async () => {
      await popup.locator('#room-error-server').click();
      assert.equal(await popup.locator('#settings').isVisible(), true);
      assert.equal(await popup.evaluate(() => document.activeElement.id), 'server');
      await popup.locator('#settings-back').click();
      assert.equal(await popup.locator('#room-error').isVisible(), false);
      await popup.reload();
      await until('reopened', async () => await popup.locator('main').getAttribute('aria-busy') === 'false');
      assert.equal(await popup.locator('#error-panel').isVisible(), false);
      assert.equal(await popup.locator('#room-error').isVisible(), false);
      assert.doesNotMatch(await popup.locator('body').innerText(), /Failed to fetch/);
    });
    await record(`${channel}: join failures stay by the invitation and clear when it is edited`, async () => {
      await popup.locator('#code').fill('QQQQQQ'); await popup.locator('#join').click();
      await popup.locator('#room-error').waitFor({ state: 'visible' });
      assert.equal(await popup.locator('#join-feedback #room-error').count(), 1);
      assert.equal(await popup.locator('#code').inputValue(), 'QQQQQQ');
      assert.equal(await popup.locator('#settings').isVisible(), false);
      await popup.locator('#code').fill('mnopqrstuvwx');
      assert.equal(await popup.locator('#room-error').isVisible(), false);
    });
    await record(`${channel}: dismiss and successful retry remove every trace of a failed action`, async () => {
      await popup.locator('#create').click(); await popup.locator('#room-error').waitFor({ state: 'visible' });
      await popup.locator('#room-error-dismiss').click();
      assert.equal(await popup.locator('#room-error').isVisible(), false);
      await popup.locator('#create').click(); await popup.locator('#room-error').waitFor({ state: 'visible' });
      gate.mode = 'online'; await popup.locator('#create').click();
      await popup.locator('#copy').waitFor({ state: 'visible' });
      assert.equal(await popup.locator('#room-error').isVisible(), false);
      assert.equal(await popup.locator('#error-panel').isVisible(), false);
      assert.equal((await api('status')).room.server, server);
      await popup.locator('body').screenshot({ path: join(evidence, `${channel}-recovered.png`) });
      await api('leave'); await popup.locator('#lobby').waitFor({ state: 'visible' });
    });
    await record(`${channel}: an expired room asks for a new invitation, not a server change`, async () => {
      await popup.locator('#code').fill('QQQQQQ'); await popup.locator('#join').click();
      await popup.locator('#room-error').waitFor({ state: 'visible' });
      assert.equal(await popup.locator('#room-error-title').textContent(), 'Raum nicht gefunden');
      assert.equal(await popup.locator('#room-error-server').isVisible(), false);
      await popup.locator('#room-error-invitation').click();
      assert.equal(await popup.evaluate(() => document.activeElement.id), 'code');
      assert.equal(await popup.locator('#room-error').isVisible(), false);
    });
    await record(`${channel}: a delayed failure does not follow the user to another page`, async () => {
      gate.mode = 'slow-failure'; await popup.locator('#create').click();
      await popup.locator('#open-settings').click();
      await until('failure completed', async () => await popup.locator('main').getAttribute('aria-busy') === 'false');
      assert.equal(await popup.locator('#error-panel').isVisible(), false);
      await popup.locator('#settings-back').click();
      assert.equal(await popup.locator('#room-error').isVisible(), false);
      assert.equal((await api('status')).notice, '');
    });
    await record(`${channel}: dismissed session notices stay dismissed, but new notices still appear`, async () => {
      gate.mode = 'online';
      for (let attempt = 0; attempt < 2; attempt++) {
        const created = await api('create', { server });
        await popup.locator('#copy').waitFor({ state: 'visible' });
        rooms.close(rooms.rooms.get(created.room.code));
        await popup.locator('#error-panel').waitFor({ state: 'visible' });
        assert.match(await popup.locator('#error').textContent(), /Raum wurde beendet|Sitzung ist beendet/);
        await popup.locator('#error-dismiss').click();
        await popup.locator('#error-panel').waitFor({ state: 'hidden' });
        assert.equal((await api('status')).notice, '');
        await popup.reload();
        await until('notice remains dismissed', async () => await popup.locator('main').getAttribute('aria-busy') === 'false');
        assert.equal(await popup.locator('#error-panel').isVisible(), false);
      }
    });
    await browserErrorContracts({ popup, channel, server, gate, rooms, api, rawApi, record, until });
  }
  assert.deepEqual(errors, []);
  const unexpectedConsoleErrors = consoleErrors.filter(entry => !(entry.url === `${base}/favicon.ico` && entry.text.includes('404')));
  assert.deepEqual(unexpectedConsoleErrors, []);
  await writeFile(join(evidence, 'results.json'), JSON.stringify({ build, runtimeCoverage, passed, pageErrors: errors, consoleErrors, url: popup.url(), title: await popup.title(), viewport: { width: 360, height: 600 } }, null, 2));
  console.log(`Evidence: ${evidence}`);
} finally {
  await context?.close();
  for (const server of [gate?.server, relay].filter(Boolean)) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
