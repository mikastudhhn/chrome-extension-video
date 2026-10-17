// Real watcher + isolated Git worktree + Chrome: no personal browser or port 8787.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from '../server/index.js';
import { Signaling } from '../extension/signaling.js';
import { PROTOCOL, CAPABILITIES } from '../extension/protocol.js';
import { chromium } from './browser-test-context.js';
import { uiRequest } from './browser-test-api.js';
const root = await mkdtemp(join(tmpdir(), 'video-sync-branch-test-'));
let checkout = join(root, 'repository');
const git = (...args) => execFileSync('git', args, { cwd: checkout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const until = async (label, fn) => {
  for (let i = 0; i < 200; i++) {
    try { if (await fn()) return; } catch { /* A reload briefly invalidates extension contexts. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timeout: ${label}`);
};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let watcher, context, popup, worker, peer;
let output = '';
const relay = createServer();
const startWatcher = () => {
  watcher = spawn(process.execPath, ['scripts/development-build.js', '--watch'], { cwd: checkout, stdio: ['ignore', 'pipe', 'pipe'] });
  watcher.stdout.on('data', data => { output += data; }); watcher.stderr.on('data', data => { output += data; });
};
const stopWatcher = async () => {
  if (!watcher || watcher.exitCode !== null) return;
  const stopped = new Promise(resolve => watcher.once('exit', resolve)); watcher.kill('SIGTERM'); await stopped;
};
try {
  execFileSync('git', ['clone', '--quiet', '--no-hardlinks', resolve('.'), checkout]);
  const workspace = join(root, 'checkout');
  git('worktree', 'add', '-b', 'ft/branch-one', workspace, 'HEAD');
  checkout = workspace;
  for (const name of ['scripts', 'extension', 'package.json']) await cp(resolve(name), join(checkout, name), { recursive: true });
  startWatcher();
  const directory = join(checkout, 'dist/development/extension');
  const metadata = async () => JSON.parse(await readFile(join(directory, 'build-info.json'), 'utf8').catch(() => '{}'));
  await until('first build', async () => (await metadata()).local?.branch === 'ft/branch-one');
  const first = await metadata();
  await new Promise(resolve => relay.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${relay.address().port}`;
  context = await chromium.launchPersistentContext(join(root, 'profile'), { headless: true,
    ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : { channel: 'chromium' }),
    args: [`--disable-extensions-except=${directory}`, `--load-extension=${directory}`] });
  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  context.on('serviceworker', next => { worker = next; });
  const manager = await context.newPage(); await manager.goto('chrome://extensions');
  await manager.getByRole('button', { name: /^(Entwicklermodus|Developer mode)$/ }).click(); await manager.close();
  const popupUrl = worker.url().replace('background.js', 'popup.html');
  const openPopup = async () => {
    if (popup && !popup.isClosed()) await popup.close();
    popup = await context.newPage(); await popup.goto(popupUrl);
    await until('popup ready', async () => (await api('status')).channel);
  };
  // The popup page is replaced on reopen; resolve it per request.
  const api = (action, extra = {}) => uiRequest(popup, action, extra);
  const changed = async (file, content) => {
    const before = (await metadata()).local.buildId;
    await writeFile(join(checkout, 'extension', file), content);
    await until(`build for ${file}`, async () => (await metadata()).local?.buildId !== before);
  };
  const reloaded = async previous => {
    await until('extension reload', () => worker !== previous);
    await openPopup();
    await until('dev live', async () => (await api('status')).development?.state === 'live');
  };
  await openPopup();
  await until('helper connected', async () => (await api('status')).channels.length === 3);
  assert.equal((await api('status')).channel, 'stable');
  assert.equal((await api('status')).channels.at(-1).label, 'Dev · ft/branch-one');
  const config = await readFile(join(checkout, 'extension/config.js'), 'utf8');
  let previous = worker;
  await changed('config.js', `${config}\n// Stable must not reload.\n`);
  await delay(2200); assert.equal(worker, previous);
  await api('set-channel', { channel: 'experimental' });
  await changed('config.js', `${config}\n// Experimental must not reload.\n`);
  await delay(2200); assert.equal(worker, previous);
  console.log('PASS Stable and Experimental are not reloaded by file changes');

  await api('set-channel', { channel: 'local' }); await reloaded(previous);
  assert.equal((await api('status')).channel, 'local');
  previous = worker;
  await changed('config.js', `${config}\n// Live change.\n`); await reloaded(previous);
  console.log('PASS selecting Dev activates the latest build; file save automatically reloads');

  previous = worker; await popup.close();
  await delay(31_000);
  await changed('dev-added.js', 'export const example = true;'); await reloaded(previous);
  previous = worker;
  const beforeDeletion = (await metadata()).local.buildId;
  await rm(join(checkout, 'extension/dev-added.js'));
  await until('deleted file build', async () => (await metadata()).local?.buildId !== beforeDeletion);
  await reloaded(previous);
  await assert.rejects(readFile(join(directory, 'dev-added.js')), { code: 'ENOENT' });
  console.log('PASS reload works with popup closed beyond worker idle timeout; added and deleted files are reflected');

  await popup.locator('#open-settings').click();
  await popup.locator('#open-updates').click();
  await popup.locator('#updates-dev-pause').click();
  await until('paused', async () => (await api('status')).development.paused);
  previous = worker;
  await changed('config.js', `${config}\n// Paused change.\n`);
  await delay(2200); assert.equal(worker, previous);
  await popup.locator('#updates-dev-pause').click(); await reloaded(previous);
  console.log('PASS pause retains current runtime; resume applies the pending build');

  const good = await metadata(); previous = worker;
  await writeFile(join(checkout, 'extension/config.js'), 'export const = broken;');
  await until('build error visible', async () => (await api('status')).development.state === 'error');
  assert.equal((await metadata()).local.buildId, good.local.buildId);
  assert.notEqual(await readFile(join(directory, 'config.js'), 'utf8'), 'export const = broken;');
  await delay(1500); assert.equal(worker, previous);
  await changed('config.js', `${config}\n// Fixed.\n`); await reloaded(previous);
  console.log('PASS invalid JavaScript preserves installed files and recovers after correction');

  previous = worker;
  await writeFile(join(checkout, 'extension/config.js'), "export { missing } from './missing-file.js';");
  await until('import error visible', async () => (await api('status')).development.state === 'error');
  assert.equal(worker, previous);
  await changed('config.js', `${config}\n// Imports fixed.\n`); await reloaded(previous);
  console.log('PASS missing imports cannot replace a working build');

  const video = await context.newPage(); await video.goto(base);
  await video.waitForFunction(() => document.querySelector('video')?.readyState >= 3);
  await video.evaluate(() => { document.querySelector('video').currentTime = 5; });
  const tabId = await popup.evaluate(async base => (await chrome.tabs.query({})).find(tab => tab.url === `${base}/`).id, base);
  await api('attach', { tabId });
  const room = (await api('create', { server: base })).room;
  peer = new Signaling(base, event => {
    if (event.message?.type === 'ping') peer.send({ type: 'pong', sent: event.message.sent, received: Date.now() });
  }, () => {});
  await peer.open(room.code); peer.poll();
  await until('room connected', async () => (await api('status')).room.connected);
  previous = worker;
  await changed('config.js', `${config}\n// Reload with room and video.\n`); await reloaded(previous);
  await until('room resumed', async () => (await api('status')).room?.connected);
  const restored = await api('status');
  assert.equal(restored.room.code, room.code); assert.equal(restored.room.role, room.role);
  assert.equal(restored.tabId, tabId); assert.ok(Math.abs(restored.local.time - 5) < 0.5);
  assert.equal((await fetch(`${base}/rooms/${room.code}/join`, { method: 'POST', body: JSON.stringify({ protocol: PROTOCOL, capabilities: CAPABILITIES }) })).status, 409);
  await api('leave'); await peer.close(); peer = null;
  console.log('PASS active room resumes the same seat and video position after extension reload');

  await video.evaluate(() => {
    const second = document.querySelector('video').cloneNode(true);
    second.setAttribute('aria-label', 'Second Dev video');
    document.body.append(second);
  });
  await video.waitForFunction(() => document.querySelectorAll('video')[1]?.readyState >= 3);
  await video.evaluate(() => { document.querySelectorAll('video')[1].currentTime = 15; });
  const discovered = await popup.evaluate(tabId => chrome.runtime.sendMessage({ target: 'background', type: 'discover-player', tabId }), tabId);
  assert.equal(discovered.result.candidates.length, 2);
  const selected = discovered.result.candidates.find(candidate => candidate.label === 'Second Dev video');
  await api('attach', { tabId, documentId: selected.documentId, playerId: selected.playerId });
  previous = worker;
  await changed('config.js', `${config}\n// Reload selected second video.\n`); await reloaded(previous);
  await until('exact second video restored', async () => (await api('status')).playerId === selected.playerId);
  assert.ok(Math.abs((await api('status')).local.time - 15) < 0.5);
  console.log('PASS Dev reload restores the exact selected player among multiple videos');

  await video.evaluate(() => document.querySelectorAll('video')[1].remove());
  previous = worker;
  await changed('config.js', `${config}\n// Selected video was removed.\n`); await reloaded(previous);
  assert.equal((await api('status')).local, null, 'remaining first video must never replace the removed selection');
  console.log('PASS Dev reload never silently substitutes a remaining video for a removed selection');

  previous = worker; git('switch', '-c', 'fix/branch-two');
  await until('branch metadata', async () => (await metadata()).local?.branch === 'fix/branch-two');
  await reloaded(previous);
  assert.equal((await api('status')).channels.at(-1).label, 'Dev · fix/branch-two');
  const next = await metadata();
  assert.equal(next.channel, 'local'); assert.equal(next.commit, first.commit);
  console.log('PASS worktree branch switches update the Dev branch name and build');

  await stopWatcher();
  await until('offline selected', async () => (await api('status')).development.state === 'offline');
  assert.match((await api('status')).channels.at(-1).label, /offline/);
  await api('set-channel', { channel: 'stable' });
  assert.deepEqual((await api('status')).channels.map(option => option.value), ['stable', 'experimental']);
  startWatcher();
  await until('helper restarted', async () => (await api('status')).development.online);
  assert.equal((await api('status')).channels.length, 3);
  assert.equal((await metadata()).local.helper.origin, first.local.helper.origin);
  console.log('PASS stopped helper hides unselected Dev; restarting reconnects without reinstallation');
} catch (error) {
  console.error(output); throw error;
} finally {
  await peer?.close(); await context?.close(); await stopWatcher();
  relay.closeAllConnections(); await new Promise(resolve => relay.close(resolve));
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
