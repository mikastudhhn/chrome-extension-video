import test from 'node:test';
import assert from 'node:assert/strict';
import { REPOSITORY, selectRelease, releaseCommit, validateBundle, githubRequest } from '../extension/github-updates.js';
import { validPackagePath, packageFile } from '../extension/package-files.js';
import { verifyInstallation, backupFiles, installFiles, restoreFiles } from '../extension/update-install.js';
import { candidateBundle } from './update-fixtures.js';

const commit = 'a'.repeat(40);
const release = (tag, extra = {}) => ({ tag_name: tag, target_commitish: commit, draft: false, prerelease: tag.includes('-preview.'),
  published_at: '2026-09-18', assets: [{ name: 'update.json', state: 'uploaded' }], ...extra });
test('Stable never follows experimental, unversioned, incomplete or draft releases', () => {
  const stable = release('v0.6.0');
  assert.equal(selectRelease([release('v0.6.1-preview.3'), release('stable-' + commit, { prerelease: false }), release('v0.7.0', { draft: true }),
    release('v0.8.0', { assets: [] }), release('v0.9.0', { assets: [{ name: 'update-stable.json', state: 'uploaded' }] }), stable], 'stable'), stable);
  assert.equal(selectRelease([release('v0.6.1-preview.3')], 'stable'), null);
  assert.throws(() => selectRelease([], 'local'), /lokale Branches/);
});
test('candidates and Stable versions require a version tag and an immutable commit', () => {
  const candidate = release('v0.6.0-preview.12');
  const stable = release('v0.6.0');
  assert.equal(selectRelease([release(`experimental-${commit}`, { published_at: '2030-01-01' }), candidate], 'experimental'), candidate);
  assert.equal(selectRelease([candidate], 'stable'), null);
  assert.equal(selectRelease([candidate, stable], 'stable'), stable);
  assert.equal(selectRelease([{ ...candidate, target_commitish: 'main' }], 'experimental'), null);
  assert.equal(releaseCommit(candidate), commit);
  assert.equal(releaseCommit({ tag_name: `experimental-${commit}` }), null);
});
test('update paths allow lowercase folders up to three levels but no traversal, absolute, hidden or reserved names', () => {
  for (const path of ['../manifest.json', '/manifest.json', 'ui/../popup.js', '.git/config', 'ui/.hidden.js', 'a/b/c/d/deep.js', 'popup.js\\evil',
    'ui//popup.js', 'UI/popup.js', 'ui/Popup.js', 'ui/', 'update-proof-abc.json', 'ui/update-proof-abc.json', 'assets/con.png',
    'notes.txt', 'ui/' + 'a'.repeat(160) + '.js']) assert.equal(validPackagePath(path), false, path);
  for (const path of ['manifest.json', 'ui/popup.js', 'ui/views/updates.css', 'assets/icons/pause-16.png', 'a/b/c/three-levels.json']) assert.equal(validPackagePath(path), true, path);
});
test('bundle validation binds every byte to the repository, immutable commit and selected channel', async () => {
  const valid = await candidateBundle({ commit });
  await validateBundle(valid, 'experimental', commit);
  await assert.rejects(validateBundle(valid, 'stable', commit), /Kanal/);
  await assert.rejects(validateBundle(valid, 'experimental', 'b'.repeat(40)), /Kanal/);
  await assert.rejects(validateBundle({ ...valid, schema: 2 }, 'experimental', commit), /Kanal/);
  const corrupted = structuredClone(valid); corrupted.files[0].content += ' ';
  await assert.rejects(validateBundle(corrupted, 'experimental', commit), /Prüfsumme/);
  const duplicate = structuredClone(valid); duplicate.files.push(duplicate.files[0]);
  await assert.rejects(validateBundle(duplicate, 'experimental', commit), /Dateipfad/);
  const unencoded = structuredClone(valid); delete unencoded.files[0].encoding;
  await assert.rejects(validateBundle(unencoded, 'experimental', commit), /kodierung/);
  const local = structuredClone(valid); const index = local.files.findIndex(file => file.path === 'build-info.json');
  local.files[index] = await packageFile('build-info.json', new TextEncoder().encode(JSON.stringify({ schema: 2, repository: REPOSITORY, commit,
    channel: 'experimental', candidateTag: valid.candidateTag, local: { branch: 'developer' } })), 'utf8');
  await assert.rejects(validateBundle(local, 'experimental', commit), /Falsche Erweiterung/);
});
test('private API requests send credentials only to the fixed GitHub repository and handle access errors', async () => {
  let options;
  await githubRequest('/releases', 'test-token', { fetcher: async (url, request) => {
    assert.equal(url, `https://api.github.com/repos/${REPOSITORY}/releases`); options = request; return { ok: true };
  } });
  assert.equal(options.credentials, 'omit');
  assert.equal(options.headers.Authorization, 'Bearer test-token');
  await assert.rejects(githubRequest('/releases', 'test-token', { fetcher: async () => ({ ok: false, status: 404 }) }), error => error.code === 'forbidden' && /GitHub-Zugriff/.test(error.message));
});

