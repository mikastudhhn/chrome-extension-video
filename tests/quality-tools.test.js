import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ESLint } from 'eslint';
import { check, resolveConfig } from 'prettier';

// Exercise the real config against mistakes which syntax checks alone accept.
test('lint rejects async Promise executors, unsafe optional chaining and duplicate branches', async () => {
  const eslint = new ESLint();
  const cases = [
    ['new Promise(async resolve => { resolve(1); });', 'no-async-promise-executor'],
    ['const object = {}; (object?.method)();', 'no-unsafe-optional-chaining'],
    ['if (value) one(); else if (value) two();', 'no-dupe-else-if'],
    ['const state = {phase: "aligning", phase: "synced"};', 'no-dupe-keys']
  ];
  for (const [source, rule] of cases) {
    const [result] = await eslint.lintText(source, { filePath: 'extension/quality-fixture.js' });
    assert.ok(result.messages.some(message => message.ruleId === rule), `${rule} must reject its fixture`);
  }
  assert.equal(await eslint.isPathIgnored('dist/experimental/extension/timeline.js'), true);
});

test('formatter check detects drift without rewriting files', async () => {
  const config = await resolveConfig('eslint.config.js');
  assert.equal(await check("export const phase='aligning'", { ...config, parser: 'babel' }), false);
  assert.equal(await check("export const phase = 'aligning';\n", { ...config, parser: 'babel' }), true);
});

test('existing package validator rejects missing exports and resources without executing code', async t => {
  const root = await mkdtemp(join(tmpdir(), 'video-sync-quality-package-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const validate = () => spawnSync(process.execPath, ['--experimental-vm-modules', '--no-warnings',
    'scripts/validate-development.js', root], { encoding: 'utf8' });
  await writeFile(join(root, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Fixture', version: '1.0',
    background: { service_worker: 'background.js' }, action: { default_popup: 'popup.html' } }));
  await writeFile(join(root, 'popup.html'), '<script type="module" src="background.js"></script>');
  await writeFile(join(root, 'background.js'), "import { ready } from './state.js'; throw new Error('must not execute');");
  await writeFile(join(root, 'state.js'), 'export const ready = true;');
  assert.equal(validate().status, 0);
  await writeFile(join(root, 'state.js'), 'export const wrong = true;');
  const missingExport = validate();
  assert.notEqual(missingExport.status, 0);
  assert.match(missingExport.stderr, /does not provide an export named 'ready'/);
  await writeFile(join(root, 'state.js'), 'export const ready = true;');
  await writeFile(join(root, 'popup.html'), '<link href="missing.css" rel="stylesheet">');
  const missingResource = validate();
  assert.notEqual(missingResource.status, 0);
  assert.match(missingResource.stderr, /Fehlende Laufzeitdatei.*missing.css/);
});

test('every selected JavaScript contract opts into strict checking', async () => {
  const { default: ts } = await import('typescript');
  const config = ts.readConfigFile('tsconfig.contracts.json', ts.sys.readFile);
  assert.equal(config.error, undefined);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd());
  assert.ok(parsed.fileNames.length >= 5);
  for (const path of parsed.fileNames.filter(path => path.endsWith('.js'))) {
    assert.match(await readFile(path, 'utf8'), /^\/\/ @ts-check\r?\n/, `${path} must stay checked even with gradual adoption`);
  }
});
