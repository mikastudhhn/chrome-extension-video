import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Diagnostics, DIAGNOSTIC_LIMITS, serializeDiagnosticReport } from '../extension/diagnostics.js';
import { mountDiagnostics, downloadDiagnosticReport, DIAGNOSTIC_FILENAME } from '../extension/diagnostics-view.js';

class Control extends EventTarget {
  constructor() { super(); this.attributes = {}; this.textContent = ''; this.disabled = false; }
  setAttribute(name, value) { this.attributes[name] = value; }
  click() { if (!this.disabled) this.dispatchEvent(new Event('click')); }
}
function panel(options) {
  const controls = Object.fromEntries(['diagnostics-export', 'diagnostics-clear', 'diagnostics-feedback', 'diagnostics-availability'].map(id => [id, new Control()]));
  const root = new Control();
  root.querySelector = selector => controls[selector.slice(1)];
  return { controls, root, view: mountDiagnostics(root, options) };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('visible export and delete actions use the real bounded buffer and respect retention', async () => {
  let now = 0;
  const buffer = new Diagnostics({ now: () => now });
  const downloads = [], actions = [];
  const { controls, view } = panel({ request: async action => {
    actions.push(action);
    if (action === 'diagnostics-clear') { buffer.clear(); return { cleared: true }; }
    return buffer.export({ appVersion: '0.5.0', engineVersion: '0.5.0', protocol: 2 });
  }, download: content => downloads.push(JSON.parse(content)) });
  view.update({ diagnosticsAvailable: true, channel: 'experimental' });
  buffer.record('phase', { phase: 'synced', token: 'SECRET', mediaId: 'SECRET' });
  controls['diagnostics-export'].click(); await settle();
  assert.equal(downloads[0].events.length, 1);
  assert.equal(JSON.stringify(downloads).includes('SECRET'), false);
  assert.match(controls['diagnostics-feedback'].textContent, /Download gestartet/);
  assert.equal(buffer.export().events.length, 1, 'export does not delete');
  controls['diagnostics-clear'].click(); await settle();
  assert.match(controls['diagnostics-feedback'].textContent, /Diagnose gelöscht/);
  assert.deepEqual(buffer.export().events, []);
  controls['diagnostics-export'].click(); await settle();
  assert.deepEqual(downloads[1].events, []);
  buffer.record('phase', { phase: 'ended' });
  now = DIAGNOSTIC_LIMITS.retentionMs;
  controls['diagnostics-export'].click(); await settle();
  assert.deepEqual(downloads[2].events, [], 'expired records never enter a visible export');
  assert.deepEqual(actions, ['diagnostics-export', 'diagnostics-clear', 'diagnostics-export', 'diagnostics-export']);
  buffer.clear();
});

test('legacy/blocked controls cannot dispatch; repeated clicks and late channel results are guarded', async () => {
  let resolve, calls = 0, downloads = 0;
  const { controls, view } = panel({ request: () => { calls++; return new Promise(done => { resolve = done; }); }, download: () => downloads++ });
  controls['diagnostics-export'].click(); assert.equal(calls, 0);
  assert.equal(controls['diagnostics-availability'].hidden, false);
  view.update({ diagnosticsAvailable: true, channel: 'experimental' }, true);
  controls['diagnostics-clear'].click(); assert.equal(calls, 0);
  view.update({ diagnosticsAvailable: true, channel: 'experimental' });
  controls['diagnostics-export'].click();
  controls['diagnostics-clear'].click(); controls['diagnostics-export'].click();
  assert.equal(calls, 1);
  assert.equal(controls['diagnostics-export'].disabled, false, 'busy action keeps native focus');
  assert.equal(controls['diagnostics-export'].attributes['aria-disabled'], 'true');
  view.update({ channel: 'stable' });
  resolve({ schema: 1, events: [] }); await settle();
  assert.equal(downloads, 0);
  assert.equal(controls['diagnostics-feedback'].textContent, '');
});

test('export/delete failure feedback is local and never displays raw exception text or false success', async () => {
  const { controls, view } = panel({ request: async action => {
    if (action === 'diagnostics-clear') return { cleared: false };
    throw new Error('https://SECRET.invalid/TITLE');
  } });
  view.update({ diagnosticsAvailable: true, channel: 'experimental' });
  controls['diagnostics-export'].click(); await settle();
  assert.equal(controls['diagnostics-feedback'].textContent, 'Export nicht möglich. Bitte erneut versuchen.');
  controls['diagnostics-clear'].click(); await settle();
  assert.equal(controls['diagnostics-feedback'].textContent, 'Löschen nicht bestätigt. Bitte erneut versuchen.');
});

test('file serializer reselects fields and enforces bounds rather than exporting raw UI data', () => {
  const content = serializeDiagnosticReport({ schema: 1, storage: 'session-memory', retentionMs: 999,
    appVersion: 'https://SECRET.invalid', engineVersion: '0.5.0', protocol: 2,
    token: 'SECRET', lifecycle: { instanceId: 'SECRET' }, events: Array.from({ length: 1000 }, () => ({
      at: 0, kind: 'phase', phase: 'synced', title: 'SECRET', mediaId: 'SECRET', message: 'SECRET'
    })) });
  assert.equal(content.includes('SECRET'), false);
  const report = JSON.parse(content);
  assert.equal(report.events.length, 200);
  assert.equal(report.retentionMs, DIAGNOSTIC_LIMITS.retentionMs);
  assert.deepEqual(Object.keys(report.events[0]), ['at', 'kind', 'phase']);
  assert.throws(() => serializeDiagnosticReport({ schema: 2, events: [] }));
});

test('download creates a local JSON file with a fixed name and revokes its object URL', async () => {
  let blob, link, removed = false, clicked = false, cleanup, revoked;
  const document = { body: { append(value) { link = value; } }, createElement(tag) {
    assert.equal(tag, 'a');
    return { click() { clicked = true; }, remove() { removed = true; } };
  } };
  downloadDiagnosticReport('{"schema":1}', document, {
    createObjectURL(value) { blob = value; return 'blob:local-only'; }, revokeObjectURL(url) { revoked = url; }
  }, fn => { cleanup = fn; });
  assert.equal(link.download, DIAGNOSTIC_FILENAME);
  assert.equal(link.href, 'blob:local-only');
  assert.equal(blob.type, 'application/json;charset=utf-8');
  assert.equal(await blob.text(), '{"schema":1}');
  assert.ok(clicked && removed); cleanup(); assert.equal(revoked, 'blob:local-only');
});

test('popup exposes native keyboard controls and persistent accessible retention/status text', async () => {
  const html = await readFile(new URL('../extension/popup.html', import.meta.url), 'utf8');
  assert.match(html, /<summary id="diagnostics-summary">Synchronisationsdiagnose<\/summary>/);
  for (const action of ['export', 'clear']) assert.match(html, new RegExp(`<button id="diagnostics-${action}" type="button"[^>]*aria-describedby="diagnostics-retention`));
  assert.match(html, /id="diagnostics-retention">[^<]*30 Minuten und 200 Ereignisse/);
  assert.match(html, /id="diagnostics-feedback" role="status" aria-live="polite" aria-atomic="true"/);
});
