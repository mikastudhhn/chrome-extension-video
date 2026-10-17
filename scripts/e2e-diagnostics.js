// Run only through the integrated common starter in the coordinator's browser slot.
// Candidate files are read-only; all profiles/downloads/evidence are isolated.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, evidence, selectChannel } from './browser-test-context.js';
import { extensionApi } from './browser-test-api.js';

const base = process.env.TEST_SERVER;
assert.ok(base && process.env.TEST_EXTENSION && process.env.TEST_CHANNEL, 'Use the shared browser starter');
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(base).hostname));
assert.notEqual(new URL(base).port, '8787', 'Never use the personal relay');
assert.ok(['0', '1'].includes(process.env.TEST_EXPECT_DIAGNOSTICS));
const supported = process.env.TEST_EXPECT_DIAGNOSTICS === '1';
const extension = resolve(process.env.TEST_EXTENSION);
const profile = await mkdtemp(join(tmpdir(), 'video-sync-diagnostics-'));
const passed = [], failures = [];
let context;
const record = async (name, run) => { await run(); passed.push(name); console.log(`PASS ${name}`); };

// Chrome toolbar popups are not consistently exposed as Playwright Pages.
// Attach only to the newly opened popup target for native input and screenshots.
async function nativeSession(browser, worker, bridge, video, run) {
  const cdp = await browser.newBrowserCDPSession();
  let sessionId;
  try {
    const before = new Set((await cdp.send('Target.getTargets')).targetInfos.map(target => target.targetId));
    const windowId = await bridge.evaluate(async () => (await chrome.tabs.getCurrent()).windowId);
    await video.bringToFront();
    await worker.evaluate(async windowId => {
      await chrome.windows.update(windowId, { focused: true });
      await chrome.action.openPopup({ windowId });
    }, windowId);
    await bridge.waitForFunction(() => chrome.extension.getViews({ type: 'popup' })[0]
      ?.document.querySelector('main')?.getAttribute('aria-busy') === 'false');
    const targets = (await cdp.send('Target.getTargets')).targetInfos;
    const target = targets.find(item => !before.has(item.targetId) && item.url === bridge.url());
    assert.ok(target, 'Native toolbar popup target must be inspectable');
    ({ sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: false }));
    let sequence = 0;
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++sequence;
      const finish = (error, result) => { clearTimeout(timer); cdp.off('Target.receivedMessageFromTarget', receive); error ? reject(error) : resolve(result); };
      const receive = event => {
        if (event.sessionId !== sessionId) return;
        const message = JSON.parse(event.message);
        if (message.id === id) finish(message.error ? new Error(message.error.message) : null, message.result);
      };
      const timer = setTimeout(() => finish(new Error(`Native popup command timed out: ${method}`)), 5000);
      cdp.on('Target.receivedMessageFromTarget', receive);
      cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) }).catch(error => finish(error));
    });
    await run(send);
  } finally {
    if (sessionId) await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {});
    await bridge.evaluate(() => chrome.extension.getViews({ type: 'popup' })[0]?.close()).catch(() => {});
    await cdp.detach();
  }
}

