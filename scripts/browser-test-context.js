import { mkdir, writeFile } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { loadedExtensionIdentities } from './browser-test-package.js';

const playwright = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
export const evidence = resolve(process.env.TEST_RESULTS || 'test-results');
await mkdir(evidence, { recursive: true });
let sequence = 0;
const active = new Set();

export function recordDiagnostic(event) {
  appendFileSync(join(evidence, 'timing.jsonl'), JSON.stringify({ at: Date.now(), ...event }) + '\n');
}

export const chromium = {
  async launchPersistentContext(profile, options) {
    // Update checks run without a token, so every installation would contact
    // GitHub on its own. Suites use worker fetch fixtures; real GitHub hosts
    // stay unresolvable so live releases never change a test result.
    options = { ...options, args: [...(options.args || []),
      '--host-resolver-rules=MAP api.github.com ~NOTFOUND, MAP release-assets.githubusercontent.com ~NOTFOUND'] };
    const context = await playwright.chromium.launchPersistentContext(profile, options);
    active.add(context);
    // Suites test the working popup; the first-run steps have their own suite (TEST_ONBOARDING=1).
    if (process.env.TEST_ONBOARDING !== '1') {
      const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
      await worker.evaluate(() => chrome.storage.local.set({ onboarding: { version: 1, step: 0, completedAt: 1, skipped: true } }));
    }
    const name = `context-${++sequence}`;
    const extensions = await loadedExtensionIdentities(options.args);
    // Retain the single-installation fields used by existing evidence readers.
    const primary = extensions.length === 1 ? extensions[0] : null;
    await writeFile(join(evidence, `${name}-identity.json`), JSON.stringify({ profile, extensions,
      extension: primary?.extension || null, metadata: primary?.metadata || null,
      manifestSha256: primary?.manifestSha256 || null,
      browser: context.browser()?.version(), executable: options.executablePath || playwright.chromium.executablePath(),
      headless: options.headless, args: options.args }, null, 2) + '\n');
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    const record = event => recordDiagnostic({ context: name, ...event });
    context.on('console', message => {
      if (['error', 'warning'].includes(message.type())) record({ type: 'console', level: message.type(), text: message.text() });
    });
    const observe = page => {
      page.on('pageerror', error => record({ type: 'pageerror', error: error.message }));
      page.on('crash', () => record({ type: 'crash', url: page.url() }));
    };
    context.on('page', observe);
    for (const page of context.pages()) observe(page);
    await context.exposeBinding('__videoSyncTestEvent', ({ page }, event) => record({ page: page.url(), ...event }));
    await context.addInitScript(() => {
      const emit = event => { void window.__videoSyncTestEvent({ browserAt: performance.timeOrigin + performance.now(), ...event }).catch(() => {}); };
      for (const type of ['play', 'playing', 'pause', 'seeking', 'seeked', 'waiting', 'ended', 'ratechange']) {
        document.addEventListener(type, event => {
          if (!(event.target instanceof HTMLMediaElement)) return;
          const video = event.target;
          emit({ type: 'media', event: type, time: video.currentTime, paused: video.paused,
            seeking: video.seeking, readyState: video.readyState, rate: video.playbackRate });
        }, true);
      }
      document.addEventListener('click', event => {
        const button = event.target.closest?.('button');
        if (button) emit({ type: 'click', id: button.id, control: button.dataset.control, text: button.textContent });
      }, true);
    });
    const close = context.close.bind(context);
    let closing;
    context.close = () => closing ||= (async () => {
      try {
        let index = 0;
        for (const page of context.pages()) {
          if (page.isClosed()) continue;
          await page.screenshot({ path: join(evidence, `${name}-page-${++index}.png`), timeout: 2000 }).catch(error => record({ type: 'screenshot-error', error: error.message }));
        }
        await context.tracing.stop({ path: join(evidence, `${name}-trace.zip`) });
      } finally { await close(); active.delete(context); }
    })();
    return context;
  }
};

// The parent owns process-group termination. Give normal cancellation a chance
// to flush traces before its bounded final cleanup terminates any descendants.
process.once('SIGTERM', async () => {
  await Promise.allSettled([...active].map(context => context.close()));
  process.exit(143);
});

export async function selectChannel(page, channel = process.env.TEST_CHANNEL) {
  if (!channel) return;
  const response = await page.evaluate(channel => chrome.runtime.sendMessage({ target: 'background', type: 'ui', action: 'set-channel', channel }), channel);
  if (!response?.ok) throw new Error(response?.error || 'Channel selection failed');
  if (response.result.channel !== channel) throw new Error(`Expected ${channel}, received ${response.result.channel}`);
  recordDiagnostic({ type: 'channel', channel });
}
