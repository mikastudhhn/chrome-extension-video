import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../server/index.js';
import { Rooms } from '../server/rooms.js';
import { OperatingCounters, clientLabel, CLIENT_LABELS } from '../server/operating-counters.js';
import { ErrorLog, ERROR_LOG_LIMITS, scrub, shapeOf } from '../server/error-log.js';
import { UsageStats, USAGE_LIMITS, difference, sum } from '../server/usage-stats.js';
import { PROTOCOL, CAPABILITIES } from '../extension/protocol.js';

const hello = { protocol: PROTOCOL, capabilities: [...CAPABILITIES] };
const build = { ...hello, client: { version: '0.6.0.9', distribution: 'chrome-web-store', channel: 'stable' } };
const post = (body, headers = {}) => ({ method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
const DAY = 86_400_000;

async function listen(server, t) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}
async function folder(t) {
  const directory = await mkdtemp(join(tmpdir(), 'video-sync-monitoring-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
const clock = start => { const time = { now: start }; return Object.assign(() => time.now, { advance: ms => { time.now += ms; } }); };
const lines = async file => (await readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line));

test('client labels accept only a version and two short identifiers', () => {
  assert.equal(clientLabel(build), 'chrome-web-store/stable/0.6.0.9');
  assert.equal(clientLabel({ client: { version: '0.6.0', channel: 'experimental' } }), 'unknown/experimental/0.6.0');
  assert.equal(clientLabel(hello), 'unknown');
  assert.equal(clientLabel({ client: { version: 'x'.repeat(40) } }), 'unknown');
  assert.equal(clientLabel({ client: { version: '1.2.3', distribution: 'Robert Tables', channel: 'a'.repeat(30) } }), 'unknown/unknown/1.2.3');
  const counters = new OperatingCounters();
  for (let index = 0; index < CLIENT_LABELS + 5; index++) counters.seat(`github/stable/0.6.0.${index}`);
  counters.seat('github/stable/0.6.0.0');
  assert.equal(Object.keys(counters.clients).length, CLIENT_LABELS + 1);
  assert.equal(counters.clients.other, 5);
  assert.equal(counters.clients['github/stable/0.6.0.0'], 2);
});

test('rooms count creation, joining, unused invitations, durations and delivery delay', async () => {
  const now = clock(1_800_000_000_000);
  const counters = new OperatingCounters();
  const rooms = new Rooms({ now, counters });
  const unused = rooms.create(build);
  rooms.close(rooms.rooms.get(unused.code), 'leave');
  const host = rooms.create(build);
  const guest = rooms.join(host.code, hello);
  const sender = rooms.members.get(guest.token), receiver = rooms.members.get(host.token);
  rooms.relayData(sender, { sequence: 1, messages: [{ type: 'ready', epoch: 1 }] });
  now.advance(300);
  const abort = new AbortController();
  // peer-joined is not relayed data; the ready message waited 300 ms.
  assert.equal((await rooms.poll(receiver, 0, abort.signal, 10)).length, 2);
  await rooms.poll(receiver, 0, abort.signal, 10); // a repeated delivery is not counted again
  now.advance(2 * 3_600_000);
  rooms.close(receiver.room, 'idle');
  assert.deepEqual(counters.rooms, { created: 2, joined: 1, unusedInvitations: 1, aligned: 0, played: 0 });
  assert.deepEqual(counters.durations, { under10m: 0, under1h: 0, under3h: 1, longer: 0 });
  assert.deepEqual(counters.delivery, { under50ms: 0, under250ms: 0, under1s: 1, under5s: 0, longer: 0 });
  assert.deepEqual(counters.clients, { 'chrome-web-store/stable/0.6.0.9': 2, unknown: 1 });
  assert.equal(counters.closed.leave + counters.closed.idle, 2);
});

test('HTTP: route classes, error codes and API latency are counted; malformed paths are 404, not server errors', async t => {
  const server = createServer();
  const base = await listen(server, t);
  await fetch(`${base}/health`);
  await fetch(`${base}/`);
  await fetch(`${base}/wp-login.php`);
  const malformed = await fetch(`${base}/%E0%A4%A`);
  assert.equal(malformed.status, 404);
  assert.equal((await malformed.json()).failure.code, 'NOT_FOUND');
  const created = await (await fetch(`${base}/rooms`, post(build))).json();
  await fetch(`${base}/relay`, post({ sequence: 1, messages: [{ type: 'ready', epoch: 1 }] }, { Authorization: 'Bearer nope' }));
  await fetch(`${base}/leave`, { method: 'POST', headers: { Authorization: `Bearer ${created.token}` } });
  const snapshot = server.operatingSnapshot();
  assert.deepEqual(snapshot.traffic, { api: 3, health: 1, page: 1, unknown: 2 });
  assert.deepEqual(snapshot.codes, { NOT_FOUND: 2, SESSION_ENDED: 1 });
  assert.equal(Object.values(snapshot.apiLatency).reduce((total, value) => total + value, 0), 3);
  assert.equal(snapshot.errorLog.logged, 0, 'bots and ordinary rejections are not logged');
  assert.deepEqual(server.errors.recent, []);
});

test('HTTP: an unexpected exception is logged with context but without addresses, tokens or IDs, and reported as an incident', async t => {
  const rooms = new Rooms();
  const server = createServer({ rooms, commit: 'abc1234' });
  const base = await listen(server, t);
  const host = await (await fetch(`${base}/rooms`, post(build))).json();
  await fetch(`${base}/rooms/${host.code}/join`, post(hello));
  rooms.relayData = () => { throw new TypeError(`boom 192.0.2.44 2001:db8::7 ${host.token} 0f8fad5b-d9cb-469f-a165-70867728950e`); };
  const response = await fetch(`${base}/relay`, post({ sequence: 1, messages: [{ type: 'ready', epoch: 1, note: 'private text' }] }, { Authorization: `Bearer ${host.token}` }));
  assert.equal(response.status, 500);
  assert.equal((await response.json()).failure.code, 'SERVER_ERROR');
  const [entry] = server.errors.recent;
  assert.equal(entry.kind, 'exception');
  assert.equal(entry.route, 'relay');
  assert.equal(entry.status, 500);
  assert.equal(entry.error.name, 'TypeError');
  assert.match(entry.error.message, /^boom <ip> <ip> <token> <uuid>$/);
  assert.ok(entry.error.stack.length > 0 && entry.error.stack.length <= ERROR_LOG_LIMITS.stackLines);
  assert.ok(entry.error.stack.some(frame => /^at .*\(server\/index\.js:\d+:\d+\)$/.test(frame)), entry.error.stack.join('\n'));
  assert.equal(entry.error.stack.some(frame => frame.includes('file://') || frame.includes(process.cwd())), false);
  assert.deepEqual(entry.member, { role: 'host', client: 'chrome-web-store/stable/0.6.0.9', joined: true, roomAgeS: 0, queued: 1, sequence: 1, sentSequence: 0 });
  assert.deepEqual(entry.request.shape, { sequence: 1, messages: [{ type: 'ready', epoch: 1, note: '<string:12>' }] });
  assert.equal(entry.server.commit, 'abc1234');
  assert.equal(entry.server.joinedRooms, 1);
  const text = JSON.stringify(entry);
  for (const secret of [host.token, host.code, '192.0.2.44', 'private text', '127.0.0.1']) assert.equal(text.includes(secret), false, secret);
  const health = await (await fetch(`${base}/health`)).json();
  assert.deepEqual(Object.keys(health.incidents), ['error']);
});

test('HTTP: protocol rejections are logged with the payload shape; scanners only count', async t => {
  const server = createServer();
  const base = await listen(server, t);
  const host = await (await fetch(`${base}/rooms`, post(build))).json();
  const guest = await (await fetch(`${base}/rooms/${host.code}/join`, post(build))).json();
  const relay = body => fetch(`${base}/relay`, post(body, { Authorization: `Bearer ${guest.token}` }));
  assert.equal((await relay({ sequence: 3, messages: [{ type: 'ready', epoch: 1 }] })).status, 400);
  const [entry] = server.errors.recent;
  assert.equal(entry.kind, 'rejected');
  assert.equal(entry.code, 'INVALID_SEQUENCE');
  assert.equal(entry.member.role, 'guest');
  assert.equal(entry.member.sentSequence, 0);
  assert.deepEqual(entry.request.shape, { sequence: 3, messages: [{ type: 'ready', epoch: 1 }] });
  await fetch(`${base}/rooms`, post({ protocol: 1, capabilities: [] }));
  assert.equal(server.errors.recent.at(-1).code, 'INCOMPATIBLE_PROTOCOL');
  assert.deepEqual(server.errors.recent.at(-1).request.shape, { protocol: 1, capabilities: [] });
});

test('the error log is bounded per signature and per day and appends one JSON line per entry', async t => {
  const directory = await folder(t);
  const now = clock(Date.parse('2026-10-28T10:00:00Z'));
  const counters = new OperatingCounters();
  const log = new ErrorLog({ directory, now, counters });
  for (let index = 0; index < ERROR_LOG_LIMITS.perSignature + 3; index++) log.rejected('INVALID_MESSAGE', { route: 'relay' });
  for (let index = 0; index < ERROR_LOG_LIMITS.perDay; index++) log.rejected('INVALID_MESSAGE', { route: `r${index}` });
  assert.equal(counters.errorLog.logged, ERROR_LOG_LIMITS.perDay);
  assert.equal(counters.errorLog.suppressed, 3 + ERROR_LOG_LIMITS.perSignature);
  assert.equal(log.recent.length, ERROR_LOG_LIMITS.recent);
  now.advance(DAY);
  assert.ok(log.rejected('INVALID_MESSAGE', { route: 'relay' }), 'a new UTC day starts new budgets');
  log.crash(new Error('fatal'));
  await log.flush();
  assert.equal((await lines(join(directory, '2026-10-28.jsonl'))).length, ERROR_LOG_LIMITS.perDay);
  const next = await lines(join(directory, '2026-10-29.jsonl'));
  assert.deepEqual(next.map(entry => entry.kind).sort(), ['crash', 'rejected']);
  assert.match(next[0].id, /^[0-9a-f]{8}$/);
});

test('scrubbing and payload shapes keep identifiers and numbers, never free text', () => {
  assert.equal(scrub('at 10.0.0.1 and fe80::1 and ::ffff:192.0.2.1'), 'at <ip> and <ip> and ::ffff:<ip>');
  assert.equal(scrub('server/index.js:140:25 at 10:12'), 'server/index.js:140:25 at 10:12');
  assert.equal(scrub('2001:0db8:0000:0000:0000:ff00:0042:8329'), '<ip>');
  assert.equal(scrub('x'.repeat(2000)).length, ERROR_LOG_LIMITS.textBytes);
  assert.deepEqual(shapeOf({ type: 'sample', sample: { time: 5, paused: true, adapter: 'HTML5', mediaId: '0f8fad5b-d9cb-469f-a165-70867728950e' }, list: [1, 2, 3, 4, 5, 6, 7] }),
    { type: 'sample', sample: { time: 5, paused: true, adapter: '<string:5>', mediaId: '<string:36>' }, list: [1, 2, 3, 4, 5, '<+2>'] });
  assert.deepEqual(shapeOf({ a: { b: { c: { d: { e: 1 } } } } }), { a: { b: { c: { d: '<object>' } } } });
  assert.deepEqual(shapeOf({ note: 'private', type: 'ready', capabilities: ['relay-v2'], requestId: 'abc' }),
    { note: '<string:7>', type: 'ready', capabilities: ['relay-v2'], requestId: '<string:3>' }, 'free text never survives, not even one word');
});

test('usage sums are kept per UTC day, survive restarts and record unclean exits as crashes', async t => {
  const directory = await folder(t);
  const now = clock(Date.parse('2026-10-28T22:00:00Z'));
  const statfs = async () => ({ bavail: 4096, bsize: 1048576 });
  const first = createServer({ now, dataDirectory: directory, commit: 'abc1234', statfs });
  await first.usage.start();
  const base = await listen(first, t);
  const host = await (await fetch(`${base}/rooms`, post(build))).json();
  await fetch(`${base}/rooms/${host.code}/join`, post(hello));
  first.usage.tick();
  await first.usage.flush();
  const file = join(directory, 'usage', '2026-10-28.json');
  let day = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(day.schema, 1);
  assert.equal(day.commit, 'abc1234');
  assert.equal(day.starts, 1);
  assert.equal(day.crashes, 0);
  assert.equal(day.totals.rooms.created, 1);
  assert.equal(day.totals.rooms.joined, 1);
  assert.deepEqual(day.totals.clients, { 'chrome-web-store/stable/0.6.0.9': 1, unknown: 1 });
  assert.deepEqual({ rooms: day.peaks.activeRooms, joined: day.peaks.joinedRooms }, { rooms: 1, joined: 1 });
  assert.equal(day.minDiskFreeMB, 4096);
  assert.equal(await readFile(join(directory, 'running'), 'utf8').then(() => true), true);

  // No clean shutdown: the marker stays, the next process continues the day and counts a crash.
  const second = createServer({ now, dataDirectory: directory, statfs });
  await second.usage.start();
  const secondBase = await listen(second, t);
  await fetch(`${secondBase}/rooms`, post(hello));
  await second.usage.flush();
  day = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(day.starts, 2);
  assert.equal(day.crashes, 1);
  assert.equal(day.totals.rooms.created, 2);
  assert.ok((await (await fetch(`${secondBase}/health`)).json()).incidents.crash);

  // The UTC day ends: the finished day is written once more, the next one starts empty.
  now.advance(3 * 3_600_000);
  second.usage.tick();
  await second.usage.flush();
  const finished = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(finished.totals.rooms.created, 2);
  const next = JSON.parse(await readFile(join(directory, 'usage', '2026-10-29.json'), 'utf8'));
  assert.equal(next.starts, 0);
  assert.equal(next.totals.rooms.created, 0);
  assert.equal(next.peaks.activeRooms, 1, 'open rooms carry into the new day as its first peak');

  await second.shutdown();
  assert.equal(await readFile(join(directory, 'running')).then(() => true, () => false), false, 'a clean shutdown removes the marker');
});

test('old usage files and error logs are pruned by their own retention', async t => {
  const directory = await folder(t);
  await mkdir(join(directory, 'usage'), { recursive: true });
  await mkdir(join(directory, 'errors'), { recursive: true });
  for (const name of ['2025-09-01.json', '2025-10-01.json', 'notes.txt']) await writeFile(join(directory, 'usage', name), '{}\n');
  for (const name of ['2026-09-27.jsonl', '2026-09-29.jsonl']) await writeFile(join(directory, 'errors', name), '{}\n');
  const counters = new OperatingCounters();
  const usage = new UsageStats({ directory, counters, rooms: new Rooms(), now: () => Date.parse('2026-10-28T12:00:00Z'), statfs: async () => ({ bavail: 1, bsize: 1 }) });
  await usage.start();
  assert.deepEqual((await readdir(join(directory, 'usage'))).sort(), ['2025-10-01.json', '2026-10-28.json', 'notes.txt']);
  assert.deepEqual(await readdir(join(directory, 'errors')), ['2026-09-29.jsonl']);
  assert.ok(usage.recentIncidents().disk, 'less than 1 GB free');
  await usage.stop();
});

test('incidents: limits and capacity alert once per hour, memory above the threshold, all expire after a day', () => {
  const now = clock(Date.parse('2026-10-28T12:00:00Z'));
  const counters = new OperatingCounters();
  let rss = 50 * 1048576;
  const usage = new UsageStats({ counters, rooms: new Rooms(), now, rss: () => rss });
  usage.tick();
  assert.deepEqual(usage.recentIncidents(), {});
  counters.limited.flood += USAGE_LIMITS.limitedPerHour - 1;
  usage.tick();
  assert.deepEqual(usage.recentIncidents(), {});
  counters.limited.relay++;
  counters.codes.SERVER_BUSY = 1;
  usage.tick();
  const first = usage.recentIncidents();
  assert.deepEqual(Object.keys(first).sort(), ['capacity', 'limits']);
  now.advance(60_000);
  counters.limited.flood += 1000;
  usage.tick();
  assert.equal(usage.recentIncidents().limits, first.limits, 'one alert per hour');
  now.advance(3_600_000);
  usage.tick();
  counters.limited.flood += USAGE_LIMITS.limitedPerHour;
  usage.tick();
  assert.ok(usage.recentIncidents().limits > first.limits, 'a new hour alerts again');
  rss = (USAGE_LIMITS.rssMB + 1) * 1048576;
  usage.tick();
  assert.ok(usage.recentIncidents().memory);
  now.advance(DAY + 1);
  assert.deepEqual(usage.recentIncidents(), {});
});

test('day sums combine carried totals with the difference since the day began', () => {
  assert.deepEqual(difference({ a: 5, nested: { b: 3, c: 1 } }, { a: 2, nested: { b: 1 } }), { a: 3, nested: { b: 2, c: 1 } });
  assert.deepEqual(sum({ a: 1, codes: { X: 1 } }, { a: 2, codes: { X: 1, Y: 4 } }), { a: 3, codes: { X: 2, Y: 4 } });
});

test('process: an unusable DATA_DIR is reported, the relay still serves', async t => {
  const directory = await folder(t);
  const blocked = join(directory, 'not-a-directory');
  await writeFile(blocked, 'x');
  const child = spawn(process.execPath, ['server/index.js'], { cwd: process.cwd(),
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DATA_DIR: blocked }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let output = '', errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  await new Promise(resolve => child.stdout.on('data', chunk => { output += chunk; if (/relay started/.test(output)) resolve(); }));
  assert.match(errors, /Nutzungsstatistik ohne Datei/);
  child.kill('SIGTERM');
  assert.equal((await once(child, 'exit'))[0], 0);
});

test('process: DATA_DIR keeps the running marker while serving and removes it on SIGTERM after the last flush', async t => {
  const directory = await folder(t);
  const child = spawn(process.execPath, ['server/index.js'], { cwd: process.cwd(),
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DATA_DIR: directory, SOURCE_COMMIT: 'feedbee' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let output = '';
  await new Promise(resolve => child.stdout.on('data', chunk => { output += chunk; if (/relay started/.test(output)) resolve(); }));
  assert.equal(await readFile(join(directory, 'running')).then(() => true, () => false), true);
  child.kill('SIGTERM');
  const [code] = await once(child, 'exit');
  assert.equal(code, 0);
  assert.equal(await readFile(join(directory, 'running')).then(() => true, () => false), false);
  const [file] = await readdir(join(directory, 'usage'));
  const day = JSON.parse(await readFile(join(directory, 'usage', file), 'utf8'));
  assert.equal(day.commit, 'feedbee');
  assert.equal(day.crashes, 0);
});
