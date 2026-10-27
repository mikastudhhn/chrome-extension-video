import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, cp, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { updateAssetName } from '../extension/package-files.js';
import { REPOSITORY } from '../extension/github-updates.js';
import { verifyUpdateSignature } from '../extension/update-signature.js';
import { candidateBundle, testReleaseKey, generateTestKey, releaseKeyModule, signedUpdateAssets } from './update-fixtures.js';
import { spawnSync } from 'node:child_process';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
test('Stable promotion copies accepted bytes despite changed sources; corrupted downloads cannot overwrite them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'video-sync-promote-test-'));
  try {
    await mkdir(join(root, 'scripts')); await mkdir(join(root, 'extension')); await mkdir(join(root, 'bin'));
    for (const file of ['promote.js', 'promotion-policy.js', 'github-releases.js', 'release-refs.js', 'release-signing.js', 'store-package.js']) await cp(resolve('scripts', file), join(root, 'scripts', file));
    for (const file of ['github-updates.js', 'package-files.js', 'update-signature.js', 'features.js']) await cp(`extension/${file}`, join(root, 'extension', file));
    const key = testReleaseKey();
    await writeFile(join(root, 'extension/release-key.js'), releaseKeyModule(key.publicKey));
    await writeFile(join(root, 'package.json'), '{"type":"module"}');
    await writeFile(join(root, 'extension/manifest.json'), '{"version":"99.0.0"}');
    const commit = 'a'.repeat(40), tag = 'v0.6.0-preview.12';
    const update = JSON.stringify(await candidateBundle({ channel: 'stable', commit, build: 12,
      extra: { 'assets/icons/mark.png': Uint8Array.from([0, 255, 128, 0]) } }));
    const preparedName = updateAssetName(true), publishedName = updateAssetName();
    // CI signed the prepared Stable package for the candidate tag.
    const candidateSignature = (await signedUpdateAssets(update, { tag, channel: 'stable', preparedStable: true })).signature;
    const sources = { [preparedName]: update, 'video-sync-0.6.0.12-stable.zip': 'opaque previously tested ZIP bytes', [`${preparedName}.sig`]: candidateSignature };
    for (const [name, value] of Object.entries(sources)) await writeFile(join(root, name), value);
    const release = { id: 1, tag_name: tag, target_commitish: commit, draft: false, prerelease: true,
      assets: Object.entries(sources).map(([name, value]) => ({ name, state: 'uploaded', digest: `sha256:${hash(value)}` })) };
    const statePath = join(root, 'mock.json');
    await writeFile(statePath, JSON.stringify({ root, releases: { [tag]: release } }));
    const mock = join(root, 'bin/gh');
    await cp('tests/fixtures/release-gh.js', mock);
    await chmod(mock, 0o755);
    const run = (env = {}) => spawnSync(process.execPath, ['scripts/promote.js', 'stable', '--candidate', tag, '--tested', commit], {
      cwd: root, encoding: 'utf8', env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, MOCK_STATE: statePath, RELEASE_SIGNING_KEY: key.pem, RELEASE_SIGNING_KEY_FILE: '', ...env }
    });
    for (const env of [{ RELEASE_SIGNING_KEY: '' }, { RELEASE_SIGNING_KEY: generateTestKey().pem }]) {
      const refused = run(env); assert.notEqual(refused.status, 0);
      assert.equal(JSON.parse(await readFile(statePath)).releases['v0.6.0'], undefined, 'no Stable release without the matching key');
    }
    const first = run(); assert.equal(first.status, 0, first.stderr);
    const published = join(root, 'published/v0.6.0');
    assert.equal(await readFile(join(published, publishedName), 'utf8'), update);
    // The owner's promotion signs the unchanged bytes as the released Stable update.
    const expected = { repository: REPOSITORY, tag: 'v0.6.0', channel: 'stable', asset: publishedName, sha256: hash(update) };
    await verifyUpdateSignature(await readFile(join(published, `${publishedName}.sig`)), expected, { publicKey: key.publicKey });
    assert.equal(await readFile(join(published, 'video-sync-0.6.0.12.zip'), 'utf8'), sources['video-sync-0.6.0.12-stable.zip']);
    const publishedRelease = JSON.parse(await readFile(statePath)).releases['v0.6.0'];
    assert.equal(publishedRelease.draft, false);
    assert.equal(publishedRelease.assets.some(asset => asset.name === preparedName), false);
    const acceptedState = JSON.parse(await readFile(statePath));
    for (const problem of ['commit', 'channel', 'asset-name', 'package-commit', 'zip-digest', 'candidate-signature']) {
      const state = structuredClone(acceptedState), candidate = state.releases[tag];
      let body = update;
      if (problem === 'commit') candidate.target_commitish = 'b'.repeat(40);
      if (problem === 'asset-name') candidate.assets[0].name = 'unexpected.json';
      if (problem === 'zip-digest') candidate.assets[1].digest = 'sha256:' + '0'.repeat(64);
      if (problem === 'candidate-signature') {
        // A prepared package signed by any other key is not CI provenance.
        const foreign = (await signedUpdateAssets(update, { tag, channel: 'stable', preparedStable: true, key: generateTestKey() })).signature;
        await writeFile(join(root, `${preparedName}.sig`), foreign);
        candidate.assets[2].digest = `sha256:${hash(foreign)}`;
      }
      if (['channel', 'package-commit'].includes(problem)) {
        const changed = JSON.parse(update);
        if (problem === 'channel') changed.channel = 'experimental';
        else changed.commit = 'b'.repeat(40);
        body = JSON.stringify(changed);
        candidate.assets[0].digest = `sha256:${hash(body)}`;
        // Validly signed, so the promotion policy itself must reject it.
        const resigned = (await signedUpdateAssets(body, { tag, channel: 'stable', preparedStable: true })).signature;
        await writeFile(join(root, `${preparedName}.sig`), resigned);
        candidate.assets[2].digest = `sha256:${hash(resigned)}`;
      }
      await writeFile(join(root, preparedName), body);
      await writeFile(statePath, JSON.stringify(state));
      const rejected = run(); assert.notEqual(rejected.status, 0, problem);
      await writeFile(join(root, `${preparedName}.sig`), candidateSignature);
      assert.equal(await readFile(join(published, publishedName), 'utf8'), update);
      assert.deepEqual(JSON.parse(await readFile(statePath)).releases['v0.6.0'], publishedRelease);
    }
    await writeFile(statePath, JSON.stringify(acceptedState));
    await writeFile(join(root, preparedName), update + 'tampered');
    const second = run(); assert.notEqual(second.status, 0); assert.match(second.stderr, /Downloaded asset changed/);
    assert.equal(await readFile(join(published, publishedName), 'utf8'), update);
  } finally { await rm(root, { recursive: true, force: true }); }
});
