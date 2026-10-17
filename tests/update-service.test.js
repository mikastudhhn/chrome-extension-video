import test from 'node:test';
import assert from 'node:assert/strict';
import { checkUpdates, configureUpdates, updateStatus, UPDATE_INTERVAL_MINUTES, AUTOMATIC_DEBOUNCE_MINUTES } from '../extension/update-service.js';

function browser(t, initial) {
  const data = structuredClone(initial), alarms = new Map();
  const previous = globalThis.chrome;
  globalThis.chrome = {
    storage: { local: {
      get: async () => structuredClone(data),
      set: async values => Object.assign(data, values),
      remove: async keys => { for (const key of keys) delete data[key]; },
      setAccessLevel: async () => {}
    } },
    alarms: {
      create: async (name, options) => { alarms.set(name, options); },
      clear: async name => alarms.delete(name)
    }
  };
  t.after(() => { globalThis.chrome = previous; });
  return { data, alarms };
}

const build = { commit: 'a'.repeat(40), channel: 'stable' };
const stableRelease = { tag_name: 'v0.5.0', target_commitish: build.commit, prerelease: false,
  assets: [{ name: 'update.json', state: 'uploaded' }] };

test('configuring updates replaces an older alarm with thirty minutes; removing the optional token keeps checking', async t => {
  const { data, alarms } = browser(t, {});
  assert.equal(UPDATE_INTERVAL_MINUTES, 30);
  assert.equal(AUTOMATIC_DEBOUNCE_MINUTES, 2);
  alarms.set('check-github-updates', { periodInMinutes: 3 });
  await configureUpdates('fixture-only');
  assert.deepEqual(alarms.get('check-github-updates'), { periodInMinutes: 30 });
  assert.equal(data.githubToken, 'fixture-only');
  const revision = data.githubAccessRevision;
  alarms.set('check-github-updates', { periodInMinutes: 60 });
  await configureUpdates('');
  assert.deepEqual(alarms.get('check-github-updates'), { periodInMinutes: 30 });
  assert.equal(data.githubToken, undefined);
  assert.ok(data.githubAccessRevision && data.githubAccessRevision !== revision, 'removal starts a new access revision');
});

test('without a token public releases are checked, configured and sent without credentials', async t => {
  browser(t, {});
  const before = await updateStatus('stable', build);
  assert.equal(before.configured, true);
  assert.equal(before.hasToken, false);
  assert.equal(before.access.status, 'public');
  assert.equal(before.releaseState, 'unchecked');
  const headers = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => { headers.push(options.headers); return new Response(JSON.stringify([stableRelease])); });
  const checked = await checkUpdates('stable', build);
  assert.equal(checked.releaseState, 'current');
  assert.equal(checked.access.status, 'verified');
  assert.equal(checked.hasToken, false);
  assert.equal(headers.length, 1);
  assert.equal(Object.hasOwn(headers[0], 'Authorization'), false);
});

test('without a token a 404 reports unreachable releases, never an invalid token', async t => {
  browser(t, {});
  t.mock.method(globalThis, 'fetch', async () => new Response('{"message":"Not Found"}', { status: 404 }));
  const failed = await checkUpdates('stable', build, true);
  assert.equal(failed.access.status, 'not-found');
  assert.equal(failed.releaseState, 'error');
  assert.equal(failed.available, false);
  assert.match(failed.error, /nicht öffentlich erreichbar/);
  assert.doesNotMatch(failed.error, /ungültig|Token ersetzen/);
});

