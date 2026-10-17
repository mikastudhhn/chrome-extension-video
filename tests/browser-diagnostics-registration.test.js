import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { browserMatrix } from '../scripts/browser-test-matrix.js';

test('common starter requires diagnosis on both candidate packages', async () => {
  const suites = browserMatrix({ stable: { extension: '/candidate-stable' }, experimental: { extension: '/candidate-experimental' } });
  const diagnosis = suites.filter(suite => suite.script === 'e2e-diagnostics.js');
  assert.deepEqual(diagnosis.map(suite => [suite.name, suite.env.TEST_EXTENSION, suite.env.TEST_CHANNEL, suite.env.TEST_EXPECT_DIAGNOSTICS]), [
    ['diagnostics-stable-candidate', '/candidate-stable', 'stable', '1'],
    ['diagnostics-experimental-candidate', '/candidate-experimental', 'experimental', '1']
  ]);
  for (const name of ['core-stable-candidate', 'core-experimental-candidate', 'discovery-stable-candidate', 'discovery-experimental-candidate', 'channels-stable-package', 'channels-experimental-package', 'errors-stable-candidate', 'errors-experimental-candidate', 'development']) {
    assert.ok(suites.some(suite => suite.name === name), `Existing suite preserved: ${name}`);
  }
  const source = await readFile(new URL('../scripts/e2e-diagnostics.js', import.meta.url), 'utf8');
  assert.match(source, /from '\.\/browser-test-context\.js'/);
  // Syntax-only: no browser or Playwright module is loaded by this Node test.
  execFileSync(process.execPath, ['--check', 'scripts/e2e-diagnostics.js'], { cwd: process.cwd() });
});
