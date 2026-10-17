// Shared-starter suite: real candidate runtime, IndexedDB, OPFS and restarts.
// The OPFS target and nonce-fetch mapping are fixtures, not native folder grants.
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { channelName } from '../extension/channels.js';
import { fileHashes, sha256 } from './browser-test-package.js';
import { recoveryCandidate, recoveryTarget } from './browser-test-recovery.js';

const candidate = await recoveryCandidate({ extension: process.env.TEST_EXTENSION, channel: process.env.TEST_CHANNEL });
const { chromium, evidence, recordDiagnostic, selectChannel } = await import('./browser-test-context.js');
const targetFiles = await recoveryTarget(candidate);
const root = await mkdtemp(join(tmpdir(), 'video-sync-recovery-'));
const extension = join(root, 'extension'), profile = join(root, 'profile');
const passed = [], runtimeIdentities = [];
const limits = [
  'Runtime loaded from a copy of the verified candidate ZIP; shared starter proves archive/update/commit identity.',
  'Only OPFS files are updated/restored; synthetic target is not a released GitHub package.',
  'Nonce-fetch mapping is a fixture; native external DirectoryHandle selection, permission persistence and OS writes are not tested.',
  'Fixture runner is suspended in an extension document; real worker performs UI restore. Extension reload and browser close/reopen are real; no power loss or physical storage durability claim.',
  'Broken Offscreen scenario uses a separately recorded fault derivative of the candidate copy.'
];
let context, extensionId, failure, interruptedPage, runtimeFault = null;
const wait = async check => {
  for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error('Recovery checkpoint did not arrive');
};
const launch = () => chromium.launchPersistentContext(profile, {
  headless: true, viewport: { width: 360, height: 600 },
  ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : { channel: 'chromium' }),
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
});
const workerIn = async () => context.serviceWorkers()[0] || context.waitForEvent('serviceworker');
const record = async (name, run) => {
  recordDiagnostic({ type: 'recovery-scenario', name, phase: 'start' });
  await run(); passed.push(name);
  recordDiagnostic({ type: 'recovery-scenario', name, phase: 'passed' });
  console.log(`PASS ${name}`);
};

async function recordRuntime(worker, boundary) {
  const actual = await worker.evaluate(async () => ({
    id: chrome.runtime.id, manifest: chrome.runtime.getManifest(),
    build: await (await fetch(chrome.runtime.getURL('build-info.json'))).json(),
    storedChannel: (await chrome.storage.local.get('channel')).channel ?? null,
    sessionMarker: (await chrome.storage.session.get('recoveryTestMarker')).recoveryTestMarker
  }));
  // Stable is the effective default; selecting it need not persist a key.
  actual.channel = channelName(actual.storedChannel, actual.build);
  extensionId ||= actual.id;
  assert.equal(actual.id, extensionId, 'Same extension identity across restart boundaries');
  assert.equal(actual.manifest.version, candidate.manifest.version);
  assert.deepEqual(actual.build, candidate.metadata, 'Runtime package metadata was never replaced with synthetic identity');
  assert.equal(actual.channel, candidate.channel);
  const hashes = await fileHashes(extension);
  const expectedHashes = { ...candidate.hashes, ...(runtimeFault ? { [runtimeFault.path]: runtimeFault.sha256 } : {}) };
  assert.deepEqual(hashes, expectedHashes, 'Only the explicitly recorded runtime fault may differ from the candidate');
  const identity = { boundary, extensionId, profile, packageProfile: candidate.metadata.channel, runtimeChannel: actual.channel, storedChannel: actual.storedChannel,
    appVersion: actual.manifest.version, candidateTag: actual.build.candidateTag, packageCommit: actual.build.commit,
    runtimeFault, hashes };
  runtimeIdentities.push(identity);
  recordDiagnostic({ type: 'recovery-runtime-identity', ...identity });
  return actual;
}

// Dynamic import is unavailable in service workers. Run fixture-only module
// operations in an extension document, without changing any candidate bytes.
async function fixturePage(worker) {
  const page = await context.newPage();
  await page.goto(worker.url().replace('background.js', 'updates.html'));
  return page;
}
async function readInPage(worker, read, argument) {
  const page = await fixturePage(worker);
  try { return await page.evaluate(read, argument); }
  finally { await page.close(); }
}

