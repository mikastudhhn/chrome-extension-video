import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDump, renderDays, renderErrors, p95, parseArguments, remoteCommand } from '../scripts/server-stats.js';
import { DELIVERY_BUCKETS } from '../server/operating-counters.js';

const day = (name, extra = {}) => ({ schema: 1, day: name, commit: 'abc1234', updatedAt: `${name}T23:59:00.000Z`, starts: 1, crashes: 0,
  peaks: { activeRooms: 2, joinedRooms: 1, activeMembers: 2, rssMB: 70 }, minDiskFreeMB: 58000,
  totals: { rooms: { created: 3, joined: 2, unusedInvitations: 1 }, durations: { under10m: 0, under1h: 1, under3h: 1, longer: 0 },
    closed: { leave: 2, idle: 1, expired: 0 }, responses: { success: 90, rejected: 4, failed: 1 }, limited: { flood: 2, relay: 0 },
    traffic: { api: 80, health: 10, page: 2, unknown: 7 }, delivery: { under50ms: 96, under250ms: 3, under1s: 1, under5s: 0, longer: 0 },
    apiLatency: { under10ms: 50 }, codes: { NOT_FOUND: 7 }, clients: { 'chrome-web-store/stable/0.6.0.9': 4 }, errorLog: { logged: 1, suppressed: 0 } }, ...extra });

test('the dump is split into usage days and error entries; broken lines are skipped', () => {
  const text = [JSON.stringify(day('2026-10-29')), JSON.stringify(day('2026-10-28')), '{broken', JSON.stringify({ schema: 2, day: 'x' }),
    '--- errors', JSON.stringify({ at: 'a', id: '1' }), ''].join('\n');
  const { days, errors } = parseDump(text);
  assert.deepEqual(days.map(entry => entry.day), ['2026-10-28', '2026-10-29']);
  assert.deepEqual(errors, [{ at: 'a', id: '1' }]);
  assert.deepEqual(parseDump(''), { days: [], errors: [] });
});

test('p95 names the bucket that holds the 95th percentile', () => {
  assert.equal(p95({ under50ms: 96, under250ms: 3, under1s: 1 }, DELIVERY_BUCKETS), '<50 ms');
  assert.equal(p95({ under50ms: 90, under250ms: 10 }, DELIVERY_BUCKETS), '<250 ms');
  assert.equal(p95({ longer: 1 }, DELIVERY_BUCKETS), '≥5 s');
  assert.equal(p95({}, DELIVERY_BUCKETS), '–');
});

test('days render as one table row each with summaries for versions, codes and limits', () => {
  const lines = renderDays([day('2026-10-28'), day('2026-10-29', { crashes: 1 })]);
  assert.match(lines[0], /^Tag\s+Räume/);
  assert.match(lines[1], /^2026-10-28\s+3\s+2\s+1\s+1\s+0\/1\/1\/0\s+2\/1\/0\s+<50 ms\s+<10 ms\s+1\s+2\s+7\s+1\/0$/);
  assert.match(lines[2], /1\/1$/);
  assert.ok(lines.includes('Extension-Versionen (Plätze): chrome-web-store/stable/0.6.0.9 8'));
  assert.ok(lines.includes('Fehlercodes der Antworten: NOT_FOUND 14'));
  assert.ok(lines.includes('Abgewiesen nach Limit: flood 4'));
  assert.match(lines.at(-1), /Commit abc1234, Arbeitsspeicher max\. 70 MB, freier Speicher min\. 58000 MB/);
  assert.deepEqual(renderDays([]), ['Noch keine Nutzungsdaten.']);
});

test('error entries show their context for reproduction', () => {
  const lines = renderErrors([{ at: '2026-10-28T10:00:00.000Z', id: 'deadbeef', kind: 'exception', method: 'POST', route: 'relay', status: 500,
    error: { name: 'TypeError', message: 'x is undefined', stack: ['at relayData (server/rooms.js:1:2)'] },
    member: { role: 'host', sequence: 3 }, request: { shape: { sequence: 3 } }, server: { commit: 'abc1234' } }]);
  assert.equal(lines[0], '2026-10-28T10:00:00.000Z  deadbeef  exception  POST relay 500');
  assert.ok(lines.includes('    TypeError: x is undefined'));
  assert.ok(lines.includes('      at relayData (server/rooms.js:1:2)'));
  assert.ok(lines.includes('    Mitglied: {"role":"host","sequence":3}'));
  assert.deepEqual(renderErrors([]), ['Keine Fehlereinträge.']);
});

test('arguments and the remote command are fixed and bounded', () => {
  assert.deepEqual(parseArguments(['--days', '30', '--errors', '5', '--json']), { days: 30, errors: 5, json: true });
  assert.throws(() => parseArguments(['--days', 'x']), /Zahl/);
  assert.throws(() => parseArguments(['--host', 'x']), /Unbekannte Option/);
  const command = remoteCommand(7);
  assert.match(command, /^cd \/opt\/video-sync && docker compose --env-file deploy\/.env -f deploy\/compose.yaml exec -T app sh -c '/);
  assert.match(command, /tail -n 7/);
});
