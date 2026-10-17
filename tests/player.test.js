import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';

// Drive the real adapter with a small media element to control delayed/stale
// command ordering exactly. Real Chromium event behavior is tested in e2e.js.
function setup() {
  let time = 1_000_000;
  const video = Object.assign(new EventTarget(), {
    duration: 120, currentTime: 5, currentSrc: 'https://video.test/movie.webm',
    readyState: 4, seeking: false, paused: true, isConnected: true,
    clientWidth: 800, clientHeight: 450, playbackRate: 1, plays: 0,
    getBoundingClientRect: () => ({ width: 800, height: 450 }), getAttribute: () => null,
    play() { this.paused = false; this.plays++; this.dispatchEvent(new Event('play')); return Promise.resolve(); },
    pause() { if (!this.paused) { this.paused = true; this.dispatchEvent(new Event('pause')); } }
  });
  const window = { __videoSyncOwner: 'owner-id' }, announced = [];
  const source = new URL('../extension/player.js', import.meta.url);
  runInNewContext(readFileSync(source, 'utf8'), {
    window, document: { querySelectorAll: () => [video], dispatchEvent: event => announced.push(event.type) }, crypto: webcrypto,
    CustomEvent: class { constructor(type) { this.type = type; } },
    Date: class extends Date { static now() { return time; } }, performance: { timeOrigin: 0, now: () => time },
    location: { hostname: 'video.test', origin: 'https://video.test', pathname: '/movie' },
    getComputedStyle: () => ({ visibility: 'visible' }), setInterval: () => 1, clearInterval() {}
  });
  const player = window.__videoSyncPlayer;
  const { mediaId, playerId } = player.attach();
  const sync = (extra = {}) => player.apply({ type: 'sync', expectedMediaId: mediaId, expectedPlayerId: playerId, epoch: 1, time: 5, playing: true, ...extra });
  return { video, player, mediaId, playerId, sync, announced, advance: ms => { time += ms; } };
}

test('a native pause survives a stale sync and its intent remains available after a lost sample response', async () => {
  const c = setup(); await c.sync();
  c.video.pause();
  const first = c.player.sample(); // Response may arrive after the extension's timeout.
  assert.equal(first.intents.length, 1);
  const again = await c.sync();
  assert.equal(c.video.paused, true);
  assert.equal(c.video.plays, 1);
  assert.equal(again.intents[0]?.id, first.intents[0].id);
  const acknowledged = await c.sync({ playing: false, ack: { mediaId: c.mediaId, id: first.intents[0].id } });
  assert.equal(acknowledged.intents.length, 0);
  await c.sync(); // A genuinely later Play remains possible after acknowledgement.
  assert.equal(c.video.paused, false);
});

test('acknowledging an older native command cannot undo the latest pause', async () => {
  const c = setup(); await c.sync();
  c.video.pause();
  const first = c.player.sample().intents.at(-1);
  await c.video.play();
  c.video.pause();
  const last = c.player.sample().intents.at(-1);
  assert.ok(last.id > first.id);
  await c.sync({ ack: { mediaId: c.mediaId, id: first.id } });
  assert.equal(c.video.paused, true);
  await c.sync({ ack: { mediaId: 'different-movie', id: last.id } });
  assert.equal(c.video.paused, true);
  await c.sync({ playing: false, ack: { mediaId: c.mediaId, id: last.id } });
  assert.equal(c.player.sample().intents.length, 0);
});

test('a safety pause and a new alignment still take precedence over pending native controls', async () => {
  const c = setup(); await c.sync();
  c.video.pause(); await c.video.play();
  await c.player.apply({ type: 'pause', expectedMediaId: c.mediaId, expectedPlayerId: c.playerId });
  assert.equal(c.video.paused, true);
  await c.player.apply({ type: 'release', expectedMediaId: c.mediaId, expectedPlayerId: c.playerId });
  assert.equal(c.player.sample().intents.length, 0);
  await c.sync({ epoch: 2 });
  assert.equal(c.video.paused, false);
});

test('an interrupted play attempt does not prevent the next Play', async () => {
  const c = setup();
  const play = c.video.play;
  c.video.play = () => Promise.reject(new DOMException('Interrupted by pause or seek', 'AbortError'));
  assert.equal((await c.sync()).blocked, false);
  c.video.play = play;
  await c.sync();
  assert.equal(c.video.paused, false);
});

