import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ADMIN_LIMITS, buildOverview, createAdminServer, normalizeDay, parseArguments, parseSections, remoteCommand } from '../scripts/admin.js';
import { capacity, features, funnel, summarize, cutoffDay } from '../admin/model.js';

const usageDay = (day, extra = {}) => ({ schema: 1, day, commit: 'abc1234', updatedAt: `${day}T23:59:00.000Z`, starts: 1, crashes: 0,
  totals: { rooms: { created: 4, joined: 3, unusedInvitations: 1, aligned: 3, played: 2 }, controls: { play: { host: 2, guest: 1, other: 0 },
    pause: { host: 1, guest: 1, other: 1 }, seek: { host: 0, guest: 0, other: 0 } }, sync: { alignments: 3, realignments: 1, interruptions: 0, resyncRequests: 0, bufferingWaits: 2 },
  playingMs: 5_400_000, durations: { under10m: 1, under1h: 0, under3h: 2, longer: 0 }, closed: { leave: 3, idle: 1 },
  delivery: { under50ms: 90, under250ms: 10 }, apiLatency: { under10ms: 100 }, responses: { success: 100, rejected: 2, failed: 0 },
  limited: { flood: 1 }, traffic: { unknown: 7 }, codes: { NOT_FOUND: 7 }, clients: { 'chrome-web-store/stable/0.6.0.10': 6 }, reports: 0, errorLog: { logged: 0 } },
  peaks: { activeRooms: 2, rssMB: 70, hostMemoryPercent: 20 }, minDiskFreeMB: 50_000, ...extra });
const loadDay = (day, cpu = 3) => ({ schema: 1, day, commit: 'abc1234', updatedAt: `${day}T23:00:00.000Z`, hours: {
  20: { samples: 240, peaks: { activeRooms: 2, inFlight: 3, connections: 6, rssMB: 72, eventLoopP99Ms: 2, hostMemoryPercent: 22 }, weights: {},
    averages: { relayCpuPercent: cpu, hostCpuPercent: cpu, hostMemoryPercent: 21 } } } });
const live = { schema: 1, at: '2026-10-29T21:00:00.000Z', commit: 'abc1234', startedAt: '2026-10-29T10:00:00.000Z',
  rooms: { activeRooms: 1, joinedRooms: 1, activeMembers: 2, parkedPolls: 2, queuedMB: 0 }, requests: { inFlight: 2, connections: 4 },
  relay: { cpuPercent: 1, cpuLimitCores: 1, rssMB: 70, heapMB: 20, memoryMB: 60, memoryLimitMB: 256, eventLoopP99Ms: 1, eventLoopMaxMs: 3, eventLoopUtilization: 0.01 },
  host: { cpus: 2, cpuPercent: 2, stealPercent: 0, load1: 0.1, memoryTotalMB: 3922, memoryAvailableMB: 3400, diskFreeMB: 57_000 },
  limits: { rooms: 500, maxInFlight: 512, maxConnections: 1024, queueBudgetMB: 16 }, incidents: {} };
const report = { id: 'K7Q2-9F3D', at: '2026-10-29T20:00:00.000Z', client: { distribution: 'chrome-web-store', channel: 'stable', version: '0.6.0.10' },
  session: { phase: 'interrupted', notice: 'NETWORK_ERROR' }, note: 'ruckelt', diagnostics: { events: [] } };
const dump = [
  '--- usage', JSON.stringify(usageDay('2026-10-28', { totals: { rooms: { created: 1 } } })), JSON.stringify(usageDay('2026-10-29')),
  '--- load', JSON.stringify(loadDay('2026-10-29')), JSON.stringify(loadDay('2026-10-28')),
  '--- live', JSON.stringify(live),
  '--- errors', JSON.stringify({ at: '2026-10-29T19:00:00.000Z', id: 'ab12', kind: 'exception' }), '{"cut off',
  '--- reports', JSON.stringify(report), JSON.stringify({ id: 'bad' }), ''
].join('\n');

test('the dashboard runs only the read script, and its output splits into sections', () => {
  assert.equal(remoteCommand('overview'), '/opt/video-sync/deploy/admin-read.sh overview');
  const sections = parseSections(dump);
  assert.deepEqual(Object.fromEntries(Object.entries(sections).map(([name, items]) => [name, items.length])), { usage: 2, load: 2, live: 1, errors: 1, reports: 2 });
});

