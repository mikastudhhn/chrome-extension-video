import { chmod, readdir, mkdir, copyFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
const directory = resolve(execFileSync('git', ['rev-parse', '--git-common-dir'], { encoding: 'utf8' }).trim(), 'video-sync-hooks');
await mkdir(directory, { recursive: true });
await copyFile('scripts/git-guard.js', join(directory, 'guard.mjs'));
for (const hook of await readdir('.githooks')) {
  const path = join(directory, hook);
  // Hooks remain installed across branch changes.
  await copyFile(join('.githooks', hook), path);
  await chmod(path, 0o755);
}
execFileSync('git', ['config', '--local', 'core.hooksPath', directory]);
console.log('Lokale Prüfungen aktiv: PR-Arbeitsbranch → main; unveränderliche Release-Tags.');
