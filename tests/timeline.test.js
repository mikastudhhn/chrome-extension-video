import test from 'node:test';
import assert from 'node:assert/strict';
import { Timeline, targetTime } from '../extension/timeline.js';

function setup() {
  let time = 1_000_000;
  const timeline = new Timeline(() => time);
  const samples = {
    host: { time: 125, duration: 600, paused: true, buffering: false, mediaId: 'a' },
    guest: { time: 30, duration: 505, paused: true, buffering: false, mediaId: 'b' }
  };
  const refresh = () => { for (const role of ['host', 'guest']) timeline.sample(role, samples[role]); };
  refresh();
  return { timeline, samples, refresh, advance: ms => { time += ms; }, now: () => time };
}

function align(context) {
  assert.equal(context.timeline.ready('host', context.timeline.epoch), true);
  assert.equal(context.timeline.ready('guest', context.timeline.epoch), true);
}

test('independently confirmed anchors preserve the offset during playback and seeks from either person', () => {
  const c = setup(); align(c);
  c.timeline.intent('guest', { type: 'play' }, 0);
  c.advance(1000); c.refresh();
  let state = c.timeline.tick();
  assert.equal(targetTime(state, 'host', c.now()), 126);
  assert.equal(targetTime(state, 'guest', c.now()), 31);
  c.timeline.intent('guest', { type: 'seek', time: 90 }, 0);
  state = c.timeline.tick();
  assert.equal(targetTime(state, 'host', c.now()), 185);
  assert.equal(targetTime(state, 'guest', c.now()), 90);
  c.timeline.intent('host', { type: 'seek', time: 150 }, 0);
  assert.equal(targetTime(c.timeline.tick(), 'guest', c.now()), 55);
});

test('buffering stops room time, recovery resumes it, and an explicit pause overrides recovery', () => {
  const c = setup(); align(c);
  c.timeline.intent('host', { type: 'play' }, 0);
  c.advance(500); c.samples.guest.buffering = true; c.refresh();
  assert.equal(c.timeline.tick().waiting, true);
  const stoppedAt = c.timeline.position;
  c.advance(5000); c.refresh();
  assert.equal(c.timeline.position, stoppedAt);
  c.samples.guest.buffering = false; c.refresh();
  assert.equal(c.timeline.playing, true);
  c.samples.guest.buffering = true; c.refresh();
  c.timeline.intent('host', { type: 'pause' }, 0);
  c.samples.guest.buffering = false; c.refresh();
  assert.equal(c.timeline.playing, false);
  assert.equal(c.timeline.wantsPlay, false);
});

test('missing heartbeats stop playback and old ready messages cannot finish a new alignment', () => {
  const c = setup(); align(c);
  c.timeline.intent('host', { type: 'play' }, 0);
  c.advance(3000);
  assert.equal(c.timeline.tick().playing, false);
  c.timeline.reset(); c.refresh();
  assert.equal(c.timeline.ready('guest', 0), false);
  assert.equal(c.timeline.phase, 'aligning');
  assert.deepEqual(c.timeline.anchors, {});
});

test('ready requires a paused loaded video and moving it invalidates the confirmation', () => {
  const c = setup();
  c.samples.host.paused = false; c.refresh();
  assert.equal(c.timeline.ready('host', 0), false);
  c.samples.host.paused = true; c.samples.host.buffering = true; c.refresh();
  assert.equal(c.timeline.ready('host', 0), false);
  c.samples.host.buffering = false; c.refresh();
  assert.equal(c.timeline.ready('host', 0), true);
  c.samples.host.time += 10; c.refresh();
  assert.equal(c.timeline.anchors.host, undefined);
});

test('changing video resets both confirmations and stops playback', () => {
  const c = setup(); align(c);
  c.timeline.intent('host', { type: 'play' }, 0);
  c.samples.guest.mediaId = 'new-episode'; c.refresh();
  assert.equal(c.timeline.phase, 'aligning');
  assert.equal(c.timeline.playing, false);
  assert.deepEqual(c.timeline.anchors, {});
});

test('seeks stay inside the range available in both versions', () => {
  const c = setup(); align(c);
  c.timeline.intent('host', { type: 'seek', time: 0 }, 0);
  assert.equal(targetTime(c.timeline.tick(), 'guest', c.now()), 0);
  assert.equal(targetTime(c.timeline.tick(), 'host', c.now()), 95);
  c.timeline.intent('guest', { type: 'seek', time: 9999 }, 0);
  assert.equal(targetTime(c.timeline.tick(), 'guest', c.now()), 505);
  assert.equal(targetTime(c.timeline.tick(), 'host', c.now()), 600);
});

