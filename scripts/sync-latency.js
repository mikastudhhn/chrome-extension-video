// Measures how quickly a native Play/Pause in one profile reaches the other
// profile's video element, and how many relay requests each client issues while
// paused and while playing. Diagnostic only: not part of the browser gate.
//
//   TEST_EXTENSION=dist/.../extension node scripts/sync-latency.js
//
// Starts its own relay on a free port (never 8787) unless TEST_SERVER is set.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createServer } from '../server/index.js';

process.env.TEST_RESULTS ||= await mkdtemp(join(tmpdir(), 'video-sync-latency-results-'));
const { chromium } = await import('./browser-test-context.js');
const { extensionApi } = await import('./browser-test-api.js');
const { failureProxy } = await import('./test-proxy.js');

const extension = resolve(process.env.TEST_EXTENSION || 'extension');
const rounds = Number(process.env.ROUNDS || 12);
const idleSeconds = Number(process.env.IDLE_SECONDS || 10);
let relay = null, base = process.env.TEST_SERVER;
if (!base) {
  relay = createServer({ env: {} });
  await new Promise(done => relay.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${relay.address().port}`;
}
const proxy = await failureProxy(base);
const contexts = [], profiles = [];

async function browser(label, version) {
  const profile = await mkdtemp(join(tmpdir(), 'video-sync-latency-'));
  profiles.push(profile);
  const context = await chromium.launchPersistentContext(profile, {
    headless: true,
    ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : { channel: 'chromium' }),
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    viewport: { width: 1200, height: 850 }
  });
  contexts.push(context);
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).hostname;
  const video = await context.newPage();
  await video.goto(base);
  if (version === 'b') await video.getByRole('button', { name: 'Version B · +5 Sekunden', exact: true }).click();
  await video.waitForFunction(expected => document.querySelector('video').currentSrc.endsWith(`/scene-${expected}.webm`), version);
  await video.waitForFunction(() => document.querySelector('video').readyState >= 3);
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  const tabId = await popup.evaluate(async origin => (await chrome.tabs.query({})).find(tab => tab.url?.startsWith(origin)).id, base);
  const api = extensionApi(popup, { label });
  if (process.env.TEST_CHANNEL) await api('set-channel', { channel: process.env.TEST_CHANNEL });
  await api('attach', { tabId });
  // Popup polling is not part of the measured traffic; it talks to the extension only.
  await popup.goto('about:blank');
  await video.evaluate(() => {
    const video = document.querySelector('video');
    window.latency = { play: [], pause: [] };
    video.addEventListener('play', () => window.latency.play.push(Date.now()));
    video.addEventListener('pause', () => window.latency.pause.push(Date.now()));
  });
  return { context, video, popup, api, label, id };
}

async function until(description, check, timeout = 15_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise(done => setTimeout(done, 50));
  }
  throw new Error(`Timeout: ${description}`);
}
const media = browser => browser.video.evaluate(() => {
  const video = document.querySelector('video');
  return { time: video.currentTime, paused: video.paused, buffering: video.readyState < 3 || video.seeking };
});
const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
};
const summary = values => ({ n: values.length, p50: percentile(values, 0.5), p90: percentile(values, 0.9),
  max: Math.max(...values), mean: Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) });

async function status(browser) {
  const popup = await browser.context.newPage();
  try {
    await popup.goto(`chrome-extension://${browser.id}/popup.html`);
    return await extensionApi(popup, { label: browser.label })('status');
  } finally { await popup.close(); }
}

let host, guest;
try {
  host = await browser('host', 'a');
  guest = await browser('guest', 'b');
  const control = await host.context.newPage();
  await control.goto(`chrome-extension://${host.id}/popup.html`);
  const hostApi = extensionApi(control, { label: 'host' });
  const created = await hostApi('create', { server: proxy.url });
  const guestControl = await guest.context.newPage();
  await guestControl.goto(`chrome-extension://${guest.id}/popup.html`);
  const guestApi = extensionApi(guestControl, { label: 'guest' });
  await guestApi('join', { server: proxy.url, code: created.room.code });
  await until('connected', async () => (await hostApi('status')).room?.connected && (await guestApi('status')).room?.connected, 25_000);
  await host.video.evaluate(() => { document.querySelector('video').currentTime = 5; });
  await guest.video.evaluate(() => { document.querySelector('video').currentTime = 10; });
  await until('seeks settle', async () => !(await media(host)).buffering && !(await media(guest)).buffering);
  await hostApi('ready'); await guestApi('ready');
  await until('synced', async () => (await hostApi('status')).room?.state?.phase === 'synced' && (await guestApi('status')).room?.state?.phase === 'synced');
  // Extension pages poll status; close them so only the session itself is measured.
  await control.goto('about:blank'); await guestControl.goto('about:blank');

  async function rate(label) {
    const before = proxy.counts();
    await new Promise(done => setTimeout(done, idleSeconds * 1000));
    const after = proxy.counts();
    const result = {};
    for (const role of ['host', 'guest']) {
      const delta = key => ((after[role]?.[key] || 0) - (before[role]?.[key] || 0)) / idleSeconds;
      result[role] = { relayPerSecond: +delta('/relay').toFixed(2), eventsPerSecond: +delta('/events').toFixed(2),
        totalPerSecond: +(delta('/relay') + delta('/events')).toFixed(2) };
    }
    console.log(`requests ${label}: ${JSON.stringify(result)}`);
    return result;
  }
  const rates = { paused: await rate('paused') };

  const latencies = { play: [], pause: [] };
  for (let round = 0; round < rounds; round++) {
    const [actor, peer] = round % 2 ? [guest, host] : [host, guest];
    for (const type of ['play', 'pause']) {
      const already = await peer.video.evaluate(type => window.latency[type].length, type);
      // Random phase relative to any internal timer.
      await new Promise(done => setTimeout(done, 400 + Math.random() * 400));
      const started = await actor.video.evaluate(async type => {
        const video = document.querySelector('video');
        const at = Date.now();
        if (type === 'play') await video.play(); else video.pause();
        return at;
      }, type);
      await until(`${peer.label} ${type}`, async () => (await peer.video.evaluate(type => window.latency[type].length, type)) > already);
      const reached = await peer.video.evaluate(({ type, already }) => window.latency[type][already], { type, already });
      latencies[type].push(reached - started);
      if (type === 'play') {
        await until('both playing', async () => !(await media(host)).paused && !(await media(guest)).paused);
        if (round === 0) rates.playing = await rate('playing');
        else await new Promise(done => setTimeout(done, 1000));
      } else await until('both paused', async () => (await media(host)).paused && (await media(guest)).paused);
    }
    if ((await media(host)).time > 28) {
      await host.video.evaluate(() => { document.querySelector('video').currentTime = 6; });
      await until('rewound', async () => Math.abs((await media(guest)).time - 11) < 0.3 && !(await media(guest)).buffering);
    }
  }
  const result = { extension, rounds, play: summary(latencies.play), pause: summary(latencies.pause), raw: latencies, rates };
  console.log(JSON.stringify(result, null, 2));
  assert.ok((await status(host)).room?.connected);
} finally {
  await proxy.close();
  for (const context of contexts) await context.close();
  for (const profile of profiles) await rm(profile, { recursive: true, force: true });
  if (relay) await new Promise(done => { relay.close(done); relay.closeAllConnections(); });
}
