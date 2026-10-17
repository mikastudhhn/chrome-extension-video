import test from 'node:test';
import assert from 'node:assert/strict';
import { updatePresentation } from '../extension/updates-view.js';

test('only a completed matching release check can claim that everything is current', () => {
  const saved = { configured: true, checkedAt: 123, available: false };
  assert.equal(updatePresentation(saved).heading, 'Bereit für Updates');
  assert.equal(updatePresentation(saved).accessLabel, 'Gespeichert · ungeprüft');
  assert.equal(updatePresentation({ ...saved, releaseState: 'no-release' }).heading, 'Kein passendes Release');
  assert.equal(updatePresentation({ ...saved, releaseState: 'current' }).heading, 'Alles aktuell');
  assert.equal(updatePresentation({ ...saved, available: true }).heading, 'Update verfügbar');
  assert.equal(updatePresentation({ ...saved, available: true, error: 'Prüfung unterbrochen.' }).heading, 'Prüfung fehlgeschlagen');
});

test('access labels and setup actions remain truthful for every access state', () => {
  for (const [status, label, needsAccess] of [
    ['unverified', 'Gespeichert · ungeprüft', false], ['verified', 'Zugang geprüft', false],
    ['invalid-token', 'Ungültig / abgelaufen', true], ['forbidden', 'Berechtigung fehlt', true],
    ['rate-limited', 'Anfragelimit erreicht', false], ['unavailable', 'Derzeit nicht prüfbar', false]
  ]) {
    const view = updatePresentation({ configured: true, access: { status } });
    assert.equal(view.accessLabel, label); assert.equal(view.needsAccess, needsAccess);
  }
  // Without a token, updates are configured; the token is optional.
  for (const [status, label, needsAccess] of [['public', 'Optional', false], ['verified', 'Optional', false],
    ['not-found', 'Releases nicht erreichbar', true], ['rate-limited', 'Anfragelimit erreicht', false], ['unavailable', 'Derzeit nicht prüfbar', false]]) {
    const view = updatePresentation({ configured: true, hasToken: false, releaseState: 'current', access: { status } });
    assert.equal(view.accessLabel, label); assert.equal(view.needsAccess, needsAccess);
    assert.notEqual(view.heading, 'Updates einrichten');
    assert.doesNotMatch(view.status, /einrichten/);
  }
  assert.equal(updatePresentation({ configured: true, hasToken: false, releaseState: 'current', access: { status: 'verified' } }).heading, 'Alles aktuell');
  assert.equal(updatePresentation({ configured: true, hasToken: true, access: { status: 'verified' } }).accessLabel, 'Zugang geprüft');
  assert.equal(updatePresentation({ configured: false }).needsAccess, true);
  assert.equal(updatePresentation({ configured: false }).accessLabel, '');
  assert.equal(updatePresentation({ configured: false, access: { status: 'missing' } }).accessLabel, '');
});
