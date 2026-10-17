// Player-discovery regressions on extracted candidate packages, with isolated fixture copies.
// Run only with the coordinator's browser slot. Real providers are not exercised here.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, evidence, selectChannel, recordDiagnostic } from './browser-test-context.js';
import { extensionApi } from './browser-test-api.js';
import { fileHashes } from './browser-test-package.js';

assert.ok(process.env.TEST_EXTENSION, 'Run through npm run test:browser with an extracted candidate package');
assert.ok(['stable', 'experimental'].includes(process.env.TEST_CHANNEL), 'A candidate runtime channel is required');
assert.ok(process.env.TEST_SERVER, 'The shared starter must provide its isolated relay');
const extension = resolve(process.env.TEST_EXTENSION);
const channel = process.env.TEST_CHANNEL;
const base = process.env.TEST_SERVER;
const metadata = JSON.parse(await readFile(join(extension, 'build-info.json'), 'utf8'));
assert.equal(metadata.channel, channel, 'Discovery must test the selected candidate profile');
const originalHashes = await fileHashes(extension);
const root = await mkdtemp(join(tmpdir(), 'video-sync-discovery-'));
const passed = [];
let context, redirectServer;
let html = '';
let sequence = 0;
let redirectRequests = 0;
async function until(label, check) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timeout: ${label}`);
}
async function record(name, run) {
  recordDiagnostic({ type: 'scenario-start', name, channel });
  await run(); passed.push(name);
  recordDiagnostic({ type: 'scenario-pass', name, channel });
  console.log(`PASS ${name}`);
}
try {
  // A real redirect avoids relying on interception of a redirected
  // request. Both iframe elements retain /redirect while their documents use /final.
  const redirectMedia = await readFile('demo/scene-a.webm');
  redirectServer = createServer((request, response) => {
    if (request.url === '/redirect') {
      redirectRequests++;
      recordDiagnostic({ type: 'fixture-redirect', from: '/redirect', to: '/final' });
      response.writeHead(302, { Location: '/final' }).end();
    } else if (request.url === '/final') {
      response.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><video aria-label="Redirected frame movie" muted preload="auto" style="width:300px;height:200px" src="/scene-a.webm"></video>');
    } else if (request.url === '/blocked-frame') {
      response.writeHead(200, { 'Content-Type': 'text/html', 'Content-Security-Policy': "frame-ancestors 'none'" }).end('<p>Cannot be embedded</p>');
    } else if (request.url.startsWith('/player-regression')) {
      response.writeHead(200, { 'Content-Type': 'text/html' }).end(html);
    } else if (request.url === '/scene-a.webm') {
      const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || '');
      if (range) {
        const start = Number(range[1]), end = range[2] ? Math.min(Number(range[2]), redirectMedia.length - 1) : redirectMedia.length - 1;
        response.writeHead(206, { 'Content-Type': 'video/webm', 'Accept-Ranges': 'bytes',
          'Content-Range': `bytes ${start}-${end}/${redirectMedia.length}` }).end(redirectMedia.subarray(start, end + 1));
      } else response.writeHead(200, { 'Content-Type': 'video/webm' }).end(redirectMedia);
    } else response.writeHead(404).end();
  });
  await new Promise(resolve => redirectServer.listen(0, '127.0.0.1', resolve));
  const redirectOrigin = `http://127.0.0.1:${redirectServer.address().port}`;
  assert.notEqual(redirectServer.address().port, 8787);
  const paths = [join(root, 'first'), join(root, 'second')];
  for (const [index, directory] of paths.entries()) {
    await cp(extension, directory, { recursive: true });
    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
    delete manifest.key; // Distinct fixture installation IDs, even for a keyed input package.
    manifest.name = `Discovery fixture ${index}`;
    manifest.host_permissions.push(`${base}/*`, `${redirectOrigin}/*`, 'https://frames.video-sync.test/*');
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
    const hashes = await fileHashes(directory);
    for (const [path, hash] of Object.entries(originalHashes)) {
      if (path !== 'manifest.json') assert.equal(hashes[path], hash, `Fixture runtime differs from package: ${path}`);
    }
  }
  context = await chromium.launchPersistentContext(join(root, 'profile'), { headless: true,
    ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : { channel: 'chromium' }),
    args: [`--disable-extensions-except=${paths.join(',')}`, `--load-extension=${paths.join(',')}`] });
  await until('both installations started', async () => context.serviceWorkers().length === 2);
  const workers = await Promise.all(context.serviceWorkers().map(async worker => ({ worker, name: await worker.evaluate(() => chrome.runtime.getManifest().name) })));
  const popup = await context.newPage();
  await popup.goto(workers.find(item => item.name.endsWith('0')).worker.url().replace('background.js', 'popup.html'));
  const secondPopup = await context.newPage();
  await secondPopup.goto(workers.find(item => item.name.endsWith('1')).worker.url().replace('background.js', 'popup.html'));
  const api = extensionApi(popup);
  await selectChannel(popup, channel);
  assert.equal((await api('status')).channel, channel);
  const page = await context.newPage();
  // Serve the top document over real loopback too: intercepted documents have
  // no network address-space provenance and cannot navigate a local iframe.
  const media = (label, style = 'width:300px;height:200px', source = `${base}/scene-a.webm`) => `<video aria-label="${label}" muted preload="auto" style="${style}" src="${source}"></video>`;
  const open = async body => {
    html = `<!doctype html><title>Player regression</title>${body}`;
    await page.goto(`${redirectOrigin}/player-regression?case=${++sequence}`);
    return popup.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url).id, page.url());
  };
  const ready = async surface => surface.waitForFunction(() => [...document.querySelectorAll('video')].every(video => video.readyState >= 3));
  const discovery = tabId => popup.evaluate(tabId => chrome.runtime.sendMessage({ target: 'background', type: 'discover-player', tabId }), tabId);

  for (const embedded of [false, true]) {
    await record(`a blocked background iframe does not prevent ${embedded ? 'embedded' : 'top-level'} player discovery and attachment`, async () => {
      const player = embedded ? `<iframe style="width:600px;height:400px" src="${redirectOrigin}/final"></iframe>` : media('Main movie');
      const tabId = await open(player + `<iframe style="display:none" src="${redirectOrigin}/blocked-frame"></iframe>`);
      await until('browser reports the blocked frame', async () => popup.evaluate(async tabId =>
        (await chrome.webNavigation.getAllFrames({ tabId })).some(frame => frame.url.endsWith('/blocked-frame') && frame.errorOccurred), tabId));
      const surface = embedded ? page.frames().find(frame => frame.url() === `${redirectOrigin}/final`) : page;
      assert.ok(surface, 'player document loaded');
      await ready(surface);
      const found = await discovery(tabId);
      assert.equal(found.ok, true, found.error);
      assert.equal(found.result.candidates.length, 1);
      assert.deepEqual(found.result.missingOrigins, []);
      assert.equal(found.result.candidates[0].label, embedded ? 'Redirected frame movie' : 'Main movie');
      assert.equal((await api('attach', { tabId })).local.adapter, 'HTML5');
    });
  }

  await record('a hidden script-disabled sandbox helper does not block the main player', async () => {
    const tabId = await open(media('Main movie') + '<iframe style="display:none" sandbox="allow-same-origin" src="about:blank"></iframe>');
    await ready(page);
    const found = await discovery(tabId);
    assert.equal(found.ok, true, found.error);
    assert.equal(found.result.candidates.length, 1);
    assert.deepEqual(found.result.missingOrigins, []);
    assert.equal((await api('attach', { tabId })).local.adapter, 'HTML5');
  });

  await record('transparent larger video and transparent ancestor never beat the visible video', async () => {
    const tabId = await open(media('Visible') + media('Transparent', 'width:1000px;height:700px;opacity:0') + `<div style="opacity:0">${media('Hidden ancestor')}</div>`);
    await ready(page);
    await page.evaluate(() => document.querySelectorAll('video').forEach((video, index) => { video.currentTime = index ? 15 : 5; }));
    const found = await discovery(tabId);
    assert.equal(found.result.candidates.length, 1);
    assert.equal((await api('attach', { tabId })).local.time, 5);
  });

  await record('nested open shadow roots and shadow-host opacity are respected', async () => {
    const tabId = await open('<div id="visible-host"></div><div id="hidden-host" style="opacity:0"></div>');
    await page.evaluate(source => {
      for (const id of ['visible-host', 'hidden-host']) {
        const outer = document.getElementById(id).attachShadow({ mode: 'open' });
        const inner = document.createElement('div'); outer.append(inner);
        inner.attachShadow({ mode: 'open' }).innerHTML = `<video muted preload="auto" aria-label="${id}" style="width:400px;height:250px" src="${source}"></video>`;
      }
    }, `${base}/scene-a.webm`);
    await page.waitForFunction(() => document.getElementById('visible-host').shadowRoot.firstElementChild.shadowRoot.querySelector('video').readyState >= 3);
    const found = await discovery(tabId);
    assert.equal(found.result.candidates.length, 1);
    assert.equal(found.result.candidates[0].label, 'visible-host');
    await api('attach', { tabId });
  });

  await record('visibility overrides admit visible media under hidden ancestors, shadow hosts and slots', async () => {
    const tabId = await open(`<div style="visibility:hidden">${media('Visible override', 'width:300px;height:200px;visibility:visible')}${media('Inherited hidden')}</div><div id="host" style="visibility:hidden"></div><div id="slot-host">${media('Slot override', 'width:300px;height:200px;visibility:visible')}</div>`);
    await page.evaluate(source => {
      document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML = `<video muted preload="auto" aria-label="Shadow override" style="width:300px;height:200px;visibility:visible" src="${source}"></video>`;
      document.getElementById('slot-host').attachShadow({ mode: 'open' }).innerHTML = '<slot style="visibility:hidden"></slot>';
    }, `${base}/scene-a.webm`);
    await ready(page);
    await page.waitForFunction(() => document.getElementById('host').shadowRoot.querySelector('video').readyState >= 3);
    const found = await discovery(tabId);
    assert.equal(found.ok, true, found.error);
    assert.deepEqual(found.result.candidates.map(candidate => candidate.label).sort(), ['Shadow override', 'Slot override', 'Visible override']);
  });

  await record('multiple videos require a keyboard selection and bind exactly the chosen trailer', async () => {
    const tabId = await open(media('Main movie') + media('Trailer'));
    await ready(page);
    await page.evaluate(() => { document.querySelectorAll('video')[1].currentTime = 15; });
    await page.bringToFront();
    await popup.locator('#change-video').dispatchEvent('click');
    const choice = popup.getByRole('button', { name: /2\. Trailer/ });
    await choice.waitFor({ state: 'visible' });
    await popup.bringToFront(); await choice.focus(); await choice.press('Enter');
    await until('selected trailer bound', async () => (await api('status')).tabId === tabId && Math.abs(((await api('status')).local?.time ?? Infinity) - 15) < 0.1);
  });

  await record('SPA title and accessible name update without changing tab or media identity', async () => {
    const before = await api('status');
    const title = 'Folge 2 · Ein vollständiger langer Videotitel für zugängliche Namen';
    await page.evaluate(title => { document.title = title; }, title);
    await until('title refreshed', async () => await popup.locator('#player-description').textContent() === title);
    assert.equal(await popup.locator('#show-video').getAttribute('title'), title);
    assert.equal(await popup.locator('#show-video').getAttribute('aria-label'), `Zum Video wechseln: ${title}`);
    assert.equal((await api('status')).local.mediaId, before.local.mediaId);
  });

  await record('media load with unchanged source changes media identity and remains paused', async () => {
    const before = (await api('status')).local.mediaId;
    await page.evaluate(() => document.querySelectorAll('video')[1].load());
    await ready(page);
    await until('new media identity sampled', async () => (await api('status')).local?.mediaId !== before);
    assert.equal((await api('status')).local.paused, true);
  });

  // Keep the HTTPS frame's media on that same origin. A request from this
  // simulated public origin to loopback is blocked by Chromium's network policy.
  const frameMedia = await readFile('demo/scene-a.webm');
  await context.route('https://frames.video-sync.test/scene-a.webm', route => {
    const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range || '');
    if (range) {
      const start = Number(range[1]), end = range[2] ? Math.min(Number(range[2]), frameMedia.length - 1) : frameMedia.length - 1;
      return route.fulfill({ status: 206, contentType: 'video/webm', body: frameMedia.subarray(start, end + 1),
        headers: { 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${frameMedia.length}` } });
    }
    return route.fulfill({ contentType: 'video/webm', body: frameMedia, headers: { 'Accept-Ranges': 'bytes' } });
  });
  await context.route('https://frames.video-sync.test/final', route => route.fulfill({ contentType: 'text/html',
    body: media('Frame movie', undefined, 'https://frames.video-sync.test/scene-a.webm') }));
  await record('iframe visibility overrides a hidden ancestor while an inherited-hidden iframe remains excluded', async () => {
    const tabId = await open('<div style="visibility:hidden"><iframe style="width:600px;height:400px;visibility:visible" src="https://frames.video-sync.test/final"></iframe><iframe style="width:600px;height:400px" src="https://frames.video-sync.test/final"></iframe></div>');
    await until('visibility fixture frames ready', async () => page.frames().filter(frame => frame.url().endsWith('/final')).length === 2);
    for (const frame of page.frames().filter(frame => frame.url().endsWith('/final'))) await ready(frame);
    const found = await discovery(tabId);
    assert.equal(found.ok, true, found.error);
    assert.equal(found.result.candidates.length, 1);
    await api('attach', { tabId, documentId: found.result.documentId, playerId: found.result.playerId });
  });

  await record('duplicate iframe sources and redirects select only the actually visible frame', async () => {
    const tabId = await open(`<iframe style="width:600px;height:400px" src="${redirectOrigin}/redirect"></iframe><div style="opacity:0"><iframe style="width:1000px;height:700px" src="${redirectOrigin}/redirect"></iframe></div>`);
    await until('redirected frames ready', async () => page.frames().filter(frame => frame.url() === `${redirectOrigin}/final`).length === 2);
    assert.equal(redirectRequests, 2, 'both documents followed a real HTTP redirect');
    assert.deepEqual(await page.locator('iframe').evaluateAll(frames => frames.map(frame => new URL(frame.src).pathname)), ['/redirect', '/redirect']);
    for (const frame of page.frames().filter(frame => frame.url().endsWith('/final'))) await ready(frame);
    const found = await discovery(tabId);
    assert.equal(found.ok, true, found.error);
    assert.equal(found.result.candidates.length, 1);
    await api('attach', { tabId, documentId: found.result.documentId, playerId: found.result.playerId });
  });

  await record('a second installation cannot take over a bound player with either channel selected', async () => {
    const before = await api('status');
    for (const otherChannel of ['stable', 'experimental']) {
      await selectChannel(secondPopup, otherChannel);
      await assert.rejects(api('attach', { tabId: before.tabId }, secondPopup), /andere oder ältere/);
      assert.equal((await api('status')).local.mediaId, before.local.mediaId);
    }
  });

  assert.deepEqual(await fileHashes(extension), originalHashes, 'The extracted candidate stays unchanged');
  await writeFile(join(evidence, 'e2e-player-discovery.json'), JSON.stringify({ passed, channel,
    extension, metadata, originalHashes, fixtureChanges: ['manifest name', 'fixture host permissions', 'distinct installation IDs'] }, null, 2));
} finally {
  await context?.close();
  if (redirectServer) await new Promise(resolve => { redirectServer.close(resolve); redirectServer.closeAllConnections(); });
  await rm(root, { recursive: true, force: true });
}
