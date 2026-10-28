import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Diagnostics } from '../extension/diagnostics.js';
import { buildErrorReport, sanitizeErrorReport, sendErrorReport, clientInfo, browserInfo, sessionInfo, REPORT_ID, REPORT_LIMITS } from '../extension/error-report.js';
import { Signaling } from '../extension/signaling.js';
import { RoomRequests } from '../server/room-requests.js';
import { createServer } from '../server/index.js';
import { reportId, REPORT_STORE_LIMITS } from '../server/reports.js';
import { PROTOCOL, CAPABILITIES } from '../extension/protocol.js';

const uuid = '0f8fad5b-d9cb-469f-a165-70867728950e';
const status = { tabId: 7, documentId: 'DOC', playerId: uuid, bindingId: uuid,
  local: { adapter: 'HTML5', mediaId: uuid, time: 12, paused: false, buffering: true, blocked: false, title: 'Geheimer Film' },
  room: { code: 'ABC234', server: 'https://relay.example', role: 'guest', connected: true, reconnecting: false, rtt: 48.6,
    state: { phase: 'synced', position: 3 } },
  notice: 'Raum nicht gefunden https://secret.invalid', noticeError: { code: 'ROOM_NOT_FOUND', message: 'x' },
  lifecycle: { instanceId: uuid, generation: 1, revision: 3, phase: 'synced', playerBound: true } };
function diagnostics() {
  const buffer = new Diagnostics({ now: () => 1_793_000_000_000 });
  buffer.record('phase', { phase: 'synced', token: 'SECRET' });
  buffer.record('failure', { code: 'NETWORK_ERROR', message: 'SECRET' });
  return buffer.export({ appVersion: '0.6.0.9', engineVersion: '0.6.0.9', protocol: PROTOCOL });
}
const report = () => buildErrorReport({ diagnostics: diagnostics(), status, client: { version: '0.6.0.9', distribution: 'chrome-web-store', channel: 'stable' },
  browser: { chrome: 141, platform: 'mac' }, note: 'Nach dem Spulen\u0007 lief es weiter.\n' });

test('a report holds only enumerated session states, filtered events, versions and the note', () => {
  const value = report();
  assert.deepEqual(value.session, { phase: 'synced', playerBound: true, inRoom: true, role: 'guest', connected: true, reconnecting: false,
    syncPhase: 'synced', rttMs: 49, adapter: 'html5', paused: false, buffering: true, blocked: false, notice: 'ROOM_NOT_FOUND' });
  assert.deepEqual(value.diagnostics.events.map(event => event.kind), ['phase', 'failure']);
  assert.equal(value.note, 'Nach dem Spulen lief es weiter.');
  assert.deepEqual(value.client, { version: '0.6.0.9', distribution: 'chrome-web-store', channel: 'stable' });
  const text = JSON.stringify(value);
  for (const secret of ['SECRET', 'ABC234', 'relay.example', 'Geheimer', uuid, 'DOC', 'secret.invalid']) assert.equal(text.includes(secret), false, secret);
  assert.deepEqual(sessionInfo(null), { inRoom: false });
});

test('sanitizing again drops unknown fields and bounds the note; other schemas are rejected', () => {
  const value = sanitizeErrorReport({ ...report(), extra: 'x', session: { ...report().session, url: 'https://x', phase: 'weird' },
    client: { version: '<script>', distribution: 'Robert', channel: 'stable' }, browser: { chrome: 1e6, platform: 'amiga' }, note: 'n'.repeat(900) });
  assert.equal(Object.hasOwn(value, 'extra'), false);
  assert.equal(Object.hasOwn(value.session, 'url'), false);
  assert.equal(Object.hasOwn(value.session, 'phase'), false);
  assert.deepEqual(value.client, { channel: 'stable' });
  assert.deepEqual(value.browser, {});
  assert.equal(value.note.length, REPORT_LIMITS.noteChars);
  assert.throws(() => sanitizeErrorReport({ schema: 2 }), { code: 'INVALID_MESSAGE' });
  assert.throws(() => sanitizeErrorReport({ schema: 1, diagnostics: { schema: 1, events: 'x' } }), { code: 'INVALID_MESSAGE' });
  assert.equal(Object.hasOwn(sanitizeErrorReport({ ...report(), note: '   ' }), 'note'), false);
});

