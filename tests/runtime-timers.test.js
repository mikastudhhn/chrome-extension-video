import test from 'node:test';
import assert from 'node:assert/strict';
import { StatusFeed } from '../extension/status-feed.js';
import { SessionLifecycle } from '../extension/session-lifecycle.js';
import { Diagnostics } from '../extension/diagnostics.js';

const cases = {
  'status notifications': () => {
    const feed = new StatusFeed({ request() {}, changed() {} });
    feed.notify(); feed.dispose();
  },
  'session watchdog': () => {
    const session = new SessionLifecycle({ requestPlayer() {}, connect() {} });
    session.room = { role: 'host' };
    session.scheduleTick(); session.invalidate();
  },
  'diagnostic expiry': () => {
    const diagnostics = new Diagnostics();
    diagnostics.record('phase', { phase: 'disconnected' }); diagnostics.clear();
  }
};
for (const [name, exercise] of Object.entries(cases)) test(`${name} calls default browser timers with their global receiver`, () => {
  const original = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  const scheduled = [], cleared = [];
  // Native Window timers reject a class instance as their receiver; Node timers
  // accept it, so existing fake-scheduler tests cannot expose this browser error.
  globalThis.setTimeout = function(callback, delay) {
    assert.equal(this, globalThis, 'Window.setTimeout receiver');
    scheduled.push({ callback, delay }); return scheduled.length;
  };
  globalThis.clearTimeout = function(id) {
    assert.equal(this, globalThis, 'Window.clearTimeout receiver'); cleared.push(id);
  };
  try {
    exercise();
    assert.equal(scheduled.length, 1);
    assert.deepEqual(cleared, [1]);
  } finally { Object.assign(globalThis, original); }
});
