import test from 'node:test';
import assert from 'node:assert/strict';
import { runUpdate } from '../extension/update-runner.js';
import { downloadBundle } from '../extension/github-updates.js';
import { configureUpdates, checkUpdates, updateStatus } from '../extension/update-service.js';
import { validateSnapshot } from '../extension/update-recovery.js';
import { fakeDirectory, copyRecord, candidateBundle, bundleContents, signedUpdateAssets, testReleaseKey } from './update-fixtures.js';

async function fixture(t, repair = false, token = 'fixture-token') {
  const previous = globalThis.chrome, local = {};
  globalThis.chrome = { runtime: { id: 'access-test' }, storage: { local: {
    get: async () => structuredClone(local), set: async values => Object.assign(local, structuredClone(values)),
    remove: async keys => { for (const key of [keys].flat()) delete local[key]; }, setAccessLevel: async () => {}
  } }, alarms: { create: async () => {}, clear: async () => {} } };
  t.after(() => { globalThis.chrome = previous; });
  await configureUpdates(token);
  const installed = await candidateBundle({ commit: 'a'.repeat(40), build: 1 });
  const bundle = repair ? installed : await candidateBundle({ commit: 'b'.repeat(40), build: 2 });
  const initial = bundleContents(installed), target = bundleContents(bundle);
  const body = JSON.stringify(bundle);
  const signed = await signedUpdateAssets(body, { tag: bundle.candidateTag, channel: 'experimental', id: 123 });
  const release = { id: 1, tag_name: bundle.candidateTag, target_commitish: bundle.commit, prerelease: true, assets: signed.assets };
  const records = new Map(), disk = fakeDirectory(initial), requests = [];
  let failure = null, gate = null;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const stage = url.includes('/assets/') ? 'download' : 'search';
    requests.push({ stage, token: options.headers.Authorization });
    if (gate?.stage === stage) { const current = gate; gate = null; current.entered(); return current.response; }
    if (failure?.stage === stage) return new Response('{"message":"fixture-token must never reach the UI"}', {
      status: failure.status, headers: failure.status === 429 ? { 'retry-after': '600' } : {}
    });
    return new Response(stage === 'download' ? signed.bodies[url.split('/').at(-1)] : JSON.stringify(url.includes('/tags/') ? release : [release]));
  });
  const io = {
    // The real download path, verifying with an injected test release key.
    downloadBundle: (found, channel, token) => downloadBundle(found, channel, token, { publicKey: testReleaseKey().publicKey }),
    verifyInstallation: async () => {},
    verifyRecoveryDirectory: async (directory, snapshot) => {
      await validateSnapshot(snapshot); assert.equal(await directory.isSameEntry(snapshot.directory), true);
    },
    async stored(key, value) {
      if (arguments.length === 1) return copyRecord(records.get(key));
      if (value === undefined) records.delete(key); else records.set(key, copyRecord(value));
    },
    storeUpdateState: async values => { for (const [key, value] of Object.entries(values)) {
      if (value === undefined) records.delete(key); else records.set(key, copyRecord(value));
    } }
  };
  const build = { channel: 'experimental', commit: 'a'.repeat(40) };
  return { disk, initial, target, records, requests, local, io, build,
    options: { channel: 'experimental', directory: disk.directory, verifyRepair: repair },
    fail: (stage, status) => { failure = { stage, status }; },
    succeed: () => { failure = null; },
    hold: stage => {
      let entered, resolve;
      const started = new Promise(done => { entered = done; });
      const response = new Promise(done => { resolve = done; });
      gate = { stage, entered, response };
      return { started, respond: status => resolve(new Response('{}', { status, headers: status === 429 ? { 'retry-after': '600' } : {} })) };
    }
  };
}

for (const stage of ['search', 'download']) {
  for (const [status, expectedAccess] of [[429, 'rate-limited'], [401, 'invalid-token'], [403, 'forbidden']]) {
    test(`installation ${stage} ${status} updates shared access; a 429 retry sends no request and recovers after cooldown`, async t => {
      const f = await fixture(t);
      let now = 1_000_000;
      t.mock.method(Date, 'now', () => now);
      const checked = await checkUpdates('experimental', f.build, true);
      assert.equal(checked.available, true);
      assert.equal(checked.access.status, 'verified');
      now += 1000;
      f.fail(stage, status);
      await assert.rejects(runUpdate(f.options, f.io), error => error.code === (status === 429 ? 'rate-limited' : status === 401 ? 'invalid-token' : 'forbidden'));
      const failed = await updateStatus('experimental', f.build);
      assert.equal(failed.access.status, expectedAccess);
      assert.equal(failed.available, false);
      assert.ok(failed.error);
      assert.equal(failed.lastSuccessfulCheckAt, checked.lastSuccessfulCheckAt);
      assert.doesNotMatch(JSON.stringify(failed), /fixture-token/);
      assert.equal(f.disk.writes.length, 0);
      assert.equal(f.records.get('updateJournal'), undefined);
      if (status === 429) {
        const requestCount = f.requests.length;
        assert.equal(failed.access.retryAt, now + 600000);
        await assert.rejects(runUpdate(f.options, f.io), error => error.code === 'rate-limited');
        await checkUpdates('experimental', f.build, true);
        assert.equal(f.requests.length, requestCount, 'neither install retry nor manual check may contact GitHub');
        now = failed.access.retryAt;
      }
      f.succeed();
      assert.equal((await runUpdate(f.options, f.io)).outcome, 'installed');
      assert.equal((await updateStatus('experimental', f.build)).access.status, 'verified');
      assert.deepEqual(Object.fromEntries(f.disk.files), f.target);
      await validateSnapshot(f.records.get('backup'));
    });
  }
}

