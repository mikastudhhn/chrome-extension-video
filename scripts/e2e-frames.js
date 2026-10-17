import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, basename } from 'node:path';

import { chromium, evidence, selectChannel } from './browser-test-context.js';
import { extensionApi } from './browser-test-api.js';
const base = process.env.TEST_SERVER || 'http://127.0.0.1:8787';
const extension = resolve(process.env.TEST_EXTENSION || 'extension');
const wrapperOrigin = 'https://wrapper.video-sync.test';
const playerOrigin = 'https://player.video-sync.test';
const origins = [`${playerOrigin}/*`, `${wrapperOrigin}/*`];
const contexts = [], profiles = [], passed = [];

async function until(description, check, timeout = 10_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timeout: ${description}`);
}

async function record(name, test) {
  await test(); passed.push(name); console.log(`PASS ${name}`);
}

async function openBrowser(embedded, grantFrameAccess = false) {
  const profile = await mkdtemp(join(tmpdir(), 'video-sync-frames-'));
  profiles.push(profile);
  let extensionPath = extension;
  if (grantFrameAccess) {
    // Headless Chrome cannot accept its native permission dialog. Load the same code
    // with only these fixture origins granted; exercise the ungranted popup separately.
    extensionPath = join(profile, 'extension');
    await cp(extension, extensionPath, { recursive: true });
    const manifest = JSON.parse(await readFile(join(extensionPath, 'manifest.json'), 'utf8'));
    manifest.host_permissions.push(...(grantFrameAccess === 'all' ? ['http://*/*', 'https://*/*'] : origins));
    await writeFile(join(extensionPath, 'manifest.json'), JSON.stringify(manifest));
  }
  const context = await chromium.launchPersistentContext(profile, {
    headless: true,
    ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : { channel: 'chromium' }),
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    viewport: { width: 1200, height: 850 }
  });
  contexts.push(context);
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).hostname;
  if (embedded) {
    const frameHtml = source => `<!doctype html><title>Embedded video fixture</title><iframe src="${source}" style="width:100%;height:800px;border:0" allow="autoplay"></iframe>`;
    await context.route(`${base}/frame-test`, route => route.fulfill({ contentType: 'text/html', body: frameHtml(`${wrapperOrigin}/embed`) +
      `<iframe src="${base}/hidden-frame" style="display:none"></iframe><iframe src="https://hidden.video-sync.test/embed" style="display:none"></iframe>` }));
    await context.route(`${base}/hidden-frame`, route => route.fulfill({ contentType: 'text/html', body:
      `<video width="2000" height="2000" muted preload="auto" src="${base}/scene-a.webm"></video>` }));
    await context.route('https://hidden.video-sync.test/**', route => route.fulfill({ contentType: 'text/html', body: '<p>Hidden non-player frame</p>' }));
    await context.route(`${wrapperOrigin}/**`, route => route.fulfill({ contentType: 'text/html', body: frameHtml(`${playerOrigin}/`) }));
    await context.route(`${playerOrigin}/**`, async route => {
      const path = new URL(route.request().url()).pathname;
      const file = path === '/' ? 'index.html' : basename(path);
      if (!['index.html', 'style.css', 'demo.js', 'scene-a.webm', 'scene-b.webm'].includes(file)) return route.fulfill({ status: 404 });
      const contentType = file.endsWith('.webm') ? 'video/webm' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html';
      const data = await readFile(`demo/${file}`);
      const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range || '');
      if (range) {
        const start = Number(range[1]), end = range[2] ? Math.min(Number(range[2]), data.length - 1) : data.length - 1;
        return route.fulfill({ status: 206, contentType, body: data.subarray(start, end + 1),
          headers: { 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${data.length}` } });
      }
      await route.fulfill({ contentType, body: data, headers: { 'Accept-Ranges': 'bytes' } });
    });
  }
  const page = await context.newPage();
  await page.goto(embedded ? `${base}/frame-test` : base);
  const video = embedded ? page.frames().find(frame => frame.url().startsWith(playerOrigin)) : page;
  assert.ok(video, 'Nested player document loaded');
  await video.waitForFunction(() => document.querySelector('video')?.readyState >= 3);
  if (embedded) {
    await video.getByRole('button', { name: 'Version B · +5 Sekunden', exact: true }).click();
    await video.waitForFunction(() => document.querySelector('video').currentSrc.endsWith('/scene-b.webm') && document.querySelector('video').readyState >= 3);
  }
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await popup.waitForFunction(() => document.querySelector('main')?.getAttribute('aria-busy') === 'false');
  await selectChannel(popup);
  const tabId = await popup.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url).id, page.url());
  const message = (type, extra) => popup.evaluate(args => chrome.runtime.sendMessage({ target: 'background', ...args }), { type, ...extra });
  const api = extensionApi(popup);
  return { context, page, video, popup, tabId, message, api };
}

const time = browser => browser.video.evaluate(() => ({ time: document.querySelector('video').currentTime, paused: document.querySelector('video').paused, ready: document.querySelector('video').readyState >= 3 && !document.querySelector('video').seeking }));

try {
  const host = await openBrowser(false);
  const ungranted = await openBrowser(true);
  await record('visible player requires site access; hidden videos and unrelated hidden domains are ignored', async () => {
    const discovery = await ungranted.message('discover-player', { tabId: ungranted.tabId });
    assert.equal(discovery.ok, true);
    assert.equal(discovery.result.documentId, null);
    assert.deepEqual(discovery.result.missingOrigins, [`${wrapperOrigin}/*`]);
    await assert.rejects(ungranted.api('attach', { tabId: ungranted.tabId }), /Zugriff/);
    assert.equal((await ungranted.api('status')).local, null);
  });
  await record('popup identifies the embedded domains that need permission', async () => {
    // The real popup resolves the active video tab. Keep it active while driving the popup DOM.
    await ungranted.page.bringToFront();
    await ungranted.popup.locator('#attach').dispatchEvent('click');
    await ungranted.popup.locator('#allow-player').waitFor({ state: 'visible' });
    assert.match(await ungranted.popup.locator('#frame-access-description').textContent(), /wrapper.video-sync.test/);
    assert.doesNotMatch(await ungranted.popup.locator('#frame-access-description').textContent(), /player.video-sync.test/);
    assert.equal((await ungranted.api('status')).local, null);
  });
  await ungranted.context.close();
  const guest = await openBrowser(true, true);
  await record('a granted nested player connects without a video in the top document', async () => {
    await guest.page.bringToFront();
    await guest.popup.locator('#attach').dispatchEvent('click');
    await until('nested player attached', async () => (await guest.api('status')).local?.adapter === 'HTML5');
    const permissions = await guest.popup.evaluate(() => chrome.permissions.getAll());
    for (const origin of origins) assert.ok(permissions.origins.includes(origin));
    assert.ok(!permissions.origins.includes('https://*/*'));
    assert.equal(await guest.page.evaluate(() => document.querySelectorAll('video').length), 0);
  });
  await record('one broad grant automatically discovers nested players when the popup opens', async () => {
    const automatic = await openBrowser(true, 'all');
    // Keep the video tab active while the extension page loads, as in a real popup.
    await automatic.page.bringToFront();
    await automatic.popup.reload();
    await until('automatic nested attach', async () => (await automatic.api('status')).local?.adapter === 'HTML5');
    assert.equal(await automatic.popup.locator('#allow-all').isVisible(), false);
    assert.equal(await automatic.popup.locator('#allow-player').isVisible(), false);
    const first = (await automatic.api('status')).tabId;
    await automatic.popup.reload();
    assert.equal((await automatic.api('status')).tabId, first);
    assert.equal(await automatic.popup.locator('#allow-player').isVisible(), false);
    await automatic.context.close();
  });
  await host.api('attach', { tabId: host.tabId });
  const room = await host.api('create', { server: base });
  await guest.api('join', { server: base, code: room.room.code });
  await until('connected', async () => (await host.api('status')).room?.connected && (await guest.api('status')).room?.connected);
  await host.video.evaluate(() => { document.querySelector('video').currentTime = 5; });
  await guest.video.evaluate(() => { document.querySelector('video').currentTime = 10; });
  await until('seek settled at both anchors', async () => (await time(host)).ready && (await time(guest)).ready &&
    Math.abs((await time(host)).time - 5) < 0.1 && Math.abs((await time(guest)).time - 10) < 0.1);
  await host.api('ready'); await guest.api('ready');
  await until('aligned', async () => (await host.api('status')).room.state.phase === 'synced');
  await record('play, native pause and seek synchronize with a nested cross-origin video', async () => {
    await host.api('control', { control: 'play' });
    await until('both play', async () => !(await time(host)).paused && !(await time(guest)).paused);
    await guest.video.evaluate(() => document.querySelector('video').pause());
    await until('both pause', async () => (await time(host)).paused && (await time(guest)).paused);
    await guest.video.evaluate(() => { document.querySelector('video').currentTime = 25; });
    try {
      await until('nested seek reaches host', async () => Math.abs((await time(host)).time - 20) < 0.4);
    } catch (error) {
      console.error('Host', await time(host), JSON.stringify(await host.api('status')));
      console.error('Guest', await time(guest), JSON.stringify(await guest.api('status')));
      throw error;
    }
    await host.video.evaluate(() => { document.querySelector('video').currentTime = 12; });
    await until('host seek reaches nested video', async () => Math.abs((await time(guest)).time - 17) < 0.4);
  });
  await record('iframe navigation pauses the peer and never attaches the replacement automatically', async () => {
    await host.api('control', { control: 'play' });
    await until('playing before navigation', async () => !(await time(host)).paused && !(await time(guest)).paused);
    await guest.video.goto(`${playerOrigin}/?replacement`);
    await guest.video.waitForFunction(() => document.querySelector('video').readyState >= 3);
    await until('peer paused and alignment cleared', async () => (await time(host)).paused && (await host.api('status')).room.state.phase === 'aligning' && !(await guest.api('status')).local);
    assert.equal((await time(guest)).paused, true);
    assert.equal(await guest.video.evaluate(() => Boolean(window.__videoSyncPlayer)), false);
    await guest.api('attach', { tabId: guest.tabId });
    await until('reconnect epoch received', async () => !(await guest.api('status')).room.resetting);
    assert.equal((await host.api('status')).room.state.phase, 'aligning');
    assert.deepEqual((await host.api('status')).room.state.anchors, {});
  });
  await guest.api('leave');
  await mkdir(evidence, { recursive: true });
  await writeFile(join(evidence, 'e2e-frames.json'), JSON.stringify({ passed }, null, 2));
} finally {
  for (const context of contexts) await context.close();
  for (const profile of profiles) await rm(profile, { recursive: true, force: true });
}
