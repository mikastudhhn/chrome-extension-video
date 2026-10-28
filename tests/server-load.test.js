import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../server/index.js';
import { Rooms } from '../server/rooms.js';
import { OperatingCounters } from '../server/operating-counters.js';
import { LoadMetrics, LOAD_LIMITS, parseCpuMax, parseMeminfo, parseProcStat } from '../server/load-metrics.js';
import { Timeline } from '../extension/timeline.js';
import { PROTOCOL, CAPABILITIES } from '../extension/protocol.js';

const hello = { protocol: PROTOCOL, capabilities: [...CAPABILITIES] };
const build = { ...hello, client: { version: '0.6.0.9', distribution: 'chrome-web-store', channel: 'stable' } };
const sample = { time: 5, duration: 600, paused: true, buffering: false, mediaId: 'secret-media-id' };
const MB = 1048576;
const clock = start => { const time = { now: start }; return Object.assign(() => time.now, { advance: ms => { time.now += ms; } }); };
async function folder(t) {
  const directory = await mkdtemp(join(tmpdir(), 'video-sync-load-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

// Host timeline driven like room-session.js: both videos sampled, then confirmed.
function room(now) {
  const counters = new OperatingCounters();
  const rooms = new Rooms({ now, counters });
  const host = rooms.create(hello);
  const guest = rooms.join(host.code, hello);
  const timeline = new Timeline(now);
  const sender = rooms.members.get(host.token);
  let sequence = 0;
  const fresh = (guestSample = {}) => { timeline.sample('host', sample); timeline.sample('guest', { ...sample, time: 10, ...guestSample }); };
  const publish = () => rooms.relayData(sender, { sequence: ++sequence, messages: [{ type: 'state', state: timeline.tick() }] });
  return { counters, rooms, timeline, fresh, publish, guest: rooms.members.get(guest.token) };
}

test('feature use is read from host states: funnel, controls by role, realignment, interruptions, buffering and played time', () => {
  const now = clock(1_800_000_000_000);
  const { counters, rooms, timeline, fresh, publish, guest } = room(now);
  fresh(); publish();
  timeline.ready('host', 0); timeline.ready('guest', 0); publish();
  assert.deepEqual([counters.rooms.aligned, counters.sync.alignments, counters.rooms.played], [1, 1, 0]);
  timeline.intent('guest', { type: 'play', id: 1, mediaId: sample.mediaId, time: 10 }, 0); publish();
  assert.equal(counters.rooms.played, 1);
  now.advance(1000); fresh(); publish(); // keepalive while playing
  timeline.intent('host', { type: 'seek', time: 100, id: 1, mediaId: sample.mediaId }, 0); publish();
  timeline.intent('guest', { type: 'pause' }, 0); publish(); // network pause without an intent ID
  timeline.intent('host', { type: 'play', id: 2, mediaId: sample.mediaId, time: 100 }, 0); publish();
  fresh({ buffering: true }); publish();
  fresh(); publish();
  publish(); // repeated state: nothing new
  timeline.suspend(); publish();
  timeline.reset(); publish();
  rooms.relayData(guest, { sequence: 1, messages: [{ type: 'resync', requestId: 'r1' }] });
  assert.deepEqual(counters.controls, { play: { host: 1, guest: 1, other: 0 }, pause: { host: 0, guest: 0, other: 1 }, seek: { host: 1, guest: 0, other: 0 } });
  assert.deepEqual(counters.sync, { alignments: 1, realignments: 1, interruptions: 1, resyncRequests: 1, bufferingWaits: 1 });
  assert.equal(counters.playingMs, 1000);
  assert.deepEqual([counters.rooms.aligned, counters.rooms.played], [1, 1]);
  // A replayed batch is not counted again.
  const before = JSON.stringify([counters.controls, counters.sync]);
  rooms.relayData(guest, { sequence: 1, messages: [{ type: 'resync', requestId: 'r1' }] });
  assert.equal(JSON.stringify([counters.controls, counters.sync]), before);
  assert.equal(counters.batchReplays, 1);
});

test('Linux sources parse; missing limits stay null', () => {
  assert.deepEqual(parseProcStat('cpu  10 1 5 100 4 1 1 2 0 0\ncpu0 1 1 1 1\ncpu1 1 1 1 1\nintr 5'), { busy: 20, idle: 104, steal: 2, cpus: 2 });
  assert.equal(parseProcStat('nothing'), null);
  assert.deepEqual(parseMeminfo('MemTotal:        4000 kB\nMemFree: 1 kB\nMemAvailable:    3000 kB\n'), { total: 4000 * 1024, available: 3000 * 1024 });
  assert.equal(parseMeminfo('MemTotal: 0 kB'), null);
  assert.equal(parseCpuMax('150000 100000\n'), 1.5);
  assert.equal(parseCpuMax('max 100000\n'), null);
});

function fakeSystem() {
  const files = {
    '/proc/stat': 'cpu  100 0 100 800 0 0 0 0 0 0\ncpu0 1\ncpu1 1\n', '/proc/meminfo': 'MemTotal: 4000000 kB\nMemAvailable: 3000000 kB\n',
    '/proc/loadavg': '0.50 0.40 0.30 1/100 5', '/sys/fs/cgroup/cpu.max': '100000 100000',
    '/sys/fs/cgroup/memory.current': String(64 * MB), '/sys/fs/cgroup/memory.max': String(256 * MB)
  };
  const cpu = { user: 0, system: 0 };
  return {
    files, cpu,
    options: {
      read: path => Object.hasOwn(files, path) ? Promise.resolve(files[path]) : Promise.reject(new Error('missing')),
      cpuUsage: () => ({ ...cpu }), memory: () => ({ rss: 80 * MB, heapUsed: 20 * MB }),
      eventLoop: { read: () => ({ p99Ms: 4, maxMs: 30, utilization: 0.1 }), stop() {} },
      statfs: async () => ({ bavail: 2048, bsize: MB })
    }
  };
}

test('load: live snapshot every sample, hourly peaks and averages per UTC day, continued after a restart', async t => {
  const directory = await folder(t);
  const now = clock(Date.parse('2026-10-28T20:59:30Z'));
  const system = fakeSystem();
  const counters = new OperatingCounters();
  const rooms = new Rooms({ now, counters });
  const metrics = () => new LoadMetrics({ directory, now, rooms, counters, connections: () => 3, commit: 'abc1234', limits: { rooms: 500 },
    incidents: () => ({ report: 1 }), ...system.options });
  const first = metrics();
  await first.start();
  await first.sample();
  assert.equal(first.current.relay.cpuPercent, null); // no interval yet
  rooms.create(hello);
  now.advance(15_000);
  system.cpu.user = 1_500_000; // 1.5 s CPU in 15 s
  system.files['/proc/stat'] = 'cpu  200 0 150 1450 0 0 0 0 0 0\ncpu0 1\ncpu1 1\n';
  await first.sample();
  const live = JSON.parse(await readFile(join(directory, 'live.json'), 'utf8'));
  assert.deepEqual(live, {
    schema: 1, at: '2026-10-28T20:59:45.000Z', commit: 'abc1234', startedAt: '2026-10-28T20:59:30.000Z',
    rooms: { activeRooms: 1, joinedRooms: 0, activeMembers: 1, parkedPolls: 0, queuedMB: 0 },
    requests: { inFlight: 0, connections: 3 },
    relay: { cpuPercent: 10, cpuLimitCores: 1, rssMB: 80, heapMB: 20, memoryMB: 64, memoryLimitMB: 256, eventLoopP99Ms: 4, eventLoopMaxMs: 30, eventLoopUtilization: 0.1 },
    host: { cpus: 2, cpuPercent: 18.8, stealPercent: 0, load1: 0.5, memoryTotalMB: 3906, memoryAvailableMB: 2930, diskFreeMB: 2048 },
    limits: { rooms: 500 }, incidents: { report: 1 }
  });
  now.advance(LOAD_LIMITS.flushMs); // 21:04:45, a new hour
  await first.sample();
  const day = JSON.parse(await readFile(join(directory, 'load', '2026-10-28.json'), 'utf8'));
  assert.deepEqual(Object.keys(day.hours), ['20', '21']);
  assert.deepEqual(day.hours['20'].peaks, { activeRooms: 1, joinedRooms: 0, activeMembers: 1, parkedPolls: 0, inFlight: 0, connections: 3,
    relayCpuPercent: 10, rssMB: 80, eventLoopP99Ms: 4, eventLoopMaxMs: 30, hostCpuPercent: 18.8, hostMemoryPercent: 25 });
  assert.equal(day.hours['20'].samples, 2);
  assert.deepEqual(day.hours['20'].weights, { relayCpuPercent: 1, eventLoopUtilization: 2, hostCpuPercent: 1, hostStealPercent: 1, hostMemoryPercent: 2 });
  assert.equal(day.hours['21'].averages.relayCpuPercent, 0);
  await first.stop();

  const second = metrics();
  await second.start();
  await second.sample();
  await second.stop();
  const continued = JSON.parse(await readFile(join(directory, 'load', '2026-10-28.json'), 'utf8'));
  assert.equal(continued.hours['21'].samples, 2);
  assert.equal(continued.hours['20'].samples, 2);
});

test('load: a broken data volume is reported once and the figures stay in memory', async t => {
  const directory = await folder(t);
  await writeFile(join(directory, 'load'), 'not a folder');
  const reports = [];
  const now = clock(Date.parse('2026-10-28T12:00:00Z'));
  const counters = new OperatingCounters();
  const metrics = new LoadMetrics({ directory, now, rooms: new Rooms({ now, counters }), counters, report: text => reports.push(text), ...fakeSystem().options });
  await metrics.sample();
  now.advance(LOAD_LIMITS.flushMs);
  await metrics.sample();
  await metrics.sample();
  assert.equal(reports.length, 1);
  assert.equal(metrics.current.rooms.activeRooms, 0);
});

// The privacy policy describes these files. Whatever the relay sees, they hold
// only fixed keys, numbers, dates, the commit and build labels.
test('stored statistics never contain room codes, tokens, addresses, media IDs or other request text', async t => {
  const directory = await folder(t);
  await mkdir(join(directory, 'load'), { recursive: true });
  const now = clock(Date.parse('2026-10-28T20:00:00Z'));
  const system = fakeSystem();
  const server = createServer({ now, dataDirectory: directory, commit: 'abc1234', statfs: system.options.statfs, load: system.options, report: () => {} });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, body, token) => (await fetch(`${base}${path}`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) })).json();
  await server.usage.start();
  await server.load.start();
  const host = await post('/rooms', build);
  const guest = await post(`/rooms/${host.code}/join`, build);
  const timeline = new Timeline(now);
  timeline.sample('host', sample); timeline.sample('guest', { ...sample, time: 10 });
  timeline.ready('host', 0); timeline.ready('guest', 0);
  timeline.intent('host', { type: 'play', id: 1, mediaId: sample.mediaId, time: 5 }, 0);
  await post('/relay', { sequence: 1, messages: [{ type: 'state', state: timeline.tick() }] }, host.token);
  await post('/relay', { sequence: 1, messages: [{ type: 'resync', requestId: 'private-request' }] }, guest.token);
  await fetch(`${base}/wp-login.php?user=admin`);
  await server.load.sample();
  now.advance(15_000);
  await server.load.sample();
  server.usage.tick(server.load.values);
  await server.usage.flush();
  await server.load.stop();
  assert.equal(server.operatingSnapshot().rooms.played, 1);

  const files = [];
  for (const name of await readdir(directory, { recursive: true })) if (name.endsWith('.json')) files.push(name);
  assert.deepEqual(files.sort(), ['live.json', 'load/2026-10-28.json', 'usage/2026-10-28.json']);
  const allowed = [/^\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z)?$/, /^abc1234$/, /^(?:[a-z][a-z0-9-]{0,23}|unknown)\/(?:[a-z][a-z0-9-]{0,23}|unknown)\/[\d.]+$/];
  const walk = (value, path) => {
    if (typeof value === 'string') assert.ok(allowed.some(pattern => pattern.test(value)), `${path}: ${value}`);
    else if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) {
        assert.match(key, /^(?:[A-Za-z0-9_]+|[a-z-]+\/[a-z-]+\/[\d.]+)$/, `${path}.${key}`);
        walk(item, `${path}.${key}`);
      }
    } else assert.ok(value === null || typeof value === 'number' || typeof value === 'boolean', path);
  };
  for (const file of files) {
    const text = await readFile(join(directory, file), 'utf8');
    for (const secret of [host.code, host.token, guest.token, sample.mediaId, 'private-request', '127.0.0.1', 'wp-login', 'admin']) {
      assert.equal(text.includes(secret), false, `${file} contains ${secret}`);
    }
    walk(JSON.parse(text), file);
  }
  const live = JSON.parse(await readFile(join(directory, 'live.json'), 'utf8'));
  assert.deepEqual(Object.keys(live), ['schema', 'at', 'commit', 'startedAt', 'rooms', 'requests', 'relay', 'host', 'limits', 'incidents']);
  const usage = JSON.parse(await readFile(join(directory, 'usage', '2026-10-28.json'), 'utf8'));
  assert.deepEqual(Object.keys(usage), ['schema', 'day', 'commit', 'updatedAt', 'starts', 'crashes', 'totals', 'peaks', 'minDiskFreeMB']);
  assert.equal(usage.peaks.relayCpuPercent, 0);
});

test('hourly load files are pruned after 30 days with the other statistics', async t => {
  const directory = await folder(t);
  await mkdir(join(directory, 'load'), { recursive: true });
  await writeFile(join(directory, 'load', '2026-09-20.json'), '{}');
  await writeFile(join(directory, 'load', '2026-10-01.json'), '{}');
  const now = clock(Date.parse('2026-10-28T12:00:00Z'));
  const server = createServer({ now, dataDirectory: directory, statfs: fakeSystem().options.statfs, load: fakeSystem().options });
  t.after(() => server.close(() => {}));
  await server.usage.start();
  assert.deepEqual((await readdir(join(directory, 'load'))).sort(), ['2026-10-01.json']);
});
