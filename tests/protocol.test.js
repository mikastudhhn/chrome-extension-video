import test from 'node:test';
import assert from 'node:assert/strict';
import { Rooms } from '../server/rooms.js';
import { Timeline, targetTime } from '../extension/timeline.js';
import { validSample, validState, validIntent, validMessage, validEvents, negotiate, LIMITS, PROTOCOL, CAPABILITIES } from '../extension/protocol.js';

const hello = { protocol: PROTOCOL, capabilities: [...CAPABILITIES] };

const sample = { time: 5, duration: 100, mediaId: 'video', paused: true, buffering: false };
function aligned() {
  const timeline = new Timeline(() => 1000);
  timeline.sample('host', sample); timeline.sample('guest', { ...sample, time: 10 });
  timeline.ready('host', 0); timeline.ready('guest', 0);
  return timeline;
}

test('protocol keeps optional intent fields and negative relative timeline positions', () => {
  const timeline = aligned();
  assert.equal(timeline.intent('host', { type: 'seek', time: 0 }, 0), true);
  const state = timeline.snapshot();
  assert.equal(state.position, -5);
  assert.equal(validState(state), true);
  assert.equal(targetTime(state, 'guest', 1000), 5);
  delete state.acknowledgedIntents;
  assert.equal(validState(state), true);
  assert.equal(validIntent({ type: 'pause' }), true);
  assert.equal(validMessage({ type: 'intent', epoch: 0, intent: { type: 'play', epoch: null } }, 'guest'), true);
  assert.equal(validMessage({ type: 'intent', epoch: null, intent: { type: 'play' } }, 'guest'), false);
  assert.equal(validSample({ ...sample, intents: [{ type: 'play', id: 1, mediaId: 'video', epoch: null }] }), true);
  assert.equal(validMessage({ type: 'state', state, futureOptionalField: true }, 'host'), true);
});

