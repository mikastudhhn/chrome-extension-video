import assert from 'node:assert/strict';
import test from 'node:test';
import { ServerSetting } from '../extension/server-setting.js';
import { formatTime, roomGuidance, participantLabels } from '../extension/popup-view.js';

const original = 'http://localhost:8787';
test('server drafts are separate from the persisted origin; save survives a fresh popup', async () => {
  let stored = original;
  const setting = new ServerSetting(stored, async server => { stored = server; });
  setting.edit(' https://SYNC.example.test:443/ ');
  assert.equal(setting.saved, original);
  assert.equal(stored, original);
  assert.equal(await setting.save(), true);
  assert.equal(stored, 'https://sync.example.test');
  assert.equal(new ServerSetting(stored).saved, 'https://sync.example.test');
  assert.equal(setting.dirty, false);
});
test('invalid addresses and cancel never overwrite the last saved server', async () => {
  let writes = 0;
  const setting = new ServerSetting(original, async () => { writes++; });
  for (const address of ['', 'not a URL', 'http://remote.example.test', 'https://user:secret@example.test', 'https://example.test/path', 'https://example.test/?token=secret', 'javascript:alert(1)']) {
    setting.edit(address);
    assert.equal(await setting.save(), false);
    assert.ok(setting.error);
    assert.equal(setting.saved, original);
  }
  setting.cancel();
  assert.equal(setting.draft, original);
  assert.equal(setting.error, '');
  assert.equal(writes, 0);
});
test('a failed write keeps the draft for retry and never claims success', async () => {
  let fail = true;
  const setting = new ServerSetting(original, async () => { if (fail) throw new Error('quota'); });
  setting.edit('https://sync.example.test');
  assert.equal(await setting.save(), false);
  assert.equal(setting.saved, original);
  assert.equal(setting.draft, 'https://sync.example.test');
  assert.equal(setting.message, '');
  fail = false;
  assert.equal(await setting.save(), true);
  assert.equal(setting.error, '');
});
test('pending save excludes a second write, including an invitation override', async () => {
  let complete;
  let writes = 0;
  const setting = new ServerSetting(original, () => { writes++; return new Promise(resolve => { complete = resolve; }); });
  setting.edit('https://sync.example.test');
  const saving = setting.save();
  assert.equal(setting.saving, true);
  assert.equal(await setting.save('https://invitation.example.test'), false);
  assert.equal(setting.saved, original);
  complete();
  await saving;
  assert.equal(setting.saving, false);
  assert.equal(writes, 1);
});
test('an accepted invitation replaces both the stored origin and an unsaved draft', async () => {
  const setting = new ServerSetting(original, async () => {});
  setting.edit('invalid draft');
  await setting.save('https://invitation.example.test/');
  assert.equal(setting.saved, 'https://invitation.example.test');
  assert.equal(setting.draft, setting.saved);
});
test('time is readable across hour boundaries and unknown media durations', () => {
  for (const [input, expected] of [[0, '0:00'], [59.9, '0:59'], [60, '1:00'], [3599, '59:59'], [3600, '1:00:00'], [3661, '1:01:01'], [360000, '100:00:00'], [-12, '0:00'], [NaN, '—'], [Infinity, '—'], [undefined, '—']]) assert.equal(formatTime(input), expected);
});
test('playback guidance retains recovery, readiness, autoplay and buffering distinctions', () => {
  const local = {};
  const room = { role: 'host', connected: true, state: { phase: 'synced', members: { guest: {} }, playing: true } };
  assert.equal(roomGuidance(local, room)[0], 'playing');
  assert.equal(roomGuidance(local, room, 'pause')[0], 'paused');
  assert.equal(roomGuidance(local, { ...room, reconnecting: true })[0], 'reconnecting');
  assert.equal(roomGuidance(null, room)[0], 'missing');
  assert.equal(roomGuidance({ blocked: true }, room)[0], 'blocked');
  assert.equal(roomGuidance(local, { ...room, connected: false })[0], 'inviting');
  assert.equal(roomGuidance(local, { ...room, state: { phase: 'aligning', members: { host: { ready: true } } } })[0], 'ready');
  assert.equal(roomGuidance(local, { ...room, state: { ...room.state, waiting: true } })[0], 'buffering');
});

