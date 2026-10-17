import test from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions, releaseOrder, manifestChanges, reviewUpdate, ConfirmationRequired } from '../extension/update-review.js';
import { runUpdate } from '../extension/update-runner.js';
import { checkUpdates } from '../extension/update-service.js';
import { confirmationPresentation } from '../extension/updates-view.js';
import { updateBannerState } from '../extension/popup-view.js';
import { REPOSITORY } from '../extension/github-updates.js';
import { packageFile } from '../extension/package-files.js';
import { fakeDirectory, copyRecord, fileEntries } from './update-fixtures.js';

const manifest = (version, extra = {}) => ({ name: 'Video Sync', manifest_version: 3, version, ...extra });
const build = (channel, commit = 'a'.repeat(40), candidateTag = 'v0.6.0-preview.1') => ({ schema: 2, repository: REPOSITORY, commit, channel, candidateTag, local: null });
const entries = async (manifestValue, buildValue) => Promise.all([['manifest.json', manifestValue], ['build-info.json', buildValue]]
  .map(([path, value]) => packageFile(path, new TextEncoder().encode(JSON.stringify(value)), 'utf8')));

test('versions compare numerically and tags order releases relative to the installed version', () => {
  assert.equal(compareVersions('0.6.0.10', '0.6.0.9'), 1);
  assert.equal(compareVersions('0.6.0', '0.6.0.0'), 0);
  assert.equal(compareVersions('0.5.9.99', '0.6.0.1'), -1);
  assert.equal(releaseOrder('v0.6.0-preview.12', 'experimental', '0.6.0.11'), 1);
  assert.equal(releaseOrder('v0.6.0-preview.11', 'experimental', '0.6.0.11'), 0);
  assert.equal(releaseOrder('v0.6.0-preview.2', 'experimental', '0.6.0.11'), -1);
  assert.equal(releaseOrder('v0.6.1', 'stable', '0.6.0.30'), 1);
  assert.equal(releaseOrder('v0.5.9', 'stable', '0.6.0.30'), -1);
  assert.equal(releaseOrder('v0.6.0', 'stable', '0.6.0.30'), null, 'a Stable tag omits the build part');
  assert.equal(releaseOrder('v0.6.0-preview.2', 'experimental', undefined), null);
});

test('manifest review lists added permissions, hosts, optional entries, scripts, resources, connections and CSP changes', () => {
  const before = manifest('1', { permissions: ['storage'], host_permissions: ['http://localhost/*'], optional_permissions: ['tabCapture'],
    content_scripts: [{ matches: ['https://a.example/*'], js: ['a.js'] }] });
  assert.deepEqual(manifestChanges(before, before), []);
  assert.deepEqual(manifestChanges(before, manifest('2', { permissions: [] })), [], 'removals need no confirmation');
  const after = manifest('2', { permissions: ['storage', 'tabs'], host_permissions: ['http://localhost/*', 'https://*/*'],
    optional_permissions: ['tabCapture', 'downloads'], optional_host_permissions: ['http://*/*'],
    content_scripts: [{ matches: ['https://a.example/*'], js: ['a.js'] }, { matches: ['<all_urls>'], js: ['b.js'] }],
    web_accessible_resources: [{ resources: ['x.js'], matches: ['<all_urls>'] }],
    externally_connectable: { matches: ['https://evil.example/*'] }, content_security_policy: { extension_pages: "script-src 'self'" } });
  const changes = Object.fromEntries(manifestChanges(before, after).map(change => [change.key, change.entries]));
  assert.deepEqual(changes.permissions, ['tabs']);
  assert.deepEqual(changes.host_permissions, ['https://*/*']);
  assert.deepEqual(changes.optional_permissions, ['downloads']);
  assert.deepEqual(changes.optional_host_permissions, ['http://*/*']);
  assert.deepEqual(changes.content_scripts, ['{"js":["b.js"],"matches":["<all_urls>"]}']);
  assert.deepEqual(changes.web_accessible_resources, ['{"matches":["<all_urls>"],"resources":["x.js"]}']);
  assert.deepEqual(changes.externally_connectable, ['matches: https://evil.example/*']);
  assert.deepEqual(changes.content_security_policy, ['{"extension_pages":"script-src \'self\'"}']);
  // Removing a CSP is a change as well.
  assert.deepEqual(manifestChanges(after, { ...after, content_security_policy: undefined }).map(change => change.key), ['content_security_policy']);
});

