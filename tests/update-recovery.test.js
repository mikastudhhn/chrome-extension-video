import { fileBytes } from '../extension/package-files.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { sealSnapshot, verifyRecoveryDirectory, installationIdentity } from '../extension/update-recovery.js';
import { verifyFiles, backupFiles } from '../extension/update-install.js';
import { fakeDirectory, packageFiles, fileEntries } from './update-fixtures.js';

function chromeFixture(t) {
  const previousChrome = globalThis.chrome, previousFetch = globalThis.fetch;
  globalThis.chrome = { runtime: { id: 'same-extension', getURL: file => `chrome-extension://same-extension/${file}` } };
  t.after(() => { globalThis.chrome = previousChrome; globalThis.fetch = previousFetch; });
}

test('recovery requires both the saved directory capability and the original loaded-folder nonce proof', async t => {
  chromeFixture(t);
  const contents = packageFiles(), disk = fakeDirectory(contents), other = fakeDirectory(contents);
  const backup = await sealSnapshot(disk.directory, fileEntries(contents));
  globalThis.fetch = async () => assert.fail('wrong directory must fail before nonce creation');
  await assert.rejects(verifyRecoveryDirectory(other.directory, backup), /gehört nicht/);
  assert.equal(other.writes.length, 0);
  globalThis.fetch = async () => new Response(JSON.stringify('nonce-from-another-folder'));
  await assert.rejects(verifyRecoveryDirectory(disk.directory, backup), /exakt.*geladenen Ordner/);
  assert.deepEqual(Object.fromEntries(disk.files), contents, 'failed proof file is cleaned up');
  globalThis.fetch = async url => new Response(disk.files.get(new URL(url).pathname.slice(1)));
  disk.files.set('manifest.json', '{broken');
  disk.files.delete('build-info.json');
  await verifyRecoveryDirectory(disk.directory, backup);
  assert.equal(disk.files.get('manifest.json'), '{broken', 'identity proof does not rewrite package files');
  assert.equal([...disk.files.keys()].some(path => path.startsWith('update-proof-')), false);
});

test('raw byte readback rejects corrupt UTF-8 that text decoding could conceal', async () => {
  const directory = { getFileHandle: async () => ({ getFile: async () => ({
    arrayBuffer: async () => new Uint8Array([0xff]).buffer,
    text: async () => '\uFFFD'
  }) }) };
  await assert.rejects(verifyFiles(directory, [{ path: 'popup.js', encoding: 'utf8', content: '\uFFFD' }]), /Dateiprüfung/);
  const backup = await backupFiles(directory, [{ path: 'popup.js' }]);
  assert.deepEqual(fileBytes(backup[0]), new Uint8Array([0xff]), 'backup preserves bytes without replacement characters');
  await verifyFiles(directory, backup);
});

test('UTF-8 BOM bytes are retained in backups and verified exactly', async () => {
  const disk = fakeDirectory({ 'popup.js': '\uFEFFconst value = 1;' });
  const files = await backupFiles(disk.directory, [{ path: 'popup.js' }]);
  assert.equal(files[0].content.charCodeAt(0), 0xfeff);
  await verifyFiles(disk.directory, files);
  disk.files.set('popup.js', 'const value = 1;');
  await assert.rejects(verifyFiles(disk.directory, files), /Dateiprüfung/);
});

test('recovery identity never claims that an object or numeric candidate tag is a release name', () => {
  const contents = packageFiles();
  const build = JSON.parse(contents['build-info.json']);
  for (const candidateTag of [123, true, {}, ['v0.5.0-preview.1']]) {
    const files = fileEntries({ ...contents, 'build-info.json': JSON.stringify({ ...build, candidateTag }) });
    assert.throws(() => installationIdentity(files), /Paketidentität.*unvollständig/);
  }
  for (const candidateTag of [null, 'v0.5.0-preview.1']) {
    const files = fileEntries({ ...contents, 'build-info.json': JSON.stringify({ ...build, candidateTag }) });
    assert.equal(installationIdentity(files).candidateTag, candidateTag);
  }
});
