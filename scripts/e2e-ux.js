import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

import { chromium, evidence, recordDiagnostic, selectChannel } from './browser-test-context.js';
const base = process.env.TEST_SERVER || 'http://127.0.0.1:8787';
const extension = resolve(process.env.TEST_EXTENSION || 'extension');
const channel = process.env.TEST_CHANNEL || 'stable';
assert.ok(['stable', 'experimental'].includes(channel));
const contexts = [], profiles = [], passed = [], errors = [];
await mkdir(evidence, { recursive: true });

async function until(label, check) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timeout: ${label}`);
}
async function record(name, run) { await run(); passed.push(name); console.log(`PASS ${name}`); }
async function shot(browser, name) {
  await browser.popup.locator('body').screenshot({ path: join(evidence, `ux-${name}.png`) });
  const size = await browser.popup.evaluate(() => ({ height: document.body.getBoundingClientRect().height, width: document.documentElement.scrollWidth }));
  assert.ok(size.height <= 600, `${name} needs vertical scrolling: ${size.height}px`);
  assert.ok(size.width <= 360, `${name} overflows horizontally`);
}
async function openProfile() {
  const profile = await mkdtemp(join(tmpdir(), 'video-sync-ux-'));
  profiles.push(profile);
  const context = await chromium.launchPersistentContext(profile, {
    headless: true, viewport: { width: 360, height: 600 },
    ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : { channel: 'chromium' }),
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
  });
  contexts.push(context);
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  await worker.evaluate(channel => chrome.storage.local.set({ channel }), channel);
  const id = new URL(worker.url()).hostname;
  const video = await context.newPage();
  await video.goto(base);
  await video.waitForFunction(() => document.querySelector('video').readyState >= 3);
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await popup.waitForFunction(() => document.querySelector('main')?.getAttribute('aria-busy') === 'false');
  await selectChannel(popup);
  await until('popup initialized', () => popup.locator('main').getAttribute('aria-busy').then(value => value === 'false'));
  const status = async () => {
    const response = await popup.evaluate(() => (window.__testStatusRequest || chrome.runtime.sendMessage.bind(chrome.runtime))({ target: 'background', type: 'ui', action: 'status' }));
    assert.equal(response?.ok, true, JSON.stringify({ error: response?.error, failure: response?.failure }));
    assert.ok(response.result && typeof response.result === 'object', 'Status response contains a state object');
    return response.result;
  };
  return { context, video, popup, status };
}
async function attach(browser) {
  await browser.video.bringToFront();
  await browser.popup.locator('#attach').dispatchEvent('click');
  await browser.popup.locator('#lobby').waitFor({ state: 'visible' });
  await browser.popup.bringToFront();
}
let host, guest;
try {
  host = await openProfile();
  await record('first use shows one setup action and keeps room controls out of the way', async () => {
    assert.equal(await host.popup.locator('#allow-all').isVisible(), true);
    assert.equal(await host.popup.locator('#lobby').isVisible(), false);
    assert.equal(await host.popup.locator('#settings').isVisible(), false);
    await shot(host, 'setup');
    await attach(host);
    assert.equal(await host.popup.locator('#setup').isVisible(), false);
    assert.equal(await host.popup.locator('#video-summary').isVisible(), true);
    await shot(host, 'lobby');
  });
  await record('invalid invitation stays local and gives an accessible correction', async () => {
    await host.popup.locator('#code').fill('nicht vollständig');
    await host.popup.locator('#code').press('Tab');
    assert.equal(await host.popup.locator('#join').isDisabled(), true);
    assert.equal(await host.popup.locator('#code').getAttribute('aria-invalid'), 'true');
    assert.match(await host.popup.locator('#join-hint').textContent(), /6-stelligen/);
    assert.equal((await host.status()).room, null);
    await host.popup.locator('#code').fill('');
  });
  await record('server settings persist explicitly and invalid drafts survive navigation without replacing storage', async () => {
    await host.popup.locator('#open-settings').click();
    await host.popup.locator('#server').fill(base);
    await host.popup.locator('#server').press('Enter');
    await host.popup.waitForFunction(() => document.getElementById('server-feedback').textContent === 'Serveradresse gespeichert.');
    await host.popup.reload();
    await host.popup.locator('#open-settings').click();
    assert.equal(await host.popup.locator('#server').inputValue(), base);
    await host.popup.locator('#server').fill('https://invalid.example.test/path');
    await host.popup.locator('#server-save').click();
    assert.equal(await host.popup.locator('#server').getAttribute('aria-invalid'), 'true');
    assert.equal(await host.popup.evaluate(() => document.activeElement.id), 'server');
    assert.equal(await host.popup.evaluate(async () => (await chrome.storage.local.get('server')).server), base);
    await host.popup.locator('#settings-back').click();
    await host.popup.locator('#open-settings').click();
    assert.equal(await host.popup.locator('#server').inputValue(), 'https://invalid.example.test/path');
    await host.popup.locator('#server-cancel').click();
    assert.equal(await host.popup.locator('#server').inputValue(), base);
    await host.popup.locator('#server').fill('https://unsaved.example.test');
    await host.popup.reload();
    await host.popup.locator('#open-settings').click();
    assert.equal(await host.popup.locator('#server').inputValue(), base);
    await shot(host, 'saved-server');
    await host.popup.locator('#settings-back').click();
  });
  let invitation;
  await record('creating a room copies a real invitation with the actual server', async () => {
    await host.popup.locator('#open-settings').press('Enter');
    assert.equal(await host.popup.locator('#settings').isVisible(), true);
    assert.equal(await host.popup.locator('#player-page').isVisible(), false);
    assert.equal(await host.popup.evaluate(() => document.activeElement.id), 'settings-back');
    await host.popup.locator('#server').fill(base);
    if (await host.popup.locator('#server-save').isEnabled()) {
      await host.popup.locator('#server-save').click();
      await host.popup.waitForFunction(() => document.getElementById('server-feedback').textContent === 'Serveradresse gespeichert.');
    }
    await host.popup.locator('#settings-back').press('Enter');
    assert.equal(await host.popup.evaluate(() => document.activeElement.id), 'open-settings');
    await host.popup.locator('#open-settings').click();
    assert.equal(await host.popup.locator('#server').inputValue(), base);
    await host.popup.locator('#settings-back').click();
    await host.popup.locator('#create').click();
    await host.popup.locator('#copy').waitFor({ state: 'visible' });
    assert.equal(await host.popup.locator('#ready').isVisible(), false);
    assert.equal(await host.popup.locator('#video-summary').isVisible(), true);
    assert.equal(await host.popup.locator('#members').isVisible(), true);
    await until('invitation focus', async () => await host.popup.evaluate(() => document.activeElement.id) === 'copy');
    await shot(host, 'inviting');
    await host.popup.locator('#copy').click();
    await until('copy feedback', async () => (await host.popup.locator('#copy').textContent()).includes('kopiert'));
    invitation = await host.popup.evaluate(() => navigator.clipboard.readText());
    assert.ok(invitation.includes(`Server: ${base}`));
    assert.ok(invitation.includes((await host.status()).room.code));
  });
  guest = await openProfile();
  await attach(guest);
  await record('an invitation for another server asks first and joins without replacing the saved server', async () => {
    const storedServer = () => guest.popup.evaluate(async () => (await chrome.storage.local.get('server')).server ?? null);
    const storedBefore = await storedServer();
    assert.notEqual(await guest.popup.locator('#server').inputValue(), base);
    await guest.popup.locator('#code').fill(invitation);
    assert.equal(await guest.popup.locator('#join').isEnabled(), true);
    await guest.popup.locator('#code').press('Enter');
    await guest.popup.locator('#server-confirm').waitFor({ state: 'visible' });
    assert.equal(await guest.popup.locator('#server-confirm-title').textContent(), `Unbekannter Server ${new URL(base).host} – beitreten?`);
    assert.equal(await guest.popup.evaluate(() => document.activeElement.id), 'server-confirm-join');
    assert.equal((await guest.status()).room, null, 'nothing is joined before the confirmation');
    await guest.popup.locator('#server-confirm-cancel').click();
    assert.equal(await guest.popup.locator('#server-confirm').isVisible(), false);
    assert.equal((await guest.status()).room, null);
    await guest.popup.locator('#code').press('Enter');
    await guest.popup.locator('#server-confirm-join').click();
    await until('both connected', async () => (await host.status()).room?.connected && (await guest.status()).room?.connected);
    assert.equal((await guest.status()).room.server, base);
    assert.equal(await storedServer(), storedBefore, 'the invitation server is used only for this room');
    assert.equal((await guest.status()).room.code, (await host.status()).room.code);
    await until('ready button visible', () => host.popup.locator('#ready').isVisible());
    assert.equal(await host.popup.locator('#invite').isVisible(), false);
    assert.match(await host.popup.locator('#instruction').textContent(), /am selben Moment/);
    await shot(host, 'aligning');
  });
  await record('alignment explains who is ready and then reveals shared playback', async () => {
    await host.popup.locator('#ready').click();
    await until('own ready shown', async () => (await host.popup.locator('#status').textContent()) === 'Du bist bereit');
    await shot(host, 'waiting-for-scene');
    await guest.popup.locator('#ready').click();
    await host.popup.locator('#playback').waitFor({ state: 'visible' });
    assert.equal(await host.popup.locator('#ready').isVisible(), false);
    assert.equal(await host.popup.locator('#connection-detail').isVisible(), false);
    assert.equal(await host.popup.locator('#resync').isVisible(), false);
    assert.equal(await host.popup.locator('#change-video').isVisible(), true);
    assert.equal(await host.popup.locator('#members').isVisible(), true);
    assert.match(await host.popup.locator('#peer-ready').innerText(), /Verbunden/);
    await shot(host, 'paused');
    await host.popup.locator('#play').click();
    await until('both playing', async () => !(await host.status()).local.paused && !(await guest.status()).local.paused);
    await until('playing heading', async () => (await host.popup.locator('#status').textContent()) === 'Wiedergabe');
    await shot(host, 'playing');
    await guest.popup.getByRole('button', { name: 'Pause', exact: true }).click();
    await until('both paused', async () => (await host.status()).local.paused && (await guest.status()).local.paused);
  });
  await record('one scene confirmation waits for a delayed pause on host and guest', async () => {
    await host.popup.locator('#open-settings').click();
    await host.popup.locator('#resync').click();
    for (const [role, browser] of [['host', host], ['guest', guest]]) {
      await browser.video.evaluate(async () => {
        const video = document.querySelector('video');
        window.restorePause = video.pause.bind(video);
        video.pause = () => setTimeout(() => window.restorePause(), 700);
        await video.play();
      });
      try {
        await browser.popup.locator('#ready').click();
        await until(`${role} delayed pause confirmed`, async () => (await host.status()).room.state.members[role].ready);
        const state = await browser.status();
        assert.equal(state.local.paused, true);
        assert.ok(Math.abs((await host.status()).room.state.anchors[role] - state.local.time) < 0.1);
      } finally {
        await browser.video.evaluate(() => { document.querySelector('video').pause = window.restorePause; });
      }
    }
    await until('both delayed confirmations synchronized', async () => (await guest.status()).room.state.phase === 'synced');
    await shot(guest, 'delayed-pause-confirmed');
  });
  await record('a delayed guest popup refresh waits for the Pause action instead of sending Play again', async () => {
    await until('guest shows paused control', () => guest.popup.getByRole('button', { name: 'Abspielen', exact: true }).isVisible());
    await guest.popup.evaluate(async () => {
      const original = chrome.runtime.sendMessage.bind(chrome.runtime);
      const frozen = await original({ target: 'background', type: 'ui', action: 'status' });
      window.__testStatusRequest = original;
      window.__testHoldStatus = true;
      chrome.runtime.sendMessage = async (message, ...args) => {
        const response = await original(message, ...args);
        return window.__testHoldStatus && message.type === 'ui' && message.action === 'status' ? frozen : response;
      };
    });
    try {
      await host.popup.getByRole('button', { name: 'Abspielen', exact: true }).click();
      await until('both playing behind stale guest view', async () => !(await host.status()).local.paused && !(await guest.status()).local.paused);
      assert.equal(await guest.popup.locator('#play').getAttribute('data-control'), 'play');
      recordDiagnostic({ type: 'ux-stale-control', actual: 'both playing', displayedGuestAction: 'play' });
      // Release only the deliberately delayed presentation on the next update.
      // The same user-facing locator as the main flow must wait for Pause.
      const clicked = guest.popup.getByRole('button', { name: 'Pause', exact: true }).click();
      await guest.popup.evaluate(() => { window.__testHoldStatus = false; });
      await clicked;
      await until('both paused after the displayed Pause action', async () => (await host.status()).local.paused && (await guest.status()).local.paused);
    } finally {
      await guest.popup.evaluate(() => {
        chrome.runtime.sendMessage = window.__testStatusRequest;
        delete window.__testStatusRequest;
        delete window.__testHoldStatus;
      });
    }
  });
  await record('settings navigation, realignment and the main video-change action work across updates', async () => {
    await host.popup.locator('#show-video').click();
    assert.equal(await host.popup.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0].url), `${base}/`);
    await host.popup.bringToFront();
    await host.popup.locator('#open-settings').click();
    await new Promise(resolve => setTimeout(resolve, 800));
    assert.equal(await host.popup.locator('#settings').isVisible(), true);
    assert.equal(await host.popup.locator('#playback').isVisible(), false);
    assert.equal(await host.popup.locator('#change-video').isVisible(), false);
    assert.equal(await host.popup.locator('#resync').isVisible(), true);
    await shot(host, 'settings');
    await host.popup.locator('#resync').click();
    await until('alignment reset', async () => (await guest.status()).room.state.phase === 'aligning');
    await host.popup.locator('#ready').waitFor({ state: 'visible' });
    assert.equal(await host.popup.locator('#settings').isVisible(), false);
    await host.popup.locator('#open-settings').click();
    await host.popup.locator('#leave').click();
    await until('both left', async () => !(await host.status()).room && !(await guest.status()).room);
    await host.popup.locator('#lobby').waitFor({ state: 'visible' });
    assert.equal(await host.popup.locator('#setup').isVisible(), false);
    const previousTab = (await host.status()).tabId;
    const nextVideo = await host.context.newPage();
    await nextVideo.goto(`${base}/?video=next`);
    await nextVideo.waitForFunction(() => document.querySelector('video').readyState >= 3);
    await nextVideo.bringToFront();
    const startedBusy = await host.popup.locator('#change-video').evaluate(button => {
      button.click();
      return document.querySelector('main').getAttribute('aria-busy');
    });
    assert.equal(startedBusy, 'true', 'Video replacement starts its UI action synchronously');
    await host.popup.waitForFunction(() => document.querySelector('main').getAttribute('aria-busy') === 'false', null, { timeout: 15000 });
    // Discovery precedes attach, which invalidates reads from the old generation.
    // Read the resulting state only after that user action has completed.
    await until('new video attached', async () => {
      const state = await host.status();
      return state.local && state.tabId !== previousTab;
    });
    const selectedUrl = await host.popup.evaluate(async () => {
      const { result } = await chrome.runtime.sendMessage({ target: 'background', type: 'ui', action: 'status' });
      return (await chrome.tabs.get(result.tabId)).url;
    });
    assert.equal(selectedUrl, `${base}/?video=next`);
    assert.equal(await host.popup.locator('#lobby').isVisible(), true);
    assert.equal(await host.popup.locator('#settings').isVisible(), false);
  });
  await record('long video metadata and keyboard paths survive real browser zoom and forced colors', async () => {
    // Chrome normalizes trailing whitespace in document/tab titles.
    const title = 'Eine lange Folge mit vollständigem zugänglichem Titel — '.repeat(8).trim();
    const selectedTab = (await host.status()).tabId;
    await host.popup.evaluate(async ({ selectedTab, title }) => chrome.scripting.executeScript({ target: { tabId: selectedTab }, func: title => { document.title = title; }, args: [title] }), { selectedTab, title });
    await until('full video name', async () => (await host.popup.locator('#show-video').getAttribute('aria-label')).includes(title));
    assert.equal(await host.popup.locator('#show-video').getAttribute('title'), title);
    assert.equal(await host.popup.locator('#position').getAttribute('aria-live'), 'off');
    await shot(host, 'long-title');
    await host.popup.setViewportSize({ width: 640, height: 1000 });
    await host.popup.evaluate(async () => chrome.tabs.setZoom((await chrome.tabs.getCurrent()).id, 2));
    assert.equal(await host.popup.evaluate(async () => chrome.tabs.getZoom((await chrome.tabs.getCurrent()).id)), 2);
    await host.popup.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
    await host.popup.locator('#open-settings').focus();
    await host.popup.keyboard.press('Enter');
    assert.equal(await host.popup.evaluate(() => document.activeElement.id), 'settings-back');
    for (const id of ['server', 'release-channel', 'open-updates']) {
      await host.popup.locator(`#${id}`).focus();
      await host.popup.locator(`#${id}`).scrollIntoViewIfNeeded();
      const bounds = await host.popup.locator(`#${id}`).evaluate(element => {
        const rect = element.getBoundingClientRect();
        return { focused: element === document.activeElement, left: rect.left, right: rect.right, viewport: innerWidth };
      });
      assert.equal(bounds.focused, true);
      assert.ok(bounds.left >= 0 && bounds.right <= bounds.viewport);
    }
    await host.popup.screenshot({ path: join(evidence, 'ux-browser-zoom-forced-colors.png') });
    await host.popup.evaluate(async () => chrome.tabs.setZoom((await chrome.tabs.getCurrent()).id, 1));
    await host.popup.emulateMedia({ forcedColors: 'none', reducedMotion: 'no-preference' });
    await host.popup.setViewportSize({ width: 360, height: 600 });
  });
  assert.deepEqual(errors, []);
  await writeFile(join(evidence, 'e2e-ux.json'), JSON.stringify({ passed, errors }, null, 2));
} catch (error) {
  for (const [name, browser] of [['host', host], ['guest', guest]]) if (browser) {
    console.error(name, await browser.status(), 'page errors', errors);
    await browser.popup.screenshot({ path: join(evidence, `ux-${name}-failure.png`), fullPage: true }).catch(() => {});
  }
  throw error;
} finally {
  for (const context of contexts) await context.close();
  for (const profile of profiles) await rm(profile, { recursive: true, force: true });
}