test('malformed samples, states, intents and role violations cannot enter the protocol', () => {
  for (const value of [null, [], {}, false, 0, 'state']) {
    assert.equal(!!validSample(value), false);
    assert.equal(!!validState(value), false);
    assert.equal(!!validIntent(value), false);
  }
  for (const value of [NaN, Infinity, -Infinity, -1, '5', Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(validSample({ ...sample, time: value }), false);
    assert.equal(validSample({ ...sample, duration: value }), false);
    assert.equal(validIntent({ type: 'seek', time: value }), false);
    assert.equal(validMessage({ type: 'ready', epoch: value }, 'guest'), false);
    assert.equal(validState({ ...aligned().snapshot(), epoch: value }), false);
  }
  for (const changes of [{ mediaId: '' }, { mediaId: 'a'.repeat(LIMITS.mediaId + 1) }, { paused: 1 }, { buffering: null },
    { blocked: 'no' }, { intents: Array(21).fill({ type: 'play' }) }]) assert.equal(validSample({ ...sample, ...changes }), false);
  for (const changes of [{ members: {} }, { anchors: [] }, { anchors: { host: 0 } }, { revision: -1 }, { at: Infinity },
    { playing: 'yes' }, { phase: 'unknown' }, { acknowledgedIntents: { guest: { id: 1, mediaId: 'v', revision: 999 } } }]) {
    assert.equal(validState({ ...aligned().snapshot(), ...changes }), false);
  }
  assert.equal(validMessage({ type: 'state', state: aligned().snapshot() }, 'guest'), false);
  assert.equal(validMessage({ type: 'sample', sample }, 'host'), false);
  assert.equal(validMessage({ type: 'resync', requestId: '' }, 'guest'), false);
});

test('audit reproductions and partly invalid batches leave relay queues and sequences unchanged', () => {
  const rooms = new Rooms(), host = rooms.create(hello), guest = rooms.join(host.code, hello);
  for (const [token, messages] of [
    [host.token, [{ type: 'state', state: {} }]],
    [guest.token, [{ type: 'sample', sample: [] }]],
    [guest.token, [{ type: 'intent', epoch: -1, intent: { type: 'seek', time: '12' } }]],
    [guest.token, [{ type: 'ready', epoch: 0 }, { type: 'sample', sample: {} }]]
  ]) {
    const sender = rooms.authenticate(token), before = structuredClone([...rooms.members.values()].map(member => member.events));
    assert.throws(() => rooms.relayData(sender, { sequence: 1, messages }), { code: 'INVALID_MESSAGE', retryable: false });
    assert.equal(sender.sentSequence, 0);
    assert.deepEqual([...rooms.members.values()].map(member => member.events), before);
  }
});

test('invalid direct timeline inputs never advance clocks, revisions or acknowledgements', () => {
  const timeline = aligned(), before = timeline.snapshot();
  for (const role of ['__proto__', 'constructor', 'outsider', null]) {
    assert.equal(timeline.ready(role, 0), false);
    assert.equal(timeline.intent(role, { type: 'play' }, 0), false);
    timeline.sample(role, sample);
  }
  for (const command of [null, {}, { type: 'seek', time: -1 }, { type: 'play', at: Infinity }, { type: 'pause', id: -1 }]) {
    assert.equal(timeline.intent('host', command, 0), false);
  }
  assert.deepEqual(timeline.snapshot(), before);
});

test('capability negotiation ignores unknown additions but rejects other protocols and unsupported requirements before joining', () => {
  assert.deepEqual(negotiate({ protocol: PROTOCOL, capabilities: ['relay-v2', 'future-feature'] }), ['relay-v2']);
  for (const old of [undefined, {}, { protocol: 2, capabilities: ['relay-v2'] }, { protocol: PROTOCOL }]) {
    assert.throws(() => negotiate(old), { code: 'INCOMPATIBLE_PROTOCOL' });
  }
  const rooms = new Rooms(), host = rooms.create(hello);
  for (const invalid of [{}, { protocol: 2, capabilities: ['relay-v2'] }, { ...hello, protocol: PROTOCOL + 1 }, { ...hello, capabilities: 'all' },
    { ...hello, requiredCapabilities: ['future-feature'] }, { ...hello, capabilities: ['relay-v2', 'relay-v2'] }]) {
    assert.throws(() => rooms.join(host.code, invalid), { code: 'INCOMPATIBLE_PROTOCOL' });
    assert.equal(rooms.rooms.get(host.code).locked, false);
    assert.equal(rooms.rooms.get(host.code).members.length, 1);
  }
  rooms.join(host.code, { protocol: PROTOCOL, capabilities: ['relay-v2', 'structured-errors-v1'] });
  assert.deepEqual(rooms.authenticate(host.token).events[0].capabilities, ['relay-v2', 'structured-errors-v1']);
});

test('event envelopes reject malformed payloads, ages, sequence ordering and wrong peer roles', () => {
  const event = { id: 1, type: 'data', at: 1000, ageMs: 0, message: { type: 'ready', epoch: 0 } };
  assert.equal(validEvents({ events: [event] }, 'host'), true);
  for (const response of [{}, { events: {} }, { events: [event, event] }, { events: [{ ...event, ageMs: -1 }] },
    { events: [{ ...event, id: -1 }] }, { events: [{ ...event, message: { type: 'sample', sample: [] } }] }]) {
    assert.equal(validEvents(response, 'host'), false);
  }
  assert.equal(validEvents({ events: [event] }, 'guest'), false);
});

test('seeded malformed numeric inputs are consistently rejected at every boundary', () => {
  let seed = 0x12345678;
  for (let index = 0; index < 250; index++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const value = -(seed + 1);
    assert.equal(validMessage({ type: 'intent', epoch: value, intent: { type: 'seek', time: 1 } }, 'guest'), false);
    assert.equal(validSample({ ...sample, time: value }), false);
    assert.equal(validState({ ...aligned().snapshot(), revision: value }), false);
  }
});
