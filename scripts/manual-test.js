// Opens two isolated profiles, either freshly installed or connected and aligned.
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createServer } from '../server/index.js';
import { PROTOCOL } from '../extension/protocol.js';

const localSetting = name => spawnSync('git', ['config', '--local', '--get', name], { encoding: 'utf8' }).stdout?.trim();
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || localSetting('videosync.playwrightModule') || 'playwright');
const executablePath = process.env.CHROMIUM_EXECUTABLE || localSetting('videosync.chromiumExecutable');
const contexts = [], profiles = [], closed = [];
let server, cleaning;
const fresh = process.env.TEST_MODE === 'fresh';
const channel = process.env.TEST_CHANNEL || 'stable';
if (!['stable', 'experimental'].includes(channel)) throw new Error('TEST_CHANNEL muss stable oder experimental sein.');
const view = process.env.TEST_VIEW || 'popup';
let extension, temporaryExtension, expectedVersion;
let base = process.env.TEST_SERVER;
if (!base) {
  server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
}

async function until(description, check, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`Timeout: ${description}`);
}

async function openProfile(label, version, x) {
  const profile = await mkdtemp(join(tmpdir(), 'video-sync-manual-'));
  profiles.push(profile);
  const context = await chromium.launchPersistentContext(profile, {
    headless: false,
    ...(executablePath ? { executablePath } : { channel: 'chromium' }),
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
      `--window-position=${x},50`, '--window-size=700,850'],
    viewport: null
  });
  contexts.push(context);
  closed.push(new Promise(resolve => context.once('close', resolve)));
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  if (!fresh) await worker.evaluate(server => chrome.storage.local.set({ server, onboarding: { version: 1, step: 0, completedAt: 1, skipped: true } }), base);
  const id = new URL(worker.url()).hostname;
  const video = await context.newPage();
  await video.goto(base);
  if (version === 'b') await video.locator('#version-b').click();
  await video.waitForFunction(version => document.querySelector('video').currentSrc.endsWith(`scene-${version}.webm`) &&
    document.querySelector('video').readyState >= 3, version);
  await video.evaluate(label => { document.title = `Profil ${label} · Testvideo`; }, label);
  const controls = await context.newPage();
  await controls.goto(`chrome-extension://${id}/popup.html`);
  await controls.evaluate(label => { document.title = `Profil ${label} · Video Sync`; }, label);
  const tabId = await controls.evaluate(async base => (await chrome.tabs.query({})).find(tab => tab.url === `${base}/`).id, base);
  const api = async (action, extra = {}) => {
    const response = await controls.evaluate(message => chrome.runtime.sendMessage(message),
      { target: 'background', type: 'ui', action, ...extra });
    if (!response?.ok) throw new Error(response?.error || 'Extension did not respond');
    return response.result;
  };
  if (channel !== 'stable') await api('set-channel', { channel });
  const state = await api('status');
  assert.equal(state.channel, channel, `Profile ${label} loaded the wrong channel`);
  assert.equal(state.engineVersion, expectedVersion, `Profile ${label} loaded the wrong runtime version`);
  await until(`Versionsanzeige ${label}`, async () => await controls.locator('#channel-label').textContent() === (channel === 'stable' ? 'Stable' : 'Experimental'));
  if (!fresh) await api('attach', { tabId });
  for (const page of context.pages()) if (page.url() === 'about:blank') await page.close();
  return { video, controls, api, worker };
}

