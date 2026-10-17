import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const checks = {
  types: { package: 'typescript', bin: 'tsc', args: ['-p', 'tsconfig.contracts.json'] },
  lint: { package: 'eslint', bin: 'eslint', args: ['.', '--max-warnings=0'] },
  format: { package: 'prettier', bin: 'prettier', args: ['--check', 'package.json', 'tsconfig.contracts.json',
    '.prettierrc.json', 'eslint.config.js', 'tests/types/**/*.js'] }
};

function toolCli(packageName, binName) {
  const packagePath = require.resolve(`${packageName}/package.json`);
  const manifest = JSON.parse(readFileSync(packagePath, 'utf8'));
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[binName];
  if (typeof bin !== 'string') throw new Error(`CLI ${binName} fehlt im installierten Paket ${packageName}.`);
  return resolve(dirname(packagePath), bin);
}

// Use the running Node binary on every platform. npm.cmd/.bin wrappers and
// shell interpolation are deliberately absent; arguments remain separate strings.
export function runQualityChecks(names = Object.keys(checks), {
  execute = spawnSync, executable = process.execPath, resolveCli = toolCli, report = console.error
} = {}) {
  for (const name of names) {
    try {
      if (!Object.hasOwn(checks, name)) throw new Error(`Unbekannte Qualitätsprüfung: ${name}`);
      const check = checks[name];
      const cli = resolveCli(check.package, check.bin);
      const result = execute(executable, [cli, ...check.args], { stdio: 'inherit', shell: false });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(result.signal ? `Signal ${result.signal}` : `Exit-Status ${result.status}`);
    } catch (error) {
      report(`Qualitätsprüfung ${name} fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }
  return true;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const names = process.argv.slice(2);
  process.exitCode = runQualityChecks(names.length ? names : undefined) ? 0 : 1;
}
