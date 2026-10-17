import { validRoomCode } from './protocol.js';
import { PlayerBinding } from './player-binding.js';
import { RoomSession } from './room-session.js';
import { fault, errorPayload } from './runtime-errors.js';

const TICK_MS = 350;
const MIN_TICK_SPACING_MS = 40;

// Status without its continuously advancing fields: whole seconds of the local
// position (the popup's clock), no sample/state timestamps, rounded RTT.
export function statusSignature(status) {
  const { lifecycle, local, room } = status;
  return JSON.stringify({ ...status, lifecycle: lifecycle && { ...lifecycle, revision: undefined },
    local: local && { ...local, at: undefined, time: Math.floor(local.time) },
    room: room && { ...room, rtt: Number.isFinite(room.rtt) ? Math.round(room.rtt / 25) : null,
      state: room.state && { ...room.state, at: undefined, position: room.state.playing ? undefined : room.state.position } } });
}

// The offscreen document is the sole session owner. Background restarts and popup
// navigation only reconnect to this owner; neither can recreate a room implicitly.
export class SessionLifecycle {
  constructor({ requestPlayer, connect, changed = () => {}, diagnose = () => {}, development = false,
    now = () => performance.timeOrigin + performance.now(), timeoutMs = 2000,
    schedule = (...args) => globalThis.setTimeout(...args), unschedule = id => globalThis.clearTimeout(id) }) {
    this.diagnose = diagnose;
    this.diagnosedPhase = null;
    this.player = new PlayerBinding(requestPlayer, { timeoutMs });
    Object.assign(this, { connect, changed, development, now, schedule, unschedule,
      room: null, phase: 'disconnected', generation: 0, revision: 0, notice: '', noticeError: null,
      stalled: false, timer: null, ticking: null, woken: false, lastTick: -Infinity, queue: Promise.resolve() });
    this.instanceId = crypto.randomUUID();
  }

  status() {
    const selection = this.player.selection, local = this.player.local;
    const room = this.room?.status() || null;
    if (room && this.stalled) room.connected = false;
    return { tabId: selection?.tabId ?? null, documentId: selection?.documentId ?? null,
      playerId: local?.playerId ?? selection?.playerId ?? null, bindingId: local?.bindingId ?? null,
      local: local ? { ...local, intents: undefined,
        pendingPlayback: local.intents?.findLast(intent => intent.type === 'play' || intent.type === 'pause')?.type } : null,
      room, notice: this.notice, noticeError: this.noticeError,
      lifecycle: { instanceId: this.instanceId, generation: this.generation, revision: this.revision,
        phase: this.phase, playerBound: this.player.active } };
  }

  publish() {
    if (this.room) this.phase = !this.room.role ? 'connecting'
      : this.stalled || this.room.reconnecting || !this.player.active ? 'interrupted'
        : this.room.state?.phase === 'synced' && !this.room.resetting ? 'synced'
          : this.room.connected ? 'aligning' : 'connecting';
    if (this.diagnosedPhase !== this.phase) {
      this.diagnose('phase', { phase: this.phase });
      this.diagnosedPhase = this.phase;
    }
    this.revision++;
    // Observers (popup, settings) re-read on notification. Notify only for a
    // visible change, not for every tick of a running clock.
    const status = this.status(), signature = statusSignature(status);
    if (signature === this.notified) return;
    this.notified = signature;
    this.changed(status);
  }

  assertCurrent(generation) { if (generation !== this.generation) throw fault('ABORTED'); }
  setNotice(error = '') {
    this.noticeError = error && typeof error === 'object' ? errorPayload(error) : null;
    this.notice = this.noticeError?.message || error;
    if (this.noticeError && this.noticeError.code !== 'ABORTED') this.diagnose('failure', { code: this.noticeError.code });
  }

  invalidate() {
    this.generation++;
    this.player.invalidate();
    if (this.timer !== null) this.unschedule(this.timer);
    this.timer = null;
    this.ticking = null;
    this.woken = false;
    this.queue = Promise.resolve();
  }

  enqueue(run) {
    const generation = this.generation;
    const result = this.queue.then(async () => { this.assertCurrent(generation); return run(generation); });
    this.queue = result.catch(() => {});
    return result;
  }

  scheduleTick(delay = this.stalled ? 1000 : TICK_MS) {
    if (!this.room?.role || this.timer !== null || this.ticking) return;
    this.timer = this.schedule(() => {
      this.timer = null;
      const ticking = this.ticking = {};
      this.lastTick = this.now();
      void this.enqueue(generation => this.tick(generation)).catch(() => {}).finally(() => {
        if (this.ticking !== ticking) return;
        this.ticking = null;
        const woken = this.woken;
        this.woken = false;
        this.scheduleTick(woken ? this.wakeDelay() : undefined);
      });
    }, delay);
  }

