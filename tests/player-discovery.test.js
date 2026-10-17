import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { callPlayer } from '../extension/player-frames.js';

const code = readFileSync(new URL('../extension/player.js', import.meta.url), 'utf8');
function video(overrides = {}) {
  return Object.assign(new EventTarget(), {
    duration: 120, currentTime: 5, currentSrc: 'blob:unchanged', readyState: 4, seeking: false,
    paused: true, isConnected: true, playbackRate: 1, style: {},
    getAttribute: () => null, getBoundingClientRect: () => ({ width: 300, height: 200 }),
    play() { this.paused = false; this.dispatchEvent(new Event('play')); return Promise.resolve(); },
    pause() { this.paused = true; this.dispatchEvent(new Event('pause')); }
  }, overrides);
}
function setup(videos, options = {}) {
  const window = { __videoSyncOwner: 'installation-a', ...options.window };
  const location = { hostname: 'video.test', origin: 'https://video.test', pathname: '/movie', ...options.location };
  const document = { title: 'Movie', querySelectorAll: selector => selector === 'video' || selector === '*' ? videos : [], ...options.document };
  const context = vm.createContext({ window, document, location, crypto: webcrypto,
    Date, performance, getComputedStyle: element => ({ visibility: 'visible', opacity: '1', ...element.style }),
    setInterval: () => 1, clearInterval() {}, setTimeout, clearTimeout });
  vm.runInContext(code, context);
  return { window, location, document, context, player: window.__videoSyncPlayer };
}

test('audit regression: a larger fully transparent player never wins over the visible video at second five', () => {
  const visible = video(), transparent = video({ currentTime: 15, style: { opacity: '0' },
    getBoundingClientRect: () => ({ width: 1000, height: 700 }) });
  const { player } = setup([visible, transparent]);
  assert.equal(player.probe().length, 1);
  assert.equal(player.attach().time, 5);
});

test('hidden ancestors, shadow hosts and assigned slots exclude a candidate', () => {
  for (const style of [{ opacity: '0.0' }, { display: 'none' }, { contentVisibility: 'hidden' }]) {
    for (const ancestor of ['parentElement', 'assignedSlot', 'shadowHost']) {
      const element = video();
      const parent = { style };
      if (ancestor === 'shadowHost') element.getRootNode = () => ({ host: parent });
      else element[ancestor] = parent;
      assert.equal(setup([element]).player.probe().length, 0, `${ancestor}: ${JSON.stringify(style)}`);
    }
  }
});

test('nested open shadow roots are searched; closed roots expose no candidates', () => {
  const element = video();
  const inner = { shadowRoot: { querySelectorAll: selector => selector === 'video' || selector === '*' ? [element] : [] } };
  const host = { shadowRoot: { querySelectorAll: selector => selector === '*' ? [inner] : [] } };
  const { player } = setup([], { document: { querySelectorAll: selector => selector === '*' ? [host, { shadowRoot: null }] : [] } });
  assert.equal(player.probe().length, 1);
  assert.equal(player.attach().time, 5);
});

test('multiple plausible videos require an explicit choice and bind that element across reorderings', () => {
  const main = video(), trailer = video({ currentTime: 15 });
  const videos = [main, trailer];
  const { player } = setup(videos);
  assert.throws(() => player.attach(), /Mehrere Videos/);
  const selected = player.probe()[1];
  videos.reverse();
  assert.equal(player.attach({ playerId: selected.id }).time, 15);
  trailer.style.opacity = '0';
  assert.throws(() => player.attach({ playerId: selected.id }), /nicht mehr sichtbar/);
  trailer.style.opacity = '1'; trailer.isConnected = false;
  assert.throws(() => player.attach({ playerId: selected.id }), /nicht mehr sichtbar/);
});