test('public API requests without a token carry no credentials and report unreachable releases distinctly', async () => {
  for (const token of [undefined, '']) {
    let options;
    await githubRequest('/releases', token, { fetcher: async (url, request) => {
      assert.equal(url, `https://api.github.com/repos/${REPOSITORY}/releases`); options = request; return { ok: true };
    } });
    assert.equal(options.credentials, 'omit');
    assert.equal(Object.hasOwn(options.headers, 'Authorization'), false);
    for (const status of [403, 404]) {
      await assert.rejects(githubRequest('/releases', token, { fetcher: async () => new Response('{}', { status }) }),
        error => error.code === 'not-found' && /nicht öffentlich erreichbar/.test(error.message) && !/ungültig/.test(error.message));
    }
    await assert.rejects(githubRequest('/releases', token, { fetcher: async () => new Response('{}', { status: 401 }) }), error => error.code === 'unavailable');
  }
});

test('a download blocked by a missing GitHub grant names the grant instead of a GitHub outage', async t => {
  const previous = globalThis.chrome;
  t.after(() => { globalThis.chrome = previous; });
  for (const granted of [false, true]) {
    globalThis.chrome = { permissions: { contains: async () => granted } };
    await assert.rejects(githubRequest('/releases/assets/1', '', { binary: true, fetcher: async () => { throw new TypeError('Failed to fetch'); } }),
      error => granted ? error.code === 'unavailable' : !error.code && /nicht freigegeben/.test(error.message));
  }
});

function fakeDirectory(initial) {
  const files = new Map(Object.entries(initial)), writes = [];
  const missing = () => Object.assign(new Error('Missing'), { name: 'NotFoundError' });
  const directory = prefix => ({
    getDirectoryHandle: async name => directory(prefix + name + '/'),
    getFileHandle: async (name, options) => {
      const path = prefix + name;
      if (!files.has(path) && !options?.create) throw missing();
      return { getFile: async () => ({ text: async () => files.get(path), arrayBuffer: async () => new TextEncoder().encode(files.get(path)).buffer }), createWritable: async () => {
        let value;
        return { write: async text => { value = text; }, close: async () => { files.set(path, value); writes.push(path); }, abort: async () => {} };
      } };
    }, removeEntry: async name => { if (!files.delete(prefix + name)) throw missing(); }
  });
  return { directory: directory(''), files, writes };
}
test('installation preserves the extension ID, commits the manifest last, and can restore overwritten and new files', async () => {
  const initial = { 'manifest.json': JSON.stringify({ name: 'Video Sync', version: '1.0.0', key: 'existing-key' }), 'popup.js': 'old', 'user-notes.txt': 'keep' };
  const disk = fakeDirectory(initial);
  const files = [{ path: 'manifest.json', encoding: 'utf8', content: JSON.stringify({ name: 'Video Sync', version: '1.0.1' }) },
    { path: 'popup.js', encoding: 'utf8', content: 'new' }, { path: 'ui/new.js', encoding: 'utf8', content: 'new file' }];
  const backup = await backupFiles(disk.directory, files);
  await installFiles(disk.directory, files);
  assert.equal(disk.writes.at(-1), 'manifest.json');
  assert.equal(JSON.parse(disk.files.get('manifest.json')).key, 'existing-key');
  assert.equal(disk.files.get('popup.js'), 'new');
  await restoreFiles(disk.directory, backup);
  assert.deepEqual(Object.fromEntries(disk.files), initial);
});

test('source and local folders are rejected before any verification file is written', async () => {
  for (const build of [{ source: true }, { local: { branch: 'developer' } }]) {
    const disk = fakeDirectory({ 'manifest.json': JSON.stringify({ name: 'Video Sync' }), 'build-info.json': JSON.stringify(build) });
    await assert.rejects(verifyInstallation(disk.directory), /Lokale Arbeitsstände/);
    assert.deepEqual(disk.writes, []);
  }
});

test('an extension identity mismatch cannot cause a partial installation', async () => {
  const disk = fakeDirectory({ 'manifest.json': JSON.stringify({ key: 'old' }), 'popup.js': 'old' });
  await assert.rejects(installFiles(disk.directory, [{ path: 'popup.js', encoding: 'utf8', content: 'new' },
    { path: 'manifest.json', encoding: 'utf8', content: JSON.stringify({ key: 'new' }) }]), /Erweiterungs-ID/);
  assert.deepEqual(disk.writes, []);
});

test('candidate bundles bind build identity and version, not just a mutable release label', async () => {
  const candidate = await candidateBundle({ commit, build: 12 });
  await validateBundle(candidate, 'experimental', commit);
  await assert.rejects(validateBundle({ ...candidate, candidateTag: 'v0.6.0-preview.11' }, 'experimental', commit), /Kandidaten/);
  await assert.rejects(validateBundle({ ...candidate, version: '0.6.0.11' }, 'experimental', commit), /Kandidaten/);
  await assert.rejects(validateBundle({ ...candidate, files: candidate.files.filter(file => file.path !== 'features.js') }, 'experimental', commit), /features\.js/);
});

test('publishing an older candidate later cannot downgrade the Experimental channel', () => {
  const newer = release('v0.6.0-preview.12');
  const older = release('v0.6.0-preview.2', { published_at: '2030-01-01' });
  assert.equal(selectRelease([older, newer], 'experimental'), newer);
});
