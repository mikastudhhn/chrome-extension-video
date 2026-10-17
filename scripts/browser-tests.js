import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { createServer } from '../server/index.js';
import { runProcess, runSerial, createSuiteTemporaryDirectory } from './browser-test-process.js';
import { loadPackage, fileHashes, sha256 } from './browser-test-package.js';
import { browserMatrix, browserDiagnostics, browserGroups } from './browser-test-matrix.js';

const root = resolve('.');
const args = process.argv.slice(2);
const skipBuild = args.includes('--skip-build');
const selected = args.filter(arg => arg.startsWith('--suite=')).map(arg => arg.slice(8));
const groups = args.filter(arg => arg.startsWith('--group=')).map(arg => arg.slice(8));
if (args.some(arg => arg !== '--skip-build' && !arg.startsWith('--suite=') && !arg.startsWith('--group='))) throw new Error('Usage: npm run test:browser -- [--skip-build] [--suite=NAME] [--group=NAME]');
if (selected.length && groups.length) throw new Error('Choose either --suite or --group, not both');
for (const group of groups) assert.ok(browserGroups.includes(group), `Unknown group: ${group}; known groups: ${browserGroups.join(', ')}`);
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const config = key => { try { return git('config', '--get', key); } catch { return ''; } };
const lock = join(root, 'test-results', '.browser-lock');
await mkdir(join(root, 'test-results'), { recursive: true });
try { await mkdir(lock); } catch (error) {
  if (error.code === 'EEXIST') throw new Error('A browser run owns test-results/.browser-lock. Wait for it; investigate an orphaned lock before removing it.');
  throw error;
}
// Only a run of the complete matrix is the full gate; CI proves it as one job per group.
const report = { started: new Date().toISOString(), status: 'running', fullGate: selected.length === 0 && groups.length === 0, groups, suites: [] };
let temporary, relay, output;
const controller = new AbortController();
const interrupt = () => controller.abort();
process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
try {
  await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, started: report.started, root }));
  output = await mkdtemp(join(root, 'test-results', 'browser-'));
  temporary = await mkdtemp(join(tmpdir(), 'video-sync-browser-'));
  const env = { ...process.env };
  // The orchestrator, not a stale shell variable, chooses each suite's inputs.
  for (const key of Object.keys(env)) if (key.startsWith('TEST_')) delete env[key];
  env.PLAYWRIGHT_MODULE = process.env.PLAYWRIGHT_MODULE || config('videosync.playwrightModule') || 'playwright';
  env.CHROMIUM_EXECUTABLE = process.env.CHROMIUM_EXECUTABLE || config('videosync.chromiumExecutable') || '';
  const require = createRequire(import.meta.url);
  const playwrightPath = require.resolve(env.PLAYWRIGHT_MODULE);
  const playwrightPackage = JSON.parse(await readFile(join(playwrightPath, '..', 'package.json'), 'utf8'));
  const { devDependencies } = JSON.parse(await readFile('package.json', 'utf8'));
  assert.equal(playwrightPackage.version, devDependencies.playwright, 'Configured Playwright must match package.json');
  const corePackage = createRequire(playwrightPath).resolve('playwright-core/package.json');
  report.tools = { node: process.version, platform: process.platform, arch: process.arch,
    playwright: playwrightPackage.version, playwrightPath,
    browserOverride: env.CHROMIUM_EXECUTABLE || null,
    browserRevisions: JSON.parse(await readFile(join(corePackage, '..', 'browsers.json'), 'utf8')).browsers,
    ffmpeg: execFileSync('ffmpeg', ['-version'], { encoding: 'utf8' }).split('\n')[0] };
  report.commit = git('rev-parse', 'HEAD');
  report.workingTree = git('status', '--porcelain');
  report.commitBound = report.workingTree === '';
  report.testSourceHashes = await fileHashes(join(root, 'scripts'));
  if (process.env.CI && !report.commitBound) throw new Error('CI requires a clean committed checkout before package verification');
  const manifest = JSON.parse(await readFile('extension/manifest.json', 'utf8'));
  env.BUILD_NUMBER ||= '0';
  env.RELEASE_TAG ||= `v${manifest.version}-preview.${env.BUILD_NUMBER}`;
  const version = process.env.PACKAGE_VERSION || `${manifest.version}.${env.BUILD_NUMBER}`;
  if (!skipBuild) {
    for (const channel of ['experimental', 'stable']) {
      const build = await runProcess(process.execPath, ['scripts/package-extension.js', process.env.VIDEO_SYNC_SERVER || 'http://localhost:8787'],
        { cwd: root, env: { ...env, PACKAGE_PROFILE: channel }, directory: join(output, `build-${channel}`), signal: controller.signal });
      if (build.code !== 0 || build.reason) throw new Error(`Package build failed: ${channel}; see ${output}`);
    }
  }
  const packages = {};
  for (const channel of ['stable', 'experimental']) packages[channel] = await loadPackage({ root, channel, version,
    commit: report.commit, destination: join(temporary, channel) });
  report.packages = packages;
  const matrix = selected.length ? [...browserMatrix(packages), ...browserDiagnostics(packages)] : browserMatrix(packages);
  for (const name of selected) assert.ok(matrix.some(suite => suite.name === name), `Unknown suite: ${name}`);
  const suites = selected.length ? matrix.filter(suite => selected.includes(suite.name))
    : groups.length ? matrix.filter(suite => groups.includes(suite.group)) : matrix;
  report.planned = suites.map(suite => ({ name: suite.name, group: suite.group, script: suite.script, inputs: suite.env }));
  relay = createServer({ env: {} });
  await new Promise((resolve, reject) => { relay.once('error', reject); relay.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${relay.address().port}`;
  assert.notEqual(relay.address().port, 8787);
  const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5000) });
  assert.equal(health.status, 200, 'Isolated relay readiness');
  report.server = base;
  const save = () => writeFile(join(output, 'summary.json'), JSON.stringify(report, null, 2) + '\n');
  await save();
  console.log(`Browser evidence: ${output}`);
  report.suites = await runSerial(suites, async suite => {
    console.log(`START ${suite.name}`);
    const directory = join(output, suite.name);
    const suiteTemporary = await createSuiteTemporaryDirectory(temporary);
    const result = await runProcess(process.execPath, [`scripts/${suite.script}`], { cwd: root,
      env: { ...env, ...suite.env, TMPDIR: suiteTemporary, TMP: suiteTemporary, TEMP: suiteTemporary,
        TEST_SERVER: base, TEST_RESULTS: directory }, directory, signal: controller.signal });
    report.suites.push({ name: suite.name, ...result });
    await save();
    console.log(`${result.code === 0 && !result.reason ? 'PASS' : 'FAIL'} ${suite.name} (${Math.round(result.durationMs / 1000)}s)`);
    if (result.code !== 0 || result.reason) console.error((await readFile(join(directory, 'output.log'), 'utf8')).slice(-12000));
    return result;
  }, controller.signal);
  for (const [channel, pkg] of Object.entries(packages)) {
    assert.deepEqual(await fileHashes(pkg.extension), pkg.hashes, `${channel}: browser tests must not modify candidate files`);
    assert.equal(sha256(await readFile(pkg.archive)), pkg.sha256, `${channel}: archive unchanged`);
    assert.equal(sha256(await readFile(pkg.updatePath)), pkg.updateSha256, `${channel}: update unchanged`);
  }
  assert.deepEqual(await fileHashes(join(root, 'scripts')), report.testSourceHashes, 'Test scripts changed during the run');
  assert.equal(git('rev-parse', 'HEAD'), report.commit, 'Commit changed during the run');
  report.finalWorkingTree = git('status', '--porcelain');
  if (report.commitBound) assert.equal(report.finalWorkingTree, '', 'Working tree changed during commit-bound verification');
  report.status = !controller.signal.aborted && report.suites.length === suites.length &&
    report.suites.every(result => result.code === 0 && !result.reason) ? 'passed' : 'failed';
  if (report.status !== 'passed') process.exitCode = 1;
} catch (error) {
  report.status = 'failed'; report.error = error.stack; process.exitCode = 1;
  console.error(error);
} finally {
  report.finished = new Date().toISOString();
  if (output) {
    await writeFile(join(output, 'summary.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(`Evidence retained: ${output}`);
  }
  if (relay) await new Promise(resolve => { relay.close(resolve); relay.closeAllConnections(); });
  if (temporary) await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  await rm(lock, { recursive: true, force: true });
  process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
}
