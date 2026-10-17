import test from 'node:test';
import assert from 'node:assert/strict';
import { API_ROOT, REPOSITORY_ID, discoverRelease, latestRelease, githubRequest } from '../extension/github-updates.js';

const release = (tag, extra = {}) => ({ tag_name: tag, target_commitish: 'b'.repeat(40),
  prerelease: tag.includes('preview'), draft: false, assets: [{ name: 'update.json', state: 'uploaded' }], ...extra });
const response = (batch, headers = {}) => new Response(JSON.stringify(batch), { headers });
const link = page => `<${API_ROOT}/releases?per_page=100&page=${page}>; rel="next"`;

test('Stable behind 500 previews is found; highest version wins even on later pages', async t => {
  const paths = [];
  t.mock.method(globalThis, 'fetch', async url => {
    const page = Number(new URL(url).searchParams.get('page')); paths.push(page);
    return response(page <= 5 ? Array.from({ length: 100 }, (_, i) => release(`v0.5.0-preview.${(page - 1) * 100 + i + 1}`))
      : [release('v0.5.0'), release('v0.7.0')]);
  });
  assert.equal((await latestRelease('stable', 'fixture-only')).tag_name, 'v0.7.0');
  assert.deepEqual(paths, [1, 2, 3, 4, 5, 6]);
});

test('304 on the first page still revalidates later pages, including edits and deletion', async () => {
  let phase = 0;
  const calls = [];
  const fetcher = async (url, { headers }) => {
    const page = Number(new URL(url).searchParams.get('page'));
    calls.push({ phase, page, etag: headers['If-None-Match'] });
    if (phase && page === 1) return new Response(null, { status: 304 });
    return page === 1 ? response([release('v0.5.0-preview.1')], { etag: 'first', link: link(2) })
      : response(phase === 2 ? [] : [release(phase ? 'v0.8.0' : 'v0.5.0')], { etag: `last-${phase}` });
  };
  const first = await discoverRelease('stable', 'fixture', { fetcher });
  phase = 1;
  const second = await discoverRelease('stable', 'fixture', { fetcher, cache: first.cache });
  assert.equal(second.release.tag_name, 'v0.8.0');
  phase = 2;
  const third = await discoverRelease('stable', 'fixture', { fetcher, cache: second.cache });
  assert.equal(third.release, null);
  assert.deepEqual(calls.slice(2), [
    { phase: 1, page: 1, etag: 'first' }, { phase: 1, page: 2, etag: 'last-0' },
    { phase: 2, page: 1, etag: 'first' }, { phase: 2, page: 2, etag: 'last-1' }
  ]);
});

test('cache follows changed pagination and discards obsolete pages', async () => {
  let phase = 0;
  const fetcher = async url => {
    const page = Number(new URL(url).searchParams.get('page'));
    if (phase === 2) { assert.equal(page, 1); return response([release('v0.6.0')]); }
    if (page === 1) return response([release('v0.5.0-preview.1')], { etag: 'first', link: link(2) });
    if (page === 2) return response([release('v0.5.0')], phase ? { link: link(3) } : {});
    return response([release('v0.9.0')]);
  };
  const first = await discoverRelease('stable', 'fixture', { fetcher });
  phase = 1;
  const second = await discoverRelease('stable', 'fixture', { fetcher, cache: first.cache });
  assert.equal(second.release.tag_name, 'v0.9.0');
  phase = 2;
  const third = await discoverRelease('stable', 'fixture', { fetcher, cache: second.cache });
  assert.equal(third.release.tag_name, 'v0.6.0');
  assert.equal(Object.keys(third.cache).length, 1);
});

test('cache contains only channel candidates and excludes release bodies and unrelated assets', async () => {
  const releases = [release('v0.5.0', { body: 'private description' }), release('v0.6.0'), release('v0.5.0-preview.1')];
  releases[1].assets.push({ name: 'private.zip', state: 'uploaded', browser_download_url: 'private' });
  const found = await discoverRelease('stable', 'fixture-secret', { fetcher: async () => response(releases, { etag: 'one' }) });
  const cached = JSON.stringify(found.cache);
  assert.doesNotMatch(cached, /private|fixture-secret|"body"/);
  assert.equal(Object.values(found.cache)[0].candidates.length, 2);
  assert.equal(found.release.tag_name, 'v0.6.0');
});

test('304 without cached data retries unconditionally instead of claiming no release', async () => {
  const headers = [];
  const found = await discoverRelease('stable', 'fixture', {
    cache: { '/releases?per_page=100&page=1': { etag: 'orphaned' } },
    fetcher: async (url, request) => {
      headers.push(request.headers['If-None-Match']);
      return headers.length === 1 ? new Response(null, { status: 304 }) : response([release('v0.6.0')]);
    }
  });
  assert.equal(found.release.tag_name, 'v0.6.0');
  assert.deepEqual(headers, ['orphaned', undefined]);
});

