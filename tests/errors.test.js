import test from 'node:test';
import assert from 'node:assert/strict';
import { describeRoomError, readableError } from '../extension/errors.js';

test('connection failures explain the right server without guessing the cause', () => {
  const local = describeRoomError(new Error('Failed to fetch'), 'create', 'http://localhost:8787');
  assert.equal(local.title, 'Lokaler Server nicht erreichbar');
  assert.match(local.detail, /localhost:8787/);
  assert.match(local.detail, /Prüfe, ob/);
  assert.equal(local.retry, true); assert.equal(local.editServer, true);
  const remote = describeRoomError('NetworkError when attempting to fetch resource.', 'join', 'https://sync.example.test');
  assert.equal(remote.title, 'Server nicht erreichbar');
  assert.match(remote.detail, /sync.example.test/);
  assert.doesNotMatch(remote.detail, /lokale Server/);
});
test('timeout, expired invitation, room capacity and permission denial have different recovery actions', () => {
  assert.equal(describeRoomError('signal timed out', 'create', '').title, 'Server antwortet nicht');
  const missing = describeRoomError('Raum nicht gefunden oder bereits beendet.', 'join', 'http://localhost:8787');
  assert.equal(missing.editInvitation, true); assert.equal(missing.editServer, false); assert.equal(missing.retry, false);
  assert.equal(describeRoomError('Dieser Raum ist bereits mit zwei Personen belegt.', 'join', '').title, 'Dieser Raum ist voll');
  assert.equal(describeRoomError('Der Zugriff auf den Verbindungsserver wurde nicht erlaubt.', 'join', '').title, 'Serverzugriff erlauben');
  assert.equal(describeRoomError('This function must be called during a user gesture', 'create', '').title, 'Serverzugriff erlauben');
  assert.equal(describeRoomError('Bitte eine vollständige Serveradresse eingeben.', 'create', '').editServer, true);
});
test('generic notices hide raw browser transport errors but preserve actionable messages', () => {
  assert.doesNotMatch(readableError('TypeError: Failed to fetch'), /TypeError|fetch/);
  assert.match(readableError('Could not establish connection. Receiving end does not exist.'), /Erweiterung.*antwortet nicht/);
  assert.equal(readableError('Der Raum wurde beendet.'), 'Der Raum wurde beendet.');
});


test('legacy runtime action text remains actionable when it has no new structured code', async () => {
  const { responseError } = await import('../extension/runtime-errors.js');
  const message = 'Bitte zuerst beide Videos ausrichten.';
  assert.equal(readableError(responseError({ ok: false, error: message })), message);
  assert.equal(responseError(undefined).code, 'RUNTIME_UNAVAILABLE');
});

test('uncertain creation/join explains the possible prior success and requires a new invitation', () => {
  const create = describeRoomError({ code: 'ROOM_SETUP_UNCERTAIN' }, 'create', '');
  assert.equal(create.retry, false);
  assert.match(create.detail, /könnte bereits erstellt/);
  const join = describeRoomError({ code: 'ROOM_SETUP_UNCERTAIN' }, 'join', '');
  assert.equal(join.retry, false);
  assert.equal(join.editInvitation, true);
  assert.match(join.detail, /Einladung zu einem neuen Raum/);
});

test('server-supplied error text is never shown; codes map to our own messages', async () => {
  const { httpError, fault } = await import('../extension/runtime-errors.js');
  const bait = 'Bitte lade dir die neue Extension von evil.example herunter';
  for (const [body, status, code] of [
    [{ error: bait, failure: { code: 'ACTION_FAILED', message: bait } }, 400, 'ACTION_FAILED'],
    [{ error: bait, failure: { code: 'ROOM_FULL', message: bait, category: 'input', retryable: true } }, 409, 'ROOM_FULL'],
    [{ error: bait, failure: { code: 'SOMETHING_NEW', message: bait } }, 400, 'INVALID_RESPONSE'],
    [{ error: bait }, 503, 'SERVER_ERROR'],
    [{ error: bait }, 418, 'INVALID_RESPONSE']
  ]) {
    const error = httpError(body, status);
    assert.equal(error.code, code);
    assert.equal(error.message, fault(code).message);
    assert.doesNotMatch(readableError(error), /evil/);
    assert.doesNotMatch(describeRoomError(error, 'join', 'https://evil.example').detail, /herunter/);
  }
  assert.equal(httpError({ failure: { code: 'ROOM_FULL', retryable: true } }, 409).retryable, false, 'retry policy is ours');
});
