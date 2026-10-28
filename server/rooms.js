import { randomBytes } from 'node:crypto';
import { transientKey, validBatch, normalizeMessage, negotiate, LIMITS, SHORT_CODE_ALPHABET } from '../extension/protocol.js';
import { fault } from '../extension/runtime-errors.js';
import { clientLabel } from './operating-counters.js';

function shortCode() {
  const bytes = randomBytes(6);
  return [...bytes].map(byte => SHORT_CODE_ALPHABET[byte % SHORT_CODE_ALPHABET.length]).join('');
}

export class RoomError extends Error {
  constructor(status, code) { const error = fault(code, status); super(error.message); Object.assign(this, error); }
}

// Every limit bounds memory or seat usage without inspecting personal data.
export const ROOM_LIMITS = Object.freeze({
  idleMs: 300_000, // a member without a successful request for 5 minutes ends the room
  unjoinedMs: 1_800_000, // an invitation nobody accepted expires after 30 minutes
  lifetimeMs: 43_200_000, // every room ends after 12 hours
  rooms: 500, // concurrent rooms on this server
  roomsPerClient: 3, // concurrent rooms created by one address (IPv6: per /64)
  memberQueueBytes: 262_144, // serialized messages waiting for one receiver
  queueBudgetBytes: 16 * 1024 * 1024 // serialized messages waiting on the whole server
});

export class Rooms {
  constructor({ now = Date.now, idleMs = ROOM_LIMITS.idleMs, unjoinedMs = ROOM_LIMITS.unjoinedMs, lifetimeMs = ROOM_LIMITS.lifetimeMs,
    limit = ROOM_LIMITS.rooms, roomsPerClient = ROOM_LIMITS.roomsPerClient, memberQueueBytes = ROOM_LIMITS.memberQueueBytes,
    queueBudgetBytes = ROOM_LIMITS.queueBudgetBytes, counters = null } = {}) {
    Object.assign(this, { counters, now, idleMs, unjoinedMs, lifetimeMs, limit, roomsPerClient, memberQueueBytes, queueBudgetBytes });
    this.rooms = new Map();
    this.members = new Map();
    this.owners = new Map(); // address key -> open rooms it created; never logged
    this.queuedBytes = 0;
  }

  // `owner` is the creator's address key; undefined means not counted (local use).
  create(client, owner) {
    const capabilities = negotiate(client);
    this.sweep();
    if (this.rooms.size >= this.limit) throw new RoomError(503, 'SERVER_BUSY');
    if (owner !== undefined && (this.owners.get(owner) || 0) >= this.roomsPerClient) {
      if (this.counters) this.counters.limited.rooms++;
      throw new RoomError(429, 'RATE_LIMITED');
    }
    let code = shortCode();
    while (this.rooms.has(code)) code = shortCode();
    const room = { code, members: [], locked: false, created: this.now(), owner };
    this.rooms.set(room.code, room);
    if (owner !== undefined) this.owners.set(owner, (this.owners.get(owner) || 0) + 1);
    if (this.counters) this.counters.rooms.created++;
    return this.add(room, 'host', capabilities, clientLabel(client));
  }

  join(code, client) {
    const capabilities = negotiate(client);
    this.sweep();
    const room = this.rooms.get(code);
    if (!room) throw new RoomError(404, 'ROOM_NOT_FOUND');
    if (room.locked) throw new RoomError(409, 'ROOM_FULL');
    room.locked = true;
    room.joined = this.now();
    if (this.counters) this.counters.rooms.joined++;
    const guest = this.add(room, 'guest', capabilities, clientLabel(client));
    this.push(room.members[0], { type: 'peer-joined', capabilities });
    return guest;
  }

  // `client` is the extension build label, kept for aggregate counts and error context.
  add(room, role, capabilities, client = 'unknown') {
    const member = {
      capabilities, token: randomBytes(32).toString('base64url'), room, role, client,
      touched: this.now(), events: [], queuedBytes: 0, sequence: 0, sentSequence: 0, wait: null
    };
    if (this.counters) this.counters.seat(client);
    room.members.push(member);
    this.members.set(member.token, member);
    return { code: room.code, token: member.token, role, peerCapabilities: room.members.find(peer => peer !== member)?.capabilities || [] };
  }

  // Authentication alone never refreshes activity; only successful polls and
  // relays do (see touch), so rejected requests cannot keep a room alive.
  authenticate(token) {
    const member = typeof token === 'string' ? this.members.get(token) : undefined;
    const expired = member && this.expired(member.room);
    if (expired) this.close(member.room, expired);
    if (!member || !this.members.has(token)) throw new RoomError(401, 'SESSION_ENDED');
    return member;
  }

  touch(member) { if (this.members.has(member.token)) member.touched = this.now(); }

  expired(room) {
    const now = this.now();
    if (room.members.some(member => now - member.touched > this.idleMs)) return 'idle';
    if (now - room.created > (room.members.length < 2 ? this.unjoinedMs : this.lifetimeMs)) return 'expired';
    return null;
  }

  push(member, event, bytes = 0) {
    member.events.push({ ...event, id: ++member.sequence, bytes });
    member.queuedBytes += bytes;
    this.queuedBytes += bytes;
    // An unavailable receiver cannot accumulate unbounded signaling data.
    if (member.events.length > LIMITS.events || member.queuedBytes > this.memberQueueBytes) { this.close(member.room, 'overflow'); return; }
    member.wait?.();
  }

