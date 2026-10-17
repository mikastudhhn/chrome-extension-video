// First-run steps inside the popup: fresh profile, resumable progress, reopen from settings.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

process.env.TEST_ONBOARDING = '1';
const { chromium, evidence } = await import('./browser-test-context.js');
const base = process.env.TEST_SERVER || 'http://127.0.0.1:8787';
const extension = resolve(process.env.TEST_EXTENSION || 'extension');
const passed = [], errors = [];
let context, profile;
await mkdir(evidence, { recursive: true });

async function until(label, check, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timeout: ${label}`);
}
async function record(name, run) { await run(); passed.push(name); console.log(`PASS ${name}`); }

async function openPopup() {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).hostname;
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await popup.waitForFunction(() => document.querySelector('main')?.getAttribute('aria-busy') === 'false');
  return { popup, worker };
}
const stored = (page, key) => page.evaluate(async key => (await chrome.storage.local.get(key))[key], key);
const step = page => page.evaluate(() => document.getElementById('onboarding').dataset.step);
async function shot(page, name) {
  await page.locator('body').screenshot({ path: join(evidence, `onboarding-${name}.png`) });
  const size = await page.evaluate(() => ({ height: document.body.getBoundingClientRect().height, width: document.documentElement.scrollWidth }));
  assert.ok(size.height <= 600, `${name} needs vertical scrolling: ${size.height}px`);
  assert.ok(size.width <= 360, `${name} overflows horizontally`);
}

try {
  profile = await mkdtemp(join(tmpdir(), 'video-sync-onboarding-'));
  context = await chromium.launchPersistentContext(profile, {
    headless: true, viewport: { width: 360, height: 600 },
    ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : { channel: 'chromium' }),
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
  });
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  let { popup } = await openPopup();

  await record('a fresh installation opens with the welcome step and hides the player', async () => {
    await until('onboarding pending', async () => (await stored(popup, 'onboarding'))?.completedAt == null);
    assert.equal(await popup.locator('#onboarding').isVisible(), true);
    assert.equal(await popup.locator('#player-page').isVisible(), false);
    assert.equal(await popup.locator('#update-banner').isVisible(), false);
    assert.equal(await step(popup), 'welcome');
    await shot(popup, 'welcome');
  });

  await record('website access can be postponed and the step remembers where the user is', async () => {
    await popup.locator('#onboarding-start').click();
    assert.equal(await step(popup), 'permission');
    assert.equal(await popup.locator('#onboarding-allow').isVisible(), true);
    assert.equal(await popup.locator('#onboarding-back').isVisible(), true);
    await shot(popup, 'permission');
    assert.equal((await stored(popup, 'onboarding')).step, 1);
    await popup.locator('#onboarding-permission-skip').click();
    assert.equal(await step(popup), 'server');
  });

  await record('the server step checks reachability before saving and offers to keep an unreachable address', async () => {
    assert.equal(await popup.locator('#onboarding-server').inputValue(), 'http://localhost:8787');
    await popup.locator('#onboarding-server').fill('http://127.0.0.1:1');
    await popup.locator('#onboarding-server-check').click();
    await until('unreachable message', () => popup.locator('#onboarding-message').isVisible());
    assert.match(await popup.locator('#onboarding-message').textContent(), /nicht erreichbar|nicht rechtzeitig/);
    assert.equal(await popup.locator('#onboarding-server-anyway').isVisible(), true);
    assert.equal(await step(popup), 'server');
    assert.notEqual(await stored(popup, 'server'), 'http://127.0.0.1:1');
    await shot(popup, 'server-unreachable');
    await popup.locator('#onboarding-server').fill(base);
    assert.equal(await popup.locator('#onboarding-server-anyway').isVisible(), false);
    await shot(popup, 'server');
    await popup.locator('#onboarding-server-check').click();
    await until('server saved', async () => await stored(popup, 'server') === base);
    await until('updates step', async () => await step(popup) === 'updates');
  });

  await record('updates need no token: the GitHub grant is skippable and the token optional', async () => {
    const panel = popup.locator('.onboarding-step[data-step="updates"]');
    assert.doesNotMatch(await panel.innerText(), /privat/i);
    assert.equal(await popup.locator('#onboarding-updates-allow').isVisible(), true);
    assert.equal(await popup.locator('#onboarding-updates-skip').isVisible(), true);
    assert.equal(await popup.locator('#onboarding-token-save').isVisible(), false);
    assert.equal(await popup.locator('#onboarding-token').isVisible(), false);
    await shot(popup, 'updates');
    await popup.locator('#onboarding-token-details > summary').click();
    await popup.locator('#onboarding-token').fill('fixture-only');
    assert.equal(await popup.locator('#onboarding-token-save').isVisible(), true);
    assert.equal(await popup.locator('#onboarding-updates-allow').isVisible(), false);
    await shot(popup, 'updates-token');
    await popup.locator('#onboarding-token').fill('');
    assert.equal(await popup.locator('#onboarding-token-save').isVisible(), false);
    assert.equal(await popup.locator('#onboarding-updates-allow').isVisible(), true);
    assert.equal(await stored(popup, 'githubToken'), undefined);
  });

  await record('updates and appearance steps apply their choices immediately', async () => {
    await popup.locator('#onboarding-updates-skip').click();
    assert.equal(await step(popup), 'appearance');
    await popup.locator('#onboarding-theme').selectOption('dark');
    await until('dark theme applied', () => popup.evaluate(() => document.documentElement.dataset.theme === 'dark'));
    assert.equal(await stored(popup, 'theme'), 'dark');
    assert.equal(await popup.locator('#theme').inputValue(), 'dark');
    await shot(popup, 'appearance-dark');
    await popup.locator('#onboarding-theme').selectOption('light');
    await until('light theme applied', () => popup.evaluate(() => document.documentElement.dataset.theme === 'light'));
    await popup.locator('#onboarding-channel').selectOption('experimental');
    await until('channel switched', async () => await stored(popup, 'channel') === 'experimental');
    await until('channel select enabled', () => popup.locator('#onboarding-channel').isEnabled());
    await popup.locator('#onboarding-appearance-next').click();
    assert.equal(await step(popup), 'done');
    await shot(popup, 'done');
  });

  await record('finishing shows the player and never asks again', async () => {
    await popup.locator('#onboarding-finish').click();
    await until('completed', async () => !!(await stored(popup, 'onboarding'))?.completedAt);
    assert.equal(await popup.locator('#onboarding').isVisible(), false);
    assert.equal(await popup.locator('#player-page').isVisible(), true);
    assert.equal(await popup.locator('#allow-all').isVisible(), true);
    await popup.reload();
    await popup.waitForFunction(() => document.querySelector('main')?.getAttribute('aria-busy') === 'false');
    assert.equal(await popup.locator('#onboarding').isVisible(), false);
    assert.equal(await popup.locator('#player-page').isVisible(), true);
  });

  await record('an interrupted run resumes at its stored step', async () => {
    await popup.evaluate(() => chrome.storage.local.set({ onboarding: { version: 1, step: 2, completedAt: null, skipped: false } }));
    await popup.reload();
    await popup.waitForFunction(() => document.querySelector('main')?.getAttribute('aria-busy') === 'false');
    assert.equal(await popup.locator('#onboarding').isVisible(), true);
    assert.equal(await step(popup), 'server');
    assert.equal(await popup.locator('#onboarding-server').inputValue(), base);
    await popup.locator('#onboarding-back').click();
    assert.equal(await step(popup), 'permission');
    await popup.evaluate(() => chrome.storage.local.set({ onboarding: { version: 1, step: 0, completedAt: 1, skipped: true } }));
  });

  await record('settings reopen the steps and the settings page hides them while open', async () => {
    await popup.reload();
    await popup.waitForFunction(() => document.querySelector('main')?.getAttribute('aria-busy') === 'false');
    await popup.locator('#open-settings').click();
    await popup.locator('#open-onboarding').click();
    await until('welcome again', async () => await step(popup) === 'welcome');
    assert.equal(await popup.locator('#onboarding').isVisible(), true);
    assert.equal(await popup.locator('#settings').isVisible(), false);
    await popup.locator('#open-settings').click();
    assert.equal(await popup.locator('#settings').isVisible(), true);
    assert.equal(await popup.locator('#onboarding').isVisible(), false);
    await popup.locator('#settings-back').click();
    assert.equal(await popup.locator('#onboarding').isVisible(), true);
    await popup.locator('#onboarding-later').click();
    await until('completed again', async () => !!(await stored(popup, 'onboarding'))?.completedAt);
    assert.equal(await popup.locator('#player-page').isVisible(), true);
  });

  assert.deepEqual(errors, [], 'No page errors');
  await writeFile(join(evidence, 'e2e-onboarding.json'), JSON.stringify({ passed }, null, 2));
  console.log(`PASS ${passed.length} onboarding scenarios`);
} finally {
  await context?.close();
  if (profile) await rm(profile, { recursive: true, force: true });
}