test('automatic checks without a token cost one request per alarm and pause near the limit', async t => {
  const { data } = browser(t, {});
  let now = 10_000_000, remaining = 40;
  const requests = [];
  t.mock.method(Date, 'now', () => now);
  const link = `<https://api.github.com/repositories/1376456582/releases?per_page=100&page=2>; rel="next"`;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const page = new URL(url).searchParams.get('page');
    requests.push({ page, etag: options.headers['If-None-Match'] });
    const headers = { 'x-ratelimit-remaining': String(--remaining), 'x-ratelimit-reset': String((now + 1_800_000) / 1000), etag: `page-${page}`, ...(page === '1' ? { link } : {}) };
    if (options.headers['If-None-Match'] === `page-${page}`) return new Response(null, { status: 304, headers });
    return new Response(JSON.stringify(page === '1' ? Array.from({ length: 100 }, (_, i) => ({ ...stableRelease, tag_name: `v0.5.0-preview.${i + 1}`, prerelease: true }))
      : [stableRelease]), { headers });
  });
  assert.equal((await checkUpdates('stable', build)).releaseState, 'current');
  assert.deepEqual(requests.map(request => request.page), ['1', '2'], 'the first check reads every page');
  requests.length = 0;
  now += 30 * 60_000;
  assert.equal((await checkUpdates('stable', build)).releaseState, 'current');
  assert.deepEqual(requests, [{ page: '1', etag: 'page-1' }], 'an unchanged first page reuses the cached chain');
  requests.length = 0;
  await checkUpdates('stable', build, true);
  assert.deepEqual(requests.map(request => request.page), ['1', '2'], 'manual checks revalidate every page');
  // Running low on the shared unauthenticated limit pauses only automatic checks.
  remaining = 5;
  now += 30 * 60_000;
  const paused = await checkUpdates('stable', build);
  assert.equal(paused.access.automaticPauseUntil, now + 1_800_000);
  assert.equal(paused.releaseState, 'current');
  assert.equal(paused.error, '');
  requests.length = 0;
  now += 2 * 60_000;
  await checkUpdates('stable', build);
  assert.equal(requests.length, 0, 'automatic checks wait for the reset');
  await checkUpdates('stable', build, true);
  assert.equal(requests.length, 2, 'a manual check still runs');
  assert.equal(data.githubToken, undefined);
});

test('without a token, rate limits back off with a clear hint and no false current state', async t => {
  browser(t, {});
  let now = 1_000_000, calls = 0;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return new Response('{"message":"API rate limit exceeded"}', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '2200' } });
  });
  const limited = await checkUpdates('stable', build, true);
  assert.equal(limited.access.status, 'rate-limited');
  assert.equal(limited.access.retryAt, 2_200_000);
  assert.notEqual(limited.releaseState, 'current');
  assert.match(limited.error, /ohne Token/);
  now = 2_199_999;
  await checkUpdates('stable', build, true);
  await checkUpdates('stable', build);
  assert.equal(calls, 1, 'no request before the reset');
});

test('automatic triggers share a two-minute debounce from the start of the previous check', async t => {
  const checkedAt = 1_000_000;
  const { data } = browser(t, { githubToken: 'fixture-only', updateResults: { experimental: { checkedAt, available: false } } });
  let now = checkedAt + 2 * 60_000 - 1, calls = 0;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response('[]'); });
  const build = { commit: 'a'.repeat(40), channel: 'experimental' };
  // A popup opened right after a check (or overlapping alarm/start triggers) sends nothing.
  await checkUpdates('experimental', build);
  assert.equal(calls, 0);
  now++;
  await checkUpdates('experimental', build);
  assert.equal(calls, 1);
  assert.equal(data.updateResults.experimental.checkedAt, now);
  await checkUpdates('experimental', build);
  assert.equal(calls, 1, 'a second popup open within two minutes is debounced');
  await checkUpdates('experimental', build, true);
  assert.equal(calls, 2, 'the manual check can bypass the debounce');
});