test('an actual autoplay restriction remains visible until native Play succeeds', async () => {
  const c = setup();
  const play = c.video.play;
  c.video.play = () => Promise.reject(new DOMException('User interaction required', 'NotAllowedError'));
  assert.equal((await c.sync()).blocked, true);
  c.video.play = play;
  await c.sync();
  assert.equal(c.video.paused, true);
  await c.video.play();
  assert.equal(c.player.sample().blocked, false);
});

test('a brief seek does not pause the room but sustained buffering and media errors still do', async () => {
  const c = setup(); await c.sync();
  c.video.seeking = true;
  assert.equal(c.player.sample().buffering, false);
  assert.equal(c.player.sample().advancing, false);
  c.advance(100); c.video.seeking = false;
  assert.equal(c.player.sample().buffering, false);
  c.video.readyState = 2;
  assert.equal(c.player.sample().buffering, false);
  c.advance(500);
  assert.equal(c.player.sample().buffering, true);
  c.video.readyState = 4;
  assert.equal(c.player.sample().buffering, false);
  c.video.error = new Error('media failed');
  assert.equal(c.player.sample().buffering, true);
});

test('loading after a seek gets a longer grace than a stall during playback', async () => {
  const c = setup(); await c.sync();
  c.video.seeking = true; c.video.readyState = 1;
  assert.equal(c.player.sample().buffering, false);
  c.advance(700); c.video.seeking = false;
  assert.equal(c.player.sample().buffering, false, 'a slow seek on a busy device does not pause the room yet');
  c.advance(800);
  assert.equal(c.player.sample().buffering, true, 'sustained loading after a seek still pauses');
  c.video.readyState = 4;
  assert.equal(c.player.sample().buffering, false);
  c.video.readyState = 2;
  c.player.sample(); c.advance(500);
  assert.equal(c.player.sample().buffering, true, 'a stall without seeking keeps the short threshold');
});

test('popup seek clicks use the live position and are protected by the same native acknowledgement', async () => {
  const c = setup(); await c.sync({ playing: false });
  for (const control of ['forward', 'forward', 'forward', 'back']) {
    await c.player.apply({ type: 'control', control, epoch: 1, expectedMediaId: c.mediaId, expectedPlayerId: c.playerId });
    c.video.dispatchEvent(new Event('seeking'));
  }
  assert.equal(c.video.currentTime, 25);
  assert.equal(c.player.sample().intents.length, 4);
  await c.sync({ playing: false, time: 5 });
  assert.equal(c.video.currentTime, 25);
  assert.equal(c.video.paused, true);
});

test('a fine native seek immediately after a remote correction is not swallowed as an echo', async () => {
  const c = setup(); await c.sync({ playing: false, time: 20, force: true });
  c.video.dispatchEvent(new Event('seeking'));
  assert.equal(c.player.sample().intents.length, 0);
  c.video.currentTime = 20.2;
  c.video.dispatchEvent(new Event('seeking'));
  assert.equal(c.player.sample().intents.at(-1).time, 20.2);
  await c.sync({ playing: false, time: 20, force: true });
  assert.equal(c.video.currentTime, 20.2);
});

test('current sync, controls and safety commands keep working with both current and historical Stable players', async () => {
  for (const runtime of ['experimental', 'stable']) {
    const c = setup(runtime);
    await c.sync({ time: 40 });
    assert.equal(c.video.currentTime, 40, runtime);
    assert.equal(c.video.paused, false, runtime);
    await c.player.apply({ type: 'control', control: 'forward', epoch: 1, expectedMediaId: c.mediaId, expectedPlayerId: c.playerId });
    assert.equal(c.video.currentTime, 50, runtime);
    await c.player.apply({ type: 'pause', expectedMediaId: c.mediaId, expectedPlayerId: c.playerId });
    assert.equal(c.video.paused, true, runtime);
    await c.player.apply({ type: 'release', expectedMediaId: c.mediaId, expectedPlayerId: c.playerId });
    assert.equal(c.player.sample().intents.length, 0, runtime);
  }
});

