import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileHashes } from './browser-test-package.js';
import { packageFile } from '../extension/package-files.js';

// The shared starter supplies the verified ZIP extraction. Refuse standalone
// source defaults and packages of a different profile.
export async function recoveryCandidate({ extension, channel }) {
  assert.ok(extension, 'Recovery requires TEST_EXTENSION from the candidate browser starter');
  assert.ok(['stable', 'experimental'].includes(channel), 'Recovery requires TEST_CHANNEL');
  const directory = resolve(extension);
  const metadata = JSON.parse(await readFile(join(directory, 'build-info.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  assert.equal(metadata.schema, 2, 'Recovery requires a built candidate');
  assert.equal(metadata.repository, 'mikastudhhn/chrome-extension-video');
  assert.equal(metadata.channel, channel, 'Recovery tests the runtime of the matching candidate profile');
  assert.ok(!metadata.source && !metadata.local, 'Source and Dev builds are not recovery candidates');
  assert.match(metadata.commit, /^[a-f0-9]{40}$/);
  assert.match(manifest.version, /^\d+\.\d+\.\d+\.\d+$/);
  const numbers = manifest.version.split('.');
  assert.equal(metadata.candidateTag, `v${numbers.slice(0, 3).join('.')}-preview.${Number(numbers[3])}`);
  const hashes = await fileHashes(directory);
  const files = await Promise.all(Object.keys(hashes).map(async path => {
    const file = await packageFile(path, await readFile(join(directory, path)), path.endsWith('.png') ? 'base64' : 'utf8');
    assert.equal(file.sha256, hashes[path], `Recovery fixture preserves every byte: ${path}`);
    return file;
  }));
  return { directory, channel, metadata, manifest, hashes, files };
}

// Only the OPFS transaction target is synthetic; browser runtime files retain
// the exact candidate identity. This target is never a published release claim.
export async function recoveryTarget(candidate) {
  const parts = candidate.manifest.version.split('.').map(Number);
  parts[3] = parts[3] < 65535 ? parts[3] + 1 : parts[3] - 1;
  const version = parts.join('.');
  const commit = candidate.metadata.commit === 'b'.repeat(40) ? 'c'.repeat(40) : 'b'.repeat(40);
  const candidateTag = `v${parts.slice(0, 3).join('.')}-preview.${parts[3]}`;
  const replacements = {
    'manifest.json': JSON.stringify({ ...candidate.manifest, version }),
    'build-info.json': JSON.stringify({ ...candidate.metadata, commit, candidateTag }),
    'popup.js': candidate.files.find(file => file.path === 'popup.js').content + '\n// Synthetic OPFS recovery target.\n'
  };
  assert.ok(!candidate.hashes['recovery-fixture.js'], 'Fixture path must not overwrite a package asset');
  return [...await Promise.all(candidate.files.map(file => replacements[file.path] === undefined ? file
    : packageFile(file.path, new TextEncoder().encode(replacements[file.path]), 'utf8'))),
    await packageFile('recovery-fixture.js', new TextEncoder().encode('// Added by the interrupted OPFS update.\n'), 'utf8')];
}