test('overview: days and hours in order, old days without feature counters, valid reports newest first', () => {
  const overview = buildOverview(parseSections(dump), Date.parse('2026-10-29T21:00:30Z'));
  assert.deepEqual(overview.days.map(day => [day.day, day.features, day.rooms.created]), [['2026-10-28', false, 1], ['2026-10-29', true, 4]]);
  assert.deepEqual(overview.hours.map(hour => hour.at), ['2026-10-28T20:00:00Z', '2026-10-29T20:00:00Z']);
  const day = overview.days[1];
  assert.deepEqual([day.playingMinutes, day.deliveryP95, day.apiP95, day.limitedTotal, day.unknownTraffic], [90, '<250 ms', '<10 ms', 1, 7]);
  assert.deepEqual(overview.reports.map(item => [item.id, item.note, item.phase]), [['K7Q2-9F3D', 'ruckelt', 'interrupted']]);
  assert.equal(overview.errors.length, 1);
  assert.equal(overview.live.commit, 'abc1234');
  assert.deepEqual(normalizeDay({ day: '2026-10-01' }).controls.play, { host: 0, guest: 0, other: 0 });
});

test('period sums, funnel shares and features that were not used', () => {
  const overview = buildOverview(parseSections(dump), Date.parse('2026-10-29T21:00:30Z'));
  assert.equal(cutoffDay(overview.generatedAt, 7), '2026-10-23');
  const one = summarize(overview, 1);
  assert.deepEqual([one.days.length, one.hours.length, one.featuresSince], [1, 1, '2026-10-29']);
  const week = summarize(overview, 7);
  assert.equal(week.totals.rooms.created, 5);
  assert.deepEqual(funnel(week.totals).map(stage => [stage.key, stage.value, stage.share]),
    [['created', 5, 1], ['joined', 3, 0.6], ['aligned', 3, 0.6], ['played', 2, 0.4]]);
  const used = Object.fromEntries(features(week.totals).map(item => [item.key, item.value]));
  assert.deepEqual(used, { invite: 5, join: 3, align: 3, play: 3, pause: 3, seek: 0, realign: 1, report: 0 });
});

test('capacity: sustained use against limits decides the verdict; refused requests mean too small', () => {
  const at = Date.parse('2026-10-29T21:00:30Z');
  const verdict = (load, extra = {}) => capacity(summarize(buildOverview(parseSections(['--- usage', JSON.stringify(usageDay('2026-10-29', extra)),
    '--- load', JSON.stringify(loadDay('2026-10-29', load)), '--- live', JSON.stringify(live)].join('\n')), at), 7), live);
  const idle = verdict(3);
  assert.equal(idle.verdict, 'ok'); // 72 MB of 256 MB is 28 %
  assert.deepEqual(idle.items.find(item => item.key === 'relayMemory'), { key: 'relayMemory', label: 'Relay-Arbeitsspeicher', value: 72, limit: 256,
    unit: 'MB', hardware: true, ratio: 72 / 256 });
  assert.equal(verdict(65).verdict, 'tight');
  assert.equal(verdict(90).verdict, 'over');
  const refused = verdict(3, { totals: { codes: { SERVER_BUSY: 4 } } });
  assert.deepEqual([refused.verdict, refused.refused], ['over', 4]);
  assert.equal(capacity(summarize({ generatedAt: new Date(at).toISOString(), days: [], hours: [] }, 7), null).verdict, 'unknown');
});

async function serve(t, remote) {
  const server = createAdminServer({ remote });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  return server.address().port;
}
// fetch() cannot send a foreign Host header; http.request can.
const get = (port, path, headers = {}, method = 'GET') => new Promise((resolve, reject) => {
  const request = http.request({ host: '127.0.0.1', port, path, method, headers }, response => {
    let body = '';
    response.on('data', chunk => { body += chunk; });
    response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
  });
  request.on('error', reject);
  request.end();
});

