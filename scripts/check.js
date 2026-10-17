import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { runQualityChecks } from './check-quality.js';
import { checkDesignTokens } from './check-design-tokens.js';

const manifest = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url)));
if (manifest.manifest_version !== 3 || !manifest.permissions.includes('offscreen')) throw new Error('Invalid extension manifest');
let count = 0;
for (const directory of ['extension', 'server', 'demo', 'tests', 'scripts']) {
  for (const file of await readdir(directory, { recursive: true })) {
    if (!file.endsWith('.js')) continue;
    const check = spawnSync(process.execPath, ['--check', `${directory}/${file}`], { encoding: 'utf8' });
    if (check.error || check.status !== 0) { console.error(check.error?.message || check.stderr || `Syntaxprüfung fehlgeschlagen: ${file}`); process.exit(1); }
    count++;
  }
}
const modules = spawnSync(process.execPath, ['--experimental-vm-modules', '--no-warnings', 'scripts/validate-development.js', 'extension'], { encoding: 'utf8' });
if (modules.error || modules.status !== 0) { console.error(modules.error?.message || modules.stderr || 'Modulprüfung fehlgeschlagen.'); process.exit(1); }
const tokenProblems = await checkDesignTokens('extension');
if (tokenProblems.length) { console.error(tokenProblems.join('\n')); process.exit(1); }
console.log(`Manifest, design tokens and ${count} JavaScript files checked.`);

if (!runQualityChecks()) process.exit(1);
