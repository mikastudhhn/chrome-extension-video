import { randomUUID, randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { fault } from '../extension/runtime-errors.js';
import { negotiate } from '../extension/protocol.js';

// A lease makes expired/restarted retries fail closed even after cache eviction.
// Request IDs and cached member credentials are secrets, never diagnostic labels.
export class RoomRequests {
  constructor({ now = Date.now, limit = 2000, leaseMs = 60_000, replayed = () => {} } = {}) {
    Object.assign(this, { now, limit, leaseMs, replayed });
    this.instance = randomUUID();
    this.secret = randomBytes(32);
    this.entries = new Map();
  }

  proof(expiresAt) {
    return createHmac('sha256', this.secret).update(String(expiresAt)).digest('hex');
  }

  offer() {
    const expiresAt = this.now() + this.leaseMs;
    return { version: 1, instance: this.instance, expiresAt, proof: this.proof(expiresAt) };
  }

  run(handshake, target, rooms, create) {
    negotiate(handshake);
    const key = handshake.roomRequest;
    if (key === undefined) return create(); // Without a lease the request is not memoized.
    if (!key || typeof key !== 'object' || Array.isArray(key) ||
        typeof key.id !== 'string' || !/^[0-9a-f-]{36}$/.test(key.id) || typeof key.proof !== 'string' ||
        !/^[0-9a-f]{64}$/.test(key.proof) || !Number.isSafeInteger(key.expiresAt)) throw fault('INVALID_MESSAGE', 400);
    if (key.instance !== this.instance || key.expiresAt <= this.now() ||
        !timingSafeEqual(Buffer.from(key.proof, 'hex'), Buffer.from(this.proof(key.expiresAt), 'hex'))) throw fault('ROOM_REQUEST_EXPIRED', 409);
    this.sweep();
    const fingerprint = JSON.stringify([target, key.expiresAt, handshake.protocol ?? null,
      handshake.capabilities ?? null, handshake.requiredCapabilities ?? null]);
    const previous = this.entries.get(key.id);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw fault('ROOM_REQUEST_CONFLICT', 409);
      if (!rooms.members.has(previous.result.token)) throw fault('SESSION_ENDED', 401);
      if (previous.replays >= 10) throw fault('RATE_LIMITED', 429);
      previous.replays++;
      this.replayed();
      return previous.result;
    }
    // Never evict an unexpired result to make room: that would permit duplicates.
    if (this.entries.size >= this.limit) throw fault('SERVER_BUSY', 503);
    const result = create(); // Synchronous mutation and memoization, no await gap.
    this.entries.set(key.id, { fingerprint, expiresAt: key.expiresAt, result, replays: 0 });
    return result;
  }

  sweep() {
    for (const [id, entry] of this.entries) if (entry.expiresAt <= this.now()) this.entries.delete(id);
  }

  clear() { this.entries.clear(); }
}
