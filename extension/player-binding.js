import { fault, responseError } from './runtime-errors.js';
import { validSample } from './protocol.js';

// One selected document, with a separate lifetime for its active player binding.
// Browser script execution cannot be cancelled. Identity and expiry travel with
// commands; locally every pending reply is invalidated before replacing a binding.
export class PlayerBinding {
  constructor(request, { timeoutMs = 2000 } = {}) {
    this.request = request;
    this.timeoutMs = timeoutMs;
    this.selection = null;
    this.local = null;
    this.active = false;
    this.generation = 0;
    this.abort = new AbortController();
    this.inFlight = null;
  }

  invalidate() {
    this.generation++;
    this.abort.abort();
    this.abort = new AbortController();
    this.inFlight = null;
  }

  async attach(selection) {
    const cleanup = this.detach(false);
    const generation = this.generation;
    await cleanup;
    this.assertCurrent(generation);
    this.selection = { ...selection, bindingId: crypto.randomUUID() };
    this.local = null;
    try {
      const result = await this.call('attach');
      this.assertCurrent(generation);
      this.selection.documentId = result.documentId;
      this.selection.playerId = result.playerId || result.sample?.playerId || null;
      this.selection.frameId = result.frameId ?? selection.frameId;
      this.accept(result.sample);
      this.active = true;
      return this.local;
    } catch (error) {
      if (generation === this.generation) { this.selection = null; this.local = null; }
      throw error;
    }
  }

  async refresh() {
    if (!this.selection) throw new Error('Zuerst ein Video verbinden.');
    if (!this.active) return this.attach(this.selection);
    return this.sample();
  }

  async observe() { return this.active ? this.sample() : this.accept(await this.call('observe')); }
  async sample() { return this.accept(await this.call('sample')); }
  async apply(command) { return this.accept(await this.call('apply', command)); }

  accept(sample) {
    if (!validSample(sample)) throw fault('INVALID_MESSAGE');
    this.local = sample;
    return sample;
  }

  assertCurrent(generation) {
    if (generation !== this.generation) throw fault('ABORTED');
  }

  async call(action, command) {
    if (!this.selection) throw new Error('Zuerst ein Video verbinden.');
    // A timeout does not end executeScript. Do not accumulate browser operations
    // while a frozen document still owns the previous one.
    if (this.inFlight) throw fault('PLAYER_TIMEOUT');
    const generation = this.generation, signal = this.abort.signal;
    const identity = { expectedMediaId: this.local?.mediaId, expectedBindingId: this.selection.bindingId,
      expectedPlayerId: this.local?.playerId };
    const timeoutMs = action === 'attach' ? Math.max(10000, this.timeoutMs) : this.timeoutMs;
    const message = { ...this.selection, action, requestDeadline: Date.now() + timeoutMs - 100,
      command: { ...identity, ...(action === 'attach' ? { bindingId: this.selection.bindingId } : {}), ...command } };
    let timer, cancel;
    const operation = Promise.resolve().then(() => { this.assertCurrent(generation); return this.request(message); });
    this.inFlight = operation;
    const settled = operation.finally(() => { if (this.inFlight === operation) this.inFlight = null; });
    try {
      const response = await Promise.race([settled, new Promise((_, reject) => {
        cancel = () => reject(fault('ABORTED'));
        signal.addEventListener('abort', cancel, { once: true });
        timer = setTimeout(() => reject(fault('PLAYER_TIMEOUT')), timeoutMs);
      })]);
      this.assertCurrent(generation);
      if (!response?.ok) throw responseError(response);
      return response.result;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
    }
  }

  async detach(remember = true) {
    const selection = this.selection, sample = this.local;
    this.invalidate();
    this.active = false;
    this.local = remember && sample ? { ...sample, paused: true, advancing: false, intents: [] } : null;
    if (!remember) this.selection = null;
    else if (this.selection) this.selection = { ...this.selection, bindingId: null };
    if (!selection) return;
    // Cleanup is bounded, belongs only to the old binding, and never publishes a
    // reply. It may run alongside an already invalidated script operation.
    let timer;
    await Promise.race([
      Promise.resolve().then(() => this.request({ ...selection, action: 'detach', requestDeadline: Date.now() + this.timeoutMs - 100, command: {
        expectedMediaId: sample?.mediaId, expectedBindingId: selection.bindingId,
        expectedPlayerId: sample?.playerId
      } })).catch(() => {}),
      new Promise(resolve => { timer = setTimeout(resolve, this.timeoutMs); })
    ]).finally(() => clearTimeout(timer));
  }

  matchesNavigation({ tabId, frameId, documentId }) {
    return this.selection?.tabId === tabId && (frameId === 0 ||
      (this.selection.frameId === frameId && this.selection.documentId !== documentId));
  }
}
