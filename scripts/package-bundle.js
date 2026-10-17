import { readdir, readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { validPackagePath, packageFile, fileEncoding, validateFileEntries, validatePackageReferences, updateAssetName, UPDATE_SCHEMA, MAX_TRANSPORT_BYTES } from '../extension/package-files.js';
import { validateBundle } from '../extension/github-updates.js';

// One inventory for ZIP parity and JSON: unsupported files fail, never disappear.
export async function createPackageBundle(directory, identity) {
  const files = [];
  async function visit(relative = '') {
    for (const name of (await readdir(join(directory, relative))).sort()) {
      const path = relative ? `${relative}/${name}` : name;
      const stat = await lstat(join(directory, path));
      if (stat.isSymbolicLink()) throw new Error(`Symlink im Paket: ${path}`);
      if (stat.isDirectory()) { await visit(path); continue; }
      if (!stat.isFile() || !validPackagePath(path)) throw new Error(`Nicht unterstützte Paketdatei: ${path}`);
      files.push(await packageFile(path, await readFile(join(directory, path)), fileEncoding(path)));
    }
  }
  await visit();
  await validateFileEntries(files);
  validatePackageReferences(files);
  const bundle = { ...identity, schema: UPDATE_SCHEMA, files };
  if (Buffer.byteLength(JSON.stringify(bundle)) > MAX_TRANSPORT_BYTES) throw new Error('Update-Paket ist zu groß.');
  return bundle;
}

// Reads the update file built for one package profile under dist/<profile>.
export async function readPackageBundle(directory, channel) {
  const path = join(directory, updateAssetName());
  const bundle = JSON.parse(await readFile(path, 'utf8'));
  await validateBundle(bundle, channel, bundle.commit);
  return { name: updateAssetName(), path, bundle };
}
