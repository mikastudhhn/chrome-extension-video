import { Timeline, targetTime } from './timeline.js';
import { validMessage, validEvent, peerRole } from './protocol.js';
import { fault } from './runtime-errors.js';

// Unchanged state and samples are repeated at this interval; the peer treats
// them as stale after 2.5 s. Changes are sent immediately.
export const KEEPALIVE_MS = 1000;
const PING_MS = 2000;

// What the host's peer needs to see change. Position/at describe a linear
// clock while playing and are only compared while paused.
function stateSignature(state) {
  if (!state) return '';
  const { epoch, revision, phase, playing, wantsPlay, waiting, anchors, members, acknowledgedIntents, position } = state;
  return JSON.stringify([epoch, revision, phase, playing, wantsPlay, waiting, anchors, members, acknowledgedIntents, playing ? null : position]);
}

// Only fields the host's timeline reads leave this browser. Intents travel as
// their own messages; player identity, adapter and page timestamps stay local.
export function peerSample(sample) {
  const shared = { time: sample.time, duration: sample.duration, paused: sample.paused, buffering: sample.buffering, mediaId: sample.mediaId };
  if (typeof sample.blocked === 'boolean') shared.blocked = sample.blocked;
  if (typeof sample.advancing === 'boolean') shared.advancing = sample.advancing;
  return shared;
}

function sampleMoved(previous, next) {
  if (!previous) return true;
  if (['mediaId', 'duration', 'paused', 'buffering', 'blocked', 'advancing'].some(key => previous.sample[key] !== next.sample[key])) return true;
  const elapsed = previous.sample.advancing && Number.isFinite(previous.at) && Number.isFinite(next.at) ? (next.at - previous.at) / 1000 : 0;
  return Math.abs(next.sample.time - previous.sample.time - elapsed) > 0.25;
}

// Owns the room's transport and synchronization state. The existing Timeline
// remains the authority for scene anchors, epochs and acknowledged user intents.
export class RoomSession {
  constructor({ now, connect, failed, changed, diagnose = () => {}, wake = () => {} }) {
    this.diagnose = diagnose;
    // Asks the owner to apply a changed state now instead of on its next tick.
    this.wake = wake;
    this.now = now;
    this.connect = connect;
    this.failed = failed;
    this.changed = changed;
    this.timeline = new Timeline(now);
    Object.assign(this, { signal: null, state: null, role: null, peerJoined: false, retrying: {},
      connected: false, reconnecting: false, lastPeer: now(), lastState: 0,
      clockOffset: 0, clockSamples: [], lastPing: 0, rtt: null, lastEpoch: -1, lastRevision: -1,
      closed: false, local: null, lastPublished: -Infinity, shared: null, sharedAt: -Infinity });
  }

  async open(server, code, local, checkpoint) {
    this.local = local;
    if (checkpoint) {
      Object.assign(this.timeline, checkpoint.timeline, { now: this.now });
      this.state = checkpoint.state;
      this.peerJoined = checkpoint.peerJoined;
      if (checkpoint.connection.member.role === 'guest') this.awaitingEpoch = checkpoint.state?.epoch;
    }
    this.signal = this.connect(server, event => this.event(event), error => {
      if (!this.closed) this.failed(error);
    }, status => {
      if (!this.closed) {
        if (this.retrying[status.lane] !== status.reconnecting) this.diagnose('transport', { lane: status.lane, reconnecting: status.reconnecting });
        this.retrying[status.lane] = status.reconnecting; this.changed();
      }
    });
    const member = await this.signal.open(code, checkpoint?.connection);
    if (this.closed) throw fault('ABORTED');
    Object.assign(this, member);
    this.peerJoined ||= member.role === 'guest';
    this.timeline.sample(member.role, this.local);
  }

  send(message) { if (!this.closed && this.peerJoined && this.role) this.signal.send(message); }

  sample(sample) {
    const changedVideo = this.local && this.local.mediaId !== sample.mediaId;
    this.local = sample;
    if (changedVideo) this.diagnose('alignment', { reason: 'player-changed' });
    if (!this.role || this.closed) return;
    if (changedVideo && this.role === 'guest') this.awaitingEpoch = this.state?.epoch;
    if (this.role === 'host') this.timeline.sample('host', sample);
    else this.share(sample);
    for (const intent of sample.intents || []) this.intent(intent);
    if (this.role === 'host') this.publish();
  }