test('a media load at the same URL and blob source changes identity and cannot receive the previous play command', async () => {
  const element = video();
  const { player } = setup([element]);
  const before = player.attach();
  await player.apply({ type: 'sync', time: 5, playing: true, epoch: 1, expectedMediaId: before.mediaId, expectedPlayerId: before.playerId });
  element.dispatchEvent(new Event('loadstart'));
  const changed = await player.apply({ type: 'sync', time: 40, playing: true, epoch: 1, expectedMediaId: before.mediaId, expectedPlayerId: before.playerId });
  assert.notEqual(changed.mediaId, before.mediaId);
  assert.equal(element.paused, true);
  assert.equal(element.currentTime, 5);
  assert.equal(changed.intents.length, 0);
  const id = changed.mediaId;
  element.dispatchEvent(new Event('loadedmetadata'));
  assert.equal(player.sample().mediaId, id, 'ordinary metadata refresh is not another episode');
});

test('display title changes do not invalidate an aligned media identity', () => {
  const { player, document, location } = setup([video()]);
  const before = player.attach();
  document.title = 'Movie · Playing';
  assert.equal(player.sample().mediaId, before.mediaId);
  location.search = '?episode=2';
  assert.notEqual(player.sample().mediaId, before.mediaId);
});

test('Netflix capabilities, replacement session and missing private API have an explicit safe outcome', async () => {
  const element = video();
  let id = 'watch-episode-1', position = 5000, seeks = 0;
  const provider = { play: () => element.play(), pause: () => element.pause(), seek: time => { position = time; seeks++; }, getCurrentTime: () => position };
  const api = { getAllPlayerSessionIds: () => [id], getVideoPlayerBySessionId: () => provider };
  const netflix = { appContext: { state: { playerApp: { getAPI: () => ({ videoPlayer: api }) } } } };
  const { player, window } = setup([element], { location: { hostname: 'www.netflix.com' }, window: { netflix } });
  const before = player.attach();
  assert.equal(before.capabilities.rate, false);
  await player.apply({ type: 'sync', time: 5.3, playing: true, epoch: 1, expectedMediaId: before.mediaId, expectedPlayerId: before.playerId });
  assert.equal(element.playbackRate, 1);
  id = 'watch-episode-2';
  const next = await player.apply({ type: 'sync', time: 40, playing: true, epoch: 1, expectedMediaId: before.mediaId, expectedPlayerId: before.playerId });
  assert.notEqual(next.mediaId, before.mediaId);
  assert.equal(element.paused, true);
  assert.equal(seeks, 0);
  element.paused = false;
  window.netflix = null;
  assert.throws(() => player.sample(), /Netflix-Steuerung/);
  assert.equal(element.paused, true, 'native pause is the fallback after private API loss');
});

test('ambiguous Netflix sessions do not silently use the first private player', () => {
  const netflix = { appContext: { state: { playerApp: { getAPI: () => ({ videoPlayer: { getAllPlayerSessionIds: () => ['watch-a', 'watch-b'] } }) } } } };
  assert.throws(() => setup([video()], { location: { hostname: 'netflix.com' }, window: { netflix } }).player.attach(), /nicht eindeutig/);
});

test('a foreign owner or legacy singleton takeover stops the old player instead of sending more commands', async () => {
  for (const takeover of ['owner', 'singleton']) {
    const element = video();
    const { player, window } = setup([element]);
    const before = player.attach();
    await player.apply({ type: 'sync', time: 5, playing: true, epoch: 1, expectedMediaId: before.mediaId, expectedPlayerId: before.playerId });
    if (takeover === 'owner') window.__videoSyncOwner = 'installation-b';
    else window.__videoSyncPlayer = { version: 4 };
    await assert.rejects(player.apply({ type: 'sync', time: 90, playing: true, epoch: 1, expectedMediaId: before.mediaId, expectedPlayerId: before.playerId }), /andere Video-Sync/);
    assert.equal(element.paused, true);
    assert.equal(element.currentTime, 5);
  }
});

test('Dev reload preserves the exact selected element for one or several videos; removal never selects a replacement', () => {
  for (const count of [1, 2]) {
    const videos = Array.from({ length: count }, (_, index) => video({ currentTime: 5 + index * 10 }));
    const fixture = setup(videos);
    const selected = fixture.player.probe().at(-1);
    fixture.player.attach({ playerId: selected.id });
    fixture.player.dispose();
    delete fixture.window.__videoSyncPlayer;
    delete fixture.window.__videoSyncOwner;
    fixture.window.__videoSyncOwner = 'installation-a';
    vm.runInContext(code, fixture.context);
    const restored = fixture.window.__videoSyncPlayer;
    assert.equal(restored.attach({ playerId: selected.id }).time, selected.time);
    restored.dispose();
    videos[videos.length - 1] = video({ currentTime: 75 });
    delete fixture.window.__videoSyncPlayer;
    vm.runInContext(code, fixture.context);
    assert.throws(() => fixture.window.__videoSyncPlayer.attach({ playerId: selected.id }), /nicht mehr sichtbar/);
  }
});