async function seedInterrupted(worker, point = 'installed-file:2') {
  await worker.evaluate(async () => {
    const originalFetch = fetch;
    globalThis.fetch = (input, options) => String(input).startsWith('https://api.github.com/')
      ? Promise.resolve(new Response('[]', { status: 200 })) : originalFetch(input, options);
    await chrome.storage.local.set({ githubToken: 'recovery-fixture-only' });
  });
  interruptedPage = await fixturePage(worker);
  await interruptedPage.evaluate(async ({ sourceFiles, targetFiles, channel, point }) => {
    const { storeUpdateState } = await import('./update-storage.js');
    const { runUpdate } = await import('./update-runner.js');
    const root = await navigator.storage.getDirectory();
    // Each scenario starts from a new OPFS directory, within the same persisted
    // extension origin. Nothing removes a native installation or its files.
    const directory = await root.getDirectoryHandle(`recovery-${crypto.randomUUID()}`, { create: true });
    const { restoreFiles } = await import('./update-install.js');
    await restoreFiles(directory, sourceFiles);
    await storeUpdateState({ updateJournal: undefined, backup: undefined, updateReceipt: undefined, directory });
    await chrome.storage.session.set({ recoveryTestMarker: 'must disappear at restart' });
    globalThis.fixtureRunnerStarted = true;
    globalThis.recoveryCheckpoint = null;
    globalThis.fixtureFailure = null;
    void runUpdate({ directory, channel, checkpoint: async name => {
      if (name === point) { globalThis.recoveryCheckpoint = name; await new Promise(() => {}); }
    } }, {
      verifyInstallation: async () => {}, latestRelease: async () => ({}), downloadBundle: async () => ({ files: targetFiles })
    }).catch(error => { globalThis.fixtureFailure = error.message; });
  }, { sourceFiles: candidate.files, targetFiles, channel: candidate.channel, point });
  await wait(async () => {
    const state = await interruptedPage.evaluate(() => ({ checkpoint: globalThis.recoveryCheckpoint, failure: globalThis.fixtureFailure }));
    if (state.failure) throw new Error(state.failure);
    return state.checkpoint === point;
  });
  await worker.evaluate(async point => {
    globalThis.recoveryCheckpoint = point;
    await chrome.storage.local.remove('githubToken'); // Recovery itself must work offline.
  }, point);
  const saved = await interruptedPage.evaluate(async () => {
    const { stored } = await import('./update-storage.js');
    const journal = await stored('updateJournal');
    return { id: journal.id, sourceDigest: journal.backup.digest, targetDigest: journal.target.digest,
      source: journal.backup.source, target: journal.target.source };
  });
  assert.equal(saved.source.commit, candidate.metadata.commit);
  assert.notEqual(saved.target.commit, candidate.metadata.commit, 'OPFS target identity is explicitly synthetic');
  return saved;
}

async function assertRestart(worker, saved, boundary) {
  const actual = await recordRuntime(worker, boundary);
  assert.equal(actual.sessionMarker, undefined, 'Session state was cleared by the real restart');
  assert.equal(await worker.evaluate(() => globalThis.recoveryCheckpoint), undefined, 'Abandoned runner did not survive');
  assert.ok(interruptedPage.isClosed() || !await interruptedPage.evaluate(() => globalThis.fixtureRunnerStarted).catch(() => false), 'Interrupted document runner did not survive');
  const journal = await readInPage(worker, async () => {
    const { stored } = await import('./update-storage.js');
    const value = await stored('updateJournal');
    return { id: value.id, sourceDigest: value.backup.digest, targetDigest: value.target.digest };
  });
  assert.deepEqual(journal, { id: saved.id, sourceDigest: saved.sourceDigest, targetDigest: saved.targetDigest }, 'Actual IndexedDB journal survived with the same backup');
}

async function installProofFixture(surface, directoryName) {
  await surface.evaluate(async directoryName => {
    const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle(directoryName);
    const originalFetch = fetch;
    globalThis.fetch = async (input, options) => {
      const url = String(input);
      if (url.startsWith(chrome.runtime.getURL('update-proof-'))) {
        return new Response(await (await (await directory.getFileHandle(new URL(url).pathname.slice(1))).getFile()).text());
      }
      return originalFetch(input, options);
    };
  }, directoryName);
}

