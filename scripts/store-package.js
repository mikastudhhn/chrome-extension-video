import { cp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { featuresFor } from '../extension/features.js';

// Chrome Web Store package: Chrome installs and updates it, so the GitHub
// updater is replaced by inert modules and every file that downloads, verifies
// or writes extension code is removed. Store policy forbids self-updating code.
export const STORE_REPLACED_MODULES = ['background-updates.js', 'github-updates.js', 'update-service.js', 'update-storage.js', 'updates.js'];
export const STORE_REMOVED_FILES = ['package-files.js', 'release-key.js', 'update-install.js', 'update-recovery.js', 'update-review.js',
  'update-runner.js', 'update-signature.js', 'updates-page.js', 'updates-view.js', 'updates.css', 'updates.html'];

export async function prepareStorePackage(extensionDirectory, manifest) {
  const stubs = new URL('./store/', import.meta.url);
  const available = (await readdir(stubs)).filter(file => file.endsWith('.js')).sort();
  if (JSON.stringify(available) !== JSON.stringify([...STORE_REPLACED_MODULES].sort())) throw new Error('scripts/store does not match STORE_REPLACED_MODULES.');
  for (const file of STORE_REPLACED_MODULES) await cp(new URL(file, stubs), join(extensionDirectory, file));
  for (const file of STORE_REMOVED_FILES) await rm(join(extensionDirectory, file));
  await writeFile(join(extensionDirectory, 'distribution.js'), 'export const STORE = true;\n');
  // Alarms only schedule GitHub checks; localhost serves local test relays only.
  manifest.permissions = manifest.permissions.filter(permission => permission !== 'alarms');
  delete manifest.host_permissions;
  // tabCapture serves only the sound test, which Stable feature sets (and so this package) lack.
  if (featuresFor('stable').audioDiagnostics) throw new Error('Store packages would need tabCapture for the sound test.');
  manifest.optional_permissions = (manifest.optional_permissions || []).filter(permission => permission !== 'tabCapture');
  if (!manifest.optional_permissions.length) delete manifest.optional_permissions;
  manifest.version_name = manifest.version;
  return manifest;
}

// The Web Store ZIP of a candidate must match its checksum file and name the
// candidate commit; release scripts publish or promote it only after this check.
export async function verifyStorePackage(archive, commit) {
  const bytes = await readFile(archive);
  const expected = (await readFile(`${archive}.sha256`, 'utf8')).split(/\s/)[0];
  if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('Store package checksum mismatch.');
  const build = JSON.parse(execFileSync('python3', ['-c', 'import sys,zipfile;print(zipfile.ZipFile(sys.argv[1]).read("build-info.json").decode())', archive], { encoding: 'utf8' }));
  if (build.distribution !== 'chrome-web-store' || build.commit !== commit) throw new Error('Store package identity mismatch.');
}
