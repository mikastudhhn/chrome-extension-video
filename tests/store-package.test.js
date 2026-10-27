import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { prepareStorePackage, STORE_REMOVED_FILES, STORE_REPLACED_MODULES } from '../scripts/store-package.js';

test('the store package replaces the updater with inert modules and keeps every import resolvable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'video-sync-store-test-'));
  try {
    await cp('extension', directory, { recursive: true });
    const manifest = await prepareStorePackage(directory, JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')));
    const files = await readdir(directory);
    for (const file of STORE_REMOVED_FILES) assert.equal(files.includes(file), false, file);
    for (const file of STORE_REPLACED_MODULES) assert.equal(await readFile(join(directory, file), 'utf8'), await readFile(join('scripts/store', file), 'utf8'), file);
    assert.equal(await readFile(join(directory, 'distribution.js'), 'utf8'), 'export const STORE = true;\n');
    assert.equal(manifest.permissions.includes('alarms'), false);
    assert.equal(manifest.host_permissions, undefined);
    assert.equal(manifest.optional_permissions, undefined);
    assert.deepEqual(manifest.optional_host_permissions, ['https://*/*', 'http://*/*']);
    // Nothing left that downloads, writes or reloads extension code.
    for (const file of files.filter(file => file.endsWith('.js'))) {
      const source = await readFile(join(directory, file), 'utf8');
      assert.doesNotMatch(source, /showDirectoryPicker|createWritable|api\.github\.com|release-assets/, file);
    }
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
    execFileSync(process.execPath, ['--experimental-vm-modules', '--no-warnings', 'scripts/validate-development.js', directory], { stdio: 'pipe' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