test('frame scanning maps the actual child window and expires without retaining message listeners', async () => {
  const listeners = new Set();
  const a = { postMessage() {} }, b = { postMessage() {} };
  const embeddings = [video({ src: 'https://same.test/', contentWindow: a }), video({ src: 'https://same.test/', contentWindow: b, style: { opacity: '0' } })];
  const { player } = setup([], {
    window: { addEventListener: (_, listener) => listeners.add(listener), removeEventListener: (_, listener) => listeners.delete(listener) },
    document: { querySelectorAll: selector => selector === 'iframe, frame' ? embeddings : [] }
  });
  player.beginFrameScan('scan', Date.now() + 1000);
  for (const listener of listeners) listener({ source: b, data: { videoSyncFrame: 'scan', documentId: 'redirected-hidden' } });
  const result = player.finishFrameScan('scan');
  assert.equal(result.mapped[0].documentId, 'redirected-hidden');
  assert.equal(result.mapped[0].area, 0);
  assert.equal(listeners.size, 0);
  player.beginFrameScan('expired', Date.now() + 10);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(listeners.size, 0);
  assert.throws(() => player.beginFrameScan('too-late', Date.now() - 1), /zu lange/);
});

test('multiple Netflix DOM videos cannot silently share one unrelated private session', () => {
  const { player } = setup([video(), video()], { location: { hostname: 'netflix.com' } });
  const selected = player.probe()[1];
  assert.throws(() => player.attach({ playerId: selected.id }), /private Steuerung.*nicht eindeutig/);
});

test('review regression: sampling a loadstart before an old sync must not start or seek the new medium', async () => {
  const element = video();
  const { player } = setup([element]);
  const before = player.attach();
  const oldCommand = { type: 'sync', time: 40, playing: true, epoch: 1, expectedMediaId: before.mediaId, expectedPlayerId: before.playerId };
  element.dispatchEvent(new Event('loadstart'));
  const changed = player.sample();
  assert.notEqual(changed.mediaId, before.mediaId);
  const rejected = await player.apply(oldCommand);
  assert.equal(rejected.mediaId, changed.mediaId);
  assert.equal(element.currentTime, 5);
  assert.equal(element.paused, true);
  assert.equal(rejected.intents.length, 0);
  await player.apply({ ...oldCommand, expectedMediaId: changed.mediaId, expectedPlayerId: changed.playerId, epoch: 2 });
  assert.equal(element.currentTime, 40, 'the current medium still accepts a new aligned command');
  assert.equal(element.paused, false);
});

test('review regression: visibility visible overrides hidden ancestors, hosts and slots', () => {
  for (const ancestor of ['parentElement', 'assignedSlot', 'shadowHost']) {
    const element = video({ style: { visibility: 'visible' } });
    const parent = { style: { visibility: 'hidden' } };
    if (ancestor === 'shadowHost') element.getRootNode = () => ({ host: parent });
    else element[ancestor] = parent;
    assert.equal(setup([element]).player.probe().length, 1, ancestor);
  }
});

test('review regression: a delayed routed command keeps its original media identity after sampling a new load', async t => {
  const element = video();
  const { player, context } = setup([element]);
  const before = player.attach();
  let deliver, enqueued;
  const held = new Promise(resolve => { deliver = resolve; });
  const queued = new Promise(resolve => { enqueued = resolve; });
  const originalChrome = globalThis.chrome;
  let forwarded;
  globalThis.chrome = {
    runtime: { id: 'installation-a' },
    scripting: { executeScript: async options => {
      forwarded = structuredClone(options.args);
      enqueued();
      await held;
      context.args = forwarded;
      return [{ result: await vm.runInContext(`(${options.func.toString()})(...args)`, context) }];
    } }
  };
  t.after(() => { globalThis.chrome = originalChrome; deliver(); });
  const response = callPlayer({ tabId: 1, documentId: 'document-a', playerId: before.playerId, action: 'apply',
    command: { type: 'sync', time: 40, playing: true, epoch: 1, expectedMediaId: before.mediaId, expectedPlayerId: before.playerId } });
  await queued;
  element.dispatchEvent(new Event('loadstart'));
  const changed = player.sample();
  assert.equal(forwarded[2].expectedMediaId, before.mediaId);
  deliver();
  assert.equal((await response).mediaId, changed.mediaId);
  assert.equal(element.currentTime, 5);
  assert.equal(element.paused, true);
});