test('an 800ms delayed real playing start receives one fresh correction, not slow rate-only catchup', async () => {
  const c = setup();
  let finish;
  c.video.play = () => new Promise(resolve => { finish = () => {
    c.video.paused = false;
    c.video.dispatchEvent(new Event('play'));
    c.video.dispatchEvent(new Event('playing'));
    resolve();
  }; });
  const starting = c.sync({ time: 5 });
  c.advance(800); finish(); await starting;
  c.advance(350); c.video.currentTime += 0.35;
  await c.sync({ time: 6.15 });
  assert.ok(Math.abs(c.video.currentTime - 6.15) < 0.04, 'catch up to the latest target after actual playing');
  c.video.seeking = true; c.video.dispatchEvent(new Event('waiting'));
  c.video.seeking = false; c.video.dispatchEvent(new Event('playing'));
  c.advance(700); c.video.currentTime += 0.7;
  await c.sync({ time: 7.1 });
  assert.ok(Math.abs(c.video.currentTime - 6.85) < 0.04, 'the corrective seek must not arm another correction');
});

test('buffer recovery gets a bounded fresh correction but a native seek keeps its chosen position', async () => {
  const c = setup(); await c.sync();
  c.video.dispatchEvent(new Event('playing'));
  c.video.readyState = 2; c.video.dispatchEvent(new Event('waiting'));
  c.advance(800); c.video.readyState = 4; c.video.dispatchEvent(new Event('playing'));
  await c.sync({ time: 5.8 });
  assert.equal(c.video.currentTime, 5.8);
  c.video.readyState = 2; c.video.dispatchEvent(new Event('waiting'));
  c.advance(800); c.video.readyState = 4; c.video.dispatchEvent(new Event('playing'));
  c.video.currentTime = 20; c.video.dispatchEvent(new Event('seeking'));
  await c.sync({ time: 6.6 });
  assert.equal(c.video.currentTime, 20, 'a pending local intent wins over recovery correction');
});

test('a late play completion after detach is paused and cannot control a newer binding', async () => {
  const c = setup(); let finish;
  c.video.play = () => new Promise(resolve => { finish = () => { c.video.paused = false; resolve(); }; });
  const pending = c.sync();
  c.player.detach();
  finish();
  await assert.rejects(pending, /verändert|verbinden/);
  assert.equal(c.video.paused, true);
});

test('binding cancellation rejects an attach before its first sample and leaves a replacement untouched', () => {
  const c = setup();
  c.player.detach({ expectedBindingId: 'cancel-before-attach' });
  assert.throws(() => c.player.attach({ playerId: c.playerId, bindingId: 'cancel-before-attach' }), /abgebrochen/);
  const next = c.player.attach({ playerId: c.playerId, bindingId: 'replacement' });
  c.player.detach({ expectedBindingId: 'cancel-before-attach' });
  assert.equal(c.player.sample().bindingId, next.bindingId);
});

test('the historical Stable runtime retains its documented rate-only delayed-start limit', async () => {
  const c = setup('stable');
  await c.sync();
  c.advance(1150); c.video.currentTime = 5.35;
  await c.sync({ time: 6.15 });
  assert.equal(c.video.currentTime, 5.35);
  assert.equal(c.video.playbackRate, 1.04);
});

for (const transition of ['reattach', 'pause-play', 'media-change']) {
  for (const outcome of ['resolve', 'reject']) {
    test(`an old ${outcome === 'resolve' ? 'resolved' : 'rejected'} Play cannot pause or block a newer Play after ${transition}`, async () => {
      const c = setup();
      const originalPlay = c.video.play;
      let resolve, reject;
      c.video.play = () => new Promise((yes, no) => { resolve = yes; reject = no; });
      const oldBinding = c.player.sample().bindingId;
      const pending = c.sync({ expiresAt: 1_001_900 });
      if (transition === 'reattach') {
        c.player.detach({ expectedBindingId: oldBinding });
        c.player.attach({ playerId: c.playerId, bindingId: 'replacement' });
      } else if (transition === 'pause-play') {
        await c.player.apply({ type: 'pause', expectedMediaId: c.mediaId, expectedPlayerId: c.playerId });
      } else {
        c.video.currentSrc = 'https://video.test/replacement.webm';
        c.video.dispatchEvent(new Event('loadstart'));
      }
      const current = c.player.sample();
      c.video.play = originalPlay;
      await c.player.apply({ type: 'sync', time: 5, playing: true, epoch: 2,
        expectedMediaId: current.mediaId, expectedPlayerId: current.playerId,
        expectedBindingId: current.bindingId, expiresAt: 1_010_000 });
      c.advance(2100);
      if (outcome === 'resolve') resolve();
      else reject(new DOMException('Old attempt rejected', 'NotAllowedError'));
      await pending;
      const after = c.player.sample();
      assert.equal(c.video.paused, false);
      assert.equal(after.blocked, false);
      assert.equal(after.bindingId, current.bindingId);
      assert.equal(after.mediaId, current.mediaId);
      assert.equal(after.intents.length, 0, 'old completion must not create a new Pause intent');
      c.player.detach();
    });
  }
}

