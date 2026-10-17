import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { browserMatrix, browserDiagnostics, browserGroups } from '../scripts/browser-test-matrix.js';

const packages = { stable: { extension: '/candidate-stable' }, experimental: { extension: '/candidate-experimental' } };

test('every required suite belongs to exactly one known CI group and no group is empty', () => {
  const suites = browserMatrix(packages);
  assert.equal(new Set(suites.map(suite => suite.name)).size, suites.length, 'Suite names are unique');
  for (const suite of suites) assert.ok(browserGroups.includes(suite.group), `${suite.name} names an unknown group: ${suite.group}`);
  for (const group of browserGroups) assert.ok(suites.some(suite => suite.group === group), `Group ${group} would run no suite`);
  // Explicit diagnoses are never part of a CI group.
  for (const suite of browserDiagnostics(packages)) assert.equal(suite.group, undefined);
});

test('CI runs exactly the known groups in parallel jobs and gates the release on all of them', async () => {
  const workflow = await readFile('.github/workflows/verify.yml', 'utf8');
  const matrix = workflow.match(/^\s+group: \[([^\]]+)\]$/m);
  assert.ok(matrix, 'browser job declares a group matrix');
  assert.deepEqual(matrix[1].split(',').map(entry => entry.trim()), browserGroups);
  assert.match(workflow, /npm run test:browser -- --skip-build --group="\$\{GROUP\}"/);
  assert.match(workflow, /fail-fast: false/, 'One red group must not cancel the evidence of the others');
  const verify = workflow.split('\n  verify:')[1].split('\n  release:')[0];
  assert.match(verify, /needs: \[build, checks, browser\]/);
  assert.match(verify, /if: always\(\)/, 'The aggregate reports a result even when a gate job failed');
  const release = workflow.split('\n  release:')[1];
  assert.match(release, /needs: verify/);
  assert.doesNotMatch(release, /if: always\(\)/);
});