async function cleanup() {
  return cleaning ??= (async () => {
    for (const context of contexts) await context.close().catch(() => {});
    if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    // Chromium can finish a last profile write just after its window closes.
    for (const profile of profiles) await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    if (temporaryExtension) await rm(temporaryExtension, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  })();
}
process.once('SIGINT', () => { cleanup().then(() => process.exit()); });
process.once('SIGTERM', () => { cleanup().then(() => process.exit()); });

try {
  const health = await (await fetch(`${base}/health`)).json();
  if (health.protocol !== PROTOCOL) throw new Error(`Der Testserver benötigt Protokoll ${PROTOCOL}.`);
  // Default: a copy of the checked-out extension/ folder with the package profile
  // of TEST_CHANNEL, so experimental features follow the selected channel. A
  // released package can be tested by unpacking its ZIP and pointing
  // TEST_EXTENSION at video-sync/extension. Every session gets its own copy so
  // later edits cannot alter a running browser.
  temporaryExtension = await mkdtemp(join(tmpdir(), 'video-sync-test-extension-'));
  extension = join(temporaryExtension, 'extension');
  await cp(resolve(process.env.TEST_EXTENSION || 'extension'), extension, { recursive: true });
  const manifest = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8'));
  expectedVersion = manifest.version;
  if (!process.env.TEST_EXTENSION) {
    const build = JSON.parse(await readFile(join(extension, 'build-info.json'), 'utf8'));
    await writeFile(join(extension, 'build-info.json'), JSON.stringify({ ...build, channel }, null, 2) + '\n');
    manifest.version_name = `${manifest.version} · Test ${channel === 'stable' ? 'Stable' : 'Experimental'}`;
    await writeFile(join(extension, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  }
  await writeFile(join(extension, 'config.js'), `export const DEFAULT_SERVER = ${JSON.stringify(base)};\n`);
  const host = await openProfile('A', 'a', 0);
  const guest = await openProfile('B', 'b', 710);
  let created;
  const freshProfiles = [];
  if (fresh) {
    for (const [label, browser] of [['A', host], ['B', guest]]) {
      const initial = await browser.controls.evaluate(async () => ({
        saved: await chrome.storage.local.get(null),
        origins: (await chrome.permissions.getAll()).origins || [],
        allowed: await chrome.permissions.contains({ origins: ['https://*/*', 'http://*/*'] })
      }));
      const state = await browser.api('status');
      assert.deepEqual(initial.saved, channel === 'stable' ? {} : { channel }, `Profile ${label} has unexpected extension settings`);
      assert.equal(initial.allowed, false, `Profile ${label} already has broad website access`);
      assert.ok(initial.origins.every(origin => ['http://localhost/*', 'http://127.0.0.1/*'].includes(origin)),
        `Profile ${label} has unexpected site permissions`);
      assert.equal(state.local, null, `Profile ${label} already has a connected video`);
      assert.equal(state.room, null, `Profile ${label} already has a room`);
      freshProfiles.push({ profile: label, emptyStorage: channel === 'stable', websitePermissionGranted: false, videoConnected: false, roomJoined: false });
      await browser.controls.close();
    }
  } else {
    created = await host.api('create', { server: base });
    await guest.api('join', { server: base, code: created.room.code });
    await until('Verbindung', async () => (await host.api('status')).room?.connected && (await guest.api('status')).room?.connected);
    for (const [browser, seconds] of [[host, 5], [guest, 10]]) {
      await browser.video.evaluate(seconds => { document.querySelector('video').currentTime = seconds; }, seconds);
      await browser.video.waitForFunction(seconds => {
        const video = document.querySelector('video');
        return !video.seeking && video.readyState >= 3 && Math.abs(video.currentTime - seconds) < 0.1;
      }, seconds);
    }
    await host.api('ready'); await guest.api('ready');
    await until('Ausrichtung', async () => (await host.api('status')).room?.state?.phase === 'synced' &&
      (await guest.api('status')).room?.state?.phase === 'synced');
  }
  for (const browser of [host, guest]) {
    if (!fresh && view === 'controls') await browser.controls.bringToFront();
    else {
      await browser.video.bringToFront();
      await browser.video.locator('#video').scrollIntoViewIfNeeded();
      if (view === 'popup') await browser.worker.evaluate(() => chrome.action.openPopup());
    }
  }
  await mkdir('test-results', { recursive: true });
  const result = { ready: true, mode: fresh ? 'fresh' : 'aligned', channel, engineVersion: expectedVersion,
    source: resolve(process.env.TEST_EXTENSION || 'extension'), extension, view, server: base, room: created?.room.code || null,
    profiles: 2, anchors: fresh ? null : { A: 5, B: 10 }, ...(fresh ? { freshProfiles } : {}), pid: process.pid };
  await writeFile('test-results/manual-session.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  console.log(fresh
    ? 'Beide Profile sind frisch: keine gespeicherten Einstellungen, keine Website-Freigabe, kein verbundenes Video und kein Raum. Mit „Erlauben & verbinden“ beginnen und Chrome selbst bestätigen.'
    : 'Beide Fenster sind verbunden und pausiert. Play/Pause/Seek direkt im Video oder im zweiten Tab „Video Sync“ testen.');
  console.log('Zum Beenden beide Test-Browserfenster schließen.');
  await Promise.all(closed);
} finally {
  await cleanup();
}