test('local server: page with a strict CSP, cached overview, only local Host names, only listed files', async t => {
  const commands = [];
  const port = await serve(t, async command => { commands.push(command); return command.endsWith(' overview') ? dump : JSON.stringify(live); });
  const page = await get(port, '/');
  assert.equal(page.status, 200);
  assert.match(page.headers['content-security-policy'], /default-src 'none'; script-src 'self'/);
  assert.equal(page.headers['x-content-type-options'], 'nosniff');
  assert.match(page.body, /<script type="module" src="\/app.js">/);
  assert.equal((await get(port, '/tokens.css')).status, 200);
  const overview = JSON.parse((await get(port, '/api/overview')).body);
  assert.equal(overview.days.length, 2);
  await get(port, '/api/overview');
  assert.equal(commands.length, 1); // cached for a minute
  await get(port, '/api/overview?fresh=1');
  assert.equal(commands.length, 2);
  assert.equal(JSON.parse((await get(port, '/api/live')).body).live.commit, 'abc1234');
  assert.equal((await get(port, '/', { Host: 'attacker.example' })).status, 421);
  assert.equal((await get(port, '/', { Host: 'localhost:8790' })).status, 200);
  assert.equal((await get(port, '/api/overview', {}, 'POST')).status, 405);
  for (const path of ['/../package.json', '/admin/app.js', '/server/index.js', '/%2e%2e/package.json']) assert.equal((await get(port, path)).status, 404, path);
  assert.equal((await get(port, '/api/report?id=../../etc')).status, 400);
});

test('local server: an unreachable relay is a 502 with the SSH message, not a crash', async t => {
  const port = await serve(t, async () => { throw new Error('ssh: connect to host video-sync port 22: Operation timed out'); });
  const response = await get(port, '/api/overview');
  assert.equal(response.status, 502);
  assert.match(JSON.parse(response.body).error, /Operation timed out/);
  assert.equal((await get(port, '/api/live')).status, 502);
});

test('admin arguments', () => {
  assert.deepEqual(parseArguments([]), { port: ADMIN_LIMITS.port, open: true });
  assert.deepEqual(parseArguments(['--port', '9000', '--no-open']), { port: 9000, open: false });
  assert.throws(() => parseArguments(['--port', '80']), /1024/);
  assert.throws(() => parseArguments(['--host', 'x']), /Unbekannte Option/);
});

// A stub `docker` prints what the script would run inside the app container.
test('admin-read.sh runs only overview, live or one report, also behind a forced SSH command', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'video-sync-admin-read-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'deploy'));
  await mkdir(join(directory, 'bin'));
  await copyFile('deploy/admin-read.sh', join(directory, 'deploy', 'admin-read.sh'));
  await writeFile(join(directory, 'bin', 'docker'), '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
  const run = (args, forced) => spawnSync('sh', [join(directory, 'deploy', 'admin-read.sh'), ...args], { encoding: 'utf8',
    env: { PATH: `${join(directory, 'bin')}:/usr/bin:/bin`, ...(forced === undefined ? {} : { SSH_ORIGINAL_COMMAND: forced }) } });
  const overview = run(['overview']);
  assert.equal(overview.status, 0, overview.stderr);
  assert.match(overview.stdout, /^compose\n--env-file\ndeploy\/\.env\n-f\ndeploy\/compose\.yaml\nexec\n-T\napp\nsh\n-c\necho "--- usage"/);
  assert.doesNotMatch(overview.stdout, /\brm\b|\bmv\b|>[^&/]/);
  assert.match(run(['live']).stdout, /cat \/data\/live\.json/);
  assert.match(run(['report', 'K7Q2-9F3D']).stdout, /cat \/data\/reports\/\*-K7Q2-9F3D\.json/);
  assert.match(run([], '/opt/video-sync/deploy/admin-read.sh report K7Q2-9F3D').stdout, /\*-K7Q2-9F3D\.json/);
  assert.match(run(['overview'], 'live').stdout, /live\.json/); // a forced command ignores its own arguments
  for (const forced of ['overview; rm -rf /', 'report ../../etc/passwd', 'report k7q2-9f3d', 'report K7Q2-9F3D extra', 'sh', '*', 'live $(id)', '/bin/sh -c id', '']) {
    const result = run(forced ? [] : ['report', 'K7Q2-9F3D*'], forced || undefined);
    assert.equal(result.status, 2, forced);
    assert.equal(result.stdout, '', forced);
  }
});