test('only strictly newer versions install by default; a channel-switch downgrade and new rights need a bound confirmation', async () => {
  const installed = await entries(manifest('0.6.0.15'), build('experimental'));
  // Newer, same rights: nothing to confirm.
  assert.equal(await reviewUpdate({ installedFiles: installed, targetFiles: await entries(manifest('0.6.0.16'), build('experimental', 'b'.repeat(40))), channel: 'experimental' }), null);
  // Same stream, older or equal: always rejected.
  await assert.rejects(reviewUpdate({ installedFiles: installed, targetFiles: await entries(manifest('0.6.0.14'), build('experimental')), channel: 'experimental' }), /älter als die installierte Version 0\.6\.0\.15/);
  await assert.rejects(reviewUpdate({ installedFiles: installed, targetFiles: await entries(manifest('0.6.0.15'), build('experimental')), channel: 'experimental' }), /bereits installiert/);
  // Switching to Stable may install the older accepted Stable after confirmation.
  const stable = await reviewUpdate({ installedFiles: installed, targetFiles: await entries(manifest('0.6.0.12'), build('stable', 'c'.repeat(40), 'v0.6.0-preview.12')), channel: 'stable' });
  assert.equal(stable.downgrade, true); assert.equal(stable.older, true);
  assert.equal(stable.from, '0.6.0.15'); assert.equal(stable.to, '0.6.0.12');
  assert.match(stable.id, /^[a-f0-9]{64}$/);
  assert.match(new ConfirmationRequired(stable).message, /Kanalwechsel installiert Version 0\.6\.0\.12/);
  // The id binds the target: another commit with the same version needs a new confirmation.
  const other = await reviewUpdate({ installedFiles: installed, targetFiles: await entries(manifest('0.6.0.12'), build('stable', 'd'.repeat(40), 'v0.6.0-preview.12')), channel: 'stable' });
  assert.notEqual(other.id, stable.id);
  // Newer but with new rights.
  const rights = await reviewUpdate({ installedFiles: installed, targetFiles: await entries(manifest('0.6.0.16', { host_permissions: ['https://*/*'] }), build('experimental')), channel: 'experimental' });
  assert.equal(rights.downgrade, false);
  assert.deepEqual(rights.changes.map(change => change.key), ['host_permissions']);
  assert.match(new ConfirmationRequired(rights).message, /zusätzliche Rechte \(Website-Zugriff\)/);
  const view = confirmationPresentation(rights);
  assert.match(view.summary, /verlangt zusätzliche Rechte/);
  assert.equal(view.details, 'Website-Zugriff: https://*/*');
  assert.match(confirmationPresentation(stable).summary, /Wechsel von Experimental zu Stable installiert Version 0\.6\.0\.12\. Sie ist älter als/);
});

function runnerFixture(t, { installed, target, channel = 'experimental' }) {
  const previous = globalThis.chrome;
  globalThis.chrome = { runtime: { id: 'review-test' }, storage: { local: { get: async () => ({}), set: async () => {} } } };
  t.after(() => { globalThis.chrome = previous; });
  const disk = fakeDirectory(installed), records = new Map();
  const io = {
    verifyInstallation: async () => {}, verifyRecoveryDirectory: async () => {},
    latestRelease: async () => ({ id: 1 }), downloadBundle: async () => ({ files: fileEntries(target) }),
    async stored(key, value) { if (arguments.length === 1) return copyRecord(records.get(key)); if (value === undefined) records.delete(key); else records.set(key, copyRecord(value)); },
    storeUpdateState: async values => { for (const [key, value] of Object.entries(values)) { if (value === undefined) records.delete(key); else records.set(key, copyRecord(value)); } }
  };
  return { disk, records, io, run: confirmation => runUpdate({ channel, directory: disk.directory, confirmation }, io) };
}
const files = (manifestValue, buildValue) => ({ 'manifest.json': JSON.stringify(manifestValue), 'build-info.json': JSON.stringify(buildValue), 'popup.js': `popup ${manifestValue.version}` });

