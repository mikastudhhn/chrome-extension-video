import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPackageBundle, readPackageBundle } from '../scripts/package-bundle.js';
import { validateBundle, downloadBundle, discoverRelease, REPOSITORY } from '../extension/github-updates.js';
import { packageFile, fileEncoding, sha256, validPackagePath, resolvePackageReference, validateFileEntries, UPDATE_SCHEMA, MAX_FILE_BYTES, MAX_PACKAGE_BYTES, MAX_TRANSPORT_BYTES } from '../extension/package-files.js';
import { installFiles, backupFiles, restoreFiles, verifyFiles } from '../extension/update-install.js';
import { runUpdate } from '../extension/update-runner.js';
import { sealSnapshot, validateSnapshot } from '../extension/update-recovery.js';
import { fakeDirectory, copyRecord, packageFiles, signedUpdateAssets, testReleaseKey } from './update-fixtures.js';

const commit = 'b'.repeat(40), candidateTag = 'v0.6.0-preview.100';
const identity = { repository: REPOSITORY, channel: 'experimental', commit, candidateTag, version: '0.6.0.100' };
const binary = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, ...Array.from({ length: 256 }, (_, n) => n)]);
const fixtureFiles = () => ({
  'manifest.json': JSON.stringify({ manifest_version: 3, name: 'Video Sync', version: identity.version,
    background: { service_worker: 'background.js' }, action: { default_popup: 'popup.html' } }),
  'build-info.json': JSON.stringify({ schema: 2, ...identity, local: null }),
  'background.js': '', 'features.js': '', 'popup.html': '', 'popup.js': '',
  'offscreen.html': '', 'updates.html': '', 'updates.js': ''
});
async function directory(t, files = fixtureFiles()) {
  const root = await mkdtemp(join(tmpdir(), 'video-sync-assets-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [path, bytes] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true }); await writeFile(join(root, path), bytes);
  }
  return root;
}
function globals(t) {
  const previous = { chrome: globalThis.chrome, fetch: globalThis.fetch };
  const local = { githubToken: 'fixture' };
  globalThis.chrome = { runtime: { id: 'fixture' }, storage: { local: { get: async () => ({ ...local }), set: async values => Object.assign(local, values) } } };
  t.after(() => Object.assign(globalThis, previous));
}
const release = (tag, name = 'update.json', extra = {}) => ({ tag_name: tag, target_commitish: commit,
  prerelease: true, draft: false, published_at: '2026-09-20', assets: [{ name, state: 'uploaded' }], ...extra });

test('binary package validates, installs, reads back and restores every byte including invalid UTF-8 and NUL', async t => {
  const root = await directory(t, { ...fixtureFiles(), 'assets/icons/mark.png': binary });
  const bundle = await createPackageBundle(root, identity);
  assert.equal(bundle.schema, UPDATE_SCHEMA);
  await validateBundle(bundle, 'experimental', commit);
  const oldBytes = Uint8Array.from([0, 255, 254, 0, 128]);
  const initial = { ...fixtureFiles(), 'assets/icons/mark.png': oldBytes, 'notes.txt': 'keep' };
  const disk = fakeDirectory(initial);
  const backup = await backupFiles(disk.directory, bundle.files);
  await installFiles(disk.directory, bundle.files);
  await verifyFiles(disk.directory, bundle.files);
  assert.deepEqual(disk.files.get('assets/icons/mark.png'), binary);
  await restoreFiles(disk.directory, backup);
  await verifyFiles(disk.directory, backup);
  assert.deepEqual(Object.fromEntries(disk.files), initial);
});

test('corrupt binary metadata and unsafe paths fail at the shared boundary before writes', async t => {
  const root = await directory(t, { ...fixtureFiles(), 'assets/icons/mark.png': binary });
  const good = await createPackageBundle(root, identity);
  const disk = fakeDirectory(fixtureFiles());
  const corruptions = [file => { file.content = 'AA=A'; }, file => { file.content = 'AB=='; },
    file => { file.encoding = 'gzip'; }, file => { file.size++; }, file => { file.sha256 = '0'.repeat(64); },
    file => { file.path = '../icon.png'; }, file => { file.path = 'assets/icons/../mark.png'; }];
  for (const corrupt of corruptions) {
    const bundle = structuredClone(good); corrupt(bundle.files.find(file => file.path.endsWith('.png')));
    await assert.rejects(async () => { await validateBundle(bundle, 'experimental', commit); await installFiles(disk.directory, bundle.files); });
  }
  const duplicate = structuredClone(good); duplicate.files.push(duplicate.files[0]);
  await assert.rejects(validateBundle(duplicate, 'experimental', commit), /Dateipfad/);
  assert.equal(disk.writes.length, 0);
  for (const path of ['/manifest.json', '../popup.js', 'assets//icons/a.png', 'assets/icons/%2e%2e.png', 'assets/icons/A.png',
    'assets/icons/a.png:stream', 'assets/icons/a\\b.png', '.git/config', 'a/b/c/d/too-deep.js',
    'update-proof-a.json', 'assets/icons/con.png', 'con/popup.js', 'assets/icons/' + 'a'.repeat(160) + '.png',
    'ui/', 'ui/Popup.js', 'ui/update-proof-a.json', 'ui/readme.txt', 'UI/popup.js', 'ui//popup.js', 'ui/./popup.js']) assert.equal(validPackagePath(path), false, path);
  // Any lowercase folder up to three levels, so a later restructure needs no updater change.
  for (const path of ['ui/popup.html', 'ui/sub/popup.js', 'ui/icon.png', 'experimental/player.js', 'a/b/c/three.json']) assert.equal(validPackagePath(path), true, path);
  assert.equal(resolvePackageReference('ui/popup.js', '../config.js'), 'config.js');
  assert.equal(resolvePackageReference('ui/popup.js', './popup-view.js'), 'ui/popup-view.js');
  assert.equal(resolvePackageReference('background.js', './ui/x.js'), 'ui/x.js');
  assert.equal(resolvePackageReference('popup.js', '../config.js'), null);
  assert.equal(resolvePackageReference('ui/popup.js', '../../config.js'), null);
});

test('file, raw package and serialized transport limits are independent', async t => {
  const oversized = await packageFile('assets/icons/large.png', new Uint8Array(MAX_FILE_BYTES + 1), 'base64');
  await assert.rejects(validateFileEntries([oversized]));
  const files = await Promise.all(['one', 'two', 'three'].map(name => packageFile(`assets/icons/${name}.png`, new Uint8Array(MAX_PACKAGE_BYTES / 2), 'base64')));
  await assert.rejects(validateFileEntries(files), /Größe/);
  const root = await directory(t);
  const good = await createPackageBundle(root, identity);
  await assert.rejects(validateBundle({ ...good, padding: 'x'.repeat(MAX_TRANSPORT_BYTES) }, 'experimental', commit), /groß/);
});

test('missing referenced icons/modules, unsupported files and symlinks fail packaging', async t => {
  for (const extra of [{ 'unknown.txt': 'never silently omit' }, { 'background.js': "import './missing.js';" },
    { 'manifest.json': JSON.stringify({ ...JSON.parse(fixtureFiles()['manifest.json']), icons: { 16: 'assets/icons/missing.png' } }) }]) {
    await assert.rejects(createPackageBundle(await directory(t, { ...fixtureFiles(), ...extra }), identity));
  }
  const root = await directory(t);
  await symlink(join(root, 'popup.js'), join(root, 'linked.js'));
  await assert.rejects(createPackageBundle(root, identity), /Symlink/);
});

test('only the digest-checked, signed update.json is downloaded and a corrupt asset never falls back to other bytes', async t => {
  globals(t);
  const bundle = await createPackageBundle(await directory(t, { ...fixtureFiles(), 'assets/icons/mark.png': binary }), identity);
  let requests = [];
  const body = JSON.stringify(bundle);
  const signed = await signedUpdateAssets(body, { tag: candidateTag, channel: 'experimental', id: 3 });
  const [asset, signature] = signed.assets;
  const options = { publicKey: testReleaseKey().publicKey };
  const candidate = { ...release(candidateTag), assets: [{ name: 'update-stable.json', state: 'uploaded', id: 2 }, asset, signature] };
  globalThis.fetch = async url => { requests.push(url); return new Response(signed.bodies[url.split('/').at(-1)]); };
  assert.equal((await downloadBundle(candidate, 'experimental', 'fixture', options)).schema, UPDATE_SCHEMA);
  assert.ok(requests[0].endsWith('/3'));
  assert.ok(requests[1].endsWith('/4'));
  asset.digest = `sha256:${'0'.repeat(64)}`; requests = [];
  await assert.rejects(downloadBundle(candidate, 'experimental', 'fixture', options), /Prüfsumme/);
  assert.equal(requests.length, 1);
  candidate.assets = [{ ...asset, name: 'update-v3.json' }, signature];
  await assert.rejects(downloadBundle(candidate, 'experimental', 'fixture', options), /kein geprüftes Update-Paket/);
  const output = await directory(t, { 'update.json': JSON.stringify({ ...bundle, schema: 3 }) });
  await assert.rejects(readPackageBundle(output, 'experimental'), /Kanal/);
});

for (const point of [1, 2, 3, 4, 5]) {
  test(`binary journal process loss after write ${point} preserves old bytes through restart and retry`, async t => {
    globals(t);
    const initial = packageFiles('0.5.0', 'a'.repeat(40), { 'assets/icons/mark.png': Uint8Array.from([255, 0, 254]) });
    const disk = fakeDirectory({ ...initial, 'notes.txt': 'keep' });
    const raw = packageFiles('0.5.1', commit, { 'assets/icons/mark.png': binary, 'assets/icons/new.png': binary });
    const files = await Promise.all(Object.entries(raw).map(([path, data]) => packageFile(path, typeof data === 'string' ? new TextEncoder().encode(data) : data, fileEncoding(path))));
    const records = new Map();
    const io = {
      verifyInstallation: async () => {}, verifyRecoveryDirectory: async (_, snapshot) => validateSnapshot(snapshot),
      latestRelease: async () => ({}), downloadBundle: async () => ({ files }),
      stored: async function(key, value) { if (arguments.length === 1) return copyRecord(records.get(key)); records.set(key, copyRecord(value)); },
      storeUpdateState: async values => { for (const [key, value] of Object.entries(values)) records.set(key, copyRecord(value)); }
    };
    const options = { channel: 'experimental', directory: disk.directory };
    const older = await sealSnapshot(disk.directory, await backupFiles(disk.directory, files));
    records.set('backup', older);
    let stop; const reached = new Promise(resolve => { stop = resolve; });
    const abandoned = runUpdate({ ...options, checkpoint: async name => { if (name === `installed-file:${point}`) { stop(); await new Promise(() => {}); } } }, io);
    await Promise.race([reached, abandoned.then(() => assert.fail('checkpoint missing'))]);
    assert.deepEqual(records.get('backup'), older);
    const restorePath = ['build-info.json', 'popup.js', 'assets/icons/mark.png', 'assets/icons/new.png', 'manifest.json'][point - 1];
    const originalBackup = copyRecord(records.get('updateJournal').backup);
    for (let interruption = 0; interruption < 2; interruption++) {
      let reachedRestore; const stopped = new Promise(resolve => { reachedRestore = resolve; });
      const restoring = runUpdate({ ...options, checkpoint: async name => {
        if (name === `restored-file:${restorePath}`) { reachedRestore(); await new Promise(() => {}); }
      } }, io);
      await Promise.race([stopped, restoring.then(() => assert.fail('restore checkpoint missing'))]);
      assert.deepEqual(records.get('updateJournal').backup, originalBackup);
    }
    assert.equal((await runUpdate(options, io)).outcome, 'restored');
    assert.deepEqual(Object.fromEntries(disk.files), { ...initial, 'notes.txt': 'keep' });
    assert.equal((await runUpdate(options, io)).outcome, 'installed');
    await runUpdate({ ...options, restore: true }, io);
    assert.deepEqual(Object.fromEntries(disk.files), { ...initial, 'notes.txt': 'keep' });
  });
}

test('discovery searches beyond five pages and revalidates cached pages of another format', async t => {
  globals(t);
  const releases = Array.from({ length: 501 }, (_, n) => release(`v0.6.0-preview.${n + 1}`));
  const calls = [];
  globalThis.fetch = async url => {
    const page = Number(new URL(url).searchParams.get('page')); calls.push(page);
    return new Response(JSON.stringify(releases.slice((page - 1) * 100, page * 100)));
  };
  assert.equal((await discoverRelease('experimental', 'fixture')).release.tag_name, 'v0.6.0-preview.501');
  assert.deepEqual(calls, [1, 2, 3, 4, 5, 6]);
  const older = release(candidateTag), newest = release('v0.6.0-preview.101');
  const requests = [];
  const cache = { '/releases?per_page=100&page=1': { etag: 'old-etag', count: 2, next: null, candidates: [older] } };
  const result = await discoverRelease('experimental', 'fixture', { cache, fetcher: async (_, options) => {
    requests.push(options.headers['If-None-Match']);
    return requests.length === 1 ? new Response(null, { status: 304 }) : new Response(JSON.stringify([older, newest]));
  } });
  assert.deepEqual(requests, ['old-etag', undefined]);
  assert.equal(result.release.tag_name, newest.tag_name);
});
