// Uses a generated local tone and an isolated test-only tabCapture grant.
// Does not visit or make compatibility claims about streaming providers.
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer as httpServer } from 'node:http';
import { createServer } from '../server/index.js';

import { chromium, evidence } from './browser-test-context.js';
import { extensionApi } from './browser-test-api.js';
const root = await mkdtemp(join(tmpdir(), 'video-sync-channels-'));
const extension = join(root, 'extension');
const errors = [], passed = [];
let context;
const relay = createServer();
let media;
const wait = async (label, check, timeout = 15000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(`Timeout: ${label}`);
};
const record = async (label, run) => { await run(); passed.push(label); console.log(`PASS ${label}`); };
try {
  await cp(resolve(process.env.TEST_EXTENSION || 'extension'), extension, { recursive: true });
  const manifest = JSON.parse(await readFile(join(extension, 'manifest.json')));
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'der' });
  manifest.key = key.toString('base64');
  manifest.permissions.push('tabCapture');
  manifest.optional_permissions = [];
  const extensionId = [...createHash('sha256').update(key).digest('hex').slice(0, 32)].map(digit => String.fromCharCode(97 + parseInt(digit, 16))).join('');
  await writeFile(join(extension, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(join(extension, 'test-controller.html'), '<!doctype html><title>Test controller</title>');
  const tonePath = join(root, 'tone.webm');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=green:s=320x180:r=12',
    '-f', 'lavfi', '-i', 'sine=frequency=523.25:sample_rate=48000', '-t', '20', '-c:v', 'libvpx-vp9', '-c:a', 'libopus', tonePath]);
  const tone = await readFile(tonePath);
  media = httpServer((request, response) => {
    if (request.url === '/tone.webm') response.writeHead(200, { 'Content-Type': 'video/webm' }).end(tone);
    else response.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><title>Local audio fixture</title><video controls loop src="/tone.webm" width="400"></video>');
  });
  await Promise.all([new Promise(resolve => relay.listen(0, '127.0.0.1', resolve)), new Promise(resolve => media.listen(0, '127.0.0.1', resolve))]);
  const base = `http://127.0.0.1:${media.address().port}`;
  const relayBase = `http://127.0.0.1:${relay.address().port}`;
  context = await chromium.launchPersistentContext(join(root, 'profile'), {
    headless: true, viewport: { width: 360, height: 600 },
    ignoreDefaultArgs: ['--mute-audio'],
    ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : { channel: 'chromium' }),
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, `--allowlisted-extension-id=${extensionId}`, '--autoplay-policy=no-user-gesture-required']
  });
  context.on('page', page => {
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', entry => { if (['warning', 'error'].includes(entry.type())) errors.push(`${entry.type()}: ${entry.text()}`); });
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  assert.equal(new URL(worker.url()).hostname, extensionId);
  const video = await context.newPage(); await video.goto(base);
  await video.waitForFunction(() => document.querySelector('video').readyState >= 3);
  const popupUrl = `chrome-extension://${extensionId}/popup.html`;
  let popup = await context.newPage(); await popup.goto(popupUrl);
  assert.equal(popup.url(), popupUrl); assert.equal(await popup.title(), 'Video Sync');
  assert.equal(await popup.getByRole('heading', { name: 'Video Sync', exact: true }).isVisible(), true);
  const controller = await context.newPage(); await controller.goto(`chrome-extension://${extensionId}/test-controller.html`);
  const api = extensionApi(controller);
  const tabId = await worker.evaluate(async base => (await chrome.tabs.query({})).find(tab => tab.url?.startsWith(base)).id, base);
  const contexts = () => worker.evaluate(() => chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }));
  await mkdir(evidence, { recursive: true });
  const profile = JSON.parse(await readFile(join(extension, 'build-info.json'), 'utf8')).channel;
  const audio = profile !== 'stable';
  const runtimeDocument = `chrome-extension://${extensionId}/offscreen.html`;
  await record(`${profile} package: Stable is the default release stream and the package profile decides diagnostics`, async () => {
    assert.equal((await api('status')).channel, 'stable');
    assert.equal((await contexts())[0].documentUrl, runtimeDocument);
    await popup.locator('#open-settings').click();
    assert.equal(await popup.locator('#capture-lab').isVisible(), audio);
    if (!audio) await assert.rejects(api('lab-start'), /nur in Experimental/);
  });
  await record(`${profile} package: the settings switch persists the release stream without replacing the runtime`, async () => {
    await popup.locator('#release-channel').selectOption('experimental');
    await wait('experimental selected', async () => (await api('status')).channel === 'experimental');
    assert.equal((await contexts()).length, 1);
    assert.equal((await contexts())[0].documentUrl, runtimeDocument);
    await popup.reload(); await popup.locator('#open-settings').click();
    assert.equal(await popup.locator('#release-channel').inputValue(), 'experimental');
    assert.equal(await popup.locator('#capture-lab').isVisible(), audio, 'features follow the package, not the selection');
    if (audio) await popup.locator('#capture-lab > summary').click();
    await popup.locator('body').screenshot({ path: join(evidence, `channels-${profile}-experimental-selected.png`) });
    assert.ok(await popup.evaluate(() => document.documentElement.scrollWidth <= 360));
  });
  await record(`${profile} package: an active room stays connected while the release stream changes`, async () => {
    await api('attach', { tabId }); const created = await api('create', { server: relayBase });
    const switched = await api('set-channel', { channel: 'stable' });
    assert.equal(switched.channel, 'stable');
    assert.equal(switched.room?.code, created.room.code);
    assert.equal(switched.local?.mediaId, created.local?.mediaId);
    assert.equal(await popup.locator('#release-channel').isDisabled(), false);
    await assert.rejects(api('lab-start'), audio ? /Raumbeitritt|Raum durchführen/ : /nur in Experimental/);
    await api('leave');
  });
  if (audio) {
    const play = async () => { await video.bringToFront(); await video.evaluate(async () => { const v = document.querySelector('video'); v.muted = false; await v.play(); });
      await wait('player playing', async () => !(await api('status')).local.paused); };
    await record('real tab audio passes through the worklet and stops after eight seconds with the popup closed', async () => {
      await api('attach', { tabId });
      await play(); await api('lab-start'); await popup.close();
      await wait('capture finished', async () => !(await api('status')).lab.running);
      const result = (await api('status')).lab;
      console.log(JSON.stringify({ diagnostic: result }));
      assert.equal(result.outcome, 'signal'); assert.ok(result.duration >= 3);
      assert.equal((await worker.evaluate(() => chrome.tabCapture.getCapturedTabs())).some(tab => tab.status === 'active'), false);
      assert.equal(await video.evaluate(() => document.querySelector('video').paused), false);
      popup = await context.newPage(); await popup.goto(`chrome-extension://${extensionId}/popup.html`);
      await popup.locator('#open-settings').click();
      await popup.locator('#capture-lab > summary').click();
      await popup.locator('#lab-status').scrollIntoViewIfNeeded();
      await popup.locator('body').screenshot({ path: join(evidence, 'channels-signal.png') });
    });
    await record('connecting a video again cancels a live capture', async () => {
      await play(); await api('lab-start');
      await wait('capture active', async () => (await api('status')).lab.outcome === 'capturing');
      const status = await api('attach', { tabId });
      assert.notEqual(status.lab?.outcome, 'capturing');
      assert.equal((await worker.evaluate(() => chrome.tabCapture.getCapturedTabs())).some(tab => tab.status === 'active'), false);
    });
  }
  assert.deepEqual(errors, []);
  await writeFile(join(evidence, 'channels.json'), JSON.stringify({ passed, errors, popupUrl, title: await popup.title(), viewport: { width: 360, height: 600 },
    captureGrant: 'test-only allowlisted extension; native permission dialog not tested', providers: 'not tested' }, null, 2));
  console.log(`Evidence: ${evidence}`);
} finally {
  await context?.close();
  for (const server of [relay, media].filter(Boolean)) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
