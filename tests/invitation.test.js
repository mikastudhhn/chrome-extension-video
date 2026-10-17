import test from 'node:test';
import assert from 'node:assert/strict';
import { createInvitation, parseInvitation, serverOrigin } from '../extension/invitation.js';

test('a copied invitation includes the actual room server and survives multiline pasting', () => {
  const invitation = createInvitation('ABC234', 'https://sync.example.test/');
  assert.deepEqual(parseInvitation(invitation.replaceAll('\n', '\r\n'), 'http://localhost:8787'), {
    code: 'ABC234', server: 'https://sync.example.test'
  });
});

test('plain room codes are case-insensitive and accept formatting whitespace without changing the configured server', () => {
  assert.deepEqual(parseInvitation(' abc 234 ', 'http://127.0.0.1:56789'), {
    code: 'ABC234', server: 'http://127.0.0.1:56789'
  });
});

test('invalid, ambiguous or incomplete invitations do not silently select a room or server', () => {
  for (const value of ['short', 'aBcd_ef-1234', 'Video Sync\nRaumcode: ABC234', 'Raumcode: aBcd_ef-1234\nServer: https://one.test',
    'Raumcode: ABC234\nServer: https://one.test\nServer: https://two.test']) {
    assert.throws(() => parseInvitation(value, 'http://localhost:8787'));
  }
  for (const value of ['http://public.example.test', 'https://user:secret@example.test', 'https://example.test/path',
    'https://example.test/?x=1', 'javascript:alert(1)', 'not a server']) assert.throws(() => serverOrigin(value));
});
