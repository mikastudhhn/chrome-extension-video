import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { checkHealth, checkCertificate, previousRun, evaluate, monitor, MONITOR_LIMITS } from '../scripts/monitor.js';

const now = Date.parse('2026-10-28T12:00:00Z');
const hours = value => new Date(now + value * 3_600_000);
const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const healthy = (incidents = {}) => async () => json({ ok: true, protocol: 3, incidents });
function tlsPeer({ authorized = true, validTo = hours(100), error } = {}) {
  return (options, ready) => {
    const socket = Object.assign(new EventEmitter(), { authorized, authorizationError: authorized ? null : 'CERT_HAS_EXPIRED', options,
      getPeerCertificate: () => ({ valid_to: validTo.toUTCString(), issuer: { CN: 'YE1' } }), end() {}, destroy() {} });
    queueMicrotask(() => (error ? socket.emit('error', error) : ready()));
    return socket;
  };
}

test('health: answers, wrong services and network failures are told apart', async () => {
  assert.deepEqual(await checkHealth('https://relay.example', { fetchImpl: healthy({ error: 1 }), clock: { now: () => 0 } }),
    { ok: true, ms: 0, protocol: 3, incidents: { error: 1 } });
  assert.match((await checkHealth('https://relay.example', { fetchImpl: async () => json({}, 502) })).problem, /Status 502/);
  assert.match((await checkHealth('https://relay.example', { fetchImpl: async () => json({ hello: 1 }) })).problem, /keine gültige Antwort/);
  const offline = async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); };
  assert.match((await checkHealth('https://relay.example', { fetchImpl: offline })).problem, /nicht erreichbar \(fetch failed: ECONNREFUSED\)/);
});

test('certificate: IP addresses send no SNI; untrusted and failing connections are problems', async () => {
  let options;
  const connect = (value, ready) => { options = value; return tlsPeer()(value, ready); };
  const result = await checkCertificate('https://159.195.131.172', { connect });
  assert.equal(result.ok, true);
  assert.equal(options.host, '159.195.131.172');
  assert.equal(options.servername, undefined);
  await checkCertificate('https://relay.example:8443', { connect });
  assert.deepEqual([options.servername, options.port], ['relay.example', 8443]);
  assert.match((await checkCertificate('https://relay.example', { connect: tlsPeer({ authorized: false }) })).problem, /CERT_HAS_EXPIRED/);
  assert.match((await checkCertificate('https://relay.example', { connect: tlsPeer({ error: new Error('ECONNRESET') }) })).problem, /fehlgeschlagen/);
});

test('evaluate: only incidents after the previous run and certificates below 36 hours fail the run', () => {
  const certificate = { ok: true, validTo: hours(MONITOR_LIMITS.certificateHours + 1), issuer: 'YE1' };
  const since = now - 15 * 60_000;
  const health = { ok: true, ms: 120, protocol: 3, incidents: { crash: since - 1, limits: since + 1 } };
  const result = evaluate({ health, certificate, since, now });
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0], /Bot oder Angriff/);
  assert.ok(result.notes.some(note => /Bereits gemeldet: .*nicht sauber beendet/.test(note)));
  assert.ok(result.notes.some(note => /noch 37 h, YE1/.test(note)));
  const expiring = evaluate({ health: { ...health, incidents: {} }, certificate: { ...certificate, validTo: hours(20) }, since, now });
  assert.match(expiring.problems[0], /Erneuerung hat nicht funktioniert/);
  assert.deepEqual(evaluate({ health: { ok: false, problem: 'down' }, certificate: { ok: false, problem: 'tls' }, since, now }).problems, ['down', 'tls']);
});

test('previous run: the start of the last completed run, or nothing when GitHub does not answer', async () => {
  let url, headers;
  const fetchImpl = async (target, options) => { url = target; headers = options.headers; return json({ workflow_runs: [{ run_started_at: '2026-10-28T11:45:00Z' }] }); };
  assert.equal(await previousRun({ repository: 'owner/repo', token: 't', fetchImpl }), Date.parse('2026-10-28T11:45:00Z'));
  assert.match(url, /\/repos\/owner\/repo\/actions\/workflows\/monitor\.yml\/runs\?status=completed&per_page=1$/);
  assert.equal(headers.Authorization, 'Bearer t');
  assert.equal(await previousRun({ repository: 'owner/repo', fetchImpl: async () => json({}, 403) }), null);
  assert.equal(await previousRun({}), null);
});

test('monitor: retries a failed check before reporting, without waiting after the last attempt', async () => {
  let calls = 0, waits = 0;
  const fetchImpl = async target => {
    if (target.includes('api.github.com')) return json({}, 500);
    calls++;
    if (calls < 3) throw new TypeError('fetch failed');
    return json({ ok: true, protocol: 3, incidents: {} });
  };
  const result = await monitor('https://relay.example', { fetchImpl, connect: tlsPeer(), now: () => now, wait: async () => { waits++; } });
  assert.deepEqual(result.problems, []);
  assert.equal(calls, 3);
  assert.equal(waits, 2);
  assert.equal(result.since, now - MONITOR_LIMITS.fallbackMs);
  const down = await monitor('https://relay.example', { fetchImpl: async () => { throw new TypeError('fetch failed'); }, connect: tlsPeer(), now: () => now, wait: async () => { waits++; } });
  assert.equal(down.problems.length, 1);
  assert.equal(waits, 4);
});

test('the monitor workflow reads no secrets and checks the configured server on a schedule', async () => {
  const workflow = await readFile('.github/workflows/monitor.yml', 'utf8');
  assert.match(workflow, /schedule:\n {4}- cron: '7,22,37,52 \* \* \* \*'/);
  assert.match(workflow, /run: node scripts\/monitor\.js "\$VIDEO_SYNC_SERVER"/);
  assert.match(workflow, /actions: read/);
  assert.doesNotMatch(workflow, /secrets\.|write/);
});
