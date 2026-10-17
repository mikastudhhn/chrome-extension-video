import { cp, mkdir, readFile, writeFile, rm, mkdtemp, rename, readdir } from 'node:fs/promises';
import { watch } from 'node:fs';
import { execFileSync, execFile } from 'node:child_process';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { helperSettings, startHelper } from './development-helper.js';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).trim();

export async function prepareDevelopment(destination = 'dist/development/extension', helper) {
  const branch = git('branch', '--show-current');
  if (!branch || branch.startsWith('archive/')) throw new Error('Lokaler Build benötigt main oder einen ausgecheckten Arbeitsbranch.');
  const directory = resolve(destination);
  if (directory === resolve('extension') || !directory.startsWith(resolve('dist') + '/')) throw new Error('Entwicklungsbuild muss unter dist/ liegen.');
  await mkdir(dirname(directory), { recursive: true });
  helper ??= await helperSettings(directory);
  const staged = await mkdtemp(resolve('dist', '.development-'));
  try {
    await cp('extension', staged, { recursive: true });
    await cp('scripts/development-client.js', join(staged, 'development.js'));
    const manifest = JSON.parse(await readFile(join(staged, 'manifest.json'), 'utf8'));
    manifest.name = 'Video Sync · Dev';
    await writeFile(join(staged, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    const offscreen = await readFile(join(staged, 'offscreen.js'), 'utf8');
    await writeFile(join(staged, 'offscreen.js'), offscreen.replace('const DEVELOPMENT = false;', 'const DEVELOPMENT = true;'));
    const digest = createHash('sha256').update(branch);
    const files = (await readdir(staged, { recursive: true, withFileTypes: true }))
      .filter(entry => entry.isFile() && entry.name !== 'build-info.json')
      .map(entry => join(entry.parentPath, entry.name)).sort();
    for (const path of files) digest.update(path.slice(staged.length)).update(await readFile(path));
    const build = { schema: 1, repository: 'mikastudhhn/chrome-extension-video', commit: git('rev-parse', 'HEAD'),
      channel: 'local', local: { branch, helper, buildId: digest.digest('hex'), dirty: !!git('status', '--porcelain', '--untracked-files=normal'), builtAt: new Date().toISOString() } };
    await writeFile(join(staged, 'build-info.json'), JSON.stringify(build, null, 2) + '\n');
    try {
      await promisify(execFile)(process.execPath, ['--experimental-vm-modules', '--no-warnings', 'scripts/validate-development.js', staged]);
    } catch (error) { throw new Error(`Build fehlgeschlagen: ${error.stderr || error.message}`); }
    // Validate before publishing. A failed build leaves every installed file intact;
    // replacing the whole directory also removes deleted source files.
    const previous = `${staged}-previous`;
    let hadPrevious = false;
    try { await rename(directory, previous); hadPrevious = true; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { await rename(staged, directory); }
    catch (error) { if (hadPrevious) await rename(previous, directory); throw error; }
    if (hadPrevious) await rm(previous, { recursive: true, force: true });
    return { directory, ...build };
  } finally { await rm(staged, { recursive: true, force: true }); }
}

export async function watchDevelopment(destination = 'dist/development/extension') {
  const helper = await helperSettings(resolve(destination));
  const server = await startHelper(helper);
  let timer, running = false, requested = true, closed = false;
  const watchers = [];
  async function build() {
    if (running || closed) return;
    running = true;
    try {
      while (requested && !closed) {
        requested = false;
        server.update({ state: 'building', error: '' });
        try {
          const result = await prepareDevelopment(destination, helper);
          server.update({ state: requested ? 'building' : 'ready', branch: result.local.branch, buildId: result.local.buildId, error: '' });
          console.log(`Dev · ${result.local.branch} · bereit`);
        } catch (error) {
          server.update({ state: 'error', error: error.message });
          console.error(error.message);
        }
      }
    } finally { running = false; }
  }
  const schedule = () => {
    requested = true;
    // Immediately inhibit reloads while the next coherent build is being prepared.
    server.update({ state: 'building', error: '' });
    clearTimeout(timer); timer = setTimeout(build, 250);
  };
  try {
    for (const directory of ['extension', 'scripts']) watchers.push(watch(directory, { recursive: true }, schedule));
    for (const directory of new Set([git('rev-parse', '--git-dir'), git('rev-parse', '--git-common-dir')])) {
      watchers.push(watch(directory, { recursive: true }, (_, file) => {
        if (file === 'HEAD' || file === 'index' || file === 'packed-refs' || file?.startsWith('refs/')) schedule();
      }));
    }
    await build();
  } catch (error) { watchers.forEach(watcher => watcher.close()); await server.close(); throw error; }
  console.log(`Entwicklungsordner: ${resolve(destination)}\nEinmal in Chrome laden. Im Kanal Dev werden Änderungen automatisch aktiviert. Strg+C beendet den Helfer.`);
  return { async close() {
    closed = true; clearTimeout(timer); watchers.forEach(watcher => watcher.close());
    while (running) await new Promise(resolve => setTimeout(resolve, 25));
    await server.close();
  } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--watch')) {
    const watcher = await watchDevelopment();
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await watcher.close(); process.exit(0); });
  } else {
    const build = await prepareDevelopment();
    console.log(`Dev · ${build.local.branch} · ${build.directory}`);
  }
}