  // A received state change or a native intent in the page is applied at once
  // rather than on the next periodic tick. Ticks stay serialized and spaced.
  wake() {
    if (!this.room?.role || this.stalled) return;
    if (this.ticking) { this.woken = true; return; }
    if (this.timer !== null) { this.unschedule(this.timer); this.timer = null; }
    this.scheduleTick(this.wakeDelay());
  }

  wakeDelay() { return Math.max(0, MIN_TICK_SPACING_MS - (this.now() - this.lastTick)); }

  // Sent by the selected document's bridge; identity comes from the sender.
  playerWake({ tabId, documentId }) {
    const selection = this.player.selection;
    if (!this.player.active || selection?.tabId !== tabId || selection.documentId !== documentId) return;
    this.wake();
  }

  async tick(generation) {
    const room = this.room;
    if (!room?.role) return;
    try {
      if (room.heartbeat()) this.setNotice('Verbindung unterbrochen. Nach der Wiederverbindung mit Play fortsetzen.');
      if (this.player.active) {
        // One browser call per tick: apply answers with the sample taken in the page.
        const plan = room.plan();
        const sample = plan ? await this.player.apply(plan.command) : await this.player.sample();
        this.assertCurrent(generation);
        if (room.closed) throw fault('ABORTED');
        plan?.applied();
        room.sample(sample);
        if (this.stalled) { this.stalled = false; this.setNotice('Video wieder erreichbar. Mit Play fortsetzen.'); }
      }
    } catch (error) {
      if (generation !== this.generation || error.code === 'ABORTED') return;
      this.setNotice(error);
      if (error.code === 'PLAYER_TIMEOUT') {
        if (!this.stalled) room.interrupt('player-timeout');
        this.stalled = true;
      } else {
        room.reset('player-changed');
        await this.player.detach(false);
        this.assertCurrent(generation);
      }
    }
    this.publish();
  }

  async stop(reason = '') {
    const room = this.room;
    this.invalidate();
    this.room = null;
    this.phase = 'ended';
    this.stalled = false;
    this.setNotice(reason);
    room?.close();
    const cleanup = this.player.detach(true);
    this.publish();
    await cleanup;
    return this.status();
  }

  async attach(message) {
    if (this.room && !this.room.role) { this.room.close(); this.room = null; }
    this.invalidate();
    const generation = this.generation;
    this.room?.reset('player-changed');
    try {
      const local = await this.player.attach({ tabId: message.tabId, documentId: message.documentId || null,
        frameId: message.frameId, playerId: message.playerId });
      this.assertCurrent(generation);
      this.diagnose('player', { adapter: local.adapter });
      this.room?.sample(local);
      this.room?.reset('player-changed');
      this.phase = this.room ? 'aligning' : 'disconnected';
      this.stalled = false;
      this.setNotice();
    } finally { if (generation === this.generation) { this.publish(); this.scheduleTick(); } }
    return this.status();
  }

  async start(message, generation, checkpoint) {
    if (this.room) throw new Error('Du bist bereits in einem Raum.');
    const url = new URL(message.server);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
        !(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) throw fault('INVALID_SERVER');
    const code = message.action === 'join' ? message.code : null;
    if (code && !validRoomCode(code)) throw new Error('Der Raumcode muss aus 6 Zeichen bestehen.');
    const local = await this.player.refresh();
    this.assertCurrent(generation);
    const room = new RoomSession({ now: this.now, connect: this.connect, diagnose: this.diagnose,
      wake: () => { if (this.room === room) this.wake(); },
      failed: error => { if (this.room === room) void this.stop(error); },
      changed: () => { if (this.room === room) this.publish(); } });
    this.room = room;
    this.publish();
    try {
      await room.open(url.origin, code, local, checkpoint);
      this.assertCurrent(generation);
      if (this.room !== room) throw fault('ABORTED');
      this.setNotice();
      this.publish();
      this.scheduleTick();
    } catch (error) {
      // A late rejection belongs to its original room, never a replacement.
      if (this.room === room) {
        if (error.code !== 'ABORTED') this.diagnose('failure', { code: error.code });
        await this.stop();
      }
      throw error;
    }
  }

  async navigation(message) {
    const matches = message.action === 'tab-closed'
      ? this.player.selection?.tabId === message.tabId : this.player.matchesNavigation(message);
    if (!matches) return this.status();
    this.invalidate();
    this.room?.interrupt('navigation');
    this.room?.reset('navigation');
    this.setNotice('Der Video-Player wurde geschlossen oder neu geladen. Video erneut verbinden und ausrichten.');
    const cleanup = this.player.detach(false);
    this.publish();
    this.scheduleTick();
    await cleanup;
    return this.status();
  }