  drop(member, index, count = 1) {
    for (const event of member.events.splice(index, count)) { member.queuedBytes -= event.bytes || 0; this.queuedBytes -= event.bytes || 0; }
  }

  relayData(member, batch) {
    if (!validBatch(batch, member.role)) throw new RoomError(400, 'INVALID_MESSAGE');
    // Forward only protocol fields; the rebuilt message has a bounded size.
    const messages = batch.messages.map(message => normalizeMessage(message, member.role));
    const sizes = messages.map(message => Buffer.byteLength(JSON.stringify(message)));
    if (sizes.some(size => size > LIMITS.messageBytes)) throw new RoomError(413, 'REQUEST_TOO_LARGE');
    // POST retries after lost responses must never replay Play/Seek/Resync.
    if (batch.sequence <= member.sentSequence) { if (this.counters) this.counters.batchReplays++; this.touch(member); return; }
    if (batch.sequence !== member.sentSequence + 1) throw new RoomError(400, 'INVALID_SEQUENCE');
    const other = member.room.members.find(peer => peer !== member);
    if (!other) throw new RoomError(409, 'PEER_MISSING');
    // A shared budget keeps the whole process inside its memory limit; the
    // sender retries this retryable rejection after the receivers catch up.
    if (this.queuedBytes + sizes.reduce((sum, size) => sum + size, 0) > this.queueBudgetBytes) throw new RoomError(503, 'SERVER_BUSY');
    for (const [position, message] of messages.entries()) {
      const key = transientKey(message);
      if (key) {
        for (let index = other.events.length - 1; index >= 0; index--) {
          const queued = other.events[index];
          const queuedKey = queued.type === 'data' && transientKey(queued.message);
          if (!queuedKey) break;
          if (queuedKey === key) { this.drop(other, index); break; }
        }
      }
      this.push(other, { type: 'data', message, at: this.now() }, sizes[position]);
      if (!this.members.has(member.token)) return; // overflow closed the room
    }
    member.sentSequence = batch.sequence;
    this.touch(member);
  }

  async poll(member, after, signal, timeoutMs = 20_000) {
    if (!Number.isSafeInteger(after) || after < 0 || after > member.sequence) throw new RoomError(400, 'INVALID_SEQUENCE');
    // A newer poll for the same member takes over; the parked one answers empty.
    if (member.wait) member.wait(true);
    this.touch(member);
    const acknowledged = member.events.findIndex(event => event.id > after);
    this.drop(member, 0, acknowledged < 0 ? member.events.length : acknowledged);
    if (member.events.length || signal.aborted) return this.deliver(member);
    let superseded = false;
    await new Promise(resolve => {
      const finish = (replaced = false) => {
        superseded = replaced === true;
        clearTimeout(timer);
        signal.removeEventListener('abort', aborted);
        if (member.wait === finish) member.wait = null;
        resolve();
      };
      const aborted = () => finish();
      const timer = setTimeout(finish, timeoutMs);
      member.wait = finish;
      signal.addEventListener('abort', aborted, { once: true });
    });
    if (superseded) { if (this.counters) this.counters.supersededPolls++; return []; }
    this.touch(member);
    return this.deliver(member);
  }

  // How long relayed data waited for the receiver, counted at its first delivery.
  deliver(member) {
    const now = this.now();
    for (const event of member.events) {
      if (event.type !== 'data' || event.delivered) continue;
      event.delivered = true;
      if (this.counters) this.counters.delivered(now - event.at);
    }
    return member.events;
  }

  close(room, reason = 'other') {
    if (!room) return;
    if (!this.rooms.delete(room.code)) return;
    if (this.counters) {
      this.counters.closed[Object.hasOwn(this.counters.closed, reason) ? reason : 'other']++;
      this.counters.roomClosed(room, this.now());
    }
    if (room.owner !== undefined) {
      const owned = (this.owners.get(room.owner) || 1) - 1;
      if (owned > 0) this.owners.set(room.owner, owned); else this.owners.delete(room.owner);
    }
    for (const member of room.members) {
      // Replace the queue instead of emptying it in place; only release its byte budget.
      this.queuedBytes -= member.queuedBytes;
      member.queuedBytes = 0;
      member.events = [{ type: 'room-closed', id: ++member.sequence, bytes: 0 }];
      member.wait?.();
      this.members.delete(member.token);
    }
  }

  sweep() {
    for (const room of this.rooms.values()) {
      const expired = this.expired(room);
      if (expired) this.close(room, expired);
    }
  }

  // Aggregate numbers only, for operating logs.
  status() {
    let joined = 0, parked = 0;
    for (const room of this.rooms.values()) if (room.members.length === 2) joined++;
    for (const member of this.members.values()) if (member.wait) parked++;
    return { activeRooms: this.rooms.size, joinedRooms: joined, activeMembers: this.members.size, parkedPolls: parked, queuedBytes: this.queuedBytes };
  }
}

// Poll responses expose only protocol fields, never internal bookkeeping.
export function publicEvent(event, now) {
  if (event.type === 'data') return { id: event.id, type: 'data', at: event.at, ageMs: Math.max(0, now - event.at), message: event.message };
  if (event.type === 'peer-joined') return { id: event.id, type: 'peer-joined', capabilities: event.capabilities };
  return { id: event.id, type: event.type };
}
