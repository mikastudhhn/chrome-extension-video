import { readPackageBundle } from './package-bundle.js';
import { fileBytes } from '../extension/package-files.js';
import assert from 'node:assert/strict';
import { readFile, readdir, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export async function fileHashes(root) {
  const files = await readdir(root, { recursive: true, withFileTypes: true });
  const result = {};
  for (const file of files.filter(file => file.isFile())) {
    const path = join(file.parentPath, file.name);
    result[path.slice(root.length + 1)] = sha256(await readFile(path));
  }
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}

// Load the actual archive, not a mutable build directory. Verify that the ZIP,
// update bundle and metadata name the same files before starting any browser.
export async function loadPackage({ root, channel, version, commit, destination }) {
  const archive = join(root, 'dist', channel, `video-sync-${version}.zip`);
  const archiveHash = sha256(await readFile(archive));
  const expected = (await readFile(`${archive}.sha256`, 'utf8')).split(/\s/)[0];
  assert.equal(archiveHash, expected, `${channel}: ZIP checksum`);
  await mkdir(destination, { recursive: true });
  execFileSync('python3', ['-c', `import pathlib,sys,zipfile
root=pathlib.Path(sys.argv[2]).resolve()
with zipfile.ZipFile(sys.argv[1]) as archive:
 for item in archive.infolist():
  target=(root/item.filename).resolve()
  if not target.is_relative_to(root): raise ValueError('Unsafe archive path')
 archive.extractall(root)
`, archive, destination]);
  const extension = join(destination, 'video-sync', 'extension');
  const metadata = JSON.parse(await readFile(join(extension, 'build-info.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8'));
  assert.equal(metadata.commit, commit, `${channel}: candidate commit`);
  assert.equal(metadata.channel, channel, `${channel}: package profile`);
  assert.equal(manifest.version, version, `${channel}: manifest version`);
  const hashes = await fileHashes(extension);
  const { path: updatePath, bundle } = await readPackageBundle(join(root, 'dist', channel), channel);
  const bundleBytes = await readFile(updatePath);
  assert.equal(bundle.commit, commit); assert.equal(bundle.channel, channel); assert.equal(bundle.version, version);
  assert.equal(bundle.candidateTag, metadata.candidateTag);
  assert.equal(new Set(bundle.files.map(file => file.path)).size, bundle.files.length, 'No duplicate update files');
  assert.deepEqual(Object.keys(hashes).sort(), bundle.files.map(file => file.path).sort(), 'ZIP and update file set');
  for (const file of bundle.files) {
    assert.equal(sha256(fileBytes(file)), file.sha256, `Update content: ${file.path}`);
    assert.equal(hashes[file.path], file.sha256, `ZIP/update match: ${file.path}`);
  }
  return { archive, updatePath, updateSchema: bundle.schema, sha256: archiveHash, updateSha256: sha256(bundleBytes), extension, metadata, version, hashes };
}

// Chrome's --load-extension argument may contain several installations. Record
// every copy separately so conflict fixtures have the same identity evidence.
export async function loadedExtensionIdentities(args) {
  const paths = args.find(arg => arg.startsWith('--load-extension='))?.slice('--load-extension='.length).split(',') || [];
  return Promise.all(paths.map(async extension => ({ extension,
    metadata: JSON.parse(await readFile(join(extension, 'build-info.json'), 'utf8')),
    manifestSha256: sha256(await readFile(join(extension, 'manifest.json')))
  })));
}
