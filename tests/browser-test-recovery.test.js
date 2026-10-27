import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserMatrix } from '../scripts/browser-test-matrix.js';
import { recoveryCandidate, recoveryTarget } from '../scripts/browser-test-recovery.js';
import { fileHashes } from '../scripts/browser-test-package.js';
import { fileBytes, validateFileEntries } from '../extension/package-files.js';

async function candidateFixture(t, channel = 'experimental', overrides = {}) {
  const extension = await mkdtemp(join(tmpdir(), 'recovery-candidate-'));
  t.after(() => rm(extension, { recursive: true, force: true }));
  const metadata = { schema: 2, repository: 'mikastudhhn/chrome-extension-video', commit: 'a'.repeat(40), channel,
    candidateTag: 'v0.5.0-preview.7', local: null, ...overrides };
  const files = {
    'manifest.json': JSON.stringify({ name: 'Video Sync', manifest_version: 3, version: '0.5.0.7' }),
    'build-info.json': JSON.stringify(metadata),
    'popup.js': '// Candidate popup.\n', 'offscreen.js': '// Candidate engine.\n'
  };
  for (const [path, content] of Object.entries(files)) await writeFile(join(extension, path), content);
  return { extension, channel };
}

test('shared CI matrix runs recovery for both matching candidate profiles', () => {
  const packages = { stable: { extension: '/verified/stable/extension' }, experimental: { extension: '/verified/experimental/extension' }, store: { extension: '/verified/store' } };
  const suites = browserMatrix(packages).filter(suite => suite.script === 'e2e-update-recovery.js');
  assert.deepEqual(suites.map(suite => suite.name), ['update-recovery-stable', 'update-recovery-experimental']);
  for (const suite of suites) {
    const profile = suite.env.TEST_CHANNEL;
    assert.equal(suite.env.TEST_EXTENSION, packages[profile].extension);
  }
});

test('recovery input refuses absent paths/channels and source/dev package fallbacks', async t => {
  await assert.rejects(recoveryCandidate({ channel: 'stable' }), /TEST_EXTENSION/);
  const input = await candidateFixture(t);
  await assert.rejects(recoveryCandidate({ extension: input.extension }), /TEST_CHANNEL/);
  await assert.rejects(recoveryCandidate({ ...input, channel: 'stable' }), /matching candidate profile/);
  for (const overrides of [{ schema: 1 }, { source: true }, { local: { branch: 'fix/test' } }, { candidateTag: 'v0.5.0-preview.6' }]) {
    await assert.rejects(recoveryCandidate(await candidateFixture(t, 'experimental', overrides)));
  }
});

for (const channel of ['stable', 'experimental']) {
  test(`${channel}: synthetic OPFS target preserves the loaded candidate and has a separately identifiable target`, async t => {
    const input = await candidateFixture(t, channel);
    await mkdir(join(input.extension, 'assets/icons'), { recursive: true });
    const icon = Buffer.from([137, 80, 78, 71, 0, 255, 254, 128]);
    await writeFile(join(input.extension, 'assets/icons/recovery.png'), icon);
    const candidate = await recoveryCandidate(input);
    const original = structuredClone(candidate);
    const target = await recoveryTarget(candidate);
    await validateFileEntries(candidate.files);
    await validateFileEntries(target);
    assert.deepEqual(Buffer.from(fileBytes(target.find(file => file.path.endsWith('.png')))), icon);
    assert.deepEqual(candidate, original);
    assert.deepEqual(await fileHashes(input.extension), candidate.hashes);
    const targetBuild = JSON.parse(target.find(file => file.path === 'build-info.json').content);
    assert.notEqual(targetBuild.commit, candidate.metadata.commit);
    assert.notEqual(targetBuild.candidateTag, candidate.metadata.candidateTag);
    assert.equal(targetBuild.channel, channel);
    const targetManifest = JSON.parse(target.find(file => file.path === 'manifest.json').content);
    assert.notEqual(targetManifest.version, candidate.manifest.version);
    assert.equal(target.length, candidate.files.length + 1);
    assert.equal(target.at(-1).path, 'recovery-fixture.js');
    for (const file of candidate.files.filter(file => !['manifest.json', 'build-info.json', 'popup.js'].includes(file.path))) {
      assert.deepEqual(target.find(next => next.path === file.path), file);
    }
  });
}