for (const stage of ['search', 'download']) {
  test(`late installation ${stage} failure cannot contaminate replaced, removed or re-saved credentials`, async t => {
    for (const token of ['replacement-token', '', 'fixture-token']) {
      await t.test(token || 'removed', async t => {
        const f = await fixture(t);
        await checkUpdates('experimental', f.build, true);
        const held = f.hold(stage);
        const installing = runUpdate(f.options, f.io);
        await held.started;
        await configureUpdates(token);
        held.respond(429);
        await assert.rejects(installing, error => error.code === 'access-changed');
        assert.equal(f.local.githubAccess?.status, token ? 'unverified' : undefined);
        assert.deepEqual(f.local.updateResults, token ? {} : undefined);
        assert.deepEqual(f.local.releaseCache, token ? {} : undefined);
        assert.equal(f.disk.writes.length, 0);
      });
    }
  });
}

for (const repair of [false, true]) {
  test(`${repair ? 'installation check' : 'installation'} works from public releases without a token or credentials`, async t => {
    const f = await fixture(t, repair, '');
    const checked = await checkUpdates('experimental', f.build, true);
    assert.equal(checked.hasToken, false);
    assert.equal(checked.access.status, 'verified');
    if (!repair) assert.equal(checked.available, true);
    f.requests.length = 0;
    await runUpdate(f.options, f.io);
    // Request budget: installation searches every page (1 here) plus the
    // package and its signature; the installation check reads one tag plus both.
    assert.deepEqual(f.requests.map(request => request.stage), ['search', 'download', 'download']);
    assert.ok(f.requests.every(request => request.token === undefined));
    if (!repair) assert.deepEqual(Object.fromEntries(f.disk.files), f.target);
  });
}

test('without a token a missing asset reports unreachable releases, not an invalid token', async t => {
  const f = await fixture(t, false, '');
  await checkUpdates('experimental', f.build, true);
  f.fail('download', 404);
  await assert.rejects(runUpdate(f.options, f.io), error => error.code === 'not-found');
  const failed = await updateStatus('experimental', f.build);
  assert.equal(failed.access.status, 'not-found');
  assert.doesNotMatch(failed.error, /ungültig/);
  assert.equal(f.disk.writes.length, 0);
});

test('token replacement after successful discovery prevents the old-token download', async t => {
  const f = await fixture(t);
  const io = { ...f.io, latestRelease: async () => {
    await configureUpdates('replacement-token');
    return { id: 1 };
  } };
  await assert.rejects(runUpdate(f.options, io), error => error.code === 'access-changed');
  assert.equal(f.requests.length, 0);
  assert.equal(f.disk.writes.length, 0);
  assert.equal(f.local.githubAccess.status, 'unverified');
});

test('a cooldown imposed after discovery prevents download before any asset request', async t => {
  const f = await fixture(t);
  const io = { ...f.io, latestRelease: async () => {
    f.local.githubAccess = { status: 'rate-limited', retryAt: Date.now() + 600000 };
    return { id: 1 };
  } };
  await assert.rejects(runUpdate(f.options, io), error => error.code === 'rate-limited');
  assert.equal(f.requests.length, 0);
  assert.equal(f.disk.writes.length, 0);
});

for (const stage of ['search', 'download']) {
  test(`published-package repair ${stage} also respects shared GitHub access and cooldown`, async t => {
    const f = await fixture(t, true);
    f.records.set('backup', ['unverified-record']);
    f.fail(stage, 429);
    await assert.rejects(runUpdate(f.options, f.io), error => error.code === 'rate-limited');
    assert.equal((await updateStatus('experimental', f.build)).access.status, 'rate-limited');
    const requests = f.requests.length;
    await assert.rejects(runUpdate(f.options, f.io), error => error.code === 'rate-limited');
    assert.equal(f.requests.length, requests);
    assert.deepEqual(f.records.get('backup'), ['unverified-record']);
    assert.equal(f.disk.writes.length, 0);
  });
}

test('local folder/package failures do not change access; offline rollback is allowed during a rate limit', async t => {
  const f = await fixture(t);
  await checkUpdates('experimental', f.build, true);
  const access = structuredClone(f.local.githubAccess);
  for (const override of [
    { verifyInstallation: async () => { throw new Error('Wrong folder'); } },
    { downloadBundle: async () => { throw new Error('Bad checksum'); } }
  ]) {
    await assert.rejects(runUpdate(f.options, { ...f.io, ...override }));
    assert.deepEqual(f.local.githubAccess, access);
  }
  await runUpdate(f.options, f.io);
  f.local.githubAccess = { status: 'rate-limited', retryAt: Date.now() + 600000 };
  const requests = f.requests.length;
  assert.equal((await runUpdate({ ...f.options, restore: true }, f.io)).outcome, 'restored');
  assert.equal(f.requests.length, requests);
  assert.deepEqual(Object.fromEntries(f.disk.files), f.initial);
  assert.equal(f.local.githubAccess.status, 'rate-limited');
});

test('an overlapping scheduled check cannot erase an installation rate limit or start another request', async t => {
  const f = await fixture(t);
  await checkUpdates('experimental', f.build, true);
  const held = f.hold('download');
  const installing = runUpdate(f.options, f.io);
  await held.started;
  const checking = checkUpdates('experimental', f.build, true);
  const requests = f.requests.length;
  held.respond(429);
  await assert.rejects(installing, error => error.code === 'rate-limited');
  assert.equal((await checking).access.status, 'rate-limited');
  assert.equal(f.requests.length, requests);
  assert.equal(f.disk.writes.length, 0);
});