test('an expired current Play is safely paused without becoming a user Pause intent', async () => {
  const c = setup(); let finish;
  c.video.play = () => new Promise(resolve => { finish = () => { c.video.paused = false; resolve(); }; });
  const pending = c.sync({ expiresAt: 1_001_900 });
  c.advance(2100); finish(); await pending;
  assert.equal(c.video.paused, true);
  assert.equal(c.player.sample().intents.length, 0);
});

for (const direction of [-1, 1]) {
  test(`an acknowledged delayed native seek converges within ten seconds without a playback jump (${direction})`, async () => {
    const c = setup(); await c.sync(); c.video.dispatchEvent(new Event('playing'));
    c.video.currentTime = 35.916943;
    c.video.dispatchEvent(new Event('seeking'));
    const intent = c.player.sample().intents.at(-1);
    const gestureTime = c.video.currentTime;
    // PR02 browser-qP2v25: 450ms transport delay leaves about 0.9s
    // discrepancy at the first seek acknowledgement after about 1050ms.
    c.advance(1050); c.video.currentTime += 1.05;
    await c.sync({ time: 26.6, ack: { mediaId: c.mediaId, id: intent.id - 1 } });
    assert.equal(c.video.playbackRate, 1, 'an older acknowledgement cannot undo the native gesture');
    let target = c.video.currentTime + direction * 0.89;
    await c.sync({ time: target, ack: { mediaId: c.mediaId, id: intent.id } });
    let convergence = null;
    for (let elapsed = 1400; elapsed <= 10150; elapsed += 350) {
      c.advance(350);
      c.video.currentTime += 0.35 * c.video.playbackRate;
      target += 0.35;
      const before = c.video.currentTime;
      await c.sync({ time: target, ack: { mediaId: c.mediaId, id: intent.id } });
      assert.equal(c.video.currentTime, before, 'correction must never seek after the gesture');
      assert.equal(c.video.paused, false);
      assert.equal(c.player.sample().intents.length, 0);
      if (elapsed <= 2450) assert.ok(Math.abs(c.video.currentTime - gestureTime - elapsed / 1000) < 0.2,
        'preserve the existing continuity tolerance');
      if (Math.abs(target - c.video.currentTime) < 0.5) { convergence = elapsed; break; }
    }
    assert.ok(convergence !== null && convergence <= 10000, `convergence: ${convergence}`);
    c.player.detach();
  });
}

test('seek catchup expires, cannot be rearmed by repeated acknowledgement, and yields to newer native intent', async () => {
  const c = setup(); await c.sync();
  c.video.currentTime = 20; c.video.dispatchEvent(new Event('seeking'));
  const first = c.player.sample().intents.at(-1);
  await c.sync({ time: 20.8, ack: { mediaId: 'other', id: first.id } });
  assert.equal(c.video.playbackRate, 1);
  await c.sync({ time: 20.8, ack: { mediaId: c.mediaId, id: first.id } });
  assert.equal(c.video.playbackRate, 1.06);
  c.advance(10000);
  await c.sync({ time: 20.8, ack: { mediaId: c.mediaId, id: first.id } });
  assert.equal(c.video.playbackRate, 1.04, 'repeated acknowledgements cannot extend the bounded correction');
  c.video.currentTime = 30; c.video.dispatchEvent(new Event('seeking'));
  await c.sync({ time: 20.8, ack: { mediaId: c.mediaId, id: first.id } });
  assert.equal(c.video.currentTime, 30);
  assert.equal(c.video.playbackRate, 1, 'the newer local seek keeps ownership');
  const latest = c.player.sample().intents.at(-1);
  await c.sync({ time: 30.8, ack: { mediaId: c.mediaId, id: latest.id } });
  assert.equal(c.video.playbackRate, 1.06);
  await c.sync({ epoch: 2, time: 30.8 });
  assert.equal(c.video.playbackRate, 1.04, 'a new alignment cannot inherit catchup');
  c.player.detach();
});

