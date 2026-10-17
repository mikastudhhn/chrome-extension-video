import { validSample, validIntent, validState, validRole } from './protocol.js';
export { validSample } from './protocol.js';
const FRESHNESS_MS = 2500;

/** The room creator orders commands; both people have identical control rights. */
export class Timeline {
  constructor(now = Date.now) {
    this.now = now;
    this.epoch = 0;
    this.revision = 0;
    this.phase = 'aligning';
    this.anchors = {};
    this.samples = {};
    this.acknowledgedIntents = {};
    this.position = 0;
    this.wantsPlay = false;
    this.playing = false;
    this.at = now();
  }

  advance() {
    const now = this.now();
    if (this.playing) this.position += Math.max(0, now - this.at) / 1000;
    this.at = now;
  }

  reset() {
    this.advance();
    this.epoch++;
    this.phase = 'aligning';
    this.anchors = {};
    this.acknowledgedIntents = {};
    this.position = 0;
    this.wantsPlay = false;
    this.playing = false;
    this.revision++;
  }

  suspend() {
    this.advance();
    this.epoch++;
    this.revision++;
    this.wantsPlay = false;
    this.playing = false;
    this.acknowledgedIntents = {};
  }

  sample(role, sample) {
    if (!['host', 'guest'].includes(role) || !validSample(sample)) return;
    const previous = this.samples[role];
    if (previous && previous.mediaId !== sample.mediaId) this.reset();
    this.samples[role] = { ...sample, receivedAt: this.now() };
    // A confirmed anchor becomes invalid if someone moves their video during alignment.
    if (this.phase === 'aligning' && this.anchors[role] !== undefined &&
        (!sample.paused || Math.abs(sample.time - this.anchors[role]) > 0.3)) {
      delete this.anchors[role];
    }
    this.tick();
  }

  ready(role, epoch) {
    if (!validRole(role) || !Number.isSafeInteger(epoch) || epoch < 0) return false;
    const sample = this.samples[role];
    if (epoch !== this.epoch || this.phase !== 'aligning' || !sample ||
        !sample.paused || sample.buffering || this.now() - sample.receivedAt > FRESHNESS_MS) return false;
    this.anchors[role] = sample.time;
    if (this.anchors.host !== undefined && this.anchors.guest !== undefined) {
      this.phase = 'synced';
      this.position = 0;
      this.at = this.now();
    }
    this.revision++;
    return true;
  }

  intent(role, command, epoch) {
    if (!validRole(role) || !validIntent(command) || !Number.isSafeInteger(epoch) || epoch < 0) return false;
    if (epoch !== this.epoch || this.phase !== 'synced' || this.anchors[role] === undefined) return false;
    if (command.id !== undefined) {
      const previous = this.acknowledgedIntents[role];
      if (!Number.isSafeInteger(command.id) || command.id < 1 || command.mediaId !== this.samples[role]?.mediaId ||
          (previous?.mediaId === command.mediaId && previous.id >= command.id)) return false;
    }
    this.advance();
    if (command.type === 'play') this.wantsPlay = true;
    else if (command.type === 'pause') {
      this.wantsPlay = false;
      // Freeze at the frame the person chose, not at the later receipt time.
      if (Number.isFinite(command.time)) this.position = this.clamp(command.time - this.anchors[role]);
    }
    else if (command.type === 'seek' && Number.isFinite(command.time)) {
      this.position = this.clamp(command.time - this.anchors[role]);
    } else return false;
    if (command.id !== undefined && command.type !== 'pause' && Number.isFinite(command.time)) {
      const elapsed = command.advancing && Number.isFinite(command.at)
        ? Math.max(0, Math.min(FRESHNESS_MS, this.now() - command.at)) / 1000 : 0;
      this.position = this.clamp(command.time - this.anchors[role] + elapsed);
    }
    this.revision++;
    if (command.id !== undefined) this.acknowledgedIntents[role] = { id: command.id, mediaId: command.mediaId, revision: this.revision };
    this.tick();
    return true;
  }

  clamp(position) {
    if (this.phase !== 'synced') return 0;
    const minimum = -Math.min(this.anchors.host, this.anchors.guest);
    const maximum = Math.min(...['host', 'guest'].map(role =>
      this.samples[role].duration - this.anchors[role]));
    return Math.max(minimum, Math.min(maximum, position));
  }

  tick() {
    this.advance();
    const ready = ['host', 'guest'].every(role => {
      const sample = this.samples[role];
      return sample && !sample.buffering && !sample.blocked &&
        this.now() - sample.receivedAt <= FRESHNESS_MS;
    });
    if (this.phase === 'synced') {
      const maximum = Math.min(...['host', 'guest'].map(role =>
        this.samples[role].duration - this.anchors[role]));
      if (this.position >= maximum) this.wantsPlay = false;
      this.position = this.clamp(this.position);
    }
    this.playing = this.phase === 'synced' && this.wantsPlay && ready;
    return this.snapshot();
  }

  snapshot() {
    return {
      epoch: this.epoch, revision: this.revision, phase: this.phase,
      anchors: { ...this.anchors }, position: this.position,
      wantsPlay: this.wantsPlay, playing: this.playing, at: this.at,
      acknowledgedIntents: structuredClone(this.acknowledgedIntents),
      waiting: this.phase === 'synced' && this.wantsPlay && !this.playing,
      members: Object.fromEntries(['host', 'guest'].map(role => [role, {
        present: !!this.samples[role] && this.now() - this.samples[role].receivedAt <= FRESHNESS_MS,
        ready: this.anchors[role] !== undefined,
        blocked: !!this.samples[role]?.blocked
      }]))
    };
  }
}

export function targetTime(state, role, now, hostClockOffset = 0) {
  if (!validState(state) || !validRole(role) || !Number.isFinite(now) || !Number.isFinite(hostClockOffset)) return null;
  if (state.phase !== 'synced' || !Number.isFinite(state.anchors[role])) return null;
  const elapsed = state.playing ? Math.max(0, now + hostClockOffset - state.at) / 1000 : 0;
  return state.anchors[role] + state.position + elapsed;
}