test('commands without a media identity and delayed controls from a previous attachment never change a new binding', async () => {
  const element = video();
  const { player } = setup([element]);
  const first = player.attach();
  const oldControl = { type: 'control', control: 'forward', epoch: 1, expectedMediaId: first.mediaId, expectedPlayerId: first.playerId };
  const current = player.attach();
  assert.notEqual(current.mediaId, first.mediaId);
  await player.apply(oldControl);
  await player.apply({ type: 'sync', time: 40, playing: true, epoch: 1 });
  assert.equal(element.currentTime, 5);
  assert.equal(element.paused, true);
  await player.apply({ ...oldControl, expectedMediaId: current.mediaId, expectedPlayerId: current.playerId });
  assert.equal(element.currentTime, 15);
});

test('computed hidden visibility still excludes inherited or directly hidden media', () => {
  for (const visibility of ['hidden', 'collapse']) {
    const element = video({ style: { visibility }, parentElement: { style: { visibility } } });
    assert.equal(setup([element]).player.probe().length, 0);
  }
});

test('frame scans respect overridden visibility through ancestors, shadow hosts and slots without overriding opacity or display', () => {
  for (const ancestor of ['parentElement', 'assignedSlot', 'shadowHost']) {
    for (const style of [{ visibility: 'hidden' }, { opacity: '0', visibility: 'hidden' }, { display: 'none', visibility: 'hidden' }]) {
      const listeners = new Set();
      const child = { postMessage() {} };
      const embedding = video({ src: 'https://frame.test/', contentWindow: child, style: { visibility: 'visible' } });
      const parent = { style };
      if (ancestor === 'shadowHost') embedding.getRootNode = () => ({ host: parent });
      else embedding[ancestor] = parent;
      const { player } = setup([], {
        window: { addEventListener: (_, listener) => listeners.add(listener), removeEventListener: (_, listener) => listeners.delete(listener) },
        document: { querySelectorAll: selector => selector === 'iframe, frame' ? [embedding] : [] }
      });
      player.beginFrameScan('visibility-scan', Date.now() + 1000);
      for (const listener of listeners) listener({ source: child, data: { videoSyncFrame: 'visibility-scan', documentId: 'child-document' } });
      const result = player.finishFrameScan('visibility-scan');
      const expectedArea = style.opacity || style.display ? 0 : 60000;
      assert.equal(result.mapped[0].area, expectedArea, `${ancestor}: ${JSON.stringify(style)}`);
      assert.equal(result.embeddings[0].area, expectedArea);
      assert.equal(listeners.size, 0);
    }
  }
});

test('old controls and detach cannot cross a selection change to another element in the same document', async () => {
  const first = video(), second = video({ currentTime: 15 });
  const { player } = setup([first, second]);
  const choices = player.probe();
  const before = player.attach({ playerId: choices[0].id });
  const current = player.attach({ playerId: choices[1].id });
  const command = { type: 'control', control: 'forward', epoch: 1,
    expectedMediaId: before.mediaId, expectedPlayerId: before.playerId };
  await player.apply(command);
  player.detach(command);
  assert.equal(player.sample().playerId, current.playerId);
  assert.equal(second.currentTime, 15);
  await player.apply({ ...command, expectedMediaId: current.mediaId });
  assert.equal(second.currentTime, 15, 'matching media alone cannot authorize another player binding');
  await player.apply({ ...command, expectedMediaId: current.mediaId, expectedPlayerId: current.playerId });
  assert.equal(second.currentTime, 25);
});