test('page errors, invalid bodies, cycles, unsafe links and cancellation never become an empty result', async () => {
  for (const later of [() => new Response('failure', { status: 500 }), () => response({}), () => response([null]),
    () => response([], { link: link(1) }), () => response([], { link: '<https://example.com/releases?page=3&per_page=100>; rel="next"' })]) {
    const urls = [];
    await assert.rejects(discoverRelease('stable', 'fixture', { fetcher: async url => {
      urls.push(url);
      return urls.length === 1 ? response([release('v0.5.0')], { link: link(2) }) : later();
    } }));
    assert.ok(urls.every(url => url.startsWith(API_ROOT)));
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(discoverRelease('stable', 'fixture', { signal: controller.signal, fetcher: () => assert.fail('no request') }),
    error => error.code === 'interrupted');
});

test('HTTP access failures have safe distinct codes and rate-limit retry times', async t => {
  t.mock.method(Date, 'now', () => 1_000_000);
  for (const [status, headers, body, code, retryAt] of [
    [401, {}, {}, 'invalid-token', null], [403, {}, {}, 'forbidden', null], [404, {}, {}, 'forbidden', null],
    [403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1200' }, {}, 'rate-limited', 1_200_000],
    [429, { 'retry-after': '300' }, {}, 'rate-limited', 1_300_000],
    [403, {}, { message: 'You have exceeded a secondary rate limit. SECRET' }, 'rate-limited', 1_060_000],
    [500, {}, { message: 'SECRET' }, 'unavailable', null]
  ]) {
    await assert.rejects(githubRequest('/releases', 'SECRET', { fetcher: async () => new Response(JSON.stringify(body), { status, headers }) }), error => {
      assert.equal(error.code, code); assert.equal(error.retryAt, retryAt); assert.doesNotMatch(error.message, /SECRET/); return true;
    });
  }
  await assert.rejects(githubRequest('/releases', 'SECRET', { fetcher: async () => { throw new Error('SECRET'); } }), error => {
    assert.equal(error.code, 'unavailable'); assert.doesNotMatch(error.message, /SECRET/); return true;
  });
});

test('GitHub pagination links with the numeric repository ID stay on the fixed API path', async () => {
  const urls = [];
  const found = await discoverRelease('stable', '', { fetcher: async url => {
    urls.push(url);
    const page = Number(new URL(url).searchParams.get('page'));
    return page === 1
      ? response([release('v0.5.0-preview.1')], { link: `<https://api.github.com/repositories/${REPOSITORY_ID}/releases?per_page=100&page=2>; rel="next", <https://api.github.com/repositories/${REPOSITORY_ID}/releases?per_page=100&page=2>; rel="last"` })
      : response([release('v0.5.0')]);
  } });
  assert.equal(found.release.tag_name, 'v0.5.0');
  assert.deepEqual(urls, [`${API_ROOT}/releases?per_page=100&page=1`, `${API_ROOT}/releases?per_page=100&page=2`]);
  await assert.rejects(discoverRelease('stable', '', { fetcher: async () => response([release('v0.5.0')],
    { link: '<https://api.github.com/repositories/1/releases?per_page=100&page=2>; rel="next"' }) }), error => error.code === 'invalid-response');
});

test('shallow discovery reuses a complete cached chain only after an unchanged first page and reports the request budget', async () => {
  let phase = 0;
  const calls = [];
  const fetcher = async (url, { headers }) => {
    const page = Number(new URL(url).searchParams.get('page'));
    calls.push(page);
    const quota = { 'x-ratelimit-remaining': String(50 - calls.length), 'x-ratelimit-reset': '2000' };
    if (phase === 1 && page === 1 && headers['If-None-Match'] === 'first') return new Response(null, { status: 304, headers: { ...quota, link: link(2) } });
    return page === 1 ? response([release(phase === 2 ? 'v0.9.0' : 'v0.5.0-preview.1')], { ...quota, etag: phase === 2 ? 'changed' : 'first', link: link(2) })
      : response([release('v0.6.0')], { ...quota, etag: 'second' });
  };
  const first = await discoverRelease('stable', '', { fetcher, shallow: true });
  assert.deepEqual(calls.splice(0), [1, 2]);
  assert.deepEqual(first.quota, { remaining: 48, reset: 2_000_000 });
  phase = 1;
  const unchanged = await discoverRelease('stable', '', { fetcher, cache: first.cache, shallow: true });
  assert.deepEqual(calls.splice(0), [1]);
  assert.equal(unchanged.release.tag_name, 'v0.6.0');
  assert.deepEqual(Object.keys(unchanged.cache), Object.keys(first.cache));
  // Without the later page in the cache, shallow mode still reads it.
  const [firstPath] = Object.keys(first.cache);
  const partial = await discoverRelease('stable', '', { fetcher, cache: { [firstPath]: first.cache[firstPath] }, shallow: true });
  assert.deepEqual(calls.splice(0), [1, 2]);
  assert.equal(partial.release.tag_name, 'v0.6.0');
  phase = 2;
  const changed = await discoverRelease('stable', '', { fetcher, cache: unchanged.cache, shallow: true });
  assert.deepEqual(calls.splice(0), [1, 2], 'a changed first page revalidates every page');
  assert.equal(changed.release.tag_name, 'v0.9.0');
});