test('build and browser labels name only distribution, channel, version, Chrome major and platform', () => {
  assert.deepEqual(clientInfo({ version: '0.6.0.9' }, { channel: 'stable' }, true), { version: '0.6.0.9', distribution: 'chrome-web-store', channel: 'stable' });
  assert.deepEqual(clientInfo({ version: '0.6.0' }, { channel: 'local', local: { branch: 'ft/secret' } }, false), { version: '0.6.0', distribution: 'development', channel: 'local' });
  assert.deepEqual(clientInfo({ version: '0.6.0' }, { channel: 'experimental', source: true }, false).distribution, 'source');
  assert.deepEqual(clientInfo({ version: '0.6.0.12' }, { channel: 'experimental' }, false).distribution, 'github');
  assert.deepEqual(browserInfo({ userAgentData: { brands: [{ brand: 'Not.A/Brand', version: '99' }, { brand: 'Google Chrome', version: '141' }], platform: 'macOS' } }),
    { chrome: 141, platform: 'mac' });
  assert.deepEqual(browserInfo({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0.0.0 Safari/537.36', platform: 'Linux x86_64' }), { chrome: 140, platform: 'linux' });
  assert.deepEqual(browserInfo({ userAgentData: { brands: [], platform: 'Windows' } }), { platform: 'windows' });
});

test('sending posts the report and accepts only a well-formed report ID', async () => {
  let call;
  const ok = async (url, options) => { call = { url, options }; return { ok: true, status: 201, json: async () => ({ ok: true, id: 'K7Q2-9F3D' }) }; };
  assert.deepEqual(await sendErrorReport('https://relay.example', report(), ok), { id: 'K7Q2-9F3D' });
  assert.equal(call.url, 'https://relay.example/reports');
  assert.equal(call.options.method, 'POST');
  assert.equal(call.options.credentials, 'omit');
  assert.equal(JSON.parse(call.options.body).schema, 1);
  await assert.rejects(sendErrorReport('https://relay.example', report(), async () => ({ ok: true, json: async () => ({ ok: true, id: '<b>' }) })), { code: 'INVALID_RESPONSE' });
  await assert.rejects(sendErrorReport('https://relay.example', report(), async () => ({ ok: false, status: 429, json: async () => ({ failure: { code: 'RATE_LIMITED' } }) })), { code: 'RATE_LIMITED' });
  await assert.rejects(sendErrorReport('https://relay.example', report(), async () => ({ ok: false, status: 404, json: async () => ({ failure: { code: 'NOT_FOUND' } }) })), { code: 'NOT_FOUND' });
  await assert.rejects(sendErrorReport('https://relay.example', report(), async () => { throw new TypeError('Failed to fetch'); }), { code: 'NETWORK_ERROR' });
});

test('relay: a sent report is sanitized, stored once under its ID, counted and reported as an incident', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'video-sync-reports-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const server = createServer({ dataDirectory: directory, commit: 'abc1234', statfs: async () => ({ bavail: 1e6, bsize: 4096 }) });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const { id } = await sendErrorReport(base, { ...report(), smuggled: 'SECRET' });
  assert.match(id, REPORT_ID);
  await server.reports.flush();
  const [file] = await readdir(join(directory, 'reports'));
  assert.match(file, new RegExp(`^\\d{4}-\\d{2}-\\d{2}-${id}\\.json$`));
  const stored = JSON.parse(await readFile(join(directory, 'reports', file), 'utf8'));
  assert.equal(stored.id, id);
  assert.equal(stored.note, 'Nach dem Spulen lief es weiter.');
  assert.equal(stored.server.commit, 'abc1234');
  assert.equal(JSON.stringify(stored).includes('SECRET'), false);
  assert.equal(server.operatingSnapshot().reports, 1);
  assert.ok((await (await fetch(`${base}/health`)).json()).incidents.report);
  const invalid = await fetch(`${base}/reports`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ schema: 9, note: 'private' }) });
  assert.equal(invalid.status, 400);
  assert.equal(server.errors.recent.at(-1).route, 'report');
  assert.equal(JSON.stringify(server.errors.recent.at(-1)).includes('private'), false);
  const large = await fetch(`${base}/reports`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ schema: 1, note: 'x'.repeat(REPORT_LIMITS.bodyBytes) }) });
  assert.equal(large.status, 413);
});

test('relay: reports are limited per address and per day', async t => {
  const server = createServer({ env: { TRUST_PROXY: '1' } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = address => fetch(`${base}/reports`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Real-IP': address }, body: JSON.stringify(report()) });
  const statuses = [];
  for (let index = 0; index < 6; index++) statuses.push((await send('192.0.2.1')).status);
  assert.deepEqual(statuses, [201, 201, 201, 201, 201, 429]);
  assert.equal(server.operatingSnapshot().limited.reports, 1);
  server.reports.count = REPORT_STORE_LIMITS.perDay;
  assert.equal((await send('192.0.2.2')).status, 429, 'the daily budget covers all addresses');
});

test('report IDs use the unambiguous invitation alphabet', () => {
  assert.equal(reportId(Buffer.from([0, 1, 2, 3, 4, 5, 6, 31])), 'ABCD-EFG9');
  for (let index = 0; index < 50; index++) assert.match(reportId(), REPORT_ID);
});

test('create and join handshakes name the build when the worker knows it', async () => {
  const sent = [];
  const member = { protocol: PROTOCOL, code: 'ABC234', token: 'a'.repeat(43), role: 'host', capabilities: [...CAPABILITIES], peerCapabilities: [] };
  const connection = new Signaling('http://localhost', () => {}, () => {}, () => {}, { version: '0.6.0.9', distribution: 'github', channel: 'stable' });
  connection.request = async (path, method, data) => { if (path === '/health') return { roomRequests: new RoomRequests().offer() }; sent.push(data); return member; };
  await connection.open();
  assert.deepEqual(sent[0].client, { version: '0.6.0.9', distribution: 'github', channel: 'stable' });
  const anonymous = new Signaling('http://localhost', () => {}, () => {});
  anonymous.request = connection.request;
  await anonymous.open();
  assert.equal(Object.hasOwn(sent[1], 'client'), false);
});
