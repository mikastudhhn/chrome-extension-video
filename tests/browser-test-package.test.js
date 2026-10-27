import { packageFile, fileEncoding, updateAssetName, UPDATE_SCHEMA } from '../extension/package-files.js';
import { REPOSITORY } from '../extension/github-updates.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPackage, sha256, loadedExtensionIdentities } from '../scripts/browser-test-package.js';
import { browserMatrix } from '../scripts/browser-test-matrix.js';

// A real ZIP/update pair proves the gate refuses stale commits, tampered ZIPs,
// and update files that differ from the installed package before browser launch.
test('only matching archive, update bundle, profile and commit enter the browser matrix', async () => {
  const root = await mkdtemp(join(tmpdir(), 'browser-package-test-'));
  try {
    const commit = 'a'.repeat(40), channel = 'stable', version = '0.6.0.0';
    const metadata = { schema: 2, repository: REPOSITORY, commit, channel, candidateTag: 'v0.6.0-preview.0' };
    const files = { 'build-info.json': JSON.stringify(metadata), 'manifest.json': JSON.stringify({ name: 'Video Sync', manifest_version: 3, version }), 'popup.js': 'original',
      'features.js': '', 'background.js': '', 'popup.html': '', 'offscreen.html': '', 'updates.html': '', 'updates.js': '',
      'assets/icons/mark.png': Buffer.from([0, 255, 254, 128]) };
    const dist = join(root, 'dist', channel); await mkdir(dist, { recursive: true });
    const archive = join(dist, `video-sync-${version}.zip`);
    execFileSync('python3', ['-c', `import sys,json,zipfile,base64
with zipfile.ZipFile(sys.argv[1],'w') as archive:
 for name,content in json.loads(sys.argv[2]).items(): archive.writestr('video-sync/extension/'+name,base64.b64decode(content))
`, archive, JSON.stringify(Object.fromEntries(Object.entries(files).map(([path, bytes]) => [path, Buffer.from(bytes).toString('base64')])))]);
    await writeFile(`${archive}.sha256`, sha256(await readFile(archive)));
    const entries = await Promise.all(Object.entries(files).map(([path, bytes]) => packageFile(path, Buffer.from(bytes), fileEncoding(path))));
    const bundle = { ...metadata, schema: UPDATE_SCHEMA, version, files: entries };
    const update = join(dist, updateAssetName()); await writeFile(update, JSON.stringify(bundle));
    const input = { root, channel, version, commit, destination: join(root, 'extracted') };
    const result = await loadPackage(input);
    assert.equal(result.metadata.commit, commit);
    assert.equal(result.updatePath, update);
    assert.equal(result.updateSchema, UPDATE_SCHEMA);
    assert.equal(result.hashes['assets/icons/mark.png'], sha256(files['assets/icons/mark.png']));
    assert.equal(result.hashes['popup.js'], sha256('original'));
    await assert.rejects(loadPackage({ ...input, commit: 'b'.repeat(40) }), /candidate commit/);
    const asset = bundle.files.find(file => file.path.endsWith('.png'));
    const content = asset.content;
    asset.content = 'not base64';
    await writeFile(update, JSON.stringify(bundle));
    await assert.rejects(loadPackage(input), /Base64/);
    asset.content = content; asset.size++;
    await writeFile(update, JSON.stringify(bundle));
    await assert.rejects(loadPackage(input), /Größe/);
    asset.size--;
    bundle.files[2] = { ...bundle.files[2], content: 'modified', sha256: sha256('modified'), size: Buffer.byteLength('modified') };
    await writeFile(update, JSON.stringify(bundle));
    await assert.rejects(loadPackage(input), /ZIP\/update match/);
    await writeFile(`${archive}.sha256`, '0'.repeat(64));
    await assert.rejects(loadPackage(input), /ZIP checksum/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('CI verifies stacked PR bases and only releases tested main artifacts outside pull requests', async () => {
  const workflow = await readFile('.github/workflows/verify.yml', 'utf8');
  const prTrigger = workflow.split('  pull_request:')[1].split('  push:')[0];
  assert.doesNotMatch(prTrigger, /branches|paths/);
  assert.match(workflow, /xvfb-run --auto-servernum npm run test:browser -- --skip-build/);
  const release = workflow.split('\n  release:')[1];
  assert.match(release, /needs: verify/);
  assert.match(release, /if: github\.event_name != 'pull_request' && github\.ref == 'refs\/heads\/main'/);
  assert.doesNotMatch(release, /npm run package/);
});


test('required discovery suites select both extracted candidate profiles', () => {
  const packages = { stable: { extension: '/verified/stable-candidate/extension' },
    experimental: { extension: '/verified/experimental-candidate/extension' }, store: { extension: '/verified/store' } };
  const discovery = browserMatrix(packages).filter(suite => suite.script === 'e2e-player-discovery.js');
  assert.equal(discovery.length, 2);
  for (const channel of ['stable', 'experimental']) {
    const suite = discovery.find(suite => suite.name === `discovery-${channel}-candidate`);
    assert.ok(suite, `Missing required ${channel} candidate suite`);
    assert.equal(suite.env.TEST_EXTENSION, packages[channel].extension);
    assert.equal(suite.env.TEST_CHANNEL, channel);
  }
});

test('browser identity evidence records every loaded installation with its own manifest and candidate metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'browser-identities-test-'));
  try {
    const directories = [join(root, 'first'), join(root, 'second')];
    const metadata = { channel: 'stable', commit: 'c'.repeat(40) };
    for (const [index, directory] of directories.entries()) {
      await mkdir(directory);
      await writeFile(join(directory, 'build-info.json'), JSON.stringify(metadata));
      await writeFile(join(directory, 'manifest.json'), JSON.stringify({ name: `Fixture ${index}` }));
    }
    const identities = await loadedExtensionIdentities([`--load-extension=${directories.join(',')}`]);
    assert.deepEqual(identities.map(identity => identity.extension), directories);
    assert.ok(identities.every(identity => identity.metadata.commit === metadata.commit));
    assert.notEqual(identities[0].manifestSha256, identities[1].manifestSha256);
    assert.deepEqual(await loadedExtensionIdentities([`--load-extension=${directories[0]}`]), [identities[0]]);
    assert.deepEqual(await loadedExtensionIdentities([]), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('delayed-start regression runs both current candidate engines in the required matrix', () => {
  const packages = { stable: { extension: '/verified/stable' }, experimental: { extension: '/verified/experimental' }, store: { extension: '/verified/store' } };
  const suites = browserMatrix(packages).filter(suite => suite.name.startsWith('core-delayed-start-'));
  assert.equal(suites.length, 2);
  for (const channel of ['stable', 'experimental']) {
    const suite = suites.find(suite => suite.name === `core-delayed-start-${channel}-candidate`);
    assert.equal(suite.script, 'e2e.js');
    assert.deepEqual(suite.env, { TEST_EXTENSION: packages[channel].extension, TEST_CHANNEL: channel, TEST_STARTUP_DELAY_MS: '800' });
  }
});
