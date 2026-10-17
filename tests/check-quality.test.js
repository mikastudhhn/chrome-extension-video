import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { runQualityChecks } from '../scripts/check-quality.js';

test('all quality tools use Node and installed JS entrypoints even for a Windows executable with spaces', () => {
  const calls = [];
  const executable = 'C:\\Program Files\\nodejs\\node.exe';
  assert.equal(runQualityChecks(undefined, {
    executable,
    execute: (command, args, options) => { calls.push({ command, args, options }); return { status: 0 }; }
  }), true);
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(call.command, executable);
    assert.equal(call.options.shell, false);
    assert.ok(isAbsolute(call.args[0]));
    assert.doesNotMatch(call.args[0], /(?:\.cmd|\.bin[\\/])/);
  }
  assert.match(calls[0].args[0], /typescript[\\/]bin[\\/]tsc$/);
  assert.match(calls[1].args[0], /eslint[\\/]bin[\\/]eslint\.js$/);
  assert.match(calls[2].args[0], /prettier[\\/]bin[\\/]prettier\.cjs$/);
  assert.deepEqual(calls[0].args.slice(1), ['-p', 'tsconfig.contracts.json']);
});

test('real Node execution preserves a CLI path with spaces and shell metacharacters literally', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'video sync quality '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cli = join(directory, 'tool ; $literal.js');
  const output = join(directory, 'arguments.json');
  await writeFile(cli, `require('node:fs').writeFileSync(${JSON.stringify(output)}, JSON.stringify(process.argv.slice(2)));`);
  assert.equal(runQualityChecks(['types'], { resolveCli: () => cli }), true);
  assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), ['-p', 'tsconfig.contracts.json']);
});

test('spawn failures, signals and failing exits are reported and stop before the next tool', () => {
  for (const [result, expected] of [
    [{ error: Object.assign(new Error('spawn Node ENOENT'), { code: 'ENOENT' }), status: null }, /ENOENT/],
    [{ status: null, signal: 'SIGTERM' }, /Signal SIGTERM/],
    [{ status: 2 }, /Exit-Status 2/]
  ]) {
    const messages = []; let calls = 0;
    assert.equal(runQualityChecks(undefined, {
      execute: () => { calls++; return result; }, report: message => messages.push(message)
    }), false);
    assert.equal(calls, 1);
    assert.equal(messages.length, 1);
    assert.match(messages[0], /Qualitätsprüfung types fehlgeschlagen/);
    assert.match(messages[0], expected);
  }
});

test('an actual missing Node executable produces a visible start error', () => {
  const messages = [];
  assert.equal(runQualityChecks(['types'], {
    executable: join(tmpdir(), 'video-sync-missing-node-executable', 'node'), report: message => messages.push(message)
  }), false);
  assert.match(messages[0], /ENOENT/);
});

test('resolver exceptions and unknown checks fail visibly without starting a process', () => {
  const messages = [];
  const options = { execute: () => assert.fail('must not spawn'), report: message => messages.push(message) };
  assert.equal(runQualityChecks(['types'], { ...options, resolveCli: () => { throw new Error('tool not installed'); } }), false);
  assert.match(messages[0], /tool not installed/);
  assert.equal(runQualityChecks(['unknown'], options), false);
  assert.match(messages[1], /Unbekannte Qualitätsprüfung/);
});
