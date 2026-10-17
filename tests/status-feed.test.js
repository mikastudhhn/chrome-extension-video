import test from 'node:test';
import assert from 'node:assert/strict';
import { StatusFeed } from '../extension/status-feed.js';
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const state = revision => ({ lifecycle: { instanceId: 'instance', revision }, room: null, channel: 'experimental' });

test('overlapping refreshes share one request and an action invalidates an older status response', async () => {
  const pending = deferred(), seen = []; let reads = 0;
  const feed = new StatusFeed({ request: async action => {
    if (action === 'status') { reads++; return pending.promise; }
    return { ok: true, result: state(2) };
  }, changed: value => seen.push(value.lifecycle.revision) });
  const first = feed.refresh(), second = feed.refresh();
  assert.equal(first, second); assert.equal(reads, 1);
  await feed.action('leave');
  pending.resolve({ ok: true, result: state(1) }); await first;
  assert.deepEqual(seen, [2]); assert.equal(feed.state.lifecycle.revision, 2);
});

test('a late mutation cannot repaint after leave and older owner revisions cannot move UI backwards', async () => {
  const pending = deferred();
  const feed = new StatusFeed({ request: action => action === 'create' ? pending.promise : Promise.resolve({ ok: true, result: state(3) }), changed() {} });
  const create = feed.action('create'); const rejected = assert.rejects(create, { code: 'ABORTED' });
  await feed.action('leave'); pending.resolve({ ok: true, result: state(2) }); await rejected;
  feed.accept(state(1)); assert.equal(feed.state.lifecycle.revision, 3);
});

test('idle/hidden/disposed pages do not poll and notifications coalesce without postponing each other', async () => {
  const timers = new Map(); let id = 0, reads = 0, visible = true;
  const feed = new StatusFeed({ request: async () => { reads++; return { ok: true, result: state(reads) }; },
    changed() {}, visible: () => visible, schedule: (fn, ms) => { timers.set(++id, { fn, ms }); return id; }, unschedule: id => timers.delete(id) });
  await feed.refresh(); assert.equal(timers.size, 0);
  feed.notify(); feed.notify(); assert.equal(timers.size, 1); assert.equal(id, 1);
  const timer = timers.get(1); timers.delete(1); timer.fn(); await feed.pending;
  assert.equal(reads, 2); assert.equal(timers.size, 0);
  visible = false; feed.notify(); await feed.refresh(); assert.equal(reads, 2);
  visible = true; feed.notify(); feed.dispose(); assert.equal(timers.size, 0);
  await feed.refresh(); assert.equal(reads, 2);
});

test('a delayed preference read cannot repaint a status superseded by a user action', async () => {
  const delayed = deferred(), prepared = deferred(), seen = [];
  const feed = new StatusFeed({
    request: async action => ({ ok: true, result: state(action === 'status' ? 1 : 2) }),
    prepare: async value => { if (value.lifecycle.revision === 1) { prepared.resolve(); await delayed.promise; } return value; },
    changed: value => seen.push(value.lifecycle.revision)
  });
  const reading = feed.refresh(); await prepared.promise;
  await feed.action('leave'); delayed.resolve(); await reading;
  assert.deepEqual(seen, [2]);
});

for (const phase of ['read', 'prepare']) {
  test(`idle invalidations during a pending ${phase} produce exactly one follow-up read`, async () => {
    const held = deferred(), reached = deferred(), timers = new Map();
    let reads = 0, timerId = 0;
    const feed = new StatusFeed({
      request: async () => { reads++; if (reads === 1 && phase === 'read') { reached.resolve(); await held.promise; } return { ok: true, result: state(reads) }; },
      prepare: async value => { if (value.lifecycle.revision === 1 && phase === 'prepare') { reached.resolve(); await held.promise; } return value; },
      changed() {}, schedule: fn => { timers.set(++timerId, fn); return timerId; }, unschedule: id => timers.delete(id)
    });
    const first = feed.refresh(); await reached.promise;
    feed.notify(); feed.notify(); feed.notify();
    assert.equal(timers.size, 0, 'never overlap a read');
    held.resolve(); await first;
    assert.equal(timers.size, 1);
    feed.notify(); assert.equal(timerId, 1, 'do not postpone the follow-up');
    const [id, run] = timers.entries().next().value; timers.delete(id); run(); await feed.pending;
    assert.equal(reads, 2); assert.equal(feed.state.lifecycle.revision, 2);
    assert.equal(timers.size, 0, 'return to event-driven idle after the fresh read');
  });
}

for (const ending of ['action', 'hidden', 'dispose']) {
  test(`a pending invalidation respects ${ending} before the stale read completes`, async () => {
    const held = deferred(), timers = new Map(); let id = 0, reads = 0, visible = true;
    const feed = new StatusFeed({
      request: async action => { if (action === 'status') { reads++; return held.promise; } return { ok: true, result: state(2) }; },
      changed() {}, visible: () => visible,
      schedule: fn => { timers.set(++id, fn); return id; }, unschedule: id => timers.delete(id)
    });
    const pending = feed.refresh(); feed.notify();
    if (ending === 'action') await feed.action('leave');
    if (ending === 'hidden') visible = false;
    if (ending === 'dispose') feed.dispose();
    held.resolve({ ok: true, result: state(1) }); await pending;
    assert.equal(reads, 1);
    assert.equal(timers.size, ending === 'action' ? 1 : 0);
    assert.equal(feed.state?.lifecycle.revision, ending === 'action' ? 2 : undefined);
    feed.dispose();
  });
}