test('the runner rejects a same-channel downgrade and writes nothing', async t => {
  const f = runnerFixture(t, { installed: files(manifest('0.6.0.15'), build('experimental')), target: files(manifest('0.6.0.14'), build('experimental', 'b'.repeat(40))) });
  await assert.rejects(f.run(), /älter als die installierte Version/);
  await assert.rejects(f.run('anything'), /älter als die installierte Version/, 'no confirmation can override a same-channel downgrade');
  assert.deepEqual(f.disk.writes, []);
  assert.equal(f.records.get('updateJournal'), undefined);
});

for (const kind of ['channel-switch downgrade', 'added permissions']) {
  test(`${kind}: installation stops before any write until the exact review is confirmed`, async t => {
    const downgrade = kind === 'channel-switch downgrade';
    const installed = files(manifest('0.6.0.15', { permissions: ['storage'] }), build('experimental'));
    const target = downgrade ? files(manifest('0.6.0.12', { permissions: ['storage'] }), build('stable', 'c'.repeat(40)))
      : files(manifest('0.6.0.16', { permissions: ['storage', 'tabs'] }), build('experimental', 'b'.repeat(40)));
    const f = runnerFixture(t, { installed, target, channel: downgrade ? 'stable' : 'experimental' });
    let review;
    await assert.rejects(f.run(), error => { review = error.confirmation; return error instanceof ConfirmationRequired && error.code === 'confirmation-required'; });
    assert.equal(review.downgrade, downgrade);
    assert.deepEqual(f.disk.writes, []);
    assert.equal(f.records.get('updateJournal'), undefined);
    await assert.rejects(f.run('f'.repeat(64)), ConfirmationRequired, 'a different confirmation id does not authorize this target');
    assert.deepEqual(f.disk.writes, []);
    assert.equal((await f.run(review.id)).outcome, 'installed');
    assert.equal(f.disk.files.get('popup.js'), target['popup.js']);
  });
}

test('discovery offers only newer releases in the same stream and flags a possible downgrade on a channel switch', async t => {
  const data = {};
  const previous = globalThis.chrome;
  globalThis.chrome = { runtime: { getManifest: () => ({ version: '0.6.0.15' }) }, storage: { local: {
    get: async () => structuredClone(data), set: async values => Object.assign(data, values), remove: async () => {}, setAccessLevel: async () => {} } } };
  t.after(() => { globalThis.chrome = previous; });
  let releases = [];
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(releases)));
  const release = (tag, commit, prerelease) => ({ id: 1, tag_name: tag, target_commitish: commit, prerelease, assets: [{ name: 'update.json', state: 'uploaded' }] });
  const installed = { commit: 'a'.repeat(40), channel: 'experimental', candidateTag: 'v0.6.0-preview.15' };
  releases = [release('v0.6.0-preview.14', 'b'.repeat(40), true)];
  const older = await checkUpdates('experimental', installed, true);
  assert.equal(older.available, false, 'an older candidate (for example after the newest was deleted) is never offered');
  assert.equal(older.releaseState, 'current');
  releases = [release('v0.6.0-preview.16', 'c'.repeat(40), true)];
  const newer = await checkUpdates('experimental', installed, true);
  assert.equal(newer.available, true); assert.equal(newer.confirmDowngrade, undefined);
  releases = [release('v0.6.0', 'd'.repeat(40), false)];
  const switching = await checkUpdates('stable', installed, true);
  assert.equal(switching.available, true);
  assert.equal(switching.confirmDowngrade, true);
  releases = [release('v0.5.9', 'd'.repeat(40), false)];
  assert.equal((await checkUpdates('stable', { ...installed, channel: 'stable' }, true)).available, false);
});

test('the popup banner sends a pending confirmation to the update details instead of retrying', () => {
  const current = { updates: { available: true, configured: true, tag: 'v0.6.0', url: 'https://example.invalid/r' },
    updateOperation: { error: 'Bestätigung erforderlich', confirmation: { id: 'x', from: '1', to: '0', downgrade: true, changes: [] } } };
  const banner = updateBannerState({ current, pending: false, updatesOpen: false, updateBannerError: '' });
  assert.equal(banner.action, 'open');
  assert.equal(banner.title, 'Bestätigung erforderlich');
  assert.equal(updateBannerState({ current: { ...current, updateOperation: { error: 'Netz' } }, pending: false, updatesOpen: false }).title, 'Update fehlgeschlagen');
});