try {
  context = await chromium.launchPersistentContext(profile, { headless: false, viewport: null, acceptDownloads: true,
    ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : { channel: 'chromium' }),
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--window-size=700,850'] });
  context.on('page', page => page.on('pageerror', error => failures.push(error.message)));
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  await worker.evaluate(server => chrome.storage.local.set({ server }), base);
  const popup = await context.newPage();
  await popup.goto(worker.url().replace('background.js', 'popup.html'));
  await selectChannel(popup);
  const video = await context.newPage();
  await video.goto(base);
  await video.waitForFunction(() => document.querySelector('video').readyState >= 3);
  const api = extensionApi(popup);
  const tabId = await popup.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url).id, video.url());
  const selected = await api('attach', { tabId });
  const privateValues = [selected.local?.mediaId, selected.playerId, selected.local?.bindingId,
    selected.lifecycle?.instanceId].filter(Boolean);
  // A native-sized background tab can retain a 0x0 viewport under Xvfb.
  // Activate the actual test tab before measuring or clicking its controls.
  await popup.bringToFront();
  await popup.waitForFunction(() => innerWidth > 0 && innerHeight > 0);
  await popup.reload();
  await popup.locator('main[aria-busy="false"]').waitFor();
  await popup.locator('#open-settings').click();
  const summary = popup.locator('#diagnostics-summary');
  const exportButton = popup.locator('#diagnostics-export');
  const clearButton = popup.locator('#diagnostics-clear');
  const feedback = popup.locator('#diagnostics-feedback');
  await record('keyboard opens diagnosis and availability matches the selected candidate engine', async () => {
    await summary.focus(); await popup.keyboard.press('Enter');
    assert.equal(await popup.locator('#diagnostics-panel').evaluate(element => element.open), true);
    assert.equal(await exportButton.isEnabled(), supported);
    assert.equal(await clearButton.isEnabled(), supported);
    assert.equal(await popup.locator('#diagnostics-availability').isVisible(), !supported);
    assert.match(await popup.locator('#diagnostics-retention').textContent(), /30 Minuten und 200 Ereignisse/);
  });

  const exported = async (name, key = 'Enter') => {
    const download = popup.waitForEvent('download');
    await exportButton.focus(); await popup.keyboard.press(key);
    const file = await download;
    assert.equal(file.suggestedFilename(), 'video-sync-diagnostics.json');
    assert.equal(await file.failure(), null);
    const path = join(evidence, name);
    await file.saveAs(path);
    const text = await readFile(path, 'utf8');
    for (const value of privateValues) assert.ok(!text.includes(value), 'No session/player identifier in export');
    const report = JSON.parse(text);
    assert.equal(report.schema, 1); assert.equal(report.retentionMs, 1800000);
    assert.ok(report.events.length <= 200);
    assert.ok(Buffer.byteLength(JSON.stringify(report.events)) <= 32768);
    assert.ok(report.events.every(event => Date.now() - event.at < 1800000));
    for (const event of report.events) assert.ok(Object.keys(event).every(key =>
      ['at', 'kind', 'phase', 'reason', 'adapter', 'lane', 'reconnecting', 'rttMs', 'code'].includes(key)));
    return report;
  };
  if (supported) {
    await record('Enter downloads actual redacted JSON from lifecycle events', async () => {
      await summary.focus(); await popup.keyboard.press('Tab');
      assert.equal(await exportButton.evaluate(element => element === document.activeElement), true);
      assert.ok((await exported('diagnostics-before-clear.json')).events.length > 0);
    });
    await record('Space deletes through the visible action; another export is empty', async () => {
      await exportButton.focus(); await popup.keyboard.press('Tab');
      assert.equal(await clearButton.evaluate(element => element === document.activeElement), true);
      await popup.keyboard.press('Space');
      await popup.waitForFunction(() => document.getElementById('diagnostics-feedback').textContent.includes('Lokale Diagnose gelöscht'));
      assert.deepEqual((await exported('diagnostics-after-clear.json', 'Space')).events, []);
    });
    await record('failed export and deletion never display raw errors or a false success', async () => {
      // Explicit presentation fixture, not a simulated successful runtime operation.
      await popup.evaluate(() => {
        window.restoreDiagnosticRequest = chrome.runtime.sendMessage.bind(chrome.runtime);
        chrome.runtime.sendMessage = message => message.action?.startsWith('diagnostics-')
          ? Promise.reject(new Error('PRIVATE_TOKEN https://private.invalid/video-title '.repeat(80)))
          : window.restoreDiagnosticRequest(message);
      });
      try {
        await exportButton.click();
        await popup.waitForFunction(() => document.getElementById('diagnostics-feedback').textContent.startsWith('Export nicht möglich'));
        await clearButton.click();
        await popup.waitForFunction(() => document.getElementById('diagnostics-feedback').textContent.startsWith('Löschen nicht bestätigt'));
        assert.ok(!(await feedback.textContent()).includes('PRIVATE_TOKEN'));
        await popup.screenshot({ path: join(evidence, 'diagnostics-error.png') });
      } finally {
        await popup.evaluate(() => { chrome.runtime.sendMessage = window.restoreDiagnosticRequest; delete window.restoreDiagnosticRequest; });
      }
    });
  }

  await record('forced colors and 200-percent text zoom preserve reachable diagnosis controls', async () => {
    await popup.emulateMedia({ forcedColors: 'active' });
    // CSS zoom is an explicit text/layout stress fixture, not browser zoom certification.
    await popup.evaluate(() => { document.documentElement.style.zoom = '2'; });
    await summary.scrollIntoViewIfNeeded();
    const geometry = await popup.locator('#diagnostics-panel').evaluate(panel => ({
      width: panel.clientWidth, scroll: panel.scrollWidth,
      controls: [...panel.querySelectorAll('button')].every(button => button.getBoundingClientRect().width > 0)
    }));
    assert.ok(geometry.controls); assert.ok(geometry.scroll <= geometry.width + 1);
    await popup.screenshot({ path: join(evidence, 'diagnostics-forced-colors-zoom.png'), fullPage: true });
    await popup.evaluate(() => { document.documentElement.style.zoom = ''; });
    await popup.emulateMedia({ forcedColors: 'none' });
  });
  await popup.screenshot({ path: join(evidence, 'diagnostics-settings.png'), fullPage: true });

  await record('native toolbar diagnosis supports keyboard expansion and stays inside its scroll viewport', async () => {
    await nativeSession(context.browser(), worker, popup, video, async send => {
      const inspect = fn => popup.evaluate(fn);
      await inspect(() => {
        const document = chrome.extension.getViews({ type: 'popup' })[0].document;
        document.getElementById('open-settings').click();
        const summary = document.getElementById('diagnostics-summary');
        summary.scrollIntoView(); summary.focus();
      });
      assert.equal(await inspect(() => chrome.extension.getViews({ type: 'popup' })[0].document.activeElement.id), 'diagnostics-summary');
      // Like Playwright keyboard.press: Enter needs its character event to
      // activate a native <summary>; rawKeyDown alone never emits keypress.
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await popup.waitForFunction(() => chrome.extension.getViews({ type: 'popup' })[0].document.getElementById('diagnostics-panel').open);
      if (supported) {
        await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
        assert.equal(await inspect(() => chrome.extension.getViews({ type: 'popup' })[0].document.activeElement.id), 'diagnostics-export');
      }
      const size = await inspect(() => {
        const view = chrome.extension.getViews({ type: 'popup' })[0], document = view.document;
        document.getElementById('diagnostics-clear').scrollIntoView({ block: 'nearest' });
        const main = document.querySelector('main');
        return { width: view.innerWidth, height: view.innerHeight, scrollWidth: main.scrollWidth, clientWidth: main.clientWidth };
      });
      assert.ok(size.width <= 800 && size.height <= 600);
      assert.ok(size.scrollWidth <= size.clientWidth + 1);
      await send('Page.enable');
      const screenshot = await send('Page.captureScreenshot', { format: 'png' });
      await writeFile(join(evidence, 'diagnostics-native-popup.png'), Buffer.from(screenshot.data, 'base64'));
      await writeFile(join(evidence, 'diagnostics-native-dimensions.json'), JSON.stringify(size, null, 2));
    });
  });
  assert.deepEqual(failures, []);
  await writeFile(join(evidence, 'e2e-diagnostics.json'), JSON.stringify({ passed, channel: process.env.TEST_CHANNEL, supported }, null, 2));
  console.log(`PASS ${passed.length} diagnosis browser cases`);
} finally {
  await context?.close();
  await rm(profile, { recursive: true, force: true });
}