test('clock compensation predicts the matching position on a peer with a different clock', () => {
  const c = setup(); align(c);
  c.timeline.intent('host', { type: 'play' }, 0);
  assert.equal(targetTime(c.timeline.tick(), 'guest', c.now() - 60_000 + 250, 60_000), 30.25);
});

test('connection interruption preserves anchors, pauses intent and rejects commands from before recovery', () => {
  let now = 1000;
  const timeline = new Timeline(() => now);
  const sample = { time: 5, duration: 30000, paused: true, buffering: false, mediaId: 'movie' };
  timeline.sample('host', sample); timeline.sample('guest', { ...sample, time: 10 });
  timeline.ready('host', 0); timeline.ready('guest', 0);
  timeline.intent('host', { type: 'play' }, 0);
  now += 1000;
  timeline.suspend();
  assert.deepEqual(timeline.anchors, { host: 5, guest: 10 });
  assert.equal(timeline.phase, 'synced');
  assert.equal(timeline.wantsPlay, false);
  timeline.intent('guest', { type: 'play' }, 0);
  assert.equal(timeline.wantsPlay, false);
  timeline.intent('guest', { type: 'play' }, timeline.epoch);
  assert.equal(timeline.wantsPlay, true);
});

test('native pause freezes at the clicked frame and acknowledges that exact media command', () => {
  const c = setup(); align(c);
  c.timeline.intent('host', { type: 'play' }, 0);
  c.advance(1000); c.refresh();
  const pause = { type: 'pause', time: 30.4, id: 1, mediaId: 'b' };
  assert.equal(c.timeline.intent('guest', pause, 0), true);
  const state = c.timeline.tick();
  assert.equal(state.playing, false);
  assert.equal(targetTime(state, 'guest', c.now()), 30.4);
  assert.deepEqual(state.acknowledgedIntents.guest, { id: 1, mediaId: 'b', revision: state.revision });
  const revision = state.revision;
  assert.equal(c.timeline.intent('guest', pause, 0), false);
  assert.equal(c.timeline.revision, revision);
});

test('an older acknowledgement or a command for another video cannot undo a newer native pause', () => {
  const c = setup(); align(c);
  const play = { type: 'play', id: 1, mediaId: 'b' };
  const pause = { type: 'pause', time: 30, id: 2, mediaId: 'b' };
  assert.equal(c.timeline.intent('guest', play, 0), true);
  const oldState = c.timeline.snapshot();
  assert.equal(c.timeline.intent('guest', pause, 0), true);
  assert.equal(c.timeline.intent('guest', play, 0), false);
  assert.equal(c.timeline.intent('guest', { ...play, id: 3, mediaId: 'other-video' }, 0), false);
  assert.equal(c.timeline.wantsPlay, false);
  assert.equal(oldState.acknowledgedIntents.guest.id, 1);
  assert.equal(c.timeline.snapshot().acknowledgedIntents.guest.id, 2);
});

test('a new alignment and a network suspension discard native command acknowledgements', () => {
  const c = setup(); align(c);
  c.timeline.intent('guest', { type: 'pause', id: 1, mediaId: 'b' }, 0);
  c.timeline.suspend();
  assert.deepEqual(c.timeline.snapshot().acknowledgedIntents, {});
  assert.equal(c.timeline.intent('guest', { type: 'play', id: 2, mediaId: 'b' }, 0), false);
  c.timeline.intent('guest', { type: 'pause', id: 2, mediaId: 'b' }, c.timeline.epoch);
  c.timeline.reset();
  assert.deepEqual(c.timeline.snapshot().acknowledgedIntents, {});
});

test('native Play and moving seeks retain progress made while their commands were in transit', () => {
  const c = setup(); align(c);
  const at = c.now(); c.advance(700);
  c.timeline.intent('guest', { type: 'play', id: 1, mediaId: 'b', time: 30, at, advancing: true }, 0);
  assert.equal(targetTime(c.timeline.tick(), 'guest', c.now()), 30.7);
  const seekAt = c.now(); c.advance(450);
  c.timeline.intent('guest', { type: 'seek', id: 2, mediaId: 'b', time: 50, at: seekAt, advancing: true }, 0);
  assert.equal(targetTime(c.timeline.tick(), 'guest', c.now()), 50.45);
  c.timeline.intent('guest', { type: 'seek', id: 3, mediaId: 'b', time: 40, at: seekAt, advancing: false }, 0);
  assert.equal(targetTime(c.timeline.tick(), 'guest', c.now()), 40);
  assert.equal(c.timeline.snapshot().acknowledgedIntents.guest.revision, c.timeline.revision);
});