test('participant context remains truthful during invitation, playback and interruption', () => {
  const room = { role: 'guest', connected: true, state: { phase: 'synced', members: { host: {} } } };
  assert.deepEqual(participantLabels({}, room), { self: 'Du · Verbunden', peer: 'Zweite Person · Verbunden' });
  assert.match(participantLabels(null, room).self, /Video fehlt/);
  assert.match(participantLabels({}, { ...room, connected: false }).peer, /Noch nicht da/);
  assert.match(participantLabels({}, { ...room, connected: false, reconnecting: true }).peer, /Unterbrochen/);
  assert.match(participantLabels({}, { ...room, state: { ...room.state, members: { host: { blocked: true } } } }).peer, /Play nötig/);
  assert.match(participantLabels({}, { ...room, state: { ...room.state, waiting: true } }).peer, /Lädt nach/);
  assert.equal(participantLabels({ buffering: true }, { ...room, state: { ...room.state, waiting: true } }).peer, 'Zweite Person · Verbunden');
});

test('semantic colour roles keep sufficient measured contrast in light and dark themes', async () => {
  const { readFile } = await import('node:fs/promises');
  const css = await readFile(new URL('../extension/tokens.css', import.meta.url), 'utf8');
  const block = selector => css.slice(css.indexOf(selector), css.indexOf('}', css.indexOf(selector)));
  const declarations = text => Object.fromEntries([...text.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()]));
  const primitives = declarations(block(':root {'));
  const resolve = (tokens, name) => {
    const value = tokens[name] ?? primitives[name];
    assert.ok(value, `token ${name} is defined`);
    const reference = value.match(/^var\(--([a-z0-9-]+)\)$/);
    return reference ? resolve(tokens, reference[1]) : value;
  };
  const luminance = hex => {
    assert.match(hex, /^#[a-f\d]{6}$/, `${hex} is a hex colour`);
    const channels = hex.slice(1).match(/../g).map(value => parseInt(value, 16) / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
    return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
  };
  const pairs = [['color-text', 'color-bg', 4.5], ['color-text', 'color-surface', 4.5], ['color-text-muted', 'color-bg', 4.5], ['color-text-muted', 'color-surface', 4.5],
    ['color-text-muted', 'color-surface-muted', 4.5], ['color-text', 'color-accent-soft', 4.5], ['color-accent', 'color-accent-soft', 4.5], ['color-accent', 'color-bg', 4.5],
    ['color-on-accent', 'color-accent', 4.5], ['color-on-danger', 'color-danger', 4.5], ['color-warning', 'color-warning-surface', 4.5],
    ['color-border-strong', 'color-field', 3], ['color-border-strong', 'color-bg', 3], ['color-focus', 'color-bg', 3], ['color-text-disabled', 'color-bg', 3]];
  for (const [theme, selector] of [['light', ':root {'], ['dark', ':root[data-theme="dark"] {']]) {
    const tokens = { ...primitives, ...declarations(block(selector)) };
    for (const [front, back, minimum] of pairs) {
      const pair = [luminance(resolve(tokens, front)), luminance(resolve(tokens, back))].sort((a, b) => a - b);
      const ratio = (pair[1] + .05) / (pair[0] + .05);
      assert.ok(ratio >= minimum, `${theme} ${front}/${back}: ${ratio.toFixed(2)} < ${minimum}`);
    }
  }
});

test('a link styled as an icon button shares the full button contract, including hover', async () => {
  const { readFile } = await import('node:fs/promises');
  const css = await readFile(new URL('../extension/components.css', import.meta.url), 'utf8');
  assert.match(css, /^button, a:where\(\.icon-button\) \{/m, 'anchor icon buttons get the button box, alignment and transition');
  assert.doesNotMatch(css, /\.icon-button[^{\n]*:enabled/, ':enabled never matches an anchor, so icon-button hover must use :not(:disabled)');
  assert.match(css, /\.icon-button\.round:hover:not\(:disabled\)/);
  const html = await readFile(new URL('../extension/popup.html', import.meta.url), 'utf8');
  assert.match(html, /<a id="update-banner-notes" class="icon-button round"/);
  assert.match(html, /<button id="update-banner-install" class="icon-button round ring"/);
});
