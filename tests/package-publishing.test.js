import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { updateAssetName } from '../extension/package-files.js';
import { REPOSITORY } from '../extension/github-updates.js';
import { verifyUpdateSignature } from '../extension/update-signature.js';
import { candidateBundle, testReleaseKey, releaseKeyModule } from './update-fixtures.js';

const hash = value => createHash('sha256').update(value).digest('hex');
// An isolated single-commit repository with prebuilt candidate files and a mock gh.
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'video-sync-publisher-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of ['scripts', 'extension', 'bin', 'docs', 'dist/experimental', 'dist/stable', 'dist/store']) await mkdir(join(root, dir), { recursive: true });
  for (const file of ['publish-release.js', 'package-bundle.js', 'github-releases.js', 'release-refs.js', 'release-signing.js', 'store-package.js']) await cp(`scripts/${file}`, join(root, 'scripts', file));
  for (const file of ['github-updates.js', 'package-files.js', 'update-signature.js', 'features.js']) await cp(`extension/${file}`, join(root, 'extension', file));
  // The fixture checkout trusts a freshly generated test key, never the real one.
  await writeFile(join(root, 'extension/release-key.js'), releaseKeyModule(testReleaseKey().publicKey));
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  await writeFile(join(root, 'docs/release-notes.md'), 'Test fixture only.');
  await cp('tests/fixtures/release-gh.js', join(root, 'bin/gh')); await chmod(join(root, 'bin/gh'), 0o755);
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
  git('init', '--initial-branch=ft/publisher-fixture');
  git('config', 'user.name', 'Publisher fixture'); git('config', 'user.email', 'fixture@example.invalid');
  git('add', '.'); git('-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'isolated publisher fixture');
  const commit = git('rev-parse', 'HEAD'); git('update-ref', 'refs/remotes/origin/main', commit);
  const tag = 'v0.6.0-preview.100', version = '0.6.0.100';
  const sources = {};
  for (const channel of ['experimental', 'stable']) {
    sources[channel] = JSON.stringify(await candidateBundle({ channel, commit, build: 100,
      extra: { 'assets/icons/mark.png': Uint8Array.from([0, 255, 254, 128]) } }));
    await writeFile(join(root, 'dist', channel, updateAssetName()), sources[channel]);
    const archive = `video-sync-${version}.zip`, bytes = `already built ${channel} ZIP`;
    await writeFile(join(root, 'dist', channel, archive), bytes);
    await writeFile(join(root, 'dist', channel, `${archive}.sha256`), `${hash(bytes)}  ${archive}\n`);
  }
  const store = join(root, 'dist/store', `video-sync-${version}-store.zip`);
  execFileSync('python3', ['-c', 'import json,sys,zipfile\nwith zipfile.ZipFile(sys.argv[1],"w") as z: z.writestr("build-info.json", json.dumps({"commit": sys.argv[2], "distribution": "chrome-web-store"}))', store, commit]);
  await writeFile(`${store}.sha256`, `${hash(await readFile(store))}  video-sync-${version}-store.zip\n`);
  const statePath = join(root, 'mock.json');
  await writeFile(statePath, JSON.stringify({ root, releases: {} }));
  const run = (env = {}) => spawnSync(process.execPath, ['scripts/publish-release.js'], { cwd: root, encoding: 'utf8',
    env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, MOCK_STATE: statePath, RELEASE_TAG: tag, GITHUB_REF: 'refs/heads/main',
      RELEASE_SIGNING_KEY: testReleaseKey().pem, RELEASE_SIGNING_KEY_FILE: '', ...env } });
  return { root, statePath, sources, tag, commit, run, version };
}

test('publisher uploads the exact built files under fixed names and never replaces published bytes', async t => {
  const f = await fixture(t);
  const first = f.run(); assert.equal(first.status, 0, first.stderr);
  const state = JSON.parse(await readFile(f.statePath));
  const release = state.releases[f.tag];
  assert.equal(release.prerelease, true); assert.equal(release.draft, false);
  assert.equal(release.target_commitish, f.commit);
  assert.deepEqual(release.assets.map(asset => asset.name).sort(), [`video-sync-${f.version}-stable.zip`, `video-sync-${f.version}.zip`,
    `video-sync-${f.version}.zip.sha256`, `video-sync-${f.version}-store.zip`, `video-sync-${f.version}-store.zip.sha256`,
    'update-stable.json', 'update-stable.json.sig', 'update.json', 'update.json.sig'].sort());
  const publicKey = testReleaseKey().publicKey;
  for (const channel of ['experimental', 'stable']) {
    const asset = updateAssetName(channel === 'stable');
    const published = await readFile(join(f.root, 'published', f.tag, asset));
    assert.equal(published.toString('utf8'), f.sources[channel]);
    const signature = await readFile(join(f.root, 'published', f.tag, `${asset}.sig`));
    const expected = { repository: REPOSITORY, tag: f.tag, channel, asset, sha256: hash(published) };
    await verifyUpdateSignature(signature, expected, { publicKey });
    if (channel === 'stable') {
      // The prepared Stable package is not installable as a released Stable update.
      await assert.rejects(verifyUpdateSignature(signature, { ...expected, tag: 'v0.6.0', asset: 'update.json' }, { publicKey }), /anderen Release/);
    }
  }
  assert.equal(Object.keys(state.releases).length, 1, 'no additional bridge or Stable release');
  const before = JSON.stringify(state.releases);
  // A re-run reuses the uploaded (randomized) signatures instead of re-signing.
  const repeated = f.run(); assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(JSON.stringify(JSON.parse(await readFile(f.statePath)).releases), before);
  await writeFile(join(f.root, 'dist/experimental', `video-sync-${f.version}.zip`), 'changed ZIP');
  const changed = f.run(); assert.notEqual(changed.status, 0); assert.match(changed.stderr, /Existing asset differs/);
  assert.equal(JSON.stringify(JSON.parse(await readFile(f.statePath)).releases), before);
});

test('a mismatched tag, a non-main ref or an invalid package is rejected before any external write', async t => {
  const f = await fixture(t);
  for (const env of [{ RELEASE_TAG: 'v0.6.0-preview.99' }, { RELEASE_TAG: 'experimental-' + f.commit }, { GITHUB_REF: 'refs/heads/ft/other' }, { RELEASE_SIGNING_KEY: '' }]) {
    const result = f.run(env); assert.notEqual(result.status, 0, JSON.stringify(env));
  }
  // A key that does not match the checkout's release key never publishes.
  const { generateTestKey } = await import('./update-fixtures.js');
  const wrongKey = f.run({ RELEASE_SIGNING_KEY: generateTestKey().pem });
  assert.notEqual(wrongKey.status, 0); assert.match(wrongKey.stderr, /does not match/);
  const bundle = JSON.parse(f.sources.stable); bundle.channel = 'experimental';
  await writeFile(join(f.root, 'dist/stable', updateAssetName()), JSON.stringify(bundle));
  const result = f.run(); assert.notEqual(result.status, 0); assert.match(result.stderr, /Kanal/);
  const state = JSON.parse(await readFile(f.statePath));
  assert.deepEqual(state.releases, {});
  assert.equal((state.calls || []).some(call => call.includes('POST') || ['upload', 'edit'].includes(call[1])), false);
});
