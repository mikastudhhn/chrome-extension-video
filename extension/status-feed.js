import { fault, responseError } from './runtime-errors.js';

// One status stream per visible extension page. Embedded views consume its
// snapshot rather than issuing a second read. Mutation tickets invalidate reads
// already in flight; lifecycle revisions reject out-of-order owner snapshots.
export class StatusFeed {
  constructor({ request, changed, prepare = value => value, failed = () => {}, visible = () => true,
    interval = () => null, observePlayer = () => false, schedule = (...args) => globalThis.setTimeout(...args), unschedule = id => globalThis.clearTimeout(id) }) {
    Object.assign(this, { request, changed, prepare, failed, visible, interval, observePlayer, schedule, unschedule,
      state: null, generation: 0, pending: null, timer: null, disposed: false, notified: false, invalidated: false });
  }

  accept(state) {
    const previous = this.state?.lifecycle, next = state?.lifecycle;
    if (previous && next && previous.instanceId === next.instanceId && next.revision < previous.revision) return this.state;
    this.state = state;
    this.changed(this.state);
    return this.state;
  }

  async action(action, extra = {}) {
    const generation = ++this.generation;
    this.clearTimer();
    try {
      const response = await this.request(action, extra);
      if (generation !== this.generation || this.disposed) throw fault('ABORTED');
      if (!response?.ok) throw responseError(response);
      const state = await this.prepare(response.result);
      if (generation !== this.generation || this.disposed) throw fault('ABORTED');
      return this.accept(state);
    } finally { this.arm(); }
  }

  refresh() {
    if (this.disposed || !this.visible()) return Promise.resolve(this.state);
    if (this.pending) return this.pending;
    this.clearTimer();
    this.invalidated = false;
    const generation = this.generation;
    const result = (async () => {
      try {
        const response = await this.request('status', { observePlayer: this.observePlayer() });
        if (generation !== this.generation || this.disposed || !this.visible()) return this.state;
        if (!response?.ok) throw responseError(response);
        const state = await this.prepare(response.result);
        if (generation !== this.generation || this.disposed || !this.visible()) return this.state;
        return this.accept(state);
      } catch (error) {
        if (generation === this.generation && !this.disposed) this.failed(error);
        return this.state;
      }
    })();
    this.pending = result;
    void result.finally(() => { if (this.pending === result) this.pending = null; this.arm(); });
    return result;
  }

  notify() {
    if (this.disposed || !this.visible()) return;
    // A notification can arrive after the owner took the pending snapshot.
    // Retain it until a new read starts, including in a non-polling idle view.
    this.invalidated = true;
    if (this.pending || this.notified) return;
    this.clearTimer();
    this.arm();
  }

  arm() {
    if (this.disposed || !this.visible() || this.pending || this.timer !== null) return;
    const delay = this.invalidated ? 150 : this.interval(this.state);
    if (delay != null) {
      this.notified = this.invalidated;
      this.timer = this.schedule(() => { this.timer = null; this.notified = false; void this.refresh(); }, delay);
    }
  }
  clearTimer() { if (this.timer !== null) this.unschedule(this.timer); this.timer = null; this.notified = false; }
  dispose() { this.disposed = true; this.generation++; this.clearTimer(); }
}

export function observeStatus(feed, { runtime = chrome.runtime, storage = chrome.storage,
  page = document, windowObject = window } = {}) {
  const message = (message, sender) => {
    if (sender.id === runtime.id && message.target === 'session-observers') feed.notify();
  };
  const change = () => feed.notify();
  const visibility = () => { feed.clearTimer(); if (!page.hidden) void feed.refresh(); };
  const dispose = () => {
    feed.dispose();
    runtime.onMessage.removeListener(message);
    storage.onChanged.removeListener(change);
    page.removeEventListener('visibilitychange', visibility);
  };
  runtime.onMessage.addListener(message);
  storage.onChanged.addListener(change);
  page.addEventListener('visibilitychange', visibility);
  windowObject.addEventListener('pagehide', dispose, { once: true });
  return dispose;
}