test('an alarm firing exactly one period after a slow check is never skipped', async t => {
  const { data } = browser(t, {});
  let now = 5_000_000, calls = 0;
  t.mock.method(Date, 'now', () => now);
  // Each request takes 20 seconds. The stored check time is its start, so the
  // next alarm exactly UPDATE_INTERVAL_MINUTES later still runs.
  t.mock.method(globalThis, 'fetch', async () => { calls++; now += 20_000; return new Response(JSON.stringify([stableRelease])); });
  const alarmTimes = [5_000_000, 5_000_000 + UPDATE_INTERVAL_MINUTES * 60_000, 5_000_000 + 2 * UPDATE_INTERVAL_MINUTES * 60_000];
  for (const [index, time] of alarmTimes.entries()) {
    now = time;
    await checkUpdates('stable', build);
    assert.equal(calls, index + 1, `alarm ${index + 1} ran`);
    assert.equal(data.updateResults.stable.checkedAt, time, 'checkedAt is the start of the check');
    assert.equal(data.updateResults.stable.lastSuccessfulCheckAt, time + 20_000);
  }
});

test('Dev packages compare release streams with their checkout while the local channel never contacts GitHub', async t => {
  browser(t, { githubToken: 'fixture-only' });
  let calls = 0;
  const checkout = 'a'.repeat(40);
  const build = { local: { branch: 'fix/example' }, commit: checkout, channel: 'local' };
  const release = (tag, commit, prerelease) => ({ tag_name: tag, target_commitish: commit, prerelease, assets: [{ name: 'update.json', state: 'uploaded' }] });
  const releases = [release('v0.6.0', checkout, false), release('v0.6.1-preview.4', checkout, true)];
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response(JSON.stringify(releases)); });
  assert.equal((await checkUpdates('local', build, true)).local, true);
  assert.equal(calls, 0);
  assert.equal((await checkUpdates('stable', build, true)).available, false);
  assert.equal((await checkUpdates('experimental', build, true)).available, false);
  releases[1] = release('v0.6.1-preview.5', 'd'.repeat(40), true);
  assert.equal((await checkUpdates('experimental', build, true)).available, true);
  assert.equal((await checkUpdates('stable', build, true)).available, false);
  assert.equal(calls, 4);
  await checkUpdates('local', build, true);
  await checkUpdates('stable', { source: true }, true);
  assert.equal(calls, 4);
});

test('saved access, successful empty search and an installed matching release are distinct', async t => {
  browser(t, { githubToken: 'fixture-only', updateResults: { stable: { checkedAt: 123, available: false } } });
  const stored = await updateStatus('stable', build);
  assert.equal(stored.access.status, 'unverified');
  assert.equal(stored.releaseState, 'unchecked');
  let releases = [];
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(releases)));
  const empty = await checkUpdates('stable', build, true);
  assert.equal(empty.access.status, 'verified');
  assert.equal(empty.releaseState, 'no-release');
  releases = [stableRelease];
  const current = await checkUpdates('stable', build, true);
  assert.equal(current.releaseState, 'current');
  assert.equal(current.tag, 'v0.5.0');
  assert.equal(current.url, 'https://github.com/mikastudhhn/chrome-extension-video/releases/tag/v0.5.0');
  assert.ok(current.checkedAt <= current.lastSuccessfulCheckAt, 'checkedAt is the start of the successful check');
});

test('failed checks retain the last success time and cannot show an old verified connection on another channel', async t => {
  browser(t, { githubToken: 'fixture-only' });
  let now = 1000, status = 200;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(status === 200 ? [stableRelease] : { message: 'fixture-only' }), { status }));
  await checkUpdates('stable', build, true);
  now = 2000; status = 401;
  const failed = await checkUpdates('experimental', build, true);
  assert.equal(failed.access.status, 'invalid-token');
  const stable = await updateStatus('stable', build);
  assert.equal(stable.lastSuccessfulCheckAt, 1000);
  assert.equal(stable.access.status, 'invalid-token');
  assert.match(stable.error, /ungültig oder abgelaufen/);
  assert.doesNotMatch(JSON.stringify(stable), /fixture-only/);
  now = 3000; status = 500;
  const unavailable = await checkUpdates('stable', build, true);
  assert.equal(unavailable.checkedAt, 3000);
  assert.equal(unavailable.lastSuccessfulCheckAt, 1000);
  assert.equal(unavailable.releaseState, 'error');
  assert.equal(unavailable.access.status, 'unavailable');
});

