import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { helperSettings, startHelper } from '../scripts/development-helper.js';
import { createDevelopmentSession } from '../extension/development.js';

test('release builds do not start a development connection', () => {
  assert.equal(createDevelopmentSession({}), null);
});

test('helper is private to its checkout and preserves its endpoint across restarts', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'video-sync-helper-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const settings = await helperSettings(join(directory, 'extension'));
  assert.deepEqual(await helperSettings(join(directory, 'extension')), settings);
  let helper = await startHelper(settings);
  t.after(() => helper.close());
  const headers = { Authorization: `Bearer ${settings.token}`, Connection: 'close' };
  assert.equal((await fetch(`${settings.origin}/status`)).status, 403);
  assert.equal((await fetch(`${settings.origin}/status`, { headers: { ...headers, Origin: 'https://example.com' } })).status, 403);
  assert.equal((await fetch(`${settings.origin}/status`, { method: 'POST', headers })).status, 404);
  assert.equal((await fetch(`${settings.origin}/extension/background.js`, { headers })).status, 404);
  helper.update({ state: 'ready', branch: 'ft/feature', buildId: 'build-one' });
  assert.equal((await (await fetch(`${settings.origin}/status`, { headers })).json()).branch, 'ft/feature');
  await assert.rejects(startHelper(settings), /Port ist belegt/);
  await helper.close();
  helper = await startHelper(settings);
  assert.equal((await fetch(`${settings.origin}/status`, { headers })).status, 200);
});