  async checkpoint(generation) {
    const checkpoint = { ...this.player.selection };
    if (this.room) {
      this.room.interrupt('reload');
      if (this.player.active) this.room.sample(await this.player.apply({ type: 'pause' }));
      this.assertCurrent(generation);
      checkpoint.room = await this.room.checkpoint();
      this.assertCurrent(generation);
    }
    this.invalidate();
    this.room = null;
    const completedGeneration = this.generation;
    await this.player.detach(false);
    this.assertCurrent(completedGeneration);
    this.phase = 'ended';
    this.publish();
    return checkpoint;
  }

  handle(message) {
    if (message.expectedSession && ['control', 'ready', 'resync'].includes(message.action) &&
        (message.expectedSession.instanceId !== this.instanceId || message.expectedSession.generation !== this.generation)) return Promise.reject(fault('ABORTED'));
    if (message.action === 'leave') return this.stop();
    if (['tab-closed', 'document-changed'].includes(message.action)) return this.navigation(message);
    if (message.action === 'attach') return this.attach(message);
    if (message.action === 'status' && !message.observePlayer) return Promise.resolve(this.status());
    const expectedMediaId = message.expectedPlayer?.mediaId ?? this.player.local?.mediaId;
    const expectedPlayerId = message.expectedPlayer?.playerId ?? this.player.local?.playerId;
    const expectedBindingId = message.expectedPlayer?.bindingId ?? this.player.selection?.bindingId;
    const expectedRoom = this.room, expectedEpoch = message.expectedEpoch ?? this.room?.state?.epoch;
    return this.enqueue(async generation => {
      if (message.action === 'status') {
        if (!this.room && this.player.selection) {
          try { await this.player.observe(); this.assertCurrent(generation); }
          catch (error) {
            if (error.code === 'ABORTED') throw error;
            if (!this.player.active) this.player.local = null;
            this.setNotice(error);
          }
        }
        return this.status();
      }
      if (message.action === 'create' || message.action === 'join') await this.start(message, generation);
      else if (message.action === 'ready') {
        if (!this.room?.connected || !this.room.state) throw new Error('Die zweite Person ist noch nicht verbunden.');
        if (this.room.resetting) throw new Error('Die neue Ausrichtung wird noch vorbereitet. Bitte kurz warten.');
        const room = this.room;
        const assertReadyContext = () => {
          if (room !== expectedRoom || room.resetting || room.state?.epoch !== expectedEpoch ||
              this.player.local?.mediaId !== expectedMediaId || this.player.local?.playerId !== expectedPlayerId ||
              this.player.selection?.bindingId !== expectedBindingId) throw fault('ABORTED');
        };
        assertReadyContext();
        const sample = await this.player.apply({ type: 'pause', waitForPause: true, expectedMediaId, expectedPlayerId, expectedBindingId });
        this.assertCurrent(generation);
        room.sample(sample);
        assertReadyContext();
        room.ready(expectedEpoch);
      } else if (message.action === 'resync') this.room?.reset();
      else if (message.action === 'control') {
        if (!this.player.active || !this.room?.connected || this.stalled) throw new Error('Die Videos sind noch nicht verbunden.');
        if (this.room.state?.phase !== 'synced') throw new Error('Bitte zuerst beide Videos ausrichten.');
        this.setNotice();
        const room = this.room;
        room.sample(await this.player.apply({ type: 'control', control: message.control, epoch: room.state.epoch, expectedMediaId, expectedPlayerId, expectedBindingId }));
        this.assertCurrent(generation);
      } else if (message.action === 'dismiss-notice') this.setNotice();
      else if (this.development && message.action === 'dev-checkpoint') return this.checkpoint(generation);
      else if (this.development && message.action === 'dev-restore') {
        const checkpoint = message.checkpoint;
        try {
          if (checkpoint.tabId != null) await this.player.attach(checkpoint);
          this.assertCurrent(generation);
          if (checkpoint.room) await this.start({ server: checkpoint.room.server }, generation, checkpoint.room);
          this.setNotice('Dev aktualisiert. Raum wieder verbunden; Szene gegebenenfalls erneut bestätigen.');
        } catch (error) {
          if (generation !== this.generation) throw error;
          this.setNotice(`Dev aktualisiert. Video oder Raum erneut verbinden: ${error.message}`);
        }
      } else throw new Error('Unbekannte Sitzungsaktion.');
      this.assertCurrent(generation);
      this.publish();
      return this.status();
    });
  }
}