test('cache is persisted across checks and reset on replacement/removal, even for the same token', async t => {
  const { data } = browser(t, {});
  await configureUpdates('fixture-only');
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls++;
    if (calls === 2) {
      assert.equal(options.headers['If-None-Match'], 'stable-etag');
      return new Response(null, { status: 304 });
    }
    assert.equal(options.headers['If-None-Match'], undefined);
    return new Response(JSON.stringify([stableRelease]), { headers: { etag: 'stable-etag' } });
  });
  await checkUpdates('stable', build, true);
  await checkUpdates('stable', build, true);
  assert.equal(Object.keys(data.releaseCache).length, 1);
  const revision = data.githubAccessRevision;
  await configureUpdates('fixture-only');
  assert.notEqual(data.githubAccessRevision, revision);
  assert.deepEqual(data.releaseCache, {});
  assert.deepEqual(data.updateResults, {});
  assert.equal(data.githubAccess.status, 'unverified');
  await checkUpdates('stable', build, true);
  await configureUpdates('');
  assert.equal(data.releaseCache, undefined);
  assert.equal(data.githubAccess, undefined);
  assert.equal((await updateStatus('stable', build)).access.status, 'public');
});

test('replacing/removing access during a request prevents late success or failure from resurrecting status and cache', async t => {
  const { data } = browser(t, {});
  for (const nextToken of ['new-token', '', 'old-token']) {
    await configureUpdates('old-token');
    let resolveFetch, started;
    const start = new Promise(resolve => { started = resolve; });
    t.mock.method(globalThis, 'fetch', () => new Promise(resolve => { resolveFetch = resolve; started(); }));
    const checking = checkUpdates('stable', build, true);
    await start;
    await configureUpdates(nextToken);
    resolveFetch(new Response(JSON.stringify([stableRelease]), { headers: { etag: 'old-token-cache' } }));
    await checking;
    assert.deepEqual(data.updateResults, nextToken ? {} : undefined);
    assert.deepEqual(data.releaseCache, nextToken ? {} : undefined);
    assert.equal(data.githubAccess?.status, nextToken ? 'unverified' : undefined);
    t.mock.restoreAll();
  }
});

test('rate-limit cooldown applies across channels and manual checks, then recovers', async t => {
  browser(t, { githubToken: 'fixture-only' });
  let now = 1_000_000, calls = 0;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async () => ++calls === 1
    ? new Response('{}', { status: 429, headers: { 'retry-after': '600' } })
    : new Response('[]'));
  assert.equal((await checkUpdates('stable', build, true)).access.status, 'rate-limited');
  await checkUpdates('experimental', build, true);
  now += 599999;
  await checkUpdates('stable', build, true);
  assert.equal(calls, 1);
  now++;
  assert.equal((await checkUpdates('stable', build)).access.status, 'verified');
  assert.equal(calls, 2);
});

test('concurrent scheduled checks share the cooldown and preserve per-channel results', async t => {
  browser(t, { githubToken: 'fixture-only' });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response('[]'); });
  await Promise.all([checkUpdates('stable', build), checkUpdates('stable', build), checkUpdates('experimental', build)]);
  assert.equal(calls, 2);
  assert.equal((await updateStatus('stable', build)).releaseState, 'no-release');
  assert.equal((await updateStatus('experimental', build)).releaseState, 'no-release');
});

test('verification on another channel clears obsolete access errors without claiming its version is current', async t => {
  browser(t, { githubToken: 'fixture-only' });
  let status = 401;
  t.mock.method(globalThis, 'fetch', async () => new Response(status === 200 ? '[]' : '{}', { status }));
  await checkUpdates('stable', build, true);
  status = 200;
  await checkUpdates('experimental', build, true);
  const stable = await updateStatus('stable', build);
  assert.equal(stable.access.status, 'verified');
  assert.equal(stable.error, '');
  assert.equal(stable.releaseState, 'unchecked');
  assert.equal(stable.available, false);
});
