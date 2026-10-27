// Chrome Web Store package: first run without the GitHub step, no release
// stream or updater anywhere, and the frozen server as the default.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.TEST_ONBOARDING = '1';
const { chromium, evidence } = await import('./browser-test-context.js');
const extension = resolve(process.env.TEST_EXTENSION || 'extension');
const { DEFAULT_SERVER } = await import(pathToFileURL(join(extension, 'config.js')).href);
const passed = [], errors = [];
let context, profile;

async function until(label, check, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timeout: ${label}`);
}
async function record(name, run) { await run(); passed.push(name); console.log(`PASS ${name}`); }
const stored = (page, key) => page.evaluate(async key => (await chrome.storage.local.get(key))[key], key);
const step = page => page.evaluate(() => document.getElementById('onboarding').dataset.step);
const ui = (page, action, extra = {}) => page.evaluate(message => chrome.runtime.sendMessage(message), { target: 'background', type: 'ui', action, ...extra });

try {
  profile = await mkdtemp(join(tmpdir(), 'video-sync-store-'));
  context = await chromium.launchPersistentContext(profile, {
    headless: true, viewport: { width: 360, height: 600 },
    ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : { channel: 'chromium' }),
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
  });
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).hostname;
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await popup.waitForFunction(() => document.querySelector('main')?.getAttribute('aria-busy') === 'false');

  await record('the package carries no updater: no alarms, no release stream, updates disabled', async () => {
    assert.equal(await worker.evaluate(() => typeof chrome.alarms), 'undefined');
    const manifest = await worker.evaluate(() => chrome.runtime.getManifest());
    assert.deepEqual(manifest.permissions.includes('alarms'), false);
    assert.equal(manifest.host_permissions, undefined);
    assert.equal(manifest.optional_permissions, undefined);
    const status = await ui(popup, 'status');
    assert.equal(status.ok, true);
    assert.equal(status.result.store, true);
    assert.deepEqual(status.result.channels, []);
    assert.equal(status.result.updates, null);
    assert.equal((await ui(popup, 'update-check')).result, null);
    const switched = await ui(popup, 'set-channel', { channel: 'experimental' });
    assert.equal(switched.ok, false);
    assert.match(switched.error, /Chrome Web Store/);
    for (const action of ['update-install', 'update-restore', 'update-verify-repair', 'update-configure']) {
      const response = await ui(popup, action, { token: 'x' });
      assert.equal(response.ok, false, action);
      assert.match(response.error, /Chrome Web Store/, action);
    }
    // A rejected request must not leave the update lock behind.
    assert.equal(await worker.evaluate(async () => (await chrome.storage.session.get('updateLock')).updateLock), undefined);
    assert.equal((await ui(popup, 'status')).ok, true);
  });

  await record('first run has five steps and goes from the server straight to appearance', async () => {
    assert.equal(await step(popup), 'welcome');
    assert.equal(await popup.locator('#onboarding-stepper').getAttribute('aria-label'), 'Schritt 1 von 5');
    assert.equal(await popup.locator('#onboarding-stepper .step-dot:visible').count(), 5);
    await popup.locator('#onboarding-start').click();
    await popup.locator('#onboarding-permission-skip').click();
    assert.equal(await step(popup), 'server');
    assert.equal(await popup.locator('#onboarding-server').inputValue(), DEFAULT_SERVER);
    // Saving the server asks Chrome for access to it; that native dialog cannot be
    // answered here. The stored index after the server step must be appearance.
    await popup.evaluate(() => chrome.storage.local.set({ onboarding: { version: 1, step: 3, completedAt: null, skipped: false } }));
    await popup.reload();
    await popup.waitForFunction(() => document.querySelector('main')?.getAttribute('aria-busy') === 'false');
    assert.equal(await step(popup), 'appearance');
    assert.equal(await popup.locator('#onboarding-stepper').getAttribute('aria-label'), 'Schritt 4 von 5');
    assert.equal(await popup.locator('#onboarding-channel').isVisible(), false);
    assert.equal(await popup.locator('#onboarding-channel-hint').isVisible(), false);
    await popup.locator('#onboarding-back').click();
    assert.equal(await step(popup), 'server');
    assert.equal((await stored(popup, 'onboarding')).step, 2);
    await popup.evaluate(() => chrome.storage.local.set({ onboarding: { version: 1, step: 3, completedAt: null, skipped: false } }));
    await popup.reload();
    await popup.waitForFunction(() => document.querySelector('main')?.getAttribute('aria-busy') === 'false');
    await popup.locator('#onboarding-appearance-next').click();
    assert.equal(await step(popup), 'done');
    assert.equal((await stored(popup, 'onboarding')).step, 4);
    await popup.locator('#onboarding-finish').click();
    await until('completed', async () => !!(await stored(popup, 'onboarding'))?.completedAt);
    await popup.locator('body').screenshot({ path: join(evidence, 'store-player.png') });
  });

  await record('settings show the version without release stream, channel badge or updates', async () => {
    assert.equal(await popup.locator('#channel-label').isVisible(), false);
    assert.equal(await popup.locator('#update-banner').isVisible(), false);
    await popup.locator('#open-settings').click();
    assert.equal(await popup.locator('#settings').isVisible(), true);
    assert.equal(await popup.locator('#release-channel-row').isVisible(), false);
    assert.equal(await popup.locator('#channel-hint').isVisible(), false);
    assert.equal(await popup.locator('#open-updates').isVisible(), false);
    assert.equal(await popup.locator('#open-onboarding').isVisible(), true);
    assert.match(await popup.locator('#edition').innerText(), /^Chrome Web Store \d+\.\d+\.\d+/);
    await popup.locator('body').screenshot({ path: join(evidence, 'store-settings.png') });
  });

  assert.deepEqual(errors, [], 'No page errors');
  await writeFile(join(evidence, 'e2e-store.json'), JSON.stringify({ passed }, null, 2));
  console.log(`PASS ${passed.length} store scenarios`);
} finally {
  await context?.close();
  if (profile) await rm(profile, { recursive: true, force: true });
}
