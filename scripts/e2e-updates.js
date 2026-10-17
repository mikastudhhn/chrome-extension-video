// Isolated browser tests for release/local channels and update coordination.
// GitHub responses are fixtures; native folder consent remains a manual test.
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareDevelopment } from './development-build.js';
import { startHelper } from './development-helper.js';
import { createServer } from '../server/index.js';

import { chromium, evidence } from './browser-test-context.js';
import { uiRequest } from './browser-test-api.js';
import { generateKeyPairSync, createHash } from 'node:crypto';
import { signUpdateAsset } from './release-signing.js';
import { packageFile } from '../extension/package-files.js';
// Installation fixtures are signed with a key generated for this run. Only the
// temporary copy of the release package trusts it (release-key.js replaced);
// the candidate itself and the production key stay untouched.
const testKey = (() => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { privateKey, publicKey: publicKey.export({ format: 'jwk' }) };
})();
async function signedInstallFixture({ files, commit, candidateTag, version, id = 101 }) {
  const entries = await Promise.all(Object.entries(files).map(([path, content]) => packageFile(path, new TextEncoder().encode(content), 'utf8')));
  const body = JSON.stringify({ schema: 1, repository: 'mikastudhhn/chrome-extension-video', channel: 'experimental', commit, candidateTag, version, files: entries });
  const signature = await signUpdateAsset({ bytes: new TextEncoder().encode(body), tag: candidateTag, channel: 'experimental', asset: 'update.json', privateKey: testKey.privateKey, publicKey: testKey.publicKey });
  const entry = (assetId, name, text) => ({ id: assetId, name, state: 'uploaded', size: Buffer.byteLength(text), digest: `sha256:${createHash('sha256').update(text).digest('hex')}` });
  return { release: { tag_name: candidateTag, target_commitish: commit, prerelease: true, assets: [entry(id, 'update.json', body), entry(id + 1, 'update.json.sig', signature)] },
    bodies: { [id]: body, [id + 1]: signature } };
}
const root = await mkdtemp(join(tmpdir(), 'video-sync-update-tests-'));
await mkdir('dist', { recursive: true });
const localBuildRoot = await mkdtemp('dist/update-tests-');
const local = await prepareDevelopment(join(localBuildRoot, 'extension'));
const helper = await startHelper(local.local.helper);
helper.update({ state: 'ready', branch: local.local.branch, buildId: local.local.buildId });
const errors = [], passed = [];
const server = createServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const record = async (name, run) => { await run(); passed.push(name); console.log(`PASS ${name}`); };
const wait = async check => { for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)); } throw new Error('UI state did not arrive'); };
await mkdir(evidence, { recursive: true });
async function openOptions(page) {
  if (!await page.locator('#updates-options').evaluate(element => element.open)) {
    await page.locator('#updates-options > summary').click();
  }
}
try {
  for (const mode of ['release', 'local']) {
    const extension = join(root, mode, 'extension');
    await cp(mode === 'local' ? local.directory : (process.env.TEST_RELEASE_EXTENSION || 'extension'), extension, { recursive: true });
    const installedCandidateTag = mode === 'local' ? null : JSON.parse(await readFile(join(extension, 'build-info.json'), 'utf8')).candidateTag || 'v0.5.0-preview.30';
    const initialManifest = await readFile(join(extension, 'manifest.json'), 'utf8');
    if (mode === 'release') await writeFile(join(extension, 'release-key.js'), `export const RELEASE_PUBLIC_KEY = Object.freeze(${JSON.stringify(testKey.publicKey)});\n`);
    const context = await chromium.launchPersistentContext(join(root, mode, 'profile'), {
      headless: true, viewport: { width: 360, height: 600 },
      ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : { channel: 'chromium' }),
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
    });
    try {
      const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
      // Command-line sideloading initially works even with developer mode off,
      // but Chrome disables unpacked extensions at their first reload then.
      const manager = await context.newPage();
      await manager.goto('chrome://extensions');
      await manager.getByRole('button', { name: /^(Entwicklermodus|Developer mode)$/ }).click();
      await manager.close();
      const url = worker.url().replace('background.js', 'popup.html');
      const popup = await context.newPage();
      popup.on('pageerror', error => errors.push(error.message));
      await popup.goto(url);
      assert.equal(await popup.title(), 'Video Sync');
      const video = await context.newPage();
      await video.goto(base);
      await video.waitForFunction(() => document.querySelector('video')?.readyState >= 3);
      const videoTabId = await popup.evaluate(async base => (await chrome.tabs.query({})).find(tab => tab.url === `${base}/`).id, base);
      const api = (page, action, extra = {}) => uiRequest(page, action, extra);
      await popup.locator('#open-settings').click();
      await wait(async () => !(await popup.locator('main').getAttribute('aria-busy') === 'true'));
      if (mode === 'local') await wait(async () => (await popup.locator('#release-channel option').count()) === 3);
      const options = await popup.locator('#release-channel option').allTextContents();
      await record(`${mode}: correct channel choices and persisted switch`, async () => {
        if (mode === 'release') {
          assert.equal(await popup.locator('#development-controls').count(), 0);
          assert.equal(await popup.locator('#dev-pause').count(), 0);
          assert.equal((await api(popup, 'status')).development, undefined);
        }
        assert.equal(await popup.locator('#development-controls').count(), 0);
        assert.equal((await popup.locator('#open-updates').innerText()).split('\n')[0], 'Updates');
        assert.deepEqual(options, ['Stable', 'Experimental', ...(mode === 'local' ? [`Dev · ${local.local.branch}`] : [])]);
        // Every channel uses the package's single runtime document.
        for (const channel of ['stable', 'experimental', ...(mode === 'local' ? ['local'] : [])]) {
          await popup.locator('#release-channel').selectOption(channel);
          await wait(() => popup.locator('#release-channel').isEnabled());
          await wait(async () => (await api(popup, 'status')).channel === channel);
          const contexts = await worker.evaluate(() => chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }));
          assert.deepEqual(contexts.map(context => new URL(context.documentUrl).pathname), ['/offscreen.html']);
          await api(popup, 'attach', { tabId: videoTabId });
          await wait(async () => !!(await api(popup, 'status')).local);
        }
        await popup.reload(); await popup.locator('#open-settings').click();
        await wait(async () => await popup.locator('#release-channel').inputValue() === (mode === 'local' ? 'local' : 'experimental'));
        assert.equal(await popup.evaluate(() => document.documentElement.scrollWidth), 360);
        await popup.locator('body').screenshot({ path: join(evidence, `${mode}-channels.png`) });
      });
      const updates = await context.newPage();
      updates.on('pageerror', error => errors.push(error.message));
      await updates.goto(url);
      const openUpdates = async () => {
        await updates.bringToFront();
        await updates.locator('#open-settings').click();
        await updates.locator('#open-updates').click();
      };
      const reloadUpdates = async () => {
        await updates.reload(); await openUpdates();
        await wait(async () => await updates.locator('#updates-content').getAttribute('aria-busy') === 'false');
      };
      await openUpdates();
      await record(`${mode}: updates stay in the popup with working back navigation`, async () => {
        const pages = context.pages().length;
        assert.equal(updates.url(), url);
        assert.equal(await updates.locator('#updates-page').isVisible(), true);
        assert.equal(await updates.locator('#settings').isVisible(), false);
        assert.equal(await updates.locator('iframe').count(), 0);
        await updates.locator('#updates-back').click();
        assert.equal(await updates.locator('#settings').isVisible(), true);
        assert.equal(await updates.locator('#open-updates').evaluate(element => element === document.activeElement), true);
        await updates.locator('#open-updates').click();
        assert.equal(context.pages().length, pages);
        const ids = await updates.locator('[id]').evaluateAll(elements => elements.map(element => element.id));
        assert.equal(new Set(ids).size, ids.length);
      });
      await wait(async () => await updates.locator('#updates-heading').innerText() !== 'Updates werden geladen …');
      await record(`${mode}: optional installed Preview number persists and stays specific to Experimental`, async () => {
        const initialChannel = (await api(updates, 'status')).channel;
        const selectChannel = async channel => {
          await updates.locator('#updates-back').click();
          await updates.locator('#release-channel').selectOption(channel);
          await wait(() => updates.locator('#release-channel').isEnabled());
          await wait(async () => (await api(updates, 'status')).channel === channel);
          await updates.locator('#open-updates').click();
          await wait(async () => (await updates.locator('#updates-installed').innerText()).startsWith(channel === 'local' ? 'Dev' : channel === 'stable' ? 'Stable' : 'Experimental'));
        };
        if (initialChannel !== 'experimental') await selectChannel('experimental');
        await openOptions(updates);
        await wait(() => updates.locator('#updates-show-preview').isVisible());
        assert.equal(await updates.locator('#updates-show-preview').isChecked(), false);
        const numericVersion = (await api(updates, 'status')).engineVersion;
        await openOptions(updates);
        await updates.locator('#updates-show-preview').check();
        const displayedVersion = installedCandidateTag?.slice(1) || numericVersion;
        await wait(async () => (await updates.locator('#updates-installed').innerText()).includes(`Experimental · ${displayedVersion}`));
        await reloadUpdates();
        await wait(async () => await updates.locator('#updates-show-preview').isChecked());
        assert.ok((await updates.locator('#updates-installed').innerText()).includes(displayedVersion));
        await updates.locator('#updates-back').click();
        await wait(async () => (await updates.locator('#edition').innerText()).includes(displayedVersion));
        await updates.locator('#open-updates').click();
        await selectChannel('stable');
        assert.equal(await updates.locator('#updates-preview-setting').isVisible(), false);
        assert.doesNotMatch(await updates.locator('#updates-installed').innerText(), /preview/);
        await selectChannel('experimental');
        assert.equal(await updates.locator('#updates-show-preview').isChecked(), true);
        await updates.screenshot({ path: join(evidence, `${mode}-preview-version.png`), fullPage: true });
        await openOptions(updates);
        await updates.locator('#updates-show-preview').uncheck();
        await wait(async () => !(await updates.locator('#updates-installed').innerText()).includes('preview'));
        if (initialChannel !== 'experimental') await selectChannel(initialChannel);
        await reloadUpdates();
      });
      await record(`${mode}: Preview preference survives a background still running the previous build`, async () => {
        const initialChannel = (await api(updates, 'status')).channel;
        await api(updates, 'set-channel', { channel: 'experimental' });
        await reloadUpdates();
        await updates.evaluate(() => {
          const send = chrome.runtime.sendMessage.bind(chrome.runtime);
          window.legacyStatusResponses = 0;
          chrome.runtime.sendMessage = async message => {
            const response = await send(message);
            if (['status', 'update-status'].includes(message.action) && response?.ok) {
              delete response.result.showExperimentalPreview;
              delete response.result.experimentalTag;
              window.legacyStatusResponses++;
            }
            return response;
          };
        });
        await openOptions(updates);
        await updates.locator('#updates-show-preview').check();
        // Idle views no longer poll. Explicit visibility refreshes exercise the
        // same old-background responses without relying on the removed timer.
        await updates.bringToFront();
        for (let refresh = 0; refresh < 4; refresh++) {
          const before = await updates.evaluate(() => window.legacyStatusResponses);
          await updates.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
          await wait(async () => await updates.evaluate(before => window.legacyStatusResponses > before, before));
        }
        assert.ok(await updates.evaluate(() => window.legacyStatusResponses >= 4));
        assert.equal(await updates.locator('#updates-show-preview').isChecked(), true);
        assert.equal(await updates.evaluate(async () => (await chrome.storage.local.get('showExperimentalPreview')).showExperimentalPreview), true);
        await reloadUpdates();
        assert.equal(await updates.locator('#updates-show-preview').isChecked(), true);
        await openOptions(updates);
        await updates.locator('#updates-show-preview').uncheck();
        await wait(async () => !(await api(updates, 'status')).showExperimentalPreview);
        await api(updates, 'set-channel', { channel: initialChannel });
        await reloadUpdates();
      });
      await record(`${mode}: a status response started before a click cannot overwrite the new selection`, async () => {
        const initialChannel = (await api(updates, 'status')).channel;
        await api(updates, 'set-channel', { channel: 'experimental' });
        const race = await context.newPage();
        race.on('pageerror', error => errors.push(error.message));
        try {
          // Drive refresh explicitly so the old response is guaranteed to arrive
          // after the user's change, not just whichever timing CI happens to get.
          await race.addInitScript(() => { window.setInterval = () => 0; });
          await race.goto(url.replace('popup.html', 'updates.html'));
          await wait(async () => await race.locator('#updates-content').getAttribute('aria-busy') === 'false');
          await race.evaluate(async () => {
            const { mountUpdates } = await import('./updates.js');
            window.raceView = mountUpdates(document.getElementById('updates-content'));
            await window.raceView.refresh();
            const send = chrome.runtime.sendMessage.bind(chrome.runtime);
            let holdNext = true;
            chrome.runtime.sendMessage = async message => {
              const response = await send(message);
              if (holdNext && message.action === 'update-status') {
                holdNext = false;
                response.result.experimentalTag = 'v0.5.0-preview.1';
                return new Promise(resolve => { window.releaseStaleStatus = () => resolve(response); });
              }
              return response;
            };
            window.staleRefresh = window.raceView.refresh();
          });
          await wait(async () => await race.evaluate(() => !!window.releaseStaleStatus));
          await openOptions(race);
          await race.locator('#updates-show-preview').check();
          await wait(async () => await race.locator('#updates-content').getAttribute('aria-busy') === 'false');
          const versionAfterClick = await race.locator('#updates-installed').innerText();
          await race.evaluate(async () => { window.releaseStaleStatus(); await window.staleRefresh; });
          assert.equal(await race.locator('#updates-show-preview').isChecked(), true);
          assert.equal(await race.locator('#updates-installed').innerText(), versionAfterClick);
          assert.ok(versionAfterClick.includes(installedCandidateTag?.slice(1) || (await api(updates, 'status')).engineVersion));
          await openOptions(race);
          await race.locator('#updates-show-preview').uncheck();
          await wait(async () => !(await api(updates, 'status')).showExperimentalPreview);
        } finally { await race.close(); }
        await api(updates, 'set-channel', { channel: initialChannel });
        await reloadUpdates();
      });
      if (mode === 'local') {
        await record('local: shared update settings include Dev controls and follow the selected channel', async () => {
          assert.equal(await updates.locator('#updates-local-panel').isVisible(), true);
          assert.equal(await updates.locator('#updates-release-panel').isVisible(), true);
          // The optional token stays collapsed: it is not needed for updates.
          assert.equal(await updates.locator('#updates-setup > summary').isVisible(), true);
          assert.equal(await updates.locator('#updates-token').isVisible(), false);
          assert.equal(await updates.locator('#updates-dev-pause').isVisible(), true);
          assert.equal(await updates.locator('#updates-local-reload').isVisible(), true);
          await updates.locator('#updates-dev-pause').click();
          await wait(async () => (await updates.locator('#updates-dev-pause').getAttribute('aria-pressed')) === 'true');
          await updates.locator('#updates-dev-pause').click();
          await wait(async () => (await updates.locator('#updates-dev-pause').getAttribute('aria-pressed')) === 'false');
          await assert.rejects(api(updates, 'update-install'), /Entwicklungsbuilds/);
          assert.match(await updates.locator('#updates-installed').innerText(), new RegExp(local.local.branch));
          await worker.evaluate(checkoutCommit => {
            const original = fetch;
            globalThis.fetch = (input, options) => String(input).startsWith('https://api.github.com/')
              ? Promise.resolve(new Response(JSON.stringify([
                { tag_name: 'v9.0.0', target_commitish: checkoutCommit, prerelease: false, assets: [{ name: 'update.json', state: 'uploaded' }] },
                { tag_name: 'v9.0.1-preview.1', target_commitish: 'b'.repeat(40), prerelease: true, assets: [{ name: 'update.json', state: 'uploaded' }] }
              ]))) : original(input, options);
          }, local.commit);
          await api(updates, 'update-configure', { token: 'fixture-only' });
          for (const channel of ['stable', 'experimental', 'local']) {
            await updates.locator('#updates-back').click();
            assert.equal((await updates.locator('#open-updates').innerText()).split('\n')[0], 'Updates');
            assert.equal(await updates.locator('#settings #updates-dev-pause').count(), 0);
            await updates.locator('#release-channel').selectOption(channel);
            await wait(() => updates.locator('#release-channel').isEnabled());
            await wait(async () => (await api(updates, 'status')).channel === channel);
            await updates.locator('#open-updates').click();
            await wait(async () => (await updates.locator('#updates-installed').innerText()).startsWith(channel === 'local' ? 'Dev' : channel === 'stable' ? 'Stable' : 'Experimental'));
            assert.equal(await updates.locator('#updates-release-panel').isVisible(), true);
            assert.equal(await updates.locator('#updates-local-panel').isVisible(), true);
            assert.equal(await updates.locator('#updates-install').isVisible(), false);
            assert.equal(await updates.locator('#updates-check').isVisible(), channel !== 'local');
            assert.equal(await updates.locator('#updates-dev-pause').isVisible(), channel === 'local');
            assert.equal(await updates.locator('#updates-local-reload').isVisible(), channel === 'local');
            if (channel !== 'local') {
              await updates.locator('#updates-check').click();
              await wait(async () => await updates.locator('#updates-heading').innerText() === (channel === 'stable' ? 'Alles aktuell' : 'Update verfügbar'));
              await assert.rejects(api(updates, 'update-install'), /Entwicklungsbuilds/);
            } else assert.equal(await updates.locator('#updates-heading').innerText(), 'Lokaler Entwicklungsstand');
            await updates.screenshot({ path: join(evidence, `local-updates-${channel}.png`), fullPage: true });
          }
          await api(updates, 'update-configure', { token: '' });
        });
      } else {
        await record('release: public releases are checked without a token; the optional token stays available', async () => {
          assert.equal(await updates.locator('#updates-release-panel').isVisible(), true);
          assert.equal(await updates.locator('#updates-install').isVisible(), false);
          assert.doesNotMatch(await updates.locator('#updates-release-panel').innerText(), /einrichten/);
          assert.equal(await updates.locator('#updates-token').isVisible(), false);
          assert.equal(await updates.locator('#updates-forget-token').isVisible(), false);
          assert.equal(await worker.evaluate(async () => (await chrome.alarms.get('check-github-updates'))?.periodInMinutes), 30);
          // Fixture only: no real token or network request is used by this test.
          await worker.evaluate(() => {
            const original = fetch;
            globalThis.githubAuthorization = [];
            globalThis.fetch = (input, options) => {
              if (!String(input).startsWith('https://api.github.com/')) return original(input, options);
              globalThis.githubAuthorization.push(options?.headers?.Authorization || null);
              return Promise.resolve(new Response(JSON.stringify([{ id: 1, tag_name: 'v9.0.0-preview.1', target_commitish: 'b'.repeat(40), name: 'Experimental fixture', draft: false, prerelease: true,
                published_at: '2026-09-18T00:00:00Z', assets: [{ name: 'update.json', state: 'uploaded' }] }]), { headers: { 'Content-Type': 'application/json' } }));
            };
          });
          await api(updates, 'update-check');
          await reloadUpdates();
          await wait(() => updates.locator('#updates-install').isVisible());
          assert.equal(await updates.locator('#updates-heading').innerText(), 'Update verfügbar');
          assert.equal(await updates.locator('#updates-access-status').innerText(), 'Optional');
          assert.equal(await updates.locator('#updates-token').isVisible(), false);
          assert.deepEqual(await worker.evaluate(() => globalThis.githubAuthorization), [null]);
          await wait(() => popup.locator('#update-banner').isVisible());
          await updates.screenshot({ path: join(evidence, 'release-public.png'), fullPage: true });
          await updates.locator('#updates-setup > summary').click();
          assert.equal(await updates.locator('#updates-token').isVisible(), true);
          assert.match(await updates.locator('#updates-token-description').innerText(), /Optional/);
          assert.equal(await updates.locator('#updates-forget-token').isVisible(), false);
          await updates.screenshot({ path: join(evidence, 'release-setup.png'), fullPage: true });
          await updates.locator('#updates-setup > summary').click();
          await api(updates, 'update-configure', { token: 'fixture-only' });
          await reloadUpdates();
          await wait(() => updates.locator('#updates-install').isVisible());
          assert.equal(await updates.locator('#updates-heading').innerText(), 'Update verfügbar');
          assert.match(await updates.locator('#updates-target').innerText(), /^v9\.0\.0-preview\.1$/);
          assert.match(await updates.locator('#updates-last-check').innerText(), /Zuletzt geprüft: .* · automatisch alle 30 Minuten und beim Öffnen\./);
          assert.match(await updates.locator('#updates-changelog').getAttribute('href'), /releases\/tag\/v9\.0\.0-preview\.1$/);
          assert.equal(await updates.locator('#updates-access-status').innerText(), 'Zugang geprüft');
          assert.equal(await updates.locator('#updates-check').isVisible(), false);
          assert.equal(await updates.locator('#updates-options').getAttribute('open'), null);
          await wait(() => popup.locator('#update-banner').isVisible());
          const pages = context.pages().length;
          await popup.locator('#update-banner-details').click();
          assert.equal(await popup.locator('#updates-page').isVisible(), true);
          assert.equal(popup.url(), url);
          assert.equal(context.pages().length, pages);
          await popup.locator('#updates-back').click();
          assert.match(await updates.locator('#updates-release-link').getAttribute('href'), /\/releases\/tag\/v9\.0\.0-preview\.1$/);
          assert.equal(await readFile(join(extension, 'manifest.json'), 'utf8'), initialManifest);
          await api(popup, 'set-channel', { channel: 'stable' });
          const stable = await api(updates, 'update-check');
          assert.equal(stable.available, false);
          assert.equal(stable.releaseState, 'no-release');
          await reloadUpdates();
          assert.equal(await updates.locator('#updates-heading').innerText(), 'Kein passendes Release');
          await api(popup, 'set-channel', { channel: 'experimental' });
        });
        await record('release: access errors never claim a connection, preserve success time and respect rate limits', async () => {
          const successfulAt = (await api(updates, 'status')).updates.lastSuccessfulCheckAt;
          await worker.evaluate(() => { globalThis.releaseFixtureFetch = fetch; });
          for (const [status, headers, label, errorText] of [
            [401, {}, 'Ungültig / abgelaufen', /ungültig oder abgelaufen/],
            [403, {}, 'Berechtigung fehlt', /Repository/],
            [500, {}, 'Derzeit nicht prüfbar', /nicht erreichbar/],
            [429, { 'retry-after': '300' }, 'Anfragelimit erreicht', /Anfragelimit/]
          ]) {
            await worker.evaluate(({ status, headers }) => {
              const original = globalThis.releaseFixtureFetch;
              globalThis.fetch = (input, options) => String(input).startsWith('https://api.github.com/')
                ? Promise.resolve(new Response(JSON.stringify({ message: 'fixture-secret-must-not-appear' }), { status, headers })) : original(input, options);
            }, { status, headers });
            await api(updates, 'update-check');
            await reloadUpdates();
            assert.equal(await updates.locator('#updates-access-status').innerText(), label);
            assert.match(await updates.locator('#updates-update-status').innerText(), errorText);
            assert.doesNotMatch(await updates.locator('body').innerText(), /fixture-secret-must-not-appear|Verbunden/);
            assert.equal((await api(updates, 'status')).updates.lastSuccessfulCheckAt, successfulAt);
            assert.equal(await updates.locator('#updates-install').isVisible(), false);
            assert.equal(await updates.locator('#updates-check').isDisabled(), status === 429);
            assert.equal(await updates.locator('#updates-check').isVisible(), status !== 401);
            assert.equal(await updates.locator('#updates-last-check').isVisible(), status !== 401 && status !== 403);
            await updates.screenshot({ path: join(evidence, `release-access-${status}.png`), fullPage: true });
          }
          await worker.evaluate(() => { globalThis.fetch = globalThis.releaseFixtureFetch; });
          await api(updates, 'update-configure', { token: 'fixture-replacement' });
          await reloadUpdates();
          await wait(() => updates.locator('#updates-install').isVisible());
        });
        await record('release: active rooms block folder actions before picker or permission requests', async () => {
          await updates.bringToFront();
          assert.equal(await updates.evaluate(() => document.hidden), false);
          await updates.evaluate(() => {
            window.roomPickerCalls = 0;
            window.showDirectoryPicker = async () => { window.roomPickerCalls++; throw new DOMException('cancel', 'AbortError'); };
          });
          await api(popup, 'attach', { tabId: videoTabId });
          await api(popup, 'create', { server: base });
          // A new room returns every popup to its player view. Reopen Updates
          // through the visible navigation before checking its room guard.
          await wait(() => updates.locator('#updates-page').isHidden());
          await openUpdates();
          await wait(() => updates.locator('#updates-install').isDisabled());
          assert.equal(await updates.locator('#updates-room-block').isVisible(), true);
          await updates.locator('#updates-options > summary').click();
          assert.equal(await updates.locator('#updates-folder').isDisabled(), true);
          // Calling the handler also exercises its defensive guard, independently
          // of the browser suppressing clicks on disabled buttons.
          await updates.evaluate(() => document.getElementById('updates-folder').onclick());
          assert.equal(await updates.evaluate(() => window.roomPickerCalls), 0);
          await assert.rejects(api(popup, 'update-install'), /Raum verlassen/);
          await api(popup, 'leave');
          await reloadUpdates();
          await wait(() => updates.locator('#updates-install').isEnabled());
        });
        await record('release: first folder selection can be cancelled without an error or update', async () => {
          await updates.evaluate(() => {
            window.pickerCalls = [];
            window.showDirectoryPicker = async options => {
              window.pickerCalls.push({ ...options, active: navigator.userActivation.isActive });
              throw new DOMException('The user aborted a request.', 'AbortError');
            };
            // Native host-permission dialogs cannot be automated; record the
            // request for GitHub downloads and grant it like the dialog would.
            window.githubPermissionRequests = [];
            chrome.permissions.request = async request => { window.githubPermissionRequests.push({ ...request, active: navigator.userActivation.isActive }); return true; };
          });
          await wait(async () => await updates.locator('#updates-install').isEnabled());
          assert.equal(await updates.locator('#updates-install').getAttribute('aria-label'), 'Ordner wählen & aktualisieren');
          await updates.locator('#updates-install').click();
          await wait(async () => await updates.locator('#updates-message').innerText() !== '');
          assert.match(await updates.locator('#updates-message').innerText(), /Ordnerauswahl abgebrochen/);
          assert.equal(await updates.locator('#updates-error').isVisible(), false);
          assert.deepEqual(await updates.evaluate(() => window.githubPermissionRequests), [{ origins: ['https://api.github.com/*', 'https://release-assets.githubusercontent.com/*'], active: true }]);
          assert.deepEqual(await updates.evaluate(() => window.pickerCalls), [{ id: 'video-sync-installation', mode: 'readwrite', startIn: 'downloads', active: true }]);
          assert.equal(await updates.evaluate(async () => (await import('./update-storage.js')).stored('directory')), undefined);
          assert.equal(await readFile(join(extension, 'manifest.json'), 'utf8'), initialManifest);
        });
        await record('release: saved folder survives reload, cancellation and denied write access', async () => {
          // OPFS provides a real serializable handle for storage/UI coverage only.
          // It cannot validate the external installation or native permission UI.
          await updates.evaluate(async () => {
            const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle('saved-extension', { create: true });
            await (await import('./update-storage.js')).stored('directory', directory);
          });
          await reloadUpdates();
          await wait(async () => await updates.locator('#updates-folder-status').textContent() === 'saved-extension');
          assert.equal(await updates.locator('#updates-folder').isVisible(), false);
          await updates.locator('#updates-options > summary').click();
          assert.equal(await updates.locator('#updates-folder').isVisible(), true);
          assert.equal(await updates.locator('#updates-setup').getAttribute('open'), null);
          assert.equal(await updates.locator('#updates-install').getAttribute('aria-label'), 'Jetzt aktualisieren');
          await updates.evaluate(() => {
            window.pickerCalls = [];
            window.permissionCalls = [];
            window.showDirectoryPicker = async options => {
              window.pickerCalls.push({ startIn: options.startIn.name, active: navigator.userActivation.isActive });
              throw new DOMException('The user aborted a request.', 'AbortError');
            };
            FileSystemDirectoryHandle.prototype.queryPermission = async () => 'prompt';
            FileSystemDirectoryHandle.prototype.requestPermission = async options => {
              window.permissionCalls.push({ ...options, active: navigator.userActivation.isActive });
              return 'denied';
            };
            chrome.permissions.request = async () => true;
          });
          await updates.locator('#updates-folder').click();
          await wait(async () => await updates.locator('#updates-folder').isEnabled());
          assert.match(await updates.locator('#updates-message').innerText(), /bleibt ausgewählt/);
          assert.equal(await updates.locator('#updates-folder-warning').isVisible(), false);
          assert.equal(await updates.locator('#updates-error').isVisible(), false);
          assert.deepEqual(await updates.evaluate(() => window.pickerCalls), [{ startIn: 'saved-extension', active: true }]);
          assert.deepEqual(await updates.evaluate(() => window.permissionCalls), []);
          await updates.locator('#updates-install').click();
          await wait(async () => await updates.locator('#updates-install').isEnabled());
          assert.match(await updates.locator('#updates-error').innerText(), /Dein Ordner bleibt gespeichert/);
          assert.deepEqual(await updates.evaluate(() => window.permissionCalls), [{ mode: 'readwrite', active: true }]);
          assert.equal(await updates.evaluate(() => window.pickerCalls.length), 1);
          assert.equal(await updates.evaluate(async () => (await (await import('./update-storage.js')).stored('directory')).name), 'saved-extension');
          assert.equal(await readFile(join(extension, 'manifest.json'), 'utf8'), initialManifest);
          await updates.evaluate(() => { FileSystemDirectoryHandle.prototype.queryPermission = async () => 'denied'; });
          await updates.locator('#updates-folder').click();
          await wait(async () => await updates.locator('#updates-folder').isEnabled());
          assert.match(await updates.locator('#updates-folder-warning').innerText(), /Schreibzugriff gesperrt/);
        });
        await record('release: invalid replacement keeps the saved folder and installation help opens its Chrome details', async () => {
          await updates.evaluate(() => {
            window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('empty-folder', { create: true });
          });
          await updates.locator('#updates-folder').click();
          await wait(async () => await updates.locator('#updates-folder').isEnabled());
          assert.match(await updates.locator('#updates-error').innerText(), /keine vollständige Video-Sync-Installation/);
          assert.equal(await updates.evaluate(async () => (await (await import('./update-storage.js')).stored('directory')).name), 'saved-extension');
          await updates.locator('#updates-folder-help summary').click();
          const opened = context.waitForEvent('page');
          await updates.locator('#updates-show-installation').click();
          const details = await opened;
          await details.waitForURL(`chrome://extensions/?id=${new URL(url).hostname}`);
          await details.close();
          assert.equal(await updates.evaluate(() => document.documentElement.scrollWidth), 360);
          await updates.screenshot({ path: join(evidence, 'release-folder-help.png'), fullPage: true });
        });
        await record('release: compact settings keep update, retry and account actions discoverable', async () => {
          const available = (await worker.evaluate(() => chrome.storage.local.get('updateResults'))).updateResults;
          const current = { ...available, experimental: { ...available.experimental, available: false, releaseState: 'current', error: '', checkedAt: Date.now() } };
          await worker.evaluate(updateResults => chrome.storage.local.set({ updateResults }), current);
          await reloadUpdates();
          await wait(async () => await updates.locator('#updates-heading').innerText() === 'Alles aktuell');
          assert.equal(await updates.locator('#updates-check').isVisible(), true);
          assert.equal(await updates.locator('#updates-install').isVisible(), false);
          assert.equal(await updates.locator('#updates-folder').isVisible(), false);
          assert.equal(await updates.locator('#updates-token').isVisible(), false);
          assert.equal(await updates.locator('#updates-release-link').isVisible(), false);
          assert.equal(await updates.locator('#updates-message').isVisible(), false);
          assert.equal(await updates.evaluate(() => document.documentElement.scrollWidth), 360);
          assert.ok(await updates.locator('#updates-options').evaluate(element => element.getBoundingClientRect().bottom) < 600);
          if ((await api(updates, 'status')).engineVersion === JSON.parse(initialManifest).version) {
            assert.doesNotMatch(await updates.locator('#updates-installed').innerText(), /App/);
          }
          await updates.screenshot({ path: join(evidence, 'release-current-mobile.png'), fullPage: true });
          await updates.setViewportSize({ width: 1034, height: 800 });
          await updates.screenshot({ path: join(evidence, 'release-current-desktop.png'), fullPage: true });
          await updates.locator('#updates-options > summary').focus();
          await updates.keyboard.press('Enter');
          assert.equal(await updates.locator('#updates-folder').isVisible(), true);
          assert.equal(await updates.locator('#updates-release-link').isVisible(), true);
          await updates.locator('#updates-check').click();
          await wait(() => updates.locator('#updates-install').isVisible());
          assert.equal(await updates.locator('#updates-check').isVisible(), false);
          assert.equal(await updates.locator('#updates-folder').isVisible(), true);
          await updates.screenshot({ path: join(evidence, 'release-settings-desktop.png'), fullPage: true });
          await worker.evaluate(updateResults => chrome.storage.local.set({ updateResults }), {
            ...current, experimental: { ...current.experimental, error: 'GitHub ist gerade nicht erreichbar.' }
          });
          await reloadUpdates();
          await wait(async () => await updates.locator('#updates-heading').innerText() === 'Prüfung fehlgeschlagen');
          assert.match(await updates.locator('#updates-update-status').innerText(), /nicht erreichbar/);
          assert.equal(await updates.locator('#updates-install').isVisible(), false);
          await updates.locator('#updates-check').click();
          await wait(() => updates.locator('#updates-install').isVisible());
          await updates.screenshot({ path: join(evidence, 'release-available-desktop.png'), fullPage: true });
          await updates.setViewportSize({ width: 360, height: 600 });
          await updates.screenshot({ path: join(evidence, 'release-available-mobile.png'), fullPage: true });
          await updates.locator('#updates-options > summary').click();
          await updates.locator('#updates-setup > summary').click();
          // Removing the optional token keeps public updates working.
          await updates.locator('#updates-forget-token').click();
          await wait(async () => await updates.locator('#updates-access-status').innerText() === 'Optional');
          assert.equal(await updates.locator('#updates-heading').innerText(), 'Update verfügbar');
          assert.equal(await updates.locator('#updates-forget-token').isVisible(), false);
          assert.equal(await updates.locator('#updates-install').isVisible(), true);
          assert.equal(await worker.evaluate(() => globalThis.githubAuthorization.at(-1)), null);
          assert.equal(await worker.evaluate(async () => (await chrome.alarms.get('check-github-updates'))?.periodInMinutes), 30);
          await api(updates, 'update-configure', { token: 'fixture-only' });
          await reloadUpdates();
          await wait(() => updates.locator('#updates-install').isVisible());
        });
        await record('release: update actions remain keyboard accessible with zoom and forced colors', async () => {
          await updates.locator('#updates-changelog').focus();
          assert.equal(await updates.locator('#updates-changelog').evaluate(element => element === document.activeElement), true);
          await updates.keyboard.press('Tab');
          assert.equal(await updates.locator('#updates-install').evaluate(element => element === document.activeElement), true);
          await updates.emulateMedia({ forcedColors: 'active' });
          await updates.evaluate(() => { document.documentElement.style.zoom = '2'; });
          // At 200%, scrolling is allowed; every action must remain reachable.
          for (const selector of ['#updates-changelog', '#updates-install', '#updates-setup > summary', '#updates-options > summary']) {
            const control = updates.locator(selector);
            await control.focus();
            await control.scrollIntoViewIfNeeded();
            assert.equal(await control.evaluate(element => element === document.activeElement && element.checkVisibility()), true);
          }
          await updates.screenshot({ path: join(evidence, 'release-zoom-forced-colors.png'), fullPage: true });
          await updates.evaluate(() => { document.documentElement.style.zoom = ''; });
          await updates.emulateMedia({ forcedColors: 'none' });
        });
        await record('release: the separate update page centers on desktop and reflows long folder names at browser zoom', async () => {
          const standalone = await context.newPage();
          standalone.on('pageerror', error => errors.push(error.message));
          await standalone.setViewportSize({ width: 1034, height: 850 });
          await standalone.goto(url.replace('popup.html', 'updates.html'));
          await standalone.waitForFunction(() => document.getElementById('updates-heading').textContent !== 'Updates werden geladen …');
          const layout = await standalone.locator('body').evaluate(body => {
            const rect = body.getBoundingClientRect();
            return { width: rect.width, left: rect.left, right: innerWidth - rect.right, overflow: document.documentElement.scrollWidth > innerWidth };
          });
          assert.ok(layout.width > 500 && layout.width <= 680, 'dedicated desktop width');
          assert.ok(Math.abs(layout.left - layout.right) <= 1, 'centered desktop page');
          assert.equal(layout.overflow, false);
          await standalone.screenshot({ path: join(evidence, 'standalone-updates-desktop.png'), fullPage: true });
          const saved = await standalone.evaluate(async () => {
            const { stored } = await import('./update-storage.js');
            const before = await stored('directory');
            window.previousDirectory = before;
            const name = 'Video-Sync-Installationsordner-mit-einem-sehr-langen-Namen-'.repeat(3);
            const folder = await (await navigator.storage.getDirectory()).getDirectoryHandle(name, { create: true });
            await stored('directory', folder);
            return name;
          });
          // Refresh through the existing view navigation; no fixture renderer.
          await standalone.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
          await standalone.locator('#updates-options > summary').click();
          await wait(async () => await standalone.locator('#updates-folder-status').innerText() === saved);
          await standalone.evaluate(async () => chrome.tabs.setZoom((await chrome.tabs.getCurrent()).id, 2));
          assert.equal(await standalone.evaluate(async () => chrome.tabs.getZoom((await chrome.tabs.getCurrent()).id)), 2);
          await standalone.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
          for (const selector of ['#updates-folder', '#updates-release-link', '#updates-setup > summary']) {
            const control = standalone.locator(selector);
            await control.focus(); await control.scrollIntoViewIfNeeded();
            assert.equal(await control.evaluate(element => {
              const rect = element.getBoundingClientRect();
              return document.activeElement === element && rect.left >= 0 && rect.right <= innerWidth;
            }), true);
          }
          assert.equal(await standalone.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
          // Chromium tab zoom and Playwright's fullPage clip use different
          // coordinate spaces. Capture the actual visible viewport without a clip.
          await standalone.bringToFront();
          await standalone.locator('#updates-folder').focus();
          await standalone.locator('#updates-folder').scrollIntoViewIfNeeded();
          await standalone.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          const screenshotSession = await context.newCDPSession(standalone);
          try {
            const { data } = await screenshotSession.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
            await writeFile(join(evidence, 'standalone-browser-zoom-forced-colors-long-folder.png'), Buffer.from(data, 'base64'));
          } finally { await screenshotSession.detach(); }
          await standalone.evaluate(async () => {
            await chrome.tabs.setZoom((await chrome.tabs.getCurrent()).id, 1);
            await (await import('./update-storage.js')).stored('directory', window.previousDirectory);
          });
          await standalone.close();
        });
        await record('release: background installation survives a closed view and blocks concurrent mutations', async () => {
          // Real IndexedDB handles and writes, isolated in OPFS. Network and
          // installation proof are fixtures; no user installation is touched.
          await updates.evaluate(async () => {
            const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle('background-install', { create: true });
            for (const [name, content] of Object.entries({
              'manifest.json': JSON.stringify({ name: 'Video Sync', manifest_version: 3, version: '0.5.0' }),
              'build-info.json': JSON.stringify({ repository: 'mikastudhhn/chrome-extension-video', commit: 'a'.repeat(40), channel: 'experimental', local: null }), 'popup.js': 'previous popup'
            })) {
              const stream = await (await directory.getFileHandle(name, { create: true })).createWritable();
              await stream.write(content); await stream.close();
            }
            await (await import('./update-storage.js')).stored('directory', directory);
          });
          const commit = 'b'.repeat(40), candidateTag = 'v9.0.0-preview.7', version = '9.0.0.7';
          const installFixture = await signedInstallFixture({ commit, candidateTag, version, files: {
            'manifest.json': JSON.stringify({ name: 'Video Sync', manifest_version: 3, version }),
            'build-info.json': JSON.stringify({ schema: 2, repository: 'mikastudhhn/chrome-extension-video', commit, channel: 'experimental', candidateTag, local: null }),
            'background.js': '', 'features.js': '', 'popup.html': '', 'popup.js': 'updated popup',
            'offscreen.html': '', 'updates.html': '', 'updates.js': '' } });
          await worker.evaluate(async ({ release, bodies }) => {
            const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle('background-install');
            const originalFetch = fetch, originalReload = chrome.runtime.reload;
            const gate = new Promise(resolve => { globalThis.finishDownload = resolve; });
            globalThis.reloads = 0;
            chrome.runtime.reload = () => { globalThis.reloads++; };
            globalThis.resetUpdateFixture = () => { globalThis.fetch = originalFetch; chrome.runtime.reload = originalReload; };
            globalThis.fetch = async (input, options) => {
              const url = String(input);
              if (url.includes('/update-proof-')) return new Response(await (await (await directory.getFileHandle(new URL(url).pathname.slice(1))).getFile()).text());
              const asset = /\/releases\/assets\/(\d+)$/.exec(url)?.[1];
              if (asset === '101') { await gate; return new Response(bodies[asset]); }
              if (asset) return new Response(bodies[asset]);
              if (url.startsWith('https://api.github.com/')) return new Response(JSON.stringify([release]));
              return originalFetch(input, options);
            };
          }, installFixture);
          await api(updates, 'update-install');
          assert.equal((await api(popup, 'status')).updating, true);
          await assert.rejects(api(popup, 'set-channel', { channel: 'stable' }), /Update läuft/);
          await assert.rejects(api(popup, 'update-install'), /Update läuft/);
          await assert.rejects(api(popup, 'update-restore'), /Update läuft/);
          await assert.rejects(api(popup, 'create', { server: base }), /Update läuft/);
          await updates.close();
          assert.equal((await api(popup, 'status')).updating, true);
          await popup.bringToFront();
          if (!await popup.locator('#settings').isVisible()) await popup.locator('#open-settings').click();
          await popup.locator('#open-updates').click();
          await wait(async () => (await popup.locator('#updates-message').innerText()).includes('geladen'));
          assert.equal(await popup.locator('#updates-install').isDisabled(), true);
          await worker.evaluate(() => globalThis.finishDownload());
          await wait(async () => await worker.evaluate(() => globalThis.reloads === 1));
          assert.equal((await api(popup, 'status')).updating, false);
          assert.equal(await worker.evaluate(async () => {
            const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle('background-install');
            return (await (await directory.getFileHandle('popup.js')).getFile()).text();
          }), 'updated popup');
          await api(popup, 'update-restore');
          await wait(async () => await worker.evaluate(() => globalThis.reloads === 2));
          assert.equal(await worker.evaluate(async () => {
            const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle('background-install');
            return (await (await directory.getFileHandle('popup.js')).getFile()).text();
          }), 'previous popup');
          // A failed background operation releases its lock and remains visible
          // after reopening, without triggering a reload or losing the folder.
          await api(popup, 'update-restore');
          await wait(async () => !!(await api(popup, 'status')).updateOperation?.error);
          await wait(async () => (await popup.locator('#updates-error').innerText()).includes('Kein vorheriger Stand'));
          assert.equal((await api(popup, 'status')).updating, false);
          assert.equal(await worker.evaluate(() => globalThis.reloads), 2);
          await worker.evaluate(() => globalThis.resetUpdateFixture());
          await worker.evaluate(() => chrome.storage.session.remove('updateOperation'));
          await api(popup, 'set-channel', { channel: 'stable' });
          await api(popup, 'update-configure', { token: '' });
        });
      }
      if (!updates.isClosed()) await updates.screenshot({ path: join(evidence, `${mode}-updates.png`) });
      await record(`${mode}: reload activates disk changes and preserves channel selection`, async () => {
        if (mode === 'release') await worker.evaluate(async () => {
          await chrome.storage.local.set({ githubToken: 'fixture-only' });
          await chrome.alarms.create('check-github-updates', { periodInMinutes: 60 });
        });
        const manifest = JSON.parse(initialManifest);
        const numbers = manifest.version.split('.');
        numbers[numbers.length - 1] = String(Number(numbers.at(-1)) + 1);
        manifest.version = numbers.join('.');
        await writeFile(join(extension, 'manifest.json'), JSON.stringify(manifest));
        const nextWorker = context.waitForEvent('serviceworker', { predicate: candidate => candidate !== worker });
        if (mode === 'local') await updates.locator('#updates-local-reload').click();
        else await worker.evaluate(() => { setTimeout(() => chrome.runtime.reload(), 100); });
        const restarted = await nextWorker;
        assert.equal(await restarted.evaluate(() => chrome.runtime.getManifest().version), manifest.version);
        assert.equal(await restarted.evaluate(async () => (await chrome.storage.local.get('channel')).channel), mode === 'local' ? 'local' : 'stable');
        if (mode === 'release') {
          await wait(async () => await restarted.evaluate(async () => (await chrome.alarms.get('check-github-updates'))?.periodInMinutes === 30));
          assert.equal(await restarted.evaluate(async () => (await chrome.alarms.get('check-github-updates')).periodInMinutes), 30);
        }
      });
    } finally { await context.close(); }
  }
  assert.deepEqual(errors, []);
  await writeFile(join(evidence, 'results.json'), JSON.stringify({ passed, errors, viewport: '360 × 600', nativeFolderConsent: 'not automated', github: 'fixture responses',
    releaseKey: 'installation fixtures signed with a per-run test key; release-key.js replaced only in the temporary release copy' }, null, 2));
  console.log(`Evidence: ${evidence}`);
} finally {
  await helper.close();
  await rm(localBuildRoot, { recursive: true, force: true });
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