for (const direction of [-1, 1]) {
  test(`a delayed final scrub acknowledgement stays continuous across the 0.9s seek threshold (${direction})`, async () => {
    const c = setup(); await c.sync(); c.video.dispatchEvent(new Event('playing'));
    const intents = [];
    for (const time of [28, 22, 31]) {
      c.video.currentTime = time; c.video.seeking = true;
      c.video.dispatchEvent(new Event('seeking'));
      c.video.dispatchEvent(new Event('waiting'));
      c.advance(80); c.video.seeking = false; c.video.dispatchEvent(new Event('playing'));
      intents.push(c.player.sample().intents.at(-1));
    }
    const finalTime = c.video.currentTime;
    for (const intent of intents.slice(0, -1)) {
      await c.sync({ time: intent.time, ack: { mediaId: c.mediaId, id: intent.id } });
      assert.equal(c.video.currentTime, finalTime, 'intermediate scrub acknowledgements cannot undo the final frame');
      assert.equal(c.video.playbackRate, 1);
    }
    const latest = intents.at(-1);
    c.advance(1050); c.video.currentTime += 1.05;
    // CI on unchanged PR01 observed a corrective seek after the final native
    // scrub. Cross the old 0.9s threshold explicitly, without widening it.
    let target = c.video.currentTime + direction * 1.05;
    for (let elapsed = 1050; elapsed <= 12250; elapsed += 350) {
      const before = c.video.currentTime;
      await c.sync({ time: target, ack: { mediaId: c.mediaId, id: latest.id } });
      assert.equal(c.video.currentTime, before, 'no automatic seek after the scrub');
      assert.equal(c.video.paused, false);
      if (elapsed <= 2450) assert.ok(Math.abs(c.video.currentTime - finalTime - elapsed / 1000) < 0.2);
      if (elapsed === 12250) assert.ok(Math.abs(target - c.video.currentTime) < 0.5,
        'converges inside the original 10s wait after the 2.4s continuity observation');
      c.advance(350); c.video.currentTime += 0.35 * c.video.playbackRate; target += 0.35;
    }
    c.player.detach();
  });
}

test('bounded native seek correction still accepts a genuinely newer remote seek and safety pause', async () => {
  const c = setup(); await c.sync();
  c.video.currentTime = 30; c.video.dispatchEvent(new Event('seeking'));
  const intent = c.player.sample().intents.at(-1), ack = { mediaId: c.mediaId, id: intent.id };
  await c.sync({ time: 31.05, ack });
  assert.equal(c.video.currentTime, 30);
  await c.sync({ time: 45, ack, force: true });
  assert.equal(c.video.currentTime, 45, 'an explicit newer remote revision wins');
  await c.sync({ time: 45, playing: false, ack });
  assert.equal(c.video.paused, true);
  assert.equal(c.video.playbackRate, 1);
  c.player.detach();
});

// Reviewer reproduction: a final acknowledgement of a moving local seek keeps
// the locally continued position instead of jumping back to the seek target.
{
  test('final moving-seek acknowledgement at 1.05s drift keeps the continued local position', async () => {
    const c = setup(); await c.sync();
    c.video.currentTime = 35; c.video.dispatchEvent(new Event('seeking'));
    const intent = c.player.sample().intents.at(-1);
    c.advance(1050); c.video.currentTime += 1.05;
    const before = c.video.currentTime;
    await c.sync({ time: before - 1.05, force: false, ack: { mediaId: c.mediaId, id: intent.id } });
    assert.equal(c.video.currentTime, before);
    assert.equal(c.video.paused, false);
    assert.equal(c.player.sample().intents.length, 0);
    c.player.detach();
  });
}

test('native intents announce themselves to the bridge without data; sync commands do not', async () => {
  const c = setup(); await c.sync();
  assert.deepEqual(c.announced, []);
  c.video.pause();
  assert.deepEqual(c.announced, ['videosync-intent:owner-id']);
  await c.sync({ playing: false });
  assert.equal(c.announced.length, 1);
});