  // Guest samples: on a change of what the host reads, otherwise as keepalive.
  share(sample = this.local, force = false) {
    if (!sample) return;
    const next = { sample: peerSample(sample), at: sample.at };
    if (!force && !sampleMoved(this.shared, next) && this.now() - this.sharedAt < KEEPALIVE_MS) return;
    this.shared = next; this.sharedAt = this.now();
    this.send({ type: 'sample', sample: next.sample });
  }

  intent(intent) {
    if (!this.state || !['play', 'pause', 'seek'].includes(intent.type)) return;
    if (intent.id !== undefined && this.sentIntent?.mediaId === intent.mediaId && this.sentIntent.id >= intent.id) return;
    const epoch = Number.isSafeInteger(intent.epoch) ? intent.epoch : this.state.epoch;
    if (intent.id !== undefined) {
      if (intent.type !== 'pause' && this.local?.mediaId === intent.mediaId && this.local.intents?.at(-1)?.id === intent.id) {
        intent = { ...intent, time: this.local.time, at: this.local.at, advancing: this.local.advancing };
      }
      if (Number.isFinite(intent.at)) intent = { ...intent, at: intent.at + this.clockOffset };
    }
    if (this.role === 'host') {
      if (this.timeline.intent('host', intent, epoch)) {
        if (intent.type === 'pause') this.diagnose('pause', { reason: 'user' });
        this.publish();
      }
    } else {
      if (intent.type === 'pause') this.diagnose('pause', { reason: 'user' });
      this.send({ type: 'intent', intent, epoch });
    }
    if (intent.id !== undefined) this.sentIntent = { id: intent.id, mediaId: intent.mediaId };
  }

  // Host state: sent when it changes, otherwise repeated as keepalive.
  publish(force = false) {
    const previous = this.state;
    this.state = this.timeline.tick();
    if (previous?.playing && !this.state.playing && this.state.waiting) this.diagnose('pause', { reason: 'buffering' });
    const changed = stateSignature(previous) !== stateSignature(this.state);
    if (changed) this.wake();
    if (!force && !changed && this.now() - this.lastPublished < KEEPALIVE_MS) return;
    this.lastPublished = this.now();
    this.send({ type: 'state', state: this.state });
  }

  reset(reason = 'user') {
    if (!this.role || this.closed) return;
    this.diagnose('alignment', { reason });
    if (this.role === 'host') { this.timeline.reset(); this.publish(); }
    else { this.resetting = crypto.randomUUID(); this.send({ type: 'resync', requestId: this.resetting }); }
    this.changed();
  }

  interrupt(reason = 'network') {
    this.diagnose('pause', { reason });
    if (this.role === 'host') { this.timeline.suspend(); this.publish(); }
    else if (this.state) this.send({ type: 'intent', intent: { type: 'pause' }, epoch: this.state.epoch });
    this.clockSamples = [];
  }

  event(event) {
    if (this.closed) return;
    if (!validEvent(event, this.role)) { this.failed(fault('INVALID_MESSAGE')); return; }
    if (event.type === 'room-closed') { this.failed(fault('ROOM_CLOSED')); return; }
    if (event.type === 'peer-joined') { this.peerJoined = true; if (this.role === 'host') this.publish(true); }
    if (event.type === 'data') {
      const durable = event.message?.type === 'resync' || (event.message?.type === 'intent' && event.message.intent?.type === 'pause');
      if (event.ageMs > 2500 && !durable) return;
      try { this.receive(event.message); } catch { this.failed(fault('INVALID_MESSAGE')); }
    }
    this.changed();
  }