async function recoverThroughUI(worker, name) {
  const page = await context.newPage();
  await page.goto(worker.url().replace('background.js', 'updates.html'));
  try {
    await page.waitForFunction(() => document.getElementById('updates-heading')?.textContent === 'Wiederherstellung erforderlich');
    assert.equal(await page.locator('#updates-install').isVisible(), false);
    await page.waitForFunction(() => document.getElementById('updates-restore')?.checkVisibility());
    assert.equal(await worker.evaluate(async () => (await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length), 0);
    const directoryName = await page.evaluate(async () => (await (await import('./update-storage.js')).stored('directory')).name);
    await installProofFixture(worker, directoryName);
    await installProofFixture(page, directoryName);
    await page.screenshot({ path: join(evidence, `${name}-before-restore.png`), fullPage: true });
    // Real UI click + real runtime.reload. OPFS grants do not exercise Chrome's
    // native external-folder permission prompt; both proof reads are fixtures.
    const restarted = context.waitForEvent('serviceworker', { predicate: next => next !== worker });
    await page.locator('#updates-restore').click();
    const nextWorker = await restarted;
    await recordRuntime(nextWorker, `${name}:verified-restore-reload`);
    const result = await readInPage(nextWorker, async sourceFiles => {
      const { stored } = await import('./update-storage.js');
      const { verifyFiles } = await import('./update-install.js');
      const directory = await stored('directory');
      await verifyFiles(directory, [...sourceFiles, { path: 'recovery-fixture.js', content: null }]);
      return { journal: await stored('updateJournal'), receipt: await stored('updateReceipt') };
    }, candidate.files);
    assert.equal(result.journal, undefined);
    assert.equal(result.receipt.outcome, 'restored');
    assert.equal(result.receipt.target.commit, candidate.metadata.commit);
    return nextWorker;
  } finally { await page.close(); }
}

try {
  await cp(candidate.directory, extension, { recursive: true });
  assert.deepEqual(await fileHashes(extension), candidate.hashes);
  context = await launch();
  let worker = await workerIn();
  const manager = await context.newPage();
  await manager.goto('chrome://extensions');
  const developerMode = manager.getByRole('button', { name: /^(Entwicklermodus|Developer mode)$/ });
  if (await developerMode.getAttribute('aria-pressed') !== 'true') await developerMode.click();
  await manager.close();
  const setup = await context.newPage();
  await setup.goto(worker.url().replace('background.js', 'updates.html'));
  await selectChannel(setup, candidate.channel);
  const selectedContexts = await worker.evaluate(() => chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }));
  assert.equal(selectedContexts.length, 1);
  assert.ok(selectedContexts[0].documentUrl.endsWith('/offscreen.html'));
  await setup.close();
  await recordRuntime(worker, 'initial-candidate');
  await record('extension reload preserves the IDB journal and clears the suspended runner/session', async () => {
    const saved = await seedInterrupted(worker);
    const restarted = context.waitForEvent('serviceworker', { predicate: next => next !== worker });
    await worker.evaluate(() => { setTimeout(() => chrome.runtime.reload(), 100); });
    worker = await restarted;
    await assertRestart(worker, saved, 'interrupted-extension-reload');
    worker = await recoverThroughUI(worker, 'extension-restart');
  });
  await record('full browser restart preserves the original backup before a new attempt', async () => {
    const saved = await seedInterrupted(worker, 'after-install-readback');
    await context.close(); context = null;
    context = await launch(); worker = await workerIn();
    await assertRestart(worker, saved, 'interrupted-browser-restart');
    worker = await recoverThroughUI(worker, 'browser-restart');
  });
  await record('recovery remains usable when the selected candidate Offscreen module is broken', async () => {
    const saved = await seedInterrupted(worker);
    await context.close(); context = null;
    const path = 'offscreen.js';
    const original = await readFile(join(extension, path));
    const broken = 'throw new Error("Intentionally broken Offscreen recovery fixture");\n';
    runtimeFault = { path, sha256: sha256(broken), reason: 'Selected candidate runtime Offscreen fails to start' };
    await writeFile(join(extension, path), broken);
    try {
      context = await launch(); worker = await workerIn();
      await assertRestart(worker, saved, 'offscreen-fault-browser-restart');
      worker = await recoverThroughUI(worker, 'offscreen-fault');
    } finally {
      await context?.close(); context = null;
      await writeFile(join(extension, path), original);
      runtimeFault = null;
    }
  });
  assert.deepEqual(await fileHashes(candidate.directory), candidate.hashes, 'Extracted candidate unchanged');
  assert.deepEqual(await fileHashes(extension), candidate.hashes, 'Runtime fault copy restored after testing');
} catch (error) {
  failure = error.stack;
  throw error;
} finally {
  try { await context?.close(); }
  catch (error) {
    failure ||= error.stack;
    console.error('Recovery browser cleanup failed:', error);
    process.exitCode = 1;
  } finally {
    await writeFile(join(evidence, 'recovery-results.json'), JSON.stringify({ status: failure ? 'failed' : 'passed', failure, passed,
      candidate: { input: candidate.directory, metadata: candidate.metadata, manifestVersion: candidate.manifest.version, hashes: candidate.hashes },
      syntheticTarget: { files: targetFiles.map(({ path, sha256 }) => ({ path, sha256 })), build: JSON.parse(targetFiles.find(file => file.path === 'build-info.json').content) },
      runtimeIdentities, limits }, null, 2) + '\n');
    await rm(root, { recursive: true, force: true });
  }
}
console.log(`${passed.length} recovery browser scenarios passed; evidence: ${evidence}`);
