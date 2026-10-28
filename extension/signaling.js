import { PROTOCOL, CAPABILITIES, negotiate, validMember, validMessage, validBatch, validEvents, transientKey } from './protocol.js';
import { fault, httpError, normalizeError } from './runtime-errors.js';
export { transientKey } from './protocol.js';
// How long a lane may keep failing before the room treats it as interrupted.
export const RECONNECT_GRACE_MS = 1500;
// Upper bound for one serialized relay POST body.
export const MAX_BATCH_BYTES = 8 * 1024;
const encoder = new TextEncoder();
// The worker owns one ordered, authenticated HTTPS connection per room member.
export class Signaling {
  // `client` names this build in create/join handshakes ({ version, distribution, channel }).
  constructor(base, onEvent, onError, onStatus = () => {}, client = null) {
    this.base = base;
    this.client = client;
    this.onEvent = onEvent;
    this.onError = onError;
    this.onStatus = onStatus;
    this.abort = new AbortController();
    this.member = null;
    this.cursor = 0;
    this.sequence = 0;
    this.queue = [];
    this.sending = false;
    this.pendingBatch = null;
    this.reconnecting = {};
    this.reconnectGraceMs = RECONNECT_GRACE_MS;
  }

  async request(path, method = 'GET', data, timeout = 25_000) {
    const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(timeout)]);
    let response, body;
    try { response = await fetch(`${this.base}${path}`, {
      method, credentials: 'omit', cache: 'no-store',
      headers: { Accept: 'application/json',
        ...(this.member ? { Authorization: `Bearer ${this.member.token}` } : {}),
        ...(data ? { 'Content-Type': 'application/json' } : {}) },
      body: data ? JSON.stringify(data) : undefined,
      signal
    });
      // Body reception can fail after successful headers. Only parse a complete
      // body so network loss/timeout cannot masquerade as invalid JSON.
      body = await response.text();
    } catch (error) { throw normalizeError(signal.aborted ? signal.reason : error, 'NETWORK_ERROR'); }
    let result;
    try { result = JSON.parse(body); } catch {
      if (!response.ok) throw httpError(null, response.status);
      throw fault('INVALID_RESPONSE');
    }
    if (!response.ok) throw httpError(result, response.status);
    if (path === '/relay' && result?.ok !== true) throw fault('INVALID_RESPONSE');
    return result;
  }

  resume(checkpoint) {
    if (!checkpoint || !validMember(checkpoint.member, checkpoint.member?.role) ||
        !Number.isSafeInteger(checkpoint.cursor) || checkpoint.cursor < 0 ||
        !Number.isSafeInteger(checkpoint.sequence) || checkpoint.sequence < 0 ||
        !Array.isArray(checkpoint.queue) || checkpoint.queue.length > 128 ||
        !checkpoint.queue.every(message => validMessage(message, checkpoint.member.role)) ||
        (checkpoint.pendingBatch && (!validBatch(checkpoint.pendingBatch, checkpoint.member.role) || checkpoint.pendingBatch.sequence !== checkpoint.sequence))) throw fault('INVALID_RESPONSE');
    negotiate(checkpoint.member);
    this.member = checkpoint.member;
    this.cursor = checkpoint.cursor;
    this.sequence = checkpoint.sequence;
    this.queue = checkpoint.queue;
    this.pendingBatch = checkpoint.pendingBatch;
    void this.flush();
    return this.member;
  }

  suspend() {
    this.abort.abort();
    return { member: this.member, cursor: this.cursor, sequence: this.sequence,
      queue: [...this.queue], pendingBatch: this.pendingBatch };
  }

  async open(code) {
    // Only this signed, leased operation can repeat an unauthenticated POST.
    // Never refresh the lease or replace its ID after an uncertain response.
    const offer = (await this.request('/health', 'GET', undefined, 4000))?.roomRequests;
    if (offer?.version !== 1 || typeof offer.instance !== 'string' || !/^[0-9a-f-]{36}$/.test(offer.instance) ||
        !Number.isSafeInteger(offer.expiresAt) || typeof offer.proof !== 'string' || !/^[0-9a-f]{64}$/.test(offer.proof)) throw fault('INCOMPATIBLE_PROTOCOL');
    const handshake = { protocol: PROTOCOL, capabilities: CAPABILITIES, roomRequest: { id: crypto.randomUUID(),
      instance: offer.instance, expiresAt: offer.expiresAt, proof: offer.proof }, ...(this.client ? { client: this.client } : {}) };
    let member;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        member = await this.request(code ? `/rooms/${encodeURIComponent(code)}/join` : '/rooms', 'POST', handshake, 4000);
        break;
      } catch (error) {
        if (this.abort.signal.aborted) throw fault('ABORTED');
        // Permanent responses, admission failures and conflicts are never retried.
        const admissionFailure = ['SERVER_BUSY', 'SERVER_DRAINING'].includes(error.code);
        const uncertain = !admissionFailure && ((!error.status && (!error.code ||
          ['NETWORK_ERROR', 'TIMEOUT', 'INVALID_RESPONSE'].includes(error.code))) || error.status === 408 || error.status >= 500);
        // A later rejection cannot prove that the earlier uncertain POST did nothing.
        if (!uncertain) throw attempt > 0 ? fault('ROOM_SETUP_UNCERTAIN') : error;
        if (attempt === 2) throw fault('ROOM_SETUP_UNCERTAIN');
      }
    }
    if (member?.protocol !== PROTOCOL) throw fault('INCOMPATIBLE_PROTOCOL');
    if (!validMember(member, code ? 'guest' : 'host')) throw fault('INVALID_RESPONSE');
    negotiate(member);
    this.member = member;
    if (this.abort.signal.aborted) { await this.close(); throw fault('ABORTED'); }
    return this.member;
  }

  supports(capability) {
    return !!this.member && CAPABILITIES.includes(capability) && negotiate(this.member).includes(capability) &&
      this.member.peerCapabilities.includes(capability);
  }

  // A single failed request is usually retried within a few hundred
  // milliseconds. Report a lane as reconnecting only once its failure has
  // persisted; the room's freshness check independently pauses real outages.
  async retry(operation, lane) {
    let attempt = 0, failedAt = null, timer = null;
    const started = Date.now();
    const report = () => {
      clearTimeout(timer); timer = null;
      if (this.reconnecting[lane] || this.abort.signal.aborted) return;
      this.reconnecting[lane] = true;
      this.onStatus({ lane, reconnecting: true });
    };
    try {
      while (!this.abort.signal.aborted) {
        try {
          const result = await operation();
          if (this.reconnecting[lane]) {
            this.reconnecting[lane] = false;
            this.onStatus({ lane, reconnecting: false });
          }
          return result;
        } catch (error) {
          if (this.abort.signal.aborted) throw error;
          const transient = typeof error.retryable === 'boolean' ? error.retryable : !error.status || [408, 409, 429].includes(error.status) || error.status >= 500;
          if (!transient || Date.now() - started >= 240_000) throw error;
          failedAt ??= Date.now();
          if (Date.now() - failedAt >= this.reconnectGraceMs) report();
          else timer ??= setTimeout(report, this.reconnectGraceMs - (Date.now() - failedAt));
          const delay = error.status === 429 ? 5000 : Math.min(5000, 300 * 2 ** Math.min(attempt++, 5));
          await new Promise(resolve => {
            const finish = () => { clearTimeout(wait); this.abort.signal.removeEventListener('abort', finish); resolve(); };
            const wait = setTimeout(finish, delay + Math.random() * 200);
            this.abort.signal.addEventListener('abort', finish, { once: true });
          });
        }
      }
      throw fault('ABORTED');
    } finally { clearTimeout(timer); }
  }

  async poll() {
    try {
      while (!this.abort.signal.aborted) {
        const response = await this.retry(() => this.request(`/events?after=${this.cursor}`), 'receive');
        if (!validEvents(response, this.member.role)) throw fault('INVALID_RESPONSE');
        const { events } = response;
        for (const event of events) {
          if (this.abort.signal.aborted) return;
          if (event.id <= this.cursor) continue;
          if (event.type === 'peer-joined') this.member.peerCapabilities = event.capabilities;
          await this.onEvent(event);
          this.cursor = event.id;
        }
      }
    } catch (error) { if (!this.abort.signal.aborted) this.onError(error); }
  }

  send(message) {
    if (this.abort.signal.aborted) return;
    if (!validMessage(message, this.member?.role)) { this.onError(fault('INVALID_MESSAGE')); return; }
    const key = transientKey(message);
    // Coalesce telemetry, but never across a user command or reset acknowledgement.
    if (key) {
      for (let index = this.queue.length - 1; index >= 0; index--) {
        const queuedKey = transientKey(this.queue[index]);
        if (!queuedKey) break;
        if (queuedKey === key) { this.queue.splice(index, 1); break; }
      }
    }
    this.queue.push(message);
    if (this.queue.length > 128) { this.onError(fault('QUEUE_FULL')); return; }
    // Messages sent in the same task share one batch.
    if (!this.flushQueued) {
      this.flushQueued = true;
      queueMicrotask(() => { this.flushQueued = false; void this.flush(); });
    }
  }

  // Each POST body stays within MAX_BATCH_BYTES (the relay rejects larger
  // bodies). A part is an ordinary batch with its own sequence number; a lone
  // oversized message still travels alone and is rejected by validation upstream.
  nextBatch() {
    const messages = [];
    let bytes = encoder.encode(`{"sequence":${this.sequence + 1},"messages":[]}`).length;
    while (this.queue.length && messages.length < 32) {
      const size = encoder.encode(JSON.stringify(this.queue[0])).length + (messages.length ? 1 : 0);
      if (messages.length && bytes + size > MAX_BATCH_BYTES) break;
      messages.push(this.queue.shift());
      bytes += size;
    }
    return { sequence: ++this.sequence, messages };
  }

  async flush() {
    if (this.sending || this.abort.signal.aborted) return;
    this.sending = true;
    try {
      while ((this.pendingBatch || this.queue.length) && !this.abort.signal.aborted) {
        const batch = this.pendingBatch ??= this.nextBatch();
        // Keep precisely the same sequence and payload after a lost HTTP response.
        await this.retry(() => this.request('/relay', 'POST', batch, 4000), 'send');
        this.pendingBatch = null;
      }
    } catch (error) { if (!this.abort.signal.aborted) this.onError(error); }
    finally { this.sending = false; }
  }

  async close() {
    this.abort.abort();
    this.queue = [];
    if (!this.member) return;
    // Independent, short cleanup request; do not keep a stopped worker alive for 25 s.
    const headers = { Authorization: `Bearer ${this.member.token}` };
    await fetch(`${this.base}/leave`, { method: 'POST', credentials: 'omit', headers, signal: AbortSignal.timeout(3000) }).catch(() => {});
  }
}