  receive(message) {
    if (!validMessage(message, peerRole(this.role))) throw fault('INVALID_MESSAGE');
    this.lastPeer = this.now();
    this.peerJoined = true;
    if (message.type === 'ping') { this.send({ type: 'pong', sent: message.sent, received: this.now() }); return; }
    if (message.type === 'pong') {
      const receivedAt = this.now(), rtt = receivedAt - message.sent;
      if (rtt >= 0 && rtt < 2500) {
        this.rtt = rtt;
        this.diagnose('rtt', { rttMs: rtt });
        this.clockSamples.push({ at: receivedAt, rtt, offset: message.received - (message.sent + receivedAt) / 2 });
        this.clockSamples = this.clockSamples.filter(sample => receivedAt - sample.at < 60_000);
        if (this.role === 'guest') this.clockOffset = this.clockSamples.reduce((best, sample) => sample.rtt < best.rtt ? sample : best).offset;
      }
      return;
    }
    if (this.role === 'host') {
      if (message.type === 'sample') { this.timeline.sample('guest', message.sample); this.publish(); }
      if (message.type === 'ready' && this.timeline.ready('guest', message.epoch)) this.publish();
      if (message.type === 'intent' && this.timeline.intent('guest', message.intent, message.epoch)) {
        if (message.intent.type === 'pause') this.diagnose('pause', { reason: 'peer' });
        this.publish();
      }
      if (message.type === 'resync') {
        this.diagnose('alignment', { reason: 'peer' });
        this.timeline.reset(); this.state = this.timeline.tick();
        this.send({ type: 'state', state: this.state, resetId: message.requestId });
      }
    } else if (message.type === 'state') {
      if (!this.state || message.state.epoch > this.state.epoch ||
          (message.state.epoch === this.state.epoch && message.state.at >= this.state.at)) {
        if (this.state?.playing && !message.state.playing) this.diagnose('pause', { reason: message.state.waiting ? 'buffering' : 'peer' });
        const changed = stateSignature(this.state) !== stateSignature(message.state);
        this.state = message.state; this.lastState = this.now();
        if (changed) this.wake();
      }
      if (message.resetId && message.resetId === this.resetting) delete this.resetting;
    }
  }

  heartbeat() {
    if (!this.role || this.closed) return false;
    const fresh = this.now() - (this.role === 'guest' ? this.lastState : this.lastPeer) < 2500;
    const connected = this.peerJoined && fresh && !Object.values(this.retrying).some(Boolean);
    const interrupted = this.connected && !connected;
    if (interrupted) this.interrupt();
    this.connected = connected;
    this.reconnecting = this.peerJoined && !connected;
    // A ping always travels in the same relay batch as a keepalive.
    const ping = this.now() - this.lastPing >= PING_MS;
    if (this.role === 'host') this.publish(ping);
    else this.share(this.local, ping || this.now() - this.sharedAt >= KEEPALIVE_MS);
    if (ping) { this.lastPing = this.now(); this.send({ type: 'ping', sent: this.now() }); }
    return interrupted;
  }

  // The player command for the current state, or null when only a sample is
  // needed. The player answers every command with a fresh sample, so one
  // browser call per tick both applies and observes. `applied` records what
  // the player confirmed; a failed call leaves the command due again.
  plan() {
    const state = this.state;
    if (!state || !this.local || this.closed) return null;
    if (this.awaitingEpoch !== undefined) {
      if (state.epoch <= this.awaitingEpoch) return { command: { type: 'release' }, applied: () => {} };
      delete this.awaitingEpoch;
    }
    if (state.phase === 'aligning') {
      return this.lastEpoch === state.epoch ? null
        : { command: { type: 'release' }, applied: () => { this.lastEpoch = state.epoch; } };
    }
    const fresh = this.now() - (this.role === 'guest' ? this.lastState : this.lastPeer) < 2500;
    if (!fresh || !this.connected) return { command: { type: 'pause' }, applied: () => {} };
    return { command: { type: 'sync', time: targetTime(state, this.role, this.now(), this.clockOffset), playing: state.playing,
      epoch: state.epoch, ack: state.acknowledgedIntents?.[this.role],
      force: state.revision !== this.lastRevision && state.acknowledgedIntents?.[this.role]?.revision !== state.revision },
    applied: () => { this.lastRevision = state.revision; this.lastEpoch = state.epoch; } };
  }

  ready(epoch) {
    if (epoch !== (this.role === 'host' ? this.timeline.epoch : this.state?.epoch)) throw fault('ABORTED');
    if (this.local.buffering) throw new Error('Das Video lädt noch. Bitte kurz warten.');
    if (!this.local.paused) throw new Error('Bitte das Video pausieren und erneut bestätigen.');
    if (this.role === 'host') {
      if (!this.timeline.ready('host', epoch)) throw new Error('Bitte das Video pausieren und erneut bestätigen.');
      this.publish();
    } else {
      // The host anchors the guest at its latest sample: send it with the confirmation.
      this.share(this.local, true);
      this.send({ type: 'ready', epoch });
    }
  }

  async checkpoint() {
    const { now: clock, ...timeline } = this.timeline;
    const connection = await this.signal.suspend();
    this.closed = true;
    return { server: this.signal.server, timeline, state: this.state, peerJoined: this.peerJoined, connection };
  }

  close() { this.closed = true; this.connected = false; this.signal?.close(); }

  status() {
    return { code: this.code, server: this.signal?.server, role: this.role, connected: this.connected,
      resetting: !!this.resetting, state: this.state, reconnecting: this.reconnecting, transport: 'https', rtt: this.rtt };
  }
}
