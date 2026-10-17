// Exercise Chrome's auto-sized toolbar popup, not a tab with a fixed viewport.
import assert from 'node:assert/strict';
import { nativePopupSession } from './native-popup.js';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

import { chromium, evidence } from './browser-test-context.js';
const base = process.env.TEST_SERVER || 'http://127.0.0.1:8787';
const extension = resolve(process.env.TEST_EXTENSION || 'extension');
const profile = await mkdtemp(join(tmpdir(), 'video-sync-popup-'));
const passed = [];
const selectedChannel = process.env.TEST_CHANNEL || 'stable';
assert.ok(['stable', 'experimental'].includes(selectedChannel));
await mkdir(evidence, { recursive: true });
let context, native;
const unavailable = createServer(request => request.socket.destroy());

try {
  await new Promise(resolve => unavailable.listen(0, '127.0.0.1', resolve));
  context = await chromium.launchPersistentContext(profile, {
    headless: false, viewport: null,
    ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : { channel: 'chromium' }),
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--window-size=700,850']
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  await worker.evaluate(({ server, channel }) => chrome.storage.local.set({ server, channel }), { server: base, channel: selectedChannel });
  const id = new URL(worker.url()).hostname;
  const bridge = await context.newPage();
  await bridge.goto(`chrome-extension://${id}/popup.html`);
  const video = await context.newPage();
  await video.goto(base);
  await video.waitForFunction(() => document.querySelector('video').readyState >= 3);

  const windowId = await bridge.evaluate(async () => (await chrome.tabs.getCurrent()).windowId);

  let nativeTargetId;
  async function openPopup() {
    await native?.close();
    const cdp = await context.browser().newBrowserCDPSession();
    try {
      const before = new Set((await cdp.send('Target.getTargets')).targetInfos.map(target => target.targetId));
      await video.bringToFront();
    // Target our own test window explicitly; macOS focus can briefly disappear
    // when the previous native popup closes. Chrome documents windowId here:
    // https://developer.chrome.com/docs/extensions/reference/api/action#type-OpenPopupOptions
    await worker.evaluate(async windowId => {
      await chrome.windows.update(windowId, { focused: true });
      await chrome.action.openPopup({ windowId });
    }, windowId);
    await bridge.waitForFunction(() => chrome.extension.getViews({ type: 'popup' })[0]
      ?.document.querySelector('main')?.getAttribute('aria-busy') === 'false');
      const targets = (await cdp.send('Target.getTargets')).targetInfos;
      const target = targets.find(item => !before.has(item.targetId) && item.url === bridge.url());
      assert.ok(target, 'New native toolbar popup target must be inspectable');
      nativeTargetId = target.targetId;
      native = await nativePopupSession(context, nativeTargetId);
      console.log('Native popup target:', { targetId: nativeTargetId, type: target.type });
    } finally { await cdp.detach(); }
  }
  async function click(id) {
    await bridge.evaluate(id => chrome.extension.getViews({ type: 'popup' })[0].document.getElementById(id).click(), id);
  }
  async function visible(id) {
    await bridge.waitForFunction(id => chrome.extension.getViews({ type: 'popup' })[0]
      ?.document.getElementById(id)?.checkVisibility(), id);
  }
  async function verify(name, ids, scrollable = false) {
    // Allow the native host to resize after a page transition and a status refresh.
    await new Promise(resolve => setTimeout(resolve, 750));
    const dimensions = await bridge.evaluate(ids => {
      const popup = chrome.extension.getViews({ type: 'popup' })[0];
      const { document } = popup;
      const main = document.querySelector('main');
      const bodyBottom = document.body.getBoundingClientRect().bottom;
      const mainBottom = main.getBoundingClientRect().bottom;
      const mainPaddingBottom = Number.parseFloat(popup.getComputedStyle(main).paddingBottom);
      return {
        width: popup.innerWidth, height: popup.innerHeight,
        contentWidth: document.documentElement.scrollWidth,
        contentHeight: document.documentElement.scrollHeight,
        bodyBottom, mainBottom, mainPaddingBottom,
        clipped: ids.filter(id => {
          const element = document.getElementById(id);
          const rect = element.getBoundingClientRect();
          return !element.checkVisibility() || rect.left < 0 || rect.top < 0 ||
            rect.right > popup.innerWidth || rect.bottom > popup.innerHeight;
        })
      };
    }, ids);
    console.log(name, dimensions);
    const screenshot = join(evidence, `${name.replaceAll(' ', '-')}.png`);
    await native.screenshot(screenshot);
    assert.equal(dimensions.width, 360, `${name}: actual toolbar popup width`);
    assert.ok(dimensions.height <= 600, `${name}: popup height`);
    assert.ok(dimensions.contentWidth <= dimensions.width, `${name}: horizontal clipping`);
    // Chrome's native autosizer truncates fractional layout heights, while
    // scrollHeight rounds them. Accept that mismatch only in main's bottom
    // padding; all required controls still use strict viewport bounds below.
    const roundedBottomPadding = dimensions.bodyBottom === dimensions.mainBottom &&
      Math.floor(dimensions.bodyBottom) === dimensions.height &&
      Math.round(dimensions.bodyBottom) === dimensions.contentHeight &&
      dimensions.mainBottom - dimensions.mainPaddingBottom <= dimensions.height;
    assert.ok(dimensions.contentHeight <= dimensions.height || roundedBottomPadding, `${name}: vertical clipping`);
    if (!scrollable) assert.deepEqual(dimensions.clipped, [], `${name}: visible controls clipped`);
    else {
      // Long settings/access forms deliberately scroll inside main. Every
      // required control must become fully visible in that region, not merely
      // exist somewhere outside the native host viewport.
      for (const control of ids) {
        const reached = await bridge.evaluate(id => {
          const popup = chrome.extension.getViews({ type: 'popup' })[0];
          const element = popup.document.getElementById(id), main = popup.document.querySelector('main');
          element.scrollIntoView({ block: 'nearest' });
          const rect = element.getBoundingClientRect(), region = main.getBoundingClientRect();
          return { overflow: popup.getComputedStyle(main).overflowY,
            visible: element.checkVisibility() && rect.left >= 0 && rect.right <= popup.innerWidth &&
              rect.top >= Math.max(0, region.top) && rect.bottom <= Math.min(popup.innerHeight, region.bottom) };
        }, control);
        await native.screenshot(join(evidence, `${name.replaceAll(' ', '-')}-${control}.png`));
        assert.equal(reached.overflow, 'auto', `${name}: explicit inner scroll region`);
        assert.equal(reached.visible, true, `${name}: ${control} fully reachable`);
      }
      await bridge.evaluate(() => { chrome.extension.getViews({ type: 'popup' })[0].document.querySelector('main').scrollTop = 0; });
    }
    passed.push({ name, channel: selectedChannel, screenshot, ...dimensions });
  }

  await openPopup();
  assert.equal(await bridge.evaluate(() => chrome.extension.getViews({ type: 'popup' })[0].document.getElementById('release-channel').value), selectedChannel);
  await verify('first opening', ['open-settings', 'allow-all', 'attach']);
  const tabsBeforeUpdates = await worker.evaluate(async () => (await chrome.tabs.query({})).length);
  await click('open-settings');
  await click('open-updates');
  await visible('updates-heading');
  await bridge.waitForFunction(() => chrome.extension.getViews({ type: 'popup' })[0]?.document.getElementById('updates-heading')?.textContent !== 'Updates werden geladen …');
  await verify('inline updates', ['updates-back', 'updates-title', 'updates-heading']);
  assert.equal(await worker.evaluate(async () => (await chrome.tabs.query({})).length), tabsBeforeUpdates);
  // Explicit presentation fixtures exercise actual toolbar sizing without a
  // private token, GitHub request or installation in the loaded folder.
  await bridge.evaluate(() => {
    const popup = chrome.extension.getViews({ type: 'popup' })[0];
    popup.originalUpdateStatusRequest = popup.chrome.runtime.sendMessage.bind(popup.chrome.runtime);
    popup.chrome.runtime.sendMessage = async message => {
      const response = await popup.originalUpdateStatusRequest(message);
      if (['status', 'update-status'].includes(message.action) && response?.ok && popup.updateStatusFixture) {
        response.result = { ...response.result, sourceBuild: false, updates: popup.updateStatusFixture };
      }
      return response;
    };
  });
  for (const [name, fixture, heading, controls] of [
    ['public updates without token', { configured: true, hasToken: false, releaseState: 'current', lastSuccessfulCheckAt: 1700000000000,
      access: { status: 'verified' } }, 'Alles aktuell', ['updates-check', 'updates-last-check', 'updates-access-status']],
    ['releases not reachable without token', { configured: true, hasToken: false, releaseState: 'error',
      error: 'Releases nicht öffentlich erreichbar. Ist das Repository privat, hilft ein GitHub-Token.',
      access: { status: 'not-found' } }, 'Prüfung fehlgeschlagen', ['updates-access-status', 'updates-token', 'updates-save-token']],
    ['update available', { configured: true, available: true, releaseState: 'available', tag: 'v0.6.0',
      url: 'https://github.com/mikastudhhn/chrome-extension-video/releases/tag/v0.6.0',
      lastSuccessfulCheckAt: 1700000000000, access: { status: 'verified' } }, 'Update verfügbar', ['updates-target', 'updates-last-check', 'updates-changelog', 'updates-install']],
    ['no matching release', { configured: true, releaseState: 'no-release', access: { status: 'verified' } }, 'Kein passendes Release', ['updates-check', 'updates-access-status']],
    ['expired access', { configured: true, error: 'GitHub-Zugang ungültig oder abgelaufen. Bitte den Token ersetzen.',
      access: { status: 'invalid-token' } }, 'Prüfung fehlgeschlagen', ['updates-access-status', 'updates-token', 'updates-save-token']]
  ]) {
    await bridge.evaluate(fixture => {
      const popup = chrome.extension.getViews({ type: 'popup' })[0];
      popup.updateStatusFixture = fixture;
      popup.document.dispatchEvent(new popup.Event('visibilitychange'));
    }, fixture);
    await bridge.waitForFunction(heading => chrome.extension.getViews({ type: 'popup' })[0]
      ?.document.getElementById('updates-heading').textContent === heading, heading);
    await verify(name, ['updates-heading', ...controls]);
    if (name === 'public updates without token') assert.equal(await bridge.evaluate(() => chrome.extension.getViews({ type: 'popup' })[0].document.getElementById('updates-access-status').textContent), 'Optional');
    if (['expired access', 'releases not reachable without token'].includes(name)) assert.equal(await bridge.evaluate(() => {
      const document = chrome.extension.getViews({ type: 'popup' })[0].document;
      return document.getElementById('updates-check').hidden && document.getElementById('updates-last-check').hidden;
    }), true, 'Token correction is the direct next action');
  }
  await bridge.evaluate(() => {
    const popup = chrome.extension.getViews({ type: 'popup' })[0];
    popup.chrome.runtime.sendMessage = popup.originalUpdateStatusRequest;
    delete popup.updateStatusFixture;
  });
  await click('updates-back');
  await visible('settings');
  await verify('back from updates', ['settings-back', 'release-channel', 'open-updates'], true);
  await click('settings-back');
  await click('attach');
  await visible('lobby');
  await verify('connected video', ['open-settings', 'show-video', 'create', 'join', 'change-video']);
  await click('open-settings');
  await bridge.evaluate(server => {
    const input = chrome.extension.getViews({ type: 'popup' })[0].document.getElementById('server');
    input.value = server; input.dispatchEvent(new Event('input'));
  }, `http://127.0.0.1:${unavailable.address().port}`);
  await click('server-save');
  await bridge.waitForFunction(() => chrome.extension.getViews({ type: 'popup' })[0]?.document.getElementById('server-feedback').textContent === 'Serveradresse gespeichert.');
  await click('settings-back'); await click('create');
  await visible('room-error');
  // Loopback host access is already granted by the candidate manifest. The
  // deliberately closed HTTP socket must report the real network failure.
  assert.equal(await bridge.evaluate(() => chrome.extension.getViews({ type: 'popup' })[0].document.getElementById('room-error-title').textContent), 'Lokaler Server nicht erreichbar');
  assert.equal(await bridge.evaluate(() => chrome.extension.getViews({ type: 'popup' })[0].document.getElementById('settings').hidden), true);
  await verify('server error stays beside create', ['create', 'room-error-title', 'room-error-dismiss']);
  await click('room-error-dismiss');
  await verify('dismissed connection error', ['create', 'join', 'change-video']);
  // Prepare a room through the existing UI API. This test covers popup sizing;
  // the normal create-button workflow is covered by e2e-ux.js.
  await bridge.evaluate(async server => {
    const response = await chrome.runtime.sendMessage({ target: 'background', type: 'ui', action: 'create', server });
    if (!response?.ok) throw new Error(response?.error || 'Room creation failed');
  }, base);
  await visible('copy');
  await verify('room invitation', ['open-settings', 'show-video', 'members', 'copy', 'change-video']);
  await click('open-settings');
  await visible('settings');
  await verify('settings', ['settings-back', 'copy-again', 'leave'], true);
  await click('settings-back');
  await visible('copy');
  await verify('back to player', ['open-settings', 'copy', 'change-video']);
  await bridge.evaluate(() => chrome.extension.getViews({ type: 'popup' })[0].close());
  await bridge.waitForFunction(() => chrome.extension.getViews({ type: 'popup' }).length === 0);
  await openPopup();
  await verify('reopened popup', ['open-settings', 'copy', 'change-video']);
  // Native rendering fixtures supplement the real two-browser flows in e2e-ux.
  // They do not claim a real second peer or a successful playback command.
  await bridge.evaluate(() => {
    const popup = chrome.extension.getViews({ type: 'popup' })[0];
    const request = popup.chrome.runtime.sendMessage.bind(popup.chrome.runtime);
    popup.nativeOriginalRequest = request;
    popup.chrome.runtime.sendMessage = async message => {
      const response = await request(message);
      if (message.action === 'status' && response?.ok && popup.playbackFixture) {
        const current = response.result;
        response.result = { ...current, local: { ...current.local, time: 3661, ...popup.playbackFixture.local },
          room: { ...current.room, connected: true, ...popup.playbackFixture.room,
            state: { phase: 'synced', members: { host: { ready: true }, guest: { ready: true } }, ...popup.playbackFixture.state } } };
      }
      return response;
    };
  });
  for (const [name, fixture, heading] of [
    ['paused fixture', { state: { playing: false, wantsPlay: false } }, 'Pausiert'],
    ['playing fixture', { state: { playing: true, wantsPlay: true } }, 'Wiedergabe'],
    ['buffering fixture', { local: { buffering: true }, state: { waiting: true } }, 'Dein Video lädt nach'],
    ['autoplay fixture', { local: { blocked: true } }, 'Starte einmal im Video'],
    ['interrupted fixture', { room: { reconnecting: true, connected: false } }, 'Wir verbinden euch erneut']
  ]) {
    await bridge.evaluate(fixture => {
      const popup = chrome.extension.getViews({ type: 'popup' })[0];
      popup.playbackFixture = fixture;
      popup.document.dispatchEvent(new popup.Event('visibilitychange'));
    }, fixture);
    await bridge.waitForFunction(heading => chrome.extension.getViews({ type: 'popup' })[0].document.getElementById('status').textContent === heading, heading);
    assert.equal(await bridge.evaluate(() => chrome.extension.getViews({ type: 'popup' })[0].document.getElementById('position').textContent), '1:01:01');
    await verify(name, ['show-video', 'members', 'status', 'play', 'change-video']);
  }
  await bridge.evaluate(() => {
    const popup = chrome.extension.getViews({ type: 'popup' })[0];
    popup.chrome.runtime.sendMessage = popup.nativeOriginalRequest;
    popup.document.dispatchEvent(new popup.Event('visibilitychange'));
  });
  await visible('copy');
  // Actual native keyboard input: open settings from the focused toolbar control.
  await bridge.evaluate(() => chrome.extension.getViews({ type: 'popup' })[0].document.getElementById('open-settings').focus());
  await native.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' });
  await native.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await visible('settings');
  assert.equal(await bridge.evaluate(() => chrome.extension.getViews({ type: 'popup' })[0].document.activeElement.id), 'settings-back');
  await verify('native keyboard settings', ['settings-back', 'leave'], true);
  await native.send('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'active' }] });
  await bridge.evaluate(() => {
    chrome.extension.getViews({ type: 'popup' })[0].document.documentElement.style.fontSize = '28px';
  });
  const enlarged = await bridge.evaluate(() => {
    const popup = chrome.extension.getViews({ type: 'popup' })[0];
    const main = popup.document.querySelector('main');
    const leave = popup.getComputedStyle(popup.document.getElementById('leave'));
    return {
      forcedColors: popup.matchMedia('(forced-colors: active)').matches,
      viewportWidth: popup.innerWidth, clientWidth: main.clientWidth, scrollWidth: main.scrollWidth,
      leaveColor: leave.color, leaveBackground: leave.backgroundColor,
      elements: [...main.querySelectorAll('*')].filter(element => element.checkVisibility()).map(element => {
        const rect = element.getBoundingClientRect();
        return { tag: element.tagName, id: element.id, left: rect.left, right: rect.right,
          clientWidth: element.clientWidth, scrollWidth: element.scrollWidth,
          font: popup.getComputedStyle(element).font };
      })
    };
  });
  await writeFile(join(evidence, 'native-large-text-geometry.json'), JSON.stringify(enlarged, null, 2));
  await native.screenshot(join(evidence, 'native-large-text-forced-colors-overview.png'));
  assert.equal(enlarged.forcedColors, true, 'Native forced colors must be active');
  assert.notEqual(enlarged.leaveColor, enlarged.leaveBackground, 'Forced-colors leave label must remain visible');
  // Combining a 28px root font with forced colors is an additional stress case,
  // not browser zoom. Record global overflow; actual control reachability and
  // labels remain strict below, as do normal layouts and the real zoom suite.
  if (enlarged.scrollWidth > enlarged.clientWidth) {
    console.warn('Native enlarged-text stress: additional horizontal scroll width', enlarged);
  }
  // The active room intentionally hides server-settings; check the controls
  // actually offered here. Server editing is covered by the real-zoom UX flow.
  for (const control of ['settings-back', 'release-channel', 'open-updates', 'diagnostics-summary', 'copy-again', 'leave']) {
    const result = await bridge.evaluate(id => {
      const popup = chrome.extension.getViews({ type: 'popup' })[0];
      const element = popup.document.getElementById(id);
      // Guard against focusing a control disabled by a pending action.
      if (!element.disabled) element.focus();
      element.scrollIntoView({ block: 'center' });
      const rect = element.getBoundingClientRect();
      const main = popup.document.querySelector('main');
      const mainRect = main.getBoundingClientRect();
      const visibleLeft = Math.max(0, mainRect.left + main.clientLeft);
      const visibleTop = Math.max(0, mainRect.top + main.clientTop);
      return {
        visible: element.checkVisibility(), left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
        visibleLeft, visibleTop,
        visibleRight: Math.min(popup.innerWidth, mainRect.left + main.clientLeft + main.clientWidth),
        visibleBottom: Math.min(popup.innerHeight, mainRect.top + main.clientTop + main.clientHeight),
        // Inputs/selects have native internal scrolling; button/summary labels must fit.
        labelFits: !element.matches('button, summary') || element.scrollWidth <= element.clientWidth
      };
    }, control);
    await native.screenshot(join(evidence, `native-large-text-forced-colors-${control}.png`));
    assert.ok(result.visible && result.left >= result.visibleLeft && result.right <= result.visibleRight &&
      result.top >= result.visibleTop && result.bottom <= result.visibleBottom && result.labelFits,
    `native enlarged text: ${control} reachable with readable label: ${JSON.stringify(result)}`);
  }
  await mkdir(evidence, { recursive: true });
  await writeFile(join(evidence, 'e2e-popup.json'), JSON.stringify({ passed }, null, 2));
  console.log(`PASS ${passed.length} native toolbar popup states`);
} finally {
  await native?.close();
  await context?.close();
  await new Promise(resolve => { unavailable.close(resolve); unavailable.closeAllConnections(); });
  await rm(profile, { recursive: true, force: true });
}
